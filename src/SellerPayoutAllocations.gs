/**
 * SellerPayoutAllocations.gs
 * Seller Payout Allocations: classification of an actual Seller Payout to seller payout obligations.
 *
 * - Seller Payout = the actual money transfer; it alone reduces Seller Balances. An allocation only says WHERE the
 *   payout was applied - it never creates money and never reduces a balance a second time.
 * - Targets (target_type / target_id):
 *     SETTLEMENT / settlement_id  - due = SUM(frozen Settlement Items.seller_available_amount) of that seller +
 *                                   settlement + currency (never provider totals, non-AVAILABLE legs, balances or
 *                                   seller sheets; another seller's share is never allocatable). Provider paid and
 *                                   seller paid are separate ledgers: provider source_paid_amount is never read here;
 *     ADJUSTMENT / adjustment_id  - a seller credit: status APPLIED and amount > 0 (any adjustment type, e.g.
 *                                   HOLD_RELEASE or a positive MANUAL_ADJUSTMENT); due = amount. Negative / zero,
 *                                   PENDING and VOID adjustments are never payout obligations.
 * - allocation_id = SPA-<sha256(seller_payout_id|target_type|target_id)>; unique by payout + target_type + target_id.
 * - Only SENT / CONFIRMED payouts count as paid; DRAFT allocations are provisional; VOID / REVERSED / CANCELLED /
 *   FAILED payouts have no financial effect (their rows must still be structurally valid), so a reversed payout makes
 *   the obligation fall back to PARTIAL / UNPAID automatically. An effective payout must be fully allocated; no payout
 *   may be over-allocated; no obligation over-paid.
 * - Temporal guards: an effective payout needs a valid payout_date; a target must be available (settlement
 *   source_payment_date / adjustment effective_date) on or before the payout date; and the seller PAYABLE BALANCE as of
 *   each effective payout date (Settlement Items paid by then + APPLIED adjustments effective by then - SENT/CONFIRMED
 *   payouts dated by then, same-day payouts together) may never go below zero. Allocation remainders ("Chưa payout")
 *   are cash attribution only, never permission to pay beyond the balance; later debits never invalidate an
 *   earlier payout.
 * - Derived per obligation: due, paid, remaining and UNPAID / PARTIAL / PAID (never stored).
 * - autoAllocateSellerPayoutFIFO(payoutId) writes rows for one DRAFT payout across settlement and adjustment
 *   obligations (oldest first) and never touches the payout status or existing allocation rows.
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
  // Terminal non-money statuses: no financial effect (rows still structurally validated); paid status reverts.
  noEffectStatuses: Object.freeze(['VOID', 'REVERSED', 'CANCELLED', 'FAILED']),
  settlementTarget: 'SETTLEMENT',
  adjustmentTarget: 'ADJUSTMENT',
  payoutableAdjustmentStatus: 'APPLIED',
  fifoNote: 'FIFO auto-allocation - review before marking the payout SENT / CONFIRMED',
  maxReportedErrors: 30,
});

/* ----------------------------- Pure helpers ----------------------------- */

function sellerAllocationId_(payoutId, targetType, targetId, digestHex) {
  const digest = digestHex || sha256Hex_;
  return SELLER_ALLOCATIONS.idPrefix + digest(String(payoutId) + '|' + String(targetType) + '|' + String(targetId));
}

function emptyAllocationErrors_() {
  return { obligation_errors: [], invalid_ids: [], invalid_targets: [], invalid_references: [], cross_seller_errors: [], currency_errors: [],
    payment_source_errors: [], invalid_amounts: [], duplicate_keys: [], overallocated_payouts: [], unallocated_effective_payouts: [],
    overpaid_obligations: [], invalid_payout_dates: [], target_date_errors: [], ambiguous_dates: [], insufficient_payable_balance: [] };
}

/** 'YYYY-MM-DD' of a valid date value, else null. */
function sellerDateKeyOrNull_(value, dateKeyOf) {
  if (!isDateValue_(value) || !isFinite(value.getTime())) return null;
  try { return dateKeyOf(value) || null; } catch (err) { return null; }
}

/**
 * Per seller|currency ledger timeline in micro units: credits (frozen Settlement Items by settlement payment date,
 * APPLIED adjustments of any sign by effective date) and effective payouts (by payout date).
 */
function buildSellerPayableTimeline_(items, settlementById, adjustments, payouts, dateKeyOf) {
  const lines = {};
  const line = function (seller, currency) {
    const k = seller + '|' + currency;
    return lines[k] = lines[k] || { seller_id: seller, currency: currency, credits: [], payouts: [], undated: [] };
  };
  items.forEach(function (i) {
    const s = settlementById[trimmedText_(i.settlement_id)];
    if (!s || !isFiniteNumber_(i.seller_available_amount)) return;
    const key = sellerDateKeyOrNull_(s.source_payment_date, dateKeyOf);
    if (key) line(trimmedText_(i.seller_id), trimmedText_(i.currency)).credits.push({ key: key, micros: Math.round(i.seller_available_amount * 1e6) });
  });
  (adjustments || []).forEach(function (a) {
    if (trimmedText_(a.status) !== SELLER_ALLOCATIONS.payoutableAdjustmentStatus || !isFiniteNumber_(a.amount)) return;
    const l = line(trimmedText_(a.seller_id), trimmedText_(a.currency));
    const key = sellerDateKeyOrNull_(a.effective_date, dateKeyOf);
    if (key) l.credits.push({ key: key, micros: Math.round(a.amount * 1e6) });
    else l.undated.push(trimmedText_(a.adjustment_id));
  });
  payouts.forEach(function (p) {
    if (SELLER_ALLOCATIONS.effectiveStatuses.indexOf(trimmedText_(p.status)) < 0 || !isFiniteNumber_(p.amount)) return;
    const key = sellerDateKeyOrNull_(p.payout_date, dateKeyOf);
    if (key) line(trimmedText_(p.seller_id), trimmedText_(p.currency)).payouts.push({ key: key, micros: Math.round(p.amount * 1e6), id: trimmedText_(p.seller_payout_id) });
  });
  return lines;
}

/** Payable balance (micro units) of one timeline line as of a date key (inclusive; same-day payouts together). */
function sellerPayableAsOf_(line, dateKey) {
  const credits = line.credits.reduce(function (a, c) { return a + (c.key <= dateKey ? c.micros : 0); }, 0);
  const paid = line.payouts.reduce(function (a, p) { return a + (p.key <= dateKey ? p.micros : 0); }, 0);
  return credits - paid;
}

/** Errors for every effective payout date at which the seller payable balance would be negative. */
function sellerPayableBalanceErrors_(line) {
  const errors = [];
  if (line.payouts.length === 0) return errors;
  if (line.undated.length > 0) {
    errors.push(line.seller_id + '|' + line.currency + ': APPLIED adjustment(s) without a valid effective_date (' + line.undated.join(', ') +
      ') make the payable balance ambiguous');
    return errors;
  }
  const dates = {};
  line.payouts.forEach(function (p) { dates[p.key] = true; });
  Object.keys(dates).sort().forEach(function (d) {
    const balance = sellerPayableAsOf_(line, d);
    if (balance < -SELLER_ALLOCATIONS.toleranceMicros) {
      const ids = line.payouts.filter(function (p) { return p.key === d; }).map(function (p) { return p.id; });
      errors.push(line.seller_id + '|' + line.currency + ' ' + d + ': payout(s) ' + ids.join(', ') + ' exceed the payable balance as of that date by ' + (-balance) / 1e6);
    }
  });
  return errors;
}

function flattenAllocationErrors_(errors) {
  return Object.keys(errors).reduce(function (acc, k) { return acc.concat(errors[k]); }, []);
}

function sellerObligationKey_(targetType, sellerId, targetId, currency) {
  return targetType === SELLER_ALLOCATIONS.settlementTarget ? targetType + '|' + sellerId + '|' + targetId + '|' + currency : targetType + '|' + targetId;
}

/**
 * All payout obligations: seller settlement shares (frozen Settlement Items) and positive APPLIED adjustments.
 * Amounts in micro units.
 * @return {{obligations: Object<string, Object>, adjustmentsById: Object, errors: Array<string>}}
 */
function buildSellerPayoutObligations_(items, settlements, adjustments) {
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
    const key = sellerObligationKey_(SELLER_ALLOCATIONS.settlementTarget, sellerId, settlementId, currency);
    const o = obligations[key] = obligations[key] || { key: key, target_type: SELLER_ALLOCATIONS.settlementTarget, target_id: settlementId,
      seller_id: sellerId, payment_source: source, currency: currency, due: 0, hold: 0, item_count: 0, date: s.source_payment_date, settlement: s };
    if (o.payment_source !== source) { errors.push(label + ': mixed payment_source inside obligation ' + key); return; }
    o.due += Math.round(i.seller_available_amount * 1e6);
    o.hold += Math.round(i.seller_hold_amount * 1e6);
    o.item_count++;
  });
  const adjustmentsById = {};
  (adjustments || []).forEach(function (a) {
    const id = trimmedText_(a.adjustment_id);
    if (id === '') return;
    if (adjustmentsById[id]) errors.push('Adjustment ' + id + ' appears more than once');
    adjustmentsById[id] = a;
    if (trimmedText_(a.status) !== SELLER_ALLOCATIONS.payoutableAdjustmentStatus || !isFiniteNumber_(a.amount) || !(Math.round(a.amount * 1e6) > 0)) return;
    const sellerId = trimmedText_(a.seller_id);
    const currency = trimmedText_(a.currency);
    if (sellerId === '' || currency === '') { errors.push('Adjustment ' + id + ': positive APPLIED credit without seller_id / currency'); return; }
    const key = sellerObligationKey_(SELLER_ALLOCATIONS.adjustmentTarget, sellerId, id, currency);
    obligations[key] = { key: key, target_type: SELLER_ALLOCATIONS.adjustmentTarget, target_id: id, seller_id: sellerId,
      payment_source: trimmedText_(a.payment_source), currency: currency, due: Math.round(a.amount * 1e6), hold: 0, item_count: 0,
      date: a.effective_date, adjustment: a };
  });
  return { obligations: obligations, adjustmentsById: adjustmentsById, errors: errors };
}

function sellerSettlementStatus_(dueMicros, paidMicros) {
  const tol = SELLER_ALLOCATIONS.toleranceMicros;
  if (Math.abs(dueMicros - paidMicros) <= tol) return 'PAID';
  if (paidMicros <= tol) return 'UNPAID';
  return 'PARTIAL';
}

/** Deterministic FIFO / display order: obligation date, target type (SETTLEMENT first), settlement period / number, target_id. */
function compareSellerObligations_(a, b) {
  const settlementPart = function (x) { return x.settlement || {}; };
  return compareCanonicalValues_(a.date, b.date) ||
    (a.target_type === b.target_type ? 0 : a.target_type === SELLER_ALLOCATIONS.settlementTarget ? -1 : 1) ||
    compareCanonicalValues_(settlementPart(a).period_end_date, settlementPart(b).period_end_date) ||
    compareCanonicalValues_(settlementPart(a).source_settlement_number, settlementPart(b).source_settlement_number) ||
    compareCanonicalValues_(a.target_id, b.target_id);
}

/**
 * Validates every allocation (structure first, for every row - VOID included) and derives each obligation's state.
 * @param {{allocations: Array<Object>, payouts: Array<Object>, items: Array<Object>, settlements: Array<Object>,
 *          adjustments: Array<Object>, dateKeyOf?: function(*): string, digestHex?: Function}} input
 * @return {{errors: Object, obligations: Object, states: Array<Object>, summary: Object, payoutAllocated: Object}}
 */
function validateSellerPayoutAllocations_(input) {
  const A = SELLER_ALLOCATIONS;
  const errors = emptyAllocationErrors_();
  const tol = A.toleranceMicros;
  const ob = buildSellerPayoutObligations_(input.items, input.settlements, input.adjustments);
  ob.errors.forEach(function (e) { errors.obligation_errors.push(e); });
  const obligations = ob.obligations;
  const dateKeyOf = input.dateKeyOf || masterDateKey_;
  const settlementIds = {};
  const settlementById = {};
  input.settlements.forEach(function (s) { settlementIds[String(s.settlement_id)] = true; settlementById[String(s.settlement_id)] = s; });
  const sharesInSettlement = {};
  Object.keys(obligations).forEach(function (k) {
    const o = obligations[k];
    if (o.target_type === A.settlementTarget) (sharesInSettlement[o.target_id] = sharesInSettlement[o.target_id] || {})[o.seller_id + '|' + o.currency] = true;
  });
  const payoutsById = {};
  input.payouts.forEach(function (p) {
    const id = trimmedText_(p.seller_payout_id);
    if (id === '') return;
    if (payoutsById[id]) errors.invalid_references.push('Seller Payout ' + id + ' appears more than once');
    payoutsById[id] = p;
    if (A.effectiveStatuses.indexOf(trimmedText_(p.status)) >= 0 && !sellerDateKeyOrNull_(p.payout_date, dateKeyOf)) {
      errors.invalid_payout_dates.push('Seller Payout ' + id + ' (' + p.status + '): payout_date must be a valid date');
    }
  });

  const seenKeys = {};
  const payoutAllocated = {};
  const paid = {};
  const summary = { allocation_rows: input.allocations.length, draft_allocation_rows: 0, effective_allocation_rows: 0, void_allocation_rows: 0,
    settlement_allocation_rows: 0, adjustment_allocation_rows: 0 };
  input.allocations.forEach(function (a, i) {
    const label = 'Allocation row ' + (a._row || i + 2);
    const payoutId = trimmedText_(a.seller_payout_id);
    const targetType = trimmedText_(a.target_type);
    const targetId = trimmedText_(a.target_id);
    const sellerId = trimmedText_(a.seller_id);
    const currency = trimmedText_(a.currency);
    const source = trimmedText_(a.payment_source);
    const payout = payoutsById[payoutId];
    const status = payout ? trimmedText_(payout.status) : '';
    let ok = true;
    const bad = function (bucket, msg) { errors[bucket].push(label + ': ' + msg); ok = false; };
    // ---- structural validation (every row, VOID included)
    const key = payoutId + '|' + targetType + '|' + targetId;
    if (seenKeys[key]) bad('duplicate_keys', 'duplicate seller_payout_id + target_type + target_id ' + key);
    seenKeys[key] = true;
    if (trimmedText_(a.allocation_id) !== sellerAllocationId_(payoutId, targetType, targetId, input.digestHex)) {
      bad('invalid_ids', 'allocation_id must be ' + A.idPrefix + 'sha256(seller_payout_id|target_type|target_id)');
    }
    if (!payout) bad('invalid_references', 'unknown seller_payout_id ' + (payoutId || '(blank)'));
    if (payout && sellerId !== trimmedText_(payout.seller_id)) bad('cross_seller_errors', 'seller_id ' + sellerId + ' is not the payout seller ' + payout.seller_id);
    if (payout && currency !== trimmedText_(payout.currency)) bad('currency_errors', 'currency ' + currency + ' differs from the payout currency ' + payout.currency);
    if (!isFiniteNumber_(a.allocated_amount) || !(Math.round(a.allocated_amount * 1e6) > 0)) bad('invalid_amounts', 'allocated_amount must be a positive number');
    let o = null;
    if (targetType === A.settlementTarget) {
      o = obligations[sellerObligationKey_(targetType, sellerId, targetId, currency)] || null;
      if (!settlementIds[targetId]) bad('invalid_references', 'unknown settlement_id ' + (targetId || '(blank)'));
      else if (!o) {
        const shares = Object.keys(sharesInSettlement[targetId] || {});
        if (shares.some(function (s) { return s.indexOf(sellerId + '|') === 0; })) bad('currency_errors', 'seller ' + sellerId + ' has no ' + currency + ' obligation in ' + targetId);
        else if (shares.length > 0) bad('cross_seller_errors', 'settlement ' + targetId + ' has no share of seller ' + sellerId + ' (another seller\'s settlement share)');
        else bad('invalid_references', 'settlement ' + targetId + ' has no seller obligation (no frozen Settlement Items)');
      }
      if (o && source !== o.payment_source) bad('payment_source_errors', 'payment_source ' + (source || '(blank)') + ' differs from the settlement (' + o.payment_source + ')');
    } else if (targetType === A.adjustmentTarget) {
      const adj = ob.adjustmentsById[targetId];
      o = obligations[sellerObligationKey_(targetType, sellerId, targetId, currency)] || null;
      if (!adj) bad('invalid_references', 'unknown adjustment_id ' + (targetId || '(blank)'));
      else if (!o) bad('invalid_targets', 'adjustment ' + targetId + ' is not a payout obligation (needs status APPLIED and a positive amount; found ' +
        adj.status + ' / ' + adj.amount + ')');
      if (adj && o) {
        if (sellerId !== trimmedText_(adj.seller_id)) bad('cross_seller_errors', 'adjustment ' + targetId + ' belongs to seller ' + adj.seller_id);
        if (currency !== trimmedText_(adj.currency)) bad('currency_errors', 'currency ' + currency + ' differs from the adjustment currency ' + adj.currency);
        // Provider-linked credit: same source; manual credit (blank source): allocation source stays blank (never invented).
        if (source !== o.payment_source) bad('payment_source_errors', 'payment_source ' + (source || '(blank)') + ' must equal the adjustment payment_source (' +
          (o.payment_source || 'blank') + ')');
      }
    } else {
      bad('invalid_targets', 'target_type must be ' + A.settlementTarget + ' or ' + A.adjustmentTarget + ' (found "' + a.target_type + '")');
    }
    // A target must be available on or before the payout date (no payment of a future obligation).
    if (o && A.noEffectStatuses.indexOf(status) < 0) {
      const targetKey = sellerDateKeyOrNull_(o.date, dateKeyOf);
      const payoutKey = payout ? sellerDateKeyOrNull_(payout.payout_date, dateKeyOf) : null;
      if (!targetKey) bad('target_date_errors', targetType + ' ' + targetId + ' has no valid availability date');
      else if (payoutKey && targetKey > payoutKey) bad('target_date_errors', targetType + ' ' + targetId + ' is available on ' + targetKey + ', after the payout date ' + payoutKey);
    }
    if (targetType === A.settlementTarget) summary.settlement_allocation_rows++;
    if (targetType === A.adjustmentTarget) summary.adjustment_allocation_rows++;
    // ---- financial effect (VOID: none)
    if (A.noEffectStatuses.indexOf(status) >= 0) { summary.void_allocation_rows++; return; }
    if (!ok || !o) return;
    const micros = Math.round(a.allocated_amount * 1e6);
    payoutAllocated[payoutId] = (payoutAllocated[payoutId] || 0) + micros;
    if (A.effectiveStatuses.indexOf(status) >= 0) {
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
    if (A.noEffectStatuses.indexOf(status) >= 0) return;
    const amount = isFiniteNumber_(p.amount) ? Math.round(p.amount * 1e6) : null;
    const allocated = payoutAllocated[id] || 0;
    const effective = A.effectiveStatuses.indexOf(status) >= 0;
    if (amount === null) { if (effective || allocated > 0) errors.invalid_amounts.push('Seller Payout ' + id + ': amount is not numeric'); return; }
    if (allocated > amount + tol) errors.overallocated_payouts.push('Seller Payout ' + id + ': allocated ' + allocated / 1e6 + ' > payout amount ' + amount / 1e6);
    if (!effective) return;
    effectiveCount++;
    if (allocated < amount - tol) errors.unallocated_effective_payouts.push('Seller Payout ' + id + ' (' + status + '): allocated ' + allocated / 1e6 + ' of ' + amount / 1e6);
    else if (allocated <= amount + tol) fullyAllocated++;
  });

  // Temporal payable-balance guard (chronological; later debits never invalidate an earlier payout).
  const timeline = buildSellerPayableTimeline_(input.items, settlementById, input.adjustments, input.payouts, dateKeyOf);
  Object.keys(timeline).sort().forEach(function (k) {
    sellerPayableBalanceErrors_(timeline[k]).forEach(function (e) {
      (e.indexOf('ambiguous') >= 0 ? errors.ambiguous_dates : errors.insufficient_payable_balance).push(e);
    });
  });

  const states = Object.keys(obligations).map(function (k) { return obligations[k]; }).sort(function (a, b) {
    return compareCanonicalValues_(a.seller_id, b.seller_id) || compareSellerObligations_(a, b) || compareCanonicalValues_(a.currency, b.currency);
  }).map(function (o) {
    const p = paid[o.key] || 0;
    if (p > o.due + tol) errors.overpaid_obligations.push(o.key + ': paid ' + p / 1e6 + ' > due ' + o.due / 1e6);
    const s = o.settlement || {};
    const adj = o.adjustment || {};
    return { target_type: o.target_type, target_id: o.target_id, seller_id: o.seller_id, payment_source: o.payment_source, currency: o.currency,
      due_amount: o.due / 1e6, paid_amount: p / 1e6, remaining_amount: (o.due - p) / 1e6, payment_status: sellerSettlementStatus_(o.due, p),
      settlement_id: o.target_type === A.settlementTarget ? o.target_id : '', source_settlement_number: s.source_settlement_number,
      period_start_date: s.period_start_date, period_end_date: s.period_end_date, source_payment_date: s.source_payment_date,
      adjustment_id: o.target_type === A.adjustmentTarget ? o.target_id : '', adjustment_type: trimmedText_(adj.adjustment_type),
      effective_date: adj.effective_date, hold_amount: o.hold / 1e6, settlement: o.settlement || null, adjustment: o.adjustment || null };
  });

  const sumBy = function (filter, f) {
    return states.filter(filter).reduce(function (acc, s) { acc[s.seller_id] = Math.round(((acc[s.seller_id] || 0) + s[f]) * 1e6) / 1e6; return acc; }, {});
  };
  const total = function (filter, f) { return Math.round(states.filter(filter).reduce(function (a, s) { return a + Math.round(s[f] * 1e6); }, 0)) / 1e6; };
  const isS = function (s) { return s.target_type === A.settlementTarget; };
  const isA = function (s) { return s.target_type === A.adjustmentTarget; };
  const all = function () { return true; };
  summary.effective_payout_count = effectiveCount;
  summary.fully_allocated_effective_payouts = fullyAllocated;
  summary.settlement_due = total(isS, 'due_amount');
  summary.settlement_paid = total(isS, 'paid_amount');
  summary.settlement_remaining = total(isS, 'remaining_amount');
  summary.adjustment_due = total(isA, 'due_amount');
  summary.adjustment_paid = total(isA, 'paid_amount');
  summary.adjustment_remaining = total(isA, 'remaining_amount');
  summary.total_payoutable_due = total(all, 'due_amount');
  summary.total_paid = total(all, 'paid_amount');
  summary.total_remaining = total(all, 'remaining_amount');
  summary.per_seller_settlement_due = sumBy(isS, 'due_amount');
  summary.per_seller_settlement_paid = sumBy(isS, 'paid_amount');
  summary.per_seller_settlement_remaining = sumBy(isS, 'remaining_amount');
  summary.per_seller_adjustment_due = sumBy(isA, 'due_amount');
  summary.per_seller_adjustment_paid = sumBy(isA, 'paid_amount');
  summary.per_seller_adjustment_remaining = sumBy(isA, 'remaining_amount');
  summary.per_seller_due = sumBy(all, 'due_amount');
  summary.per_seller_paid = sumBy(all, 'paid_amount');
  summary.per_seller_remaining = sumBy(all, 'remaining_amount');
  summary.payment_status_counts = states.reduce(function (acc, s) { acc[s.payment_status] = (acc[s.payment_status] || 0) + 1; return acc; }, {});
  summary.payment_status_counts_by_target = states.reduce(function (acc, s) {
    const t = acc[s.target_type] = acc[s.target_type] || {};
    t[s.payment_status] = (t[s.payment_status] || 0) + 1;
    return acc;
  }, {});
  return { errors: errors, obligations: obligations, states: states, summary: summary, payoutAllocated: payoutAllocated, timeline: timeline,
    dateKeyOf: dateKeyOf };
}

/**
 * FIFO allocation rows for one DRAFT payout across all open obligations (settlements and positive APPLIED adjustments)
 * of the same seller + currency, oldest first. Open = due - every non-VOID allocation (effective payments and other
 * DRAFT payouts' provisional claims). Never touches existing rows.
 * @return {{status: string, rows: Array<Object>, error: ?string}}
 */
function planFifoAllocation_(payout, allocations, validation, payoutsById, now, digestHex) {
  const A = SELLER_ALLOCATIONS;
  const id = trimmedText_(payout.seller_payout_id);
  if (allocations.some(function (a) { return trimmedText_(a.seller_payout_id) === id; })) {
    return { status: 'NO_CHANGE', rows: [], error: 'Seller Payout ' + id + ' already has allocation rows; operator review required (nothing changed).' };
  }
  const tol = A.toleranceMicros;
  const sellerId = trimmedText_(payout.seller_id);
  const currency = trimmedText_(payout.currency);
  const dateKeyOf = validation.dateKeyOf || masterDateKey_;
  const payoutKey = sellerDateKeyOrNull_(payout.payout_date, dateKeyOf);
  if (!payoutKey) return { status: 'FAILED', rows: [], error: 'Seller Payout ' + id + ' needs a valid payout_date for FIFO; nothing allocated.' };
  // Payable balance guard: this payout treated as effective on its date must keep every payout date >= 0.
  const line = validation.timeline[sellerId + '|' + currency] || { seller_id: sellerId, currency: currency, credits: [], payouts: [], undated: [] };
  const simulated = { seller_id: sellerId, currency: currency, credits: line.credits, undated: line.undated,
    payouts: line.payouts.concat([{ key: payoutKey, micros: Math.round(payout.amount * 1e6), id: id }]) };
  const balanceErrors = sellerPayableBalanceErrors_(simulated);
  if (balanceErrors.length > 0) {
    return { status: 'FAILED', rows: [], error: 'Seller Payout ' + id + ' exceeds the seller payable balance (payable as of ' + payoutKey + ': ' +
      sellerPayableAsOf_(line, payoutKey) / 1e6 + '); nothing allocated: ' + balanceErrors.join(' | ') };
  }
  const claimed = {};
  allocations.forEach(function (a) {
    const parent = payoutsById[trimmedText_(a.seller_payout_id)];
    if (!parent || A.noEffectStatuses.indexOf(trimmedText_(parent.status)) >= 0 || !isFiniteNumber_(a.allocated_amount)) return;
    const key = sellerObligationKey_(trimmedText_(a.target_type), trimmedText_(a.seller_id), trimmedText_(a.target_id), trimmedText_(a.currency));
    claimed[key] = (claimed[key] || 0) + Math.round(a.allocated_amount * 1e6);
  });
  const open = Object.keys(validation.obligations).map(function (k) { return validation.obligations[k]; })
    .filter(function (o) { return o.seller_id === sellerId && o.currency === currency && o.due - (claimed[o.key] || 0) > tol; })
    .filter(function (o) { const k = sellerDateKeyOrNull_(o.date, dateKeyOf); return !k || k <= payoutKey; }) // never a future obligation
    .sort(compareSellerObligations_);
  const undated = open.filter(function (o) { return !sellerDateKeyOrNull_(o.date, dateKeyOf); });
  if (undated.length > 0) {
    return { status: 'FAILED', rows: [], error: 'FIFO order is ambiguous: open obligation(s) without a date (' +
      undated.map(function (o) { return o.target_type + ' ' + o.target_id; }).join(', ') + '); set the date or allocate manually. Nothing allocated.' };
  }
  let left = Math.round(payout.amount * 1e6);
  const rows = [];
  open.forEach(function (o) {
    if (left <= 0) return;
    const remaining = o.due - (claimed[o.key] || 0);
    if (remaining <= tol) return;
    const take = Math.min(left, remaining);
    rows.push({ allocation_id: sellerAllocationId_(id, o.target_type, o.target_id, digestHex), seller_payout_id: id, seller_id: sellerId,
      target_type: o.target_type, target_id: o.target_id, payment_source: o.payment_source, currency: currency, allocated_amount: take / 1e6,
      created_at: now, notes: A.fifoNote });
    left -= take;
  });
  if (left > tol) {
    return { status: 'FAILED', rows: [], error: 'Seller Payout ' + id + ' exceeds the open ' + currency + ' payout obligations of ' + sellerId + ' available by ' +
      payoutKey + ' by ' + left / 1e6 + '; nothing allocated (allocate manually or adjust the payout).' };
  }
  return { status: 'SUCCESS', rows: rows, error: null };
}

/* ---------------------------------- I/O --------------------------------- */

function readSellerAllocationInputs_(ss) {
  const allocations = readPlainTableObjects_(ss, SHEETS.SELLER_PAYOUT_ALLOCATIONS).map(function (a, i) { a._row = i + 2; return a; });
  const payouts = readPlainTableObjects_(ss, SHEETS.SELLER_PAYOUTS);
  const adjustments = readPlainTableObjects_(ss, SHEETS.ADJUSTMENTS);
  const items = readSchemaTableObjects_(ss, SHEETS.SETTLEMENT_ITEMS, settlementItemsTab_()).rows;
  const settlements = readSchemaTableObjects_(ss, SHEETS.SETTLEMENTS, settlementsTab_()).rows;
  return { allocations: allocations, payouts: payouts, adjustments: adjustments, items: items, settlements: settlements,
    validation: validateSellerPayoutAllocations_({ allocations: allocations, payouts: payouts, items: items, settlements: settlements, adjustments: adjustments }) };
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
    if (plan.status === 'NO_CHANGE') {
      details.warnings.push(plan.error);
      status = 'NO_CHANGE';
    } else {
      if (plan.status !== 'SUCCESS') throw new Error(plan.error);
      const check = validateSellerPayoutAllocations_({ allocations: input.allocations.concat(plan.rows), payouts: input.payouts, items: input.items,
        settlements: input.settlements, adjustments: input.adjustments });
      const planErrors = flattenAllocationErrors_(check.errors);
      if (planErrors.length > 0) throw new Error('FIFO plan would be invalid; nothing written: ' + planErrors.slice(0, 10).join(' | '));
      const sheet = ss.getSheetByName(SHEETS.SELLER_PAYOUT_ALLOCATIONS);
      const columns = getColumnNames_(SHEETS.SELLER_PAYOUT_ALLOCATIONS);
      const start = sheet.getLastRow() + 1;
      if (sheet.getMaxRows() < start + plan.rows.length - 1) sheet.insertRowsAfter(sheet.getMaxRows(), start + plan.rows.length - 1 - sheet.getMaxRows());
      sheet.getRange(start, 1, plan.rows.length, columns.length).setValues(plan.rows.map(function (r) { return objectToRow_(r, columns); }));
      details.rows = plan.rows.map(function (r) {
        return { target_type: r.target_type, target_id: r.target_id, payment_source: r.payment_source, allocated_amount: r.allocated_amount };
      });
      details.obligations = check.states.filter(function (s) { return s.seller_id === trimmedText_(payout.seller_id); }).map(function (s) {
        return { target_type: s.target_type, target_id: s.target_id, due_amount: s.due_amount, effective_paid: s.paid_amount };
      });
      details.warnings.push('Review the allocation, then set the payout to SENT / CONFIRMED and run normalizeSellerBalances.');
      status = 'SUCCESS';
    }
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

/** Read-only report of Seller Payout Allocations and the derived obligation payment states. */
function buildSellerPayoutAllocationsReport_() {
  const report = { allocation_rows: 0, draft_allocation_rows: 0, effective_allocation_rows: 0, void_allocation_rows: 0, settlement_allocation_rows: 0,
    adjustment_allocation_rows: 0, effective_payout_count: 0, fully_allocated_effective_payouts: 0, unallocated_effective_payouts: [],
    overallocated_payouts: [], overpaid_obligations: [], invalid_references: [], invalid_targets: [], cross_seller_errors: [], currency_errors: [],
    payment_source_errors: [], duplicate_keys: [], invalid_ids: [], invalid_amounts: [], obligation_errors: [], invalid_payout_dates: [],
    target_date_errors: [], ambiguous_dates: [], insufficient_payable_balance: [], settlement_due: 0, settlement_paid: 0,
    settlement_remaining: 0, adjustment_due: 0, adjustment_paid: 0, adjustment_remaining: 0, total_payoutable_due: 0, total_paid: 0,
    total_remaining: 0, per_seller_due: {}, per_seller_paid: {}, per_seller_remaining: {}, payment_status_counts: {},
    payment_status_counts_by_target: {}, obligation_states: [], pass: false, errors: [], warnings: [], regression: null };
  try {
    const input = readSellerAllocationInputs_(getSpreadsheet_());
    const v = input.validation;
    Object.keys(v.errors).forEach(function (k) { report[k] = v.errors[k]; });
    Object.keys(v.summary).forEach(function (k) { report[k] = v.summary[k]; });
    report.obligation_states = v.states.map(function (s) {
      return { target_type: s.target_type, target_id: s.target_id, seller_id: s.seller_id, payment_source: s.payment_source,
        source_settlement_number: s.source_settlement_number, adjustment_type: s.adjustment_type, currency: s.currency, due_amount: s.due_amount,
        paid_amount: s.paid_amount, remaining_amount: s.remaining_amount, payment_status: s.payment_status };
    });
    const errors = flattenAllocationErrors_(v.errors);
    if (errors.length > 0) report.errors.push('Seller Payout Allocations has ' + errors.length + ' error(s); Seller Balances will fail closed.');
    report.regression = evaluateSellerAllocationsInvariants_(v, input.payouts);
    if (!report.regression.pass) report.errors.push('Seller Payout Allocations invariants failed: ' + report.regression.failed.join(', '));
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0;
  return redactDeep_(report);
}

/**
 * Runtime invariants of the payout ledger (report.regression). State-independent - they hold with or without payouts:
 *   every obligation due = paid + remaining; paid <= due; status = UNPAID / PARTIAL / PAID of (due, paid);
 *   every effective (SENT / CONFIRMED) payout allocated exactly its amount; no payout over-allocated;
 *   summary totals = SUM(obligation states). All ± 0.00005.
 */
function evaluateSellerAllocationsInvariants_(validation, payouts) {
  const A = SELLER_ALLOCATIONS;
  const tol = A.toleranceMicros;
  const m = function (v) { return isFiniteNumber_(v) ? Math.round(v * 1e6) : NaN; };
  const checks = [];
  const add = function (n, problems) { checks.push({ name: n, pass: problems.length === 0, detail: problems.slice(0, 10).join(' | ') || 'ok' }); };
  const label = function (s) { return s.target_type + ' ' + s.target_id + ' (' + s.seller_id + ')'; };
  const states = validation.states;
  add('due = paid + remaining', states.filter(function (s) { return !(Math.abs(m(s.due_amount) - m(s.paid_amount) - m(s.remaining_amount)) <= tol); }).map(label));
  add('paid <= due', states.filter(function (s) { return !(m(s.paid_amount) <= m(s.due_amount) + tol); }).map(label));
  add('status matches paid / remaining', states.filter(function (s) {
    return s.payment_status !== sellerSettlementStatus_(m(s.due_amount), m(s.paid_amount));
  }).map(label));
  const effective = [];
  const over = [];
  (payouts || []).forEach(function (p) {
    const id = trimmedText_(p.seller_payout_id);
    const status = trimmedText_(p.status);
    if (id === '' || A.noEffectStatuses.indexOf(status) >= 0 || !isFiniteNumber_(p.amount)) return;
    const allocated = validation.payoutAllocated[id] || 0;
    if (A.effectiveStatuses.indexOf(status) >= 0 && Math.abs(allocated - m(p.amount)) > tol) effective.push(id + ' allocated ' + allocated / 1e6 + ' of ' + p.amount);
    if (allocated > m(p.amount) + tol) over.push(id + ' allocated ' + allocated / 1e6 + ' > ' + p.amount);
  });
  add('effective payout allocation = payout amount', effective);
  add('no payout over-allocated', over);
  const sum = function (f) { return states.reduce(function (a, s) { return a + m(s[f]); }, 0); };
  const sm = validation.summary;
  add('summary totals = SUM(obligations)', [['total_payoutable_due', 'due_amount'], ['total_paid', 'paid_amount'], ['total_remaining', 'remaining_amount']]
    .filter(function (t) { return !(Math.abs(m(sm[t[0]]) - sum(t[1])) <= tol); }).map(function (t) { return t[0]; }));
  return { snapshot: 'invariants', pass: checks.every(function (c) { return c.pass; }),
    failed: checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }), checks: checks };
}
