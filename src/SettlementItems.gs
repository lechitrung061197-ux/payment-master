/**
 * SettlementItems.gs
 * Settlement Items: immutable frozen accounting snapshot of every AVAILABLE Payment Leg
 * (provider-paid settlement). Written only by normalizeSettlementItems().
 *
 * - One item per AVAILABLE leg; settlement_item_id = SI-<sha256(settlement_id|payment_leg_id)>.
 * - seller_id comes from the exact internal Transaction (payment_source + internal_transaction_id),
 *   which must be MAPPED.
 * - Existing items are carried forward unchanged (content and snapshot_at); only new AVAILABLE legs
 *   add items, and only they receive snapshot_at (once). An existing item whose snapshot_at is blank or
 *   not a valid datetime is a hard error and is never repaired automatically. A frozen item that would change or disappear fails (no silent rewrite, e.g. after a
 *   retroactive Seller Terms edit).
 * - Invariants per item: seller_hold_amount = provider_hold_amount; seller_available_amount =
 *   net - seller_fee - seller_hold_amount. Aggregate: provider transaction payout = seller available +
 *   system margin (holds because KH001 seller hold mirrors provider hold).
 * - Upstream gates: Transactions, Provider Transactions KH001, Payment Matches, Settlements KH001,
 *   Seller Terms valid and Payment Legs current.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const SETTLEMENT_ITEMS = Object.freeze({
  idPrefix: 'SI-',
  copiedFields: ['settlement_id', 'payment_leg_id', 'internal_transaction_id', 'payment_source', 'external_transaction_id', 'currency',
    'gross_amount', 'processing_fee', 'net_amount', 'provider_fee_rate', 'provider_fee', 'provider_hold_rate', 'provider_hold_amount',
    'seller_fee_rate', 'seller_fee', 'seller_hold_rate', 'seller_hold_amount', 'seller_available_amount'],
  maxReportedErrors: 30,
});

/** Current production regression (after Phase 2J). Report only. */
const SETTLEMENT_ITEMS_REGRESSION = Object.freeze({
  snapshot: 'Production after Phase 2J (168 AVAILABLE KH001 legs)',
  settlement_item_rows: 168,
  settlement_counts: { 'ST-KH001-PAYPAL-000001': 94, 'ST-KH001-PAYPAL-000002': 74 },
  seller_counts: { CUS001: 43, CUS002: 74, CUS003: 4, CUS004: 47 },
  provider_transaction_payout_total: 8472.1254,
  seller_available_total: 8370.0516,
  system_margin_total: 102.0738,
  seller_hold_total: 1020.738,
  provider_hold_total: 1020.738,
  seller_fee_total: 816.5904,
  provider_fee_total: 714.5166,
});

/* ----------------------------- Pure helpers ----------------------------- */

function settlementItemId_(settlementId, paymentLegId, digestHex) {
  const digest = digestHex || sha256Hex_;
  return SETTLEMENT_ITEMS.idPrefix + digest(String(settlementId) + '|' + String(paymentLegId));
}

function emptyItemErrors_() {
  return { duplicate_item_ids: [], duplicate_payment_leg_ids: [], missing_transactions: [], seller_identity_errors: [],
    snapshot_mismatches: [], invalid_snapshot_at: [], disappearing_items: [], equation_errors: [] };
}

function flattenItemErrors_(errors) {
  return Object.keys(errors).reduce(function (acc, k) { return acc.concat(errors[k]); }, []);
}

/** A frozen item's snapshot_at must be a real, valid datetime (Sheets returns Date for datetime cells). */
function isValidSnapshotAt_(value) {
  return isDateValue_(value) && isFinite(value.getTime());
}

/** Item content key (everything except snapshot_at). */
function settlementItemContentKey_(item, columns) {
  return serializeRow_(columns.map(function (c) { return c === 'snapshot_at' ? '' : item[c]; }));
}

/**
 * Builds the complete Settlement Items table: existing items carried forward, new AVAILABLE legs added.
 * @param {{legs: Array<Object>, transactions: Array<Object>, existingItems: Array<Object>, now: *,
 *          columns: Array<string>, digestHex?: Function}} input  legs = stored Payment Legs rows
 * @return {{items: Array<Object>, newItems: number, eligible: number, errors: Object}}
 */
function buildSettlementItems_(input) {
  const errors = emptyItemErrors_();
  const columns = input.columns;
  const txByKey = {};
  input.transactions.forEach(function (t) { txByKey[String(t.payment_source) + '|' + String(t.internal_transaction_id)] = t; });

  const legCounts = {};
  input.legs.forEach(function (l) { legCounts[String(l.payment_leg_id)] = (legCounts[String(l.payment_leg_id)] || 0) + 1; });
  Object.keys(legCounts).filter(function (k) { return legCounts[k] > 1; }).forEach(function (k) {
    errors.duplicate_payment_leg_ids.push('Payment Legs has payment_leg_id ' + k + ' ' + legCounts[k] + ' times');
  });

  const candidates = {};
  const available = input.legs.filter(function (l) { return l.settlement_status === 'AVAILABLE'; });
  available.forEach(function (l) {
    const label = 'Payment Leg ' + l.payment_leg_id;
    const tx = txByKey[String(l.payment_source) + '|' + String(l.internal_transaction_id)];
    if (!tx) { errors.missing_transactions.push(label + ': internal Transaction ' + l.internal_transaction_id + ' not found'); return; }
    if (tx.ownership_status !== 'MAPPED' || trimmedText_(tx.seller_id) === '') {
      errors.seller_identity_errors.push(label + ': internal Transaction ' + l.internal_transaction_id + ' is not assigned to a seller');
      return;
    }
    const item = { settlement_item_id: settlementItemId_(l.settlement_id, l.payment_leg_id, input.digestHex), seller_id: trimmedText_(tx.seller_id),
      snapshot_at: '' };
    SETTLEMENT_ITEMS.copiedFields.forEach(function (f) { item[f] = l[f]; });
    candidates[String(l.payment_leg_id)] = item;
  });

  const existingIds = {};
  const existingLegs = {};
  input.existingItems.forEach(function (e) {
    if (existingIds[String(e.settlement_item_id)]) errors.duplicate_item_ids.push('settlement_item_id ' + e.settlement_item_id);
    if (existingLegs[String(e.payment_leg_id)]) errors.duplicate_payment_leg_ids.push('Settlement Items has payment_leg_id ' + e.payment_leg_id + ' twice');
    existingIds[String(e.settlement_item_id)] = true;
    existingLegs[String(e.payment_leg_id)] = e;
  });

  const items = [];
  input.existingItems.forEach(function (e) {
    if (!isValidSnapshotAt_(e.snapshot_at)) {
      errors.invalid_snapshot_at.push('Frozen item ' + e.settlement_item_id + ': snapshot_at ' +
        (isBlankCell_(e.snapshot_at) ? 'is blank' : '"' + String(e.snapshot_at) + '" is not a valid datetime'));
    }
    const fresh = candidates[String(e.payment_leg_id)];
    if (!fresh) { errors.disappearing_items.push('Frozen item ' + e.settlement_item_id + ' (leg ' + e.payment_leg_id + ') is no longer AVAILABLE'); return; }
    if (settlementItemContentKey_(fresh, columns) !== settlementItemContentKey_(e, columns)) {
      const changed = columns.filter(function (c) { return c !== 'snapshot_at' && serializeCell_(fresh[c]) !== serializeCell_(e[c]); });
      errors.snapshot_mismatches.push('Frozen item ' + e.settlement_item_id + ' differs from its fresh leg in ' + changed.join(', '));
      return;
    }
    items.push(e); // carried forward exactly as stored
  });
  let added = 0;
  Object.keys(candidates).forEach(function (legId) {
    if (existingLegs[legId]) return;
    const item = candidates[legId];
    item.snapshot_at = input.now;
    items.push(item);
    added++;
  });

  items.forEach(function (i) {
    const label = 'Item ' + i.settlement_item_id;
    const nums = ['net_amount', 'provider_fee', 'provider_hold_amount', 'seller_fee', 'seller_hold_amount', 'seller_available_amount'];
    if (nums.some(function (f) { return !isFiniteNumber_(i[f]); })) { errors.equation_errors.push(label + ': missing numeric economics'); return; }
    if (microsDiff_(i.seller_hold_amount, i.provider_hold_amount) !== 0) errors.equation_errors.push(label + ': seller hold != provider hold');
    if (microsDiff_(i.seller_available_amount, i.net_amount - i.seller_fee - i.seller_hold_amount) !== 0) {
      errors.equation_errors.push(label + ': seller available != net - seller fee - seller hold');
    }
  });
  const totals = summarizeSettlementItems_(items);
  if (Math.abs(totals.provider_transaction_payout_total - totals.seller_available_total - totals.system_margin_total) >= 0.00005) {
    errors.equation_errors.push('Aggregate: provider transaction payout ' + totals.provider_transaction_payout_total + ' != seller available ' +
      totals.seller_available_total + ' + system margin ' + totals.system_margin_total);
  }
  items.sort(function (a, b) {
    return compareCanonicalValues_(String(a.settlement_id), String(b.settlement_id)) ||
      compareCanonicalValues_(String(a.external_transaction_id), String(b.external_transaction_id));
  });
  return { items: items, newItems: added, eligible: available.length, errors: errors };
}

/** Generic summary of items (micro-unit sums). */
function summarizeSettlementItems_(items) {
  const tally = function (field) {
    return items.reduce(function (acc, i) { const k = String(i[field]); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  };
  const sum = function (f) { return items.reduce(function (a, i) { return a + (isFiniteNumber_(i[f]) ? Math.round(i[f] * 1e6) : 0); }, 0) / 1e6; };
  const sumOf = function (fn) { return items.reduce(function (a, i) { return a + Math.round(fn(i) * 1e6); }, 0) / 1e6; };
  const num = function (v) { return isFiniteNumber_(v) ? v : 0; };
  return {
    settlement_item_rows: items.length,
    seller_counts: tally('seller_id'),
    settlement_counts: tally('settlement_id'),
    currency_counts: tally('currency'),
    gross_total: sum('gross_amount'),
    processing_fee_total: sum('processing_fee'),
    net_total: sum('net_amount'),
    provider_fee_total: sum('provider_fee'),
    provider_hold_total: sum('provider_hold_amount'),
    provider_transaction_payout_total: sumOf(function (i) { return num(i.net_amount) - num(i.provider_fee) - num(i.provider_hold_amount); }),
    seller_fee_total: sum('seller_fee'),
    seller_hold_total: sum('seller_hold_amount'),
    seller_available_total: sum('seller_available_amount'),
    system_margin_total: sumOf(function (i) { return num(i.seller_fee) - num(i.provider_fee); }),
  };
}

function evaluateSettlementItemsRegression_(summary) {
  const exp = SETTLEMENT_ITEMS_REGRESSION;
  const checks = [];
  const add = function (n, e, a, pass) { checks.push({ name: n, expected: e, actual: a, pass: pass }); };
  const same = function (e, a) {
    return Object.keys(e).every(function (k) { return (a[k] || 0) === e[k]; }) &&
      Object.keys(a).every(function (k) { return Object.prototype.hasOwnProperty.call(e, k); });
  };
  add('settlement_item_rows', exp.settlement_item_rows, summary.settlement_item_rows, summary.settlement_item_rows === exp.settlement_item_rows);
  ['settlement_counts', 'seller_counts'].forEach(function (k) { add(k, exp[k], summary[k], same(exp[k], summary[k])); });
  ['provider_transaction_payout_total', 'seller_available_total', 'system_margin_total', 'seller_hold_total', 'provider_hold_total',
    'seller_fee_total', 'provider_fee_total'].forEach(function (k) { add(k, exp[k], summary[k], Math.abs(summary[k] - exp[k]) < 0.00005); });
  return { snapshot: exp.snapshot, pass: checks.every(function (c) { return c.pass; }),
    failed: checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }), checks: checks };
}

/* ---------------------------------- I/O --------------------------------- */

function settlementItemsTab_() {
  return { targetSheet: SHEETS.SETTLEMENT_ITEMS, stagingSheet: '__STAGE_SETTLEMENT_ITEMS' };
}

/** Upstream chain for Settlement Items; each {current, reason}. Read-only, never throws. */
function readSettlementItemsUpstream_(ss) {
  const legsUpstream = readPaymentLegsUpstream_(ss);
  legsUpstream.payment_legs = readPaymentLegsFreshness_(ss);
  return legsUpstream;
}

function readSettlementItemsInputs_(ss, now) {
  const legs = readSchemaTableObjects_(ss, SHEETS.PAYMENT_LEGS, paymentLegsTab_());
  const transactions = readSchemaTableObjects_(ss, SHEETS.TRANSACTIONS, transactionsTab_());
  const existing = readSchemaTableObjects_(ss, SHEETS.SETTLEMENT_ITEMS, settlementItemsTab_());
  const columns = getColumnNames_(SHEETS.SETTLEMENT_ITEMS);
  return { existing: existing, columns: columns,
    built: buildSettlementItems_({ legs: legs.rows, transactions: transactions.rows, existingItems: existing.rows, now: now, columns: columns }) };
}

/**
 * Freshness of Settlement Items: upstream current, no errors, no pending new item, table equal.
 * @param {Object=} upstream an already computed readSettlementItemsUpstream_(ss) (avoids recomputing it)
 */
function readSettlementItemsFreshness_(ss, upstream) {
  try {
    upstream = upstream || readSettlementItemsUpstream_(ss);
    const stale = Object.keys(upstream).filter(function (k) { return !upstream[k].current; });
    if (stale.length > 0) return { current: false, reason: 'Settlement Items upstream is stale (' + stale.join(', ') + ').' };
    const input = readSettlementItemsInputs_(ss, null);
    const problems = flattenItemErrors_(input.built.errors).length;
    if (problems > 0) return { current: false, reason: 'Settlement Items is invalid (' + problems + ' error(s)); run normalizeSettlementItems.' };
    if (input.built.newItems > 0) return { current: false, reason: 'Settlement Items is stale; run normalizeSettlementItems first.' };
    const expected = computeRawChecksum_(buildTableValues_(input.columns, input.built.items.map(function (o) { return objectToRow_(o, input.columns); })));
    const current = expected === input.existing.grid.checksum;
    return { current: current, reason: current ? null : 'Settlement Items is stale; run normalizeSettlementItems first.' };
  } catch (err) {
    return { current: false, reason: 'Settlement Items is stale (' + (err && err.message ? err.message : String(err)) + ').' };
  }
}

function throwIfItemErrors_(label, list) {
  if (list.length === 0) return;
  const shown = list.slice(0, SETTLEMENT_ITEMS.maxReportedErrors);
  throw new Error(label + ' (' + list.length + ' error(s)): ' + shown.join(' | ') +
    (list.length > shown.length ? ' | ... ' + (list.length - shown.length) + ' more' : ''));
}

/** Adds frozen items for new AVAILABLE legs under the script lock. Never throws. */
function runSettlementItemsNormalizer_() {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  const details = {};
  let status = 'FAILED';
  let ss = null;
  const tab = settlementItemsTab_();
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms.');
    ss = getSpreadsheet_();
    const recovery = recoverSwapState_(ss, tab);
    details.initial_swap_state = recovery.state;
    details.recovery_actions = recovery.actions;

    const upstream = readSettlementItemsUpstream_(ss);
    Object.keys(upstream).forEach(function (k) { details[k === 'seller_terms' ? 'seller_terms_valid' : k + '_current'] = upstream[k].current; });
    ['transactions', 'provider_transactions', 'payment_matches', 'settlements', 'seller_terms', 'payment_legs'].forEach(function (k) {
      if (!upstream[k].current) throw new Error(upstream[k].reason);
    });

    const input = readSettlementItemsInputs_(ss, new Date(Math.floor(Date.now() / 1000) * 1000));
    throwIfItemErrors_('Settlement Items input is invalid', flattenItemErrors_(input.built.errors));
    const rows = input.built.items.map(function (o) { return objectToRow_(o, input.columns); });
    const summary = summarizeSettlementItems_(input.built.items);
    details.eligible_available_legs = input.built.eligible;
    details.new_items = input.built.newItems;
    ['settlement_item_rows', 'provider_transaction_payout_total', 'seller_available_total', 'system_margin_total', 'seller_hold_total']
      .forEach(function (k) { details[k] = summary[k]; });
    const expected = computeRawChecksum_(buildTableValues_(input.columns, rows));
    details.settlement_items_checksum = expected;
    if (expected === input.existing.grid.checksum) {
      status = 'NO_CHANGE';
    } else {
      writeCanonicalTable_(ss, getTableSchema_(SHEETS.SETTLEMENT_ITEMS), tab, rows);
      status = 'SUCCESS';
    }
  } catch (err) {
    details.error = redactEndpointCredentials_(err && err.message ? err.message : String(err));
    status = 'FAILED';
  } finally {
    try {
      if (ss) details.final_swap_state = detectSwapState_(ss, tab).state;
    } catch (stateErr) {
      details.final_swap_state = 'UNKNOWN';
    }
    try {
      appendAuditLog_({ action: 'SETTLEMENT_ITEMS_NORMALIZE_' + status, entityType: 'SETTLEMENT_ITEMS', entityId: '',
        newStatus: status, details: redactDeep_(details) });
    } catch (auditErr) {
      Logger.log('Failed to write audit entry: %s', auditErr);
    }
    if (locked) lock.releaseLock();
  }
  return redactDeep_(Object.assign({ status: status }, details));
}

/** Read-only verification of Settlement Items. */
function buildSettlementItemsReport_() {
  const report = { eligible_available_legs: 0, settlement_item_rows: 0, new_item_candidates: 0, seller_counts: {}, settlement_counts: {},
    currency_counts: {}, gross_total: 0, processing_fee_total: 0, net_total: 0, provider_fee_total: 0, provider_hold_total: 0,
    provider_transaction_payout_total: 0, seller_fee_total: 0, seller_hold_total: 0, seller_available_total: 0, system_margin_total: 0,
    duplicate_item_ids: [], duplicate_payment_leg_ids: [], missing_transactions: [], seller_identity_errors: [], snapshot_mismatches: [],
    invalid_snapshot_at: [], disappearing_items: [], equation_errors: [], upstream: {}, target_match: false, swap_state: null, pass: false, errors: [], warnings: [],
    regression: null };
  try {
    const ss = getSpreadsheet_();
    report.swap_state = detectSwapState_(ss, settlementItemsTab_()).state;
    if (report.swap_state !== 'NORMAL') report.errors.push('Settlement Items swap state is ' + report.swap_state);
    const upstream = readSettlementItemsUpstream_(ss);
    Object.keys(upstream).forEach(function (k) {
      report.upstream[k === 'seller_terms' ? 'seller_terms_valid' : k + '_current'] = upstream[k].current;
      if (!upstream[k].current) report.errors.push(upstream[k].reason);
    });
    const input = readSettlementItemsInputs_(ss, null);
    const e = input.built.errors;
    Object.keys(e).forEach(function (k) { report[k] = e[k]; });
    if (flattenItemErrors_(e).length > 0) report.errors.push('Settlement Items has ' + flattenItemErrors_(e).length + ' error(s).');
    report.eligible_available_legs = input.built.eligible;
    report.new_item_candidates = input.built.newItems;
    const stored = input.built.items.filter(function (i) { return !isBlankCell_(i.snapshot_at); });
    const summary = summarizeSettlementItems_(stored);
    Object.keys(summary).forEach(function (k) { if (k in report) report[k] = summary[k]; });
    report.target_match = input.built.newItems === 0 && flattenItemErrors_(e).length === 0 &&
      computeRawChecksum_(buildTableValues_(input.columns, input.built.items.map(function (o) { return objectToRow_(o, input.columns); }))) ===
      input.existing.grid.checksum;
    if (!report.target_match) report.errors.push('Settlement Items is stale (run normalizeSettlementItems).');
    report.regression = evaluateSettlementItemsRegression_(summary);
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0;
  return redactDeep_(report);
}
