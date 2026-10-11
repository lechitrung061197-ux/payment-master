/**
 * SellerPayoutAllocations.gs
 * Seller Payout Allocations: classification of an actual Seller Payout to seller settlement obligations.
 *
 * - Seller Payout = the actual money transfer; it alone reduces Seller Balances. An allocation only says WHERE
 *   (which seller settlement obligation) a payout was applied - it never creates money and never reduces a
 *   balance a second time.
 * - Obligation per seller_id + settlement_id + currency = SUM(frozen Settlement Items.seller_available_amount) of
 *   that seller in that settlement (never provider-wide totals, non-AVAILABLE legs, balances or seller sheets).
 * - allocation_id = SPA-<sha256(seller_payout_id|settlement_id)>; unique by seller_payout_id + settlement_id.
 * - Only SENT / CONFIRMED payouts count as paid; DRAFT allocations are provisional; VOID allocations are ignored.
 *   An effective payout must be fully allocated; no payout may be over-allocated; no obligation over-paid.
 * - Derived per seller + settlement: due, paid, remaining and UNPAID / PARTIAL / PAID (never stored).
 * - autoAllocateSellerPayoutFIFO(payoutId) writes allocation rows for one DRAFT payout (oldest obligation
 *   first) and never touches the payout status or existing allocation rows.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const SELLER_ALLOCATIONS = Object.freeze({
  idPrefix: 'SPA-',
  // Aggregate money tolerance (micro units): the 0.00005 convention of Settlement Items / Seller Balances.
  toleranceMicros: 50,
  effectiveStatuses: Object.freeze(['SENT', 'CONFIRMED']),
  draftStatus: 'DRAFT',
  voidStatus: 'VOID',
  fifoNote: 'FIFO auto-allocation - review before marking the payout SENT / CONFIRMED',
  maxReportedErrors: 30,
});

/** Current production regression (after Phase 2K: no payouts). Report only. */
const SELLER_ALLOCATIONS_REGRESSION = Object.freeze({
  snapshot: 'Production after Phase 2K (no Seller Payouts, no allocations)',
  allocation_rows: 0,
  effective_payout_count: 0,
  per_seller_due: { CUS001: 1919.3986, CUS002: 3037.444, CUS003: 256.7666, CUS004: 3156.4424 },
  per_seller_paid: { CUS001: 0, CUS002: 0, CUS003: 0, CUS004: 0 },
  settlement_due: { 'CUS002|ST-KH001-PAYPAL-000001': 2132.2706, 'CUS002|ST-KH001-PAYPAL-000002': 905.1734 },
});

/* ----------------------------- Pure helpers ----------------------------- */

function sellerAllocationId_(payoutId, settlementId, digestHex) {
  const digest = digestHex || sha256Hex_;
  return SELLER_ALLOCATIONS.idPrefix + digest(String(payoutId) + '|' + String(settlementId));
}

function emptyAllocationErrors_() {
  return { obligation_errors: [], invalid_ids: [], invalid_references: [], cross_seller_errors: [], currency_errors: [],
    payment_source_errors: [], invalid_amounts: [], duplicate_keys: [], overallocated_payouts: [], unallocated_effective_payouts: [],
    overpaid_settlements: [] };
}

function flattenAllocationErrors_(errors) {
  return Object.keys(errors).reduce(function (acc, k) { return acc.concat(errors[k]); }, []);
}

/**
 * Seller settlement obligations from frozen Settlement Items, keyed seller|settlement|currency (amounts in micro units).
 * @return {{obligations: Object<string, Object>, errors: Array<string>}}
 */
function buildSellerSettlementObligations_(items, settlements) {
  const errors = [];
  const settlementById = {};
  settlements.forEach(function (s) { settlementById[String(s.settlement_id)] = s; });
  const obligations = {};
  items.forEach(function (i) {
    const label = 'Settlement Item ' + i.settlement_item_id;
    const sellerId = trimmedText_(i.seller_id);
    const settlementId = trimmedText_(i.settlement_id);
    const currency = trimmedText_(i.currency);
    const source = trimmedText_(i.payment_source);
    const s = settlementById[settlementId];
    if (!s) { errors.push(label + ': settlement ' + settlementId + ' not found in Settlements'); return; }
    if (sellerId === '' || currency === '' || !isFiniteNumber_(i.seller_available_amount) || !isFiniteNumber_(i.seller_hold_amount)) {
      errors.push(label + ': missing seller, currency or seller amounts');
      return;
    }
    if (trimmedText_(s.payment_source) !== '' && trimmedText_(s.payment_source) !== source) {
      errors.push(label + ': payment_source ' + source + ' differs from settlement ' + settlementId + ' (' + s.payment_source + ')');
      return;
    }
    const key = sellerId + '|' + settlementId + '|' + currency;
    const o = obligations[key] = obligations[key] || { key: key, seller_id: sellerId, settlement_id: settlementId, payment_source: source,
      currency: currency, due: 0, hold: 0, item_count: 0, settlement: s };
    if (o.payment_source !== source) { errors.push(label + ': mixed payment_source inside obligation ' + key); return; }
    o.due += Math.round(i.seller_available_amount * 1e6);
    o.hold += Math.round(i.seller_hold_amount * 1e6);
    o.item_count++;
  });
  return { obligations: obligations, errors: errors };
}

function sellerSettlementStatus_(dueMicros, paidMicros) {
  const tol = SELLER_ALLOCATIONS.toleranceMicros;
  if (Math.abs(dueMicros - paidMicros) <= tol) return 'PAID';
  if (paidMicros <= tol) return 'UNPAID';
  return 'PARTIAL';
}

/** Deterministic FIFO / display order of obligations: provider payment date, period end, settlement number, id. */
function compareSellerObligations_(a, b) {
  return compareCanonicalValues_(a.settlement.source_payment_date, b.settlement.source_payment_date) ||
    compareCanonicalValues_(a.settlement.period_end_date, b.settlement.period_end_date) ||
    compareCanonicalValues_(a.settlement.source_settlement_number, b.settlement.source_settlement_number) ||
    compareCanonicalValues_(a.settlement_id, b.settlement_id);
}

/**
 * Validates every allocation and derives the per seller + settlement payment state.
 * @param {{allocations: Array<Object>, payouts: Array<Object>, items: Array<Object>, settlements: Array<Object>,
 *          digestHex?: Function}} input
 * @return {{errors: Object, obligations: Object, states: Array<Object>, summary: Object, payoutAllocated: Object}}
 */
function validateSellerPayoutAllocations_(input) {
  const errors = emptyAllocationErrors_();
  const tol = SELLER_ALLOCATIONS.toleranceMicros;
  const ob = buildSellerSettlementObligations_(input.items, input.settlements);
  ob.errors.forEach(function (e) { errors.obligation_errors.push(e); });
  const obligations = ob.obligations;
  const settlementIds = {};
  input.settlements.forEach(function (s) { settlementIds[String(s.settlement_id)] = true; });
  const sellersInSettlement = {};
  Object.keys(obligations).forEach(function (k) {
    const o = obligations[k];
    (sellersInSettlement[o.settlement_id] = sellersInSettlement[o.settlement_id] || {})[o.seller_id + '|' + o.currency] = true;
  });
  const payoutsById = {};
  input.payouts.forEach(function (p) {
    const id = trimmedText_(p.seller_payout_id);
    if (id === '') return;
    if (payoutsById[id]) errors.invalid_references.push('Seller Payout ' + id + ' appears more than once');
    payoutsById[id] = p;
  });

  const seenKeys = {};
  const payoutAllocated = {};
  const paid = {};
  const summary = { allocation_rows: input.allocations.length, draft_allocation_rows: 0, effective_allocation_rows: 0, void_allocation_rows: 0 };
  input.allocations.forEach(function (a, i) {
    const label = 'Allocation row ' + (a._row || i + 2);
    const payoutId = trimmedText_(a.seller_payout_id);
    const settlementId = trimmedText_(a.settlement_id);
    const payout = payoutsById[payoutId];
    const status = payout ? trimmedText_(payout.status) : '';
    if (status === SELLER_ALLOCATIONS.voidStatus) { summary.void_allocation_rows++; return; } // VOID payouts: ignored
    const effective = SELLER_ALLOCATIONS.effectiveStatuses.indexOf(status) >= 0;
    let ok = true;
    const bad = function (bucket, msg) { errors[bucket].push(label + ': ' + msg); ok = false; };
    const key = payoutId + '|' + settlementId;
    if (seenKeys[key]) bad('duplicate_keys', 'duplicate seller_payout_id + settlement_id ' + key);
    seenKeys[key] = true;
    if (trimmedText_(a.allocation_id) !== sellerAllocationId_(payoutId, settlementId, input.digestHex)) {
      bad('invalid_ids', 'allocation_id must be ' + SELLER_ALLOCATIONS.idPrefix + 'sha256(seller_payout_id|settlement_id)');
    }
    if (!payout) bad('invalid_references', 'unknown seller_payout_id ' + (payoutId || '(blank)'));
    if (!settlementIds[settlementId]) bad('invalid_references', 'unknown settlement_id ' + (settlementId || '(blank)'));
    const sellerId = trimmedText_(a.seller_id);
    const currency = trimmedText_(a.currency);
    if (payout && sellerId !== trimmedText_(payout.seller_id)) bad('cross_seller_errors', 'seller_id ' + sellerId + ' is not the payout seller ' + payout.seller_id);
    if (payout && currency !== trimmedText_(payout.currency)) bad('currency_errors', 'currency ' + currency + ' differs from the payout currency ' + payout.currency);
    const o = obligations[sellerId + '|' + settlementId + '|' + currency];
    if (!o && settlementIds[settlementId]) {
      const shares = Object.keys(sellersInSettlement[settlementId] || {});
      if (shares.some(function (s) { return s.indexOf(sellerId + '|') === 0; })) bad('currency_errors', 'seller ' + sellerId + ' has no ' + currency + ' obligation in ' + settlementId);
      else if (shares.length > 0) bad('cross_seller_errors', 'settlement ' + settlementId + ' has no share of seller ' + sellerId + ' (another seller\'s settlement share)');
      else bad('invalid_references', 'settlement ' + settlementId + ' has no seller obligation (no frozen Settlement Items)');
    }
    if (o && trimmedText_(a.payment_source) !== o.payment_source) bad('payment_source_errors', 'payment_source ' + a.payment_source + ' differs from the obligation (' + o.payment_source + ')');
    if (!isFiniteNumber_(a.allocated_amount) || !(Math.round(a.allocated_amount * 1e6) > 0)) bad('invalid_amounts', 'allocated_amount must be a positive number');
    if (!ok || !o) return;
    const micros = Math.round(a.allocated_amount * 1e6);
    payoutAllocated[payoutId] = (payoutAllocated[payoutId] || 0) + micros;
    if (effective) {
      summary.effective_allocation_rows++;
      paid[o.key] = (paid[o.key] || 0) + micros;
    } else {
      summary.draft_allocation_rows++;
    }
  });

  let effectiveCount = 0;
  let fullyAllocated = 0;
  Object.keys(payoutsById).sort().forEach(function (id) {
    const p = payoutsById[id];
    const status = trimmedText_(p.status);
    if (status === SELLER_ALLOCATIONS.voidStatus) return;
    const amount = isFiniteNumber_(p.amount) ? Math.round(p.amount * 1e6) : null;
    const allocated = payoutAllocated[id] || 0;
    const effective = SELLER_ALLOCATIONS.effectiveStatuses.indexOf(status) >= 0;
    if (amount === null) { if (effective || allocated > 0) errors.invalid_amounts.push('Seller Payout ' + id + ': amount is not numeric'); return; }
    if (allocated > amount + tol) errors.overallocated_payouts.push('Seller Payout ' + id + ': allocated ' + allocated / 1e6 + ' > payout amount ' + amount / 1e6);
    if (!effective) return;
    effectiveCount++;
    if (allocated < amount - tol) errors.unallocated_effective_payouts.push('Seller Payout ' + id + ' (' + status + '): allocated ' + allocated / 1e6 + ' of ' + amount / 1e6);
    else if (allocated <= amount + tol) fullyAllocated++;
  });

  const states = Object.keys(obligations).map(function (k) { return obligations[k]; }).sort(function (a, b) {
    return compareCanonicalValues_(a.seller_id, b.seller_id) || compareSellerObligations_(a, b) || compareCanonicalValues_(a.currency, b.currency);
  }).map(function (o) {
    const p = paid[o.key] || 0;
    if (p > o.due + tol) errors.overpaid_settlements.push(o.key + ': paid ' + p / 1e6 + ' > due ' + o.due / 1e6);
    const s = o.settlement;
    return { seller_id: o.seller_id, settlement_id: o.settlement_id, payment_source: o.payment_source, source_settlement_number: s.source_settlement_number,
      period_start_date: s.period_start_date, period_end_date: s.period_end_date, source_payment_date: s.source_payment_date, currency: o.currency,
      due_amount: o.due / 1e6, paid_amount: p / 1e6, remaining_amount: (o.due - p) / 1e6, payment_status: sellerSettlementStatus_(o.due, p),
      hold_amount: o.hold / 1e6, settlement: s };
  });

  const perSeller = function (f) {
    return states.reduce(function (acc, s) { acc[s.seller_id] = Math.round(((acc[s.seller_id] || 0) + s[f]) * 1e6) / 1e6; return acc; }, {});
  };
  summary.effective_payout_count = effectiveCount;
  summary.fully_allocated_effective_payouts = fullyAllocated;
  summary.per_seller_due = perSeller('due_amount');
  summary.per_seller_paid = perSeller('paid_amount');
  summary.per_seller_remaining = perSeller('remaining_amount');
  summary.payment_status_counts = states.reduce(function (acc, s) { acc[s.payment_status] = (acc[s.payment_status] || 0) + 1; return acc; }, {});
  return { errors: errors, obligations: obligations, states: states, summary: summary, payoutAllocated: payoutAllocated };
}

/**
 * FIFO allocation rows for one DRAFT payout: oldest open obligation of the same seller + currency first. Remaining
 * capacity excludes effective payments and other DRAFT payouts' provisional claims. Never touches existing rows.
 * @return {{status: string, rows: Array<Object>, error: ?string}}
 */
function planFifoAllocation_(payout, allocations, validation, payoutsById, now, digestHex) {
  const id = trimmedText_(payout.seller_payout_id);
  if (allocations.some(function (a) { return trimmedText_(a.seller_payout_id) === id; })) {
    return { status: 'NO_CHANGE', rows: [], error: 'Seller Payout ' + id + ' already has allocation rows; operator review required (nothing changed).' };
  }
  const tol = SELLER_ALLOCATIONS.toleranceMicros;
  const sellerId = trimmedText_(payout.seller_id);
  const currency = trimmedText_(payout.currency);
  const claimed = {};
  allocations.forEach(function (a) {
    const parent = payoutsById[trimmedText_(a.seller_payout_id)];
    if (!parent || trimmedText_(parent.status) === SELLER_ALLOCATIONS.voidStatus || !isFiniteNumber_(a.allocated_amount)) return;
    const key = trimmedText_(a.seller_id) + '|' + trimmedText_(a.settlement_id) + '|' + trimmedText_(a.currency);
    claimed[key] = (claimed[key] || 0) + Math.round(a.allocated_amount * 1e6); // effective payments + provisional DRAFT claims
  });
  const open = Object.keys(validation.obligations).map(function (k) { return validation.obligations[k]; })
    .filter(function (o) { return o.seller_id === sellerId && o.currency === currency; })
    .sort(compareSellerObligations_);
  let left = Math.round(payout.amount * 1e6);
  const rows = [];
  open.forEach(function (o) {
    if (left <= 0) return;
    const remaining = o.due - (claimed[o.key] || 0);
    if (remaining <= tol) return;
    const take = Math.min(left, remaining);
    rows.push({ allocation_id: sellerAllocationId_(id, o.settlement_id, digestHex), seller_payout_id: id, seller_id: sellerId,
      settlement_id: o.settlement_id, payment_source: o.payment_source, currency: currency, allocated_amount: take / 1e6, created_at: now,
      notes: SELLER_ALLOCATIONS.fifoNote });
    left -= take;
  });
  if (left > tol) {
    return { status: 'FAILED', rows: [], error: 'Seller Payout ' + id + ' exceeds the open ' + currency + ' obligations of ' + sellerId + ' by ' + left / 1e6 +
      '; nothing allocated (allocate manually or adjust the payout).' };
  }
  return { status: 'SUCCESS', rows: rows, error: null };
}

/* ---------------------------------- I/O --------------------------------- */

function readSellerAllocationInputs_(ss) {
  const allocations = readPlainTableObjects_(ss, SHEETS.SELLER_PAYOUT_ALLOCATIONS).map(function (a, i) { a._row = i + 2; return a; });
  const payouts = readPlainTableObjects_(ss, SHEETS.SELLER_PAYOUTS);
  const items = readSchemaTableObjects_(ss, SHEETS.SETTLEMENT_ITEMS, settlementItemsTab_()).rows;
  const settlements = readSchemaTableObjects_(ss, SHEETS.SETTLEMENTS, settlementsTab_()).rows;
  return { allocations: allocations, payouts: payouts, items: items, settlements: settlements,
    validation: validateSellerPayoutAllocations_({ allocations: allocations, payouts: payouts, items: items, settlements: settlements }) };
}

/** autoAllocateSellerPayoutFIFO(payoutId) under the script lock. Never throws. */
function runSellerPayoutFifo_(payoutId) {
  const id = trimmedText_(payoutId);
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  const details = { seller_payout_id: id, rows: [], warnings: [] };
  let status = 'FAILED';
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms.');
    const ss = getSpreadsheet_();
    const items = readSettlementItemsFreshness_(ss);
    if (!items.current) throw new Error('Settlement Items is not current; nothing allocated: ' + items.reason);
    const input = readSellerAllocationInputs_(ss);
    const existingErrors = flattenAllocationErrors_(input.validation.errors);
    if (existingErrors.length > 0) {
      throw new Error('Seller Payout Allocations is invalid; fix it first (' + existingErrors.length + ' error(s)): ' +
        existingErrors.slice(0, SELLER_ALLOCATIONS.maxReportedErrors).join(' | '));
    }
    const matches = input.payouts.filter(function (p) { return trimmedText_(p.seller_payout_id) === id; });
    if (matches.length !== 1) throw new Error('Expected exactly one Seller Payout ' + (id || '(blank)') + ', found ' + matches.length + '.');
    const payout = matches[0];
    if (trimmedText_(payout.status) !== SELLER_ALLOCATIONS.draftStatus) throw new Error('Seller Payout ' + id + ' is ' + payout.status + '; FIFO allocates DRAFT payouts only.');
    if (trimmedText_(payout.seller_id) === '' || trimmedText_(payout.currency) === '') throw new Error('Seller Payout ' + id + ' has no seller_id / currency.');
    if (!isFiniteNumber_(payout.amount) || !(payout.amount > 0)) throw new Error('Seller Payout ' + id + ' amount must be a positive number.');
    const payoutsById = {};
    input.payouts.forEach(function (p) { payoutsById[trimmedText_(p.seller_payout_id)] = p; });
    const plan = planFifoAllocation_(payout, input.allocations, input.validation, payoutsById, new Date(Math.floor(Date.now() / 1000) * 1000));
    if (plan.status === 'NO_CHANGE') { details.warnings.push(plan.error); status = 'NO_CHANGE'; return redactDeep_(Object.assign({ status: status }, details)); }
    if (plan.status !== 'SUCCESS') throw new Error(plan.error);
    const check = validateSellerPayoutAllocations_({ allocations: input.allocations.concat(plan.rows), payouts: input.payouts, items: input.items,
      settlements: input.settlements });
    const planErrors = flattenAllocationErrors_(check.errors);
    if (planErrors.length > 0) throw new Error('FIFO plan would be invalid; nothing written: ' + planErrors.slice(0, 10).join(' | '));
    const sheet = ss.getSheetByName(SHEETS.SELLER_PAYOUT_ALLOCATIONS);
    const columns = getColumnNames_(SHEETS.SELLER_PAYOUT_ALLOCATIONS);
    const start = sheet.getLastRow() + 1;
    if (sheet.getMaxRows() < start + plan.rows.length - 1) sheet.insertRowsAfter(sheet.getMaxRows(), start + plan.rows.length - 1 - sheet.getMaxRows());
    sheet.getRange(start, 1, plan.rows.length, columns.length).setValues(plan.rows.map(function (r) { return objectToRow_(r, columns); }));
    details.rows = plan.rows.map(function (r) { return { settlement_id: r.settlement_id, payment_source: r.payment_source, allocated_amount: r.allocated_amount }; });
    details.remaining = check.states.filter(function (s) { return s.seller_id === trimmedText_(payout.seller_id); })
      .map(function (s) { return { settlement_id: s.settlement_id, due_amount: s.due_amount, effective_paid: s.paid_amount }; });
    details.warnings.push('Review the allocation, then set the payout to SENT / CONFIRMED and run normalizeSellerBalances.');
    status = 'SUCCESS';
  } catch (err) {
    details.error = redactEndpointCredentials_(err && err.message ? err.message : String(err));
    status = 'FAILED';
  } finally {
    try {
      appendAuditLog_({ action: 'SELLER_PAYOUT_ALLOCATION_FIFO_' + status, entityType: 'SELLER_PAYOUT', entityId: id, newStatus: status,
        details: redactDeep_(details) });
    } catch (auditErr) {
      Logger.log('Failed to write audit entry: %s', auditErr);
    }
    if (locked) lock.releaseLock();
  }
  return redactDeep_(Object.assign({ status: status }, details));
}

/** Read-only report of Seller Payout Allocations and the derived settlement payment states. */
function buildSellerPayoutAllocationsReport_() {
  const report = { allocation_rows: 0, draft_allocation_rows: 0, effective_allocation_rows: 0, void_allocation_rows: 0, effective_payout_count: 0,
    fully_allocated_effective_payouts: 0, unallocated_effective_payouts: [], overallocated_payouts: [], overpaid_settlements: [], invalid_references: [],
    cross_seller_errors: [], currency_errors: [], payment_source_errors: [], duplicate_keys: [], invalid_ids: [], invalid_amounts: [], obligation_errors: [],
    per_seller_due: {}, per_seller_paid: {}, per_seller_remaining: {}, payment_status_counts: {}, settlement_states: [], pass: false, errors: [],
    warnings: [], regression: null };
  try {
    const input = readSellerAllocationInputs_(getSpreadsheet_());
    const v = input.validation;
    Object.keys(v.errors).forEach(function (k) { report[k] = v.errors[k]; });
    Object.keys(v.summary).forEach(function (k) { report[k] = v.summary[k]; });
    report.settlement_states = v.states.map(function (s) {
      return { seller_id: s.seller_id, settlement_id: s.settlement_id, payment_source: s.payment_source, source_settlement_number: s.source_settlement_number,
        currency: s.currency, due_amount: s.due_amount, paid_amount: s.paid_amount, remaining_amount: s.remaining_amount, payment_status: s.payment_status };
    });
    const errors = flattenAllocationErrors_(v.errors);
    if (errors.length > 0) report.errors.push('Seller Payout Allocations has ' + errors.length + ' error(s); Seller Balances will fail closed.');
    report.regression = evaluateSellerAllocationsRegression_(v);
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0;
  return redactDeep_(report);
}

function evaluateSellerAllocationsRegression_(validation) {
  const exp = SELLER_ALLOCATIONS_REGRESSION;
  const checks = [];
  const add = function (n, e, a, pass) { checks.push({ name: n, expected: e, actual: a, pass: pass }); };
  add('allocation_rows', exp.allocation_rows, validation.summary.allocation_rows, validation.summary.allocation_rows === exp.allocation_rows);
  add('effective_payout_count', exp.effective_payout_count, validation.summary.effective_payout_count,
    validation.summary.effective_payout_count === exp.effective_payout_count);
  ['per_seller_due', 'per_seller_paid'].forEach(function (k) {
    Object.keys(exp[k]).forEach(function (s) {
      const a = validation.summary[k][s];
      add(k + '.' + s, exp[k][s], a === undefined ? null : a, isFiniteNumber_(a) && Math.abs(a - exp[k][s]) < 0.00005);
    });
  });
  Object.keys(exp.settlement_due).forEach(function (key) {
    const parts = key.split('|');
    const st = validation.states.filter(function (s) { return s.seller_id === parts[0] && s.settlement_id === parts[1]; })[0];
    add('settlement_due.' + key, exp.settlement_due[key], st ? st.due_amount : null, !!st && Math.abs(st.due_amount - exp.settlement_due[key]) < 0.00005);
  });
  return { snapshot: exp.snapshot, pass: checks.every(function (c) { return c.pass; }),
    failed: checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }), checks: checks };
}
