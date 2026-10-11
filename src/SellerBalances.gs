/**
 * SellerBalances.gs
 * Seller Balances: derived per seller + currency. Written only by normalizeSellerBalances().
 *
 *   settled_amount      = SUM(Settlement Items.seller_available_amount)   (provider-paid frozen entitlement)
 *   adjustments         = SUM(Adjustments.amount WHERE status = APPLIED)  (seller perspective: + credit, - debit)
 *   paid_amount         = SUM(Seller Payouts.amount WHERE status IN (SENT, CONFIRMED))
 *   current_balance     = available_amount = settled + adjustments - paid  (negative allowed, never clamped)
 *   seller_hold_balance = SUM(Settlement Items.seller_hold_amount) - SUM(APPLIED HOLD_RELEASE amount)
 *
 * PENDING / VOID adjustments and DRAFT / VOID payouts do not count. Seller Payout Allocations never change a balance;
 * invalid / incomplete allocations of effective payouts make the rebuild fail closed (allocation_errors). A hold balance that would go
 * materially negative fails. updated_at changes only with content; a disappearing key fails.
 * Requires Settlement Items current. Sums use micro units (1e-6) for deterministic totals.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const SELLER_BALANCES = Object.freeze({
  countedAdjustmentStatus: 'APPLIED',
  countedPayoutStatuses: ['SENT', 'CONFIRMED'],
  holdReleaseType: 'HOLD_RELEASE',
  maxReportedErrors: 30,
});

/** Current production regression (after Phase 2J). Report only. */
const SELLER_BALANCES_REGRESSION = Object.freeze({
  snapshot: 'Production after Phase 2J (no adjustments, no payouts)',
  balance_rows: 4,
  currency_counts: { USD: 4 },
  balances: {
    'CUS001|USD': { settled_amount: 1919.3986, available_amount: 1919.3986, paid_amount: 0, seller_hold_balance: 234.073, adjustments: 0, current_balance: 1919.3986 },
    'CUS002|USD': { settled_amount: 3037.444, available_amount: 3037.444, paid_amount: 0, seller_hold_balance: 370.42, adjustments: 0, current_balance: 3037.444 },
    'CUS003|USD': { settled_amount: 256.7666, available_amount: 256.7666, paid_amount: 0, seller_hold_balance: 31.313, adjustments: 0, current_balance: 256.7666 },
    'CUS004|USD': { settled_amount: 3156.4424, available_amount: 3156.4424, paid_amount: 0, seller_hold_balance: 384.932, adjustments: 0, current_balance: 3156.4424 },
  },
  totals: { settled_total: 8370.0516, available_total: 8370.0516, current_balance_total: 8370.0516, hold_total: 1020.738, paid_total: 0, adjustment_total: 0 },
});

/* ----------------------------- Pure helpers ----------------------------- */

function emptyBalanceErrors_() {
  return { duplicate_balance_keys: [], unknown_sellers: [], invalid_adjustments: [], invalid_payouts: [], negative_hold_errors: [],
    disappearing_balances: [], allocation_errors: [] };
}

function flattenBalanceErrors_(errors) {
  return Object.keys(errors).reduce(function (acc, k) { return acc.concat(errors[k]); }, []);
}

/**
 * @param {{items: Array<Object>, adjustments: Array<Object>, payouts: Array<Object>, sellerIds: Array<string>,
 *          existing: Array<Object>, now: *, columns: Array<string>}} input
 * @return {{rows: Array<Object>, errors: Object}}
 */
function buildSellerBalances_(input) {
  const errors = emptyBalanceErrors_();
  const known = {};
  input.sellerIds.forEach(function (id) { known[id] = true; });
  const acc = {};
  const key = function (seller, currency) { return seller + '|' + currency; };
  const bucket = function (seller, currency) {
    const k = key(seller, currency);
    return acc[k] = acc[k] || { seller_id: seller, currency: currency, settled: 0, adjustments: 0, paid: 0, hold: 0, released: 0 };
  };
  const micros = function (v) { return Math.round(v * 1e6); };

  input.items.forEach(function (i) {
    const seller = trimmedText_(i.seller_id);
    const currency = trimmedText_(i.currency);
    if (!known[seller]) { errors.unknown_sellers.push('Settlement Item ' + i.settlement_item_id + ': unknown seller ' + seller); return; }
    if (currency === '' || !isFiniteNumber_(i.seller_available_amount) || !isFiniteNumber_(i.seller_hold_amount)) {
      errors.unknown_sellers.push('Settlement Item ' + i.settlement_item_id + ': missing currency or seller amounts');
      return;
    }
    const b = bucket(seller, currency);
    b.settled += micros(i.seller_available_amount);
    b.hold += micros(i.seller_hold_amount);
  });

  const seenAdj = {};
  input.adjustments.forEach(function (a) {
    const id = trimmedText_(a.adjustment_id);
    const label = 'Adjustment ' + (id || '(blank id)');
    if (id === '') { errors.invalid_adjustments.push(label + ': adjustment_id is blank'); return; }
    if (seenAdj[id]) { errors.invalid_adjustments.push(label + ': duplicate adjustment_id'); return; }
    seenAdj[id] = true;
    const status = trimmedText_(a.status);
    if (ENUMS.ADJUSTMENT_STATUS.indexOf(status) < 0) { errors.invalid_adjustments.push(label + ': invalid status "' + status + '"'); return; }
    if (status !== SELLER_BALANCES.countedAdjustmentStatus) return; // PENDING / VOID never count
    const type = trimmedText_(a.adjustment_type);
    const seller = trimmedText_(a.seller_id);
    const currency = trimmedText_(a.currency);
    if (ENUMS.ADJUSTMENT_TYPE.indexOf(type) < 0) { errors.invalid_adjustments.push(label + ': invalid adjustment_type "' + type + '"'); return; }
    if (!known[seller]) { errors.invalid_adjustments.push(label + ': unknown seller ' + seller); return; }
    if (currency === '') { errors.invalid_adjustments.push(label + ': currency is blank'); return; }
    if (!isFiniteNumber_(a.amount)) { errors.invalid_adjustments.push(label + ': amount is not numeric'); return; }
    if (type === SELLER_BALANCES.holdReleaseType && !(a.amount > 0)) { errors.invalid_adjustments.push(label + ': HOLD_RELEASE amount must be positive'); return; }
    const b = bucket(seller, currency);
    b.adjustments += micros(a.amount);
    if (type === SELLER_BALANCES.holdReleaseType) b.released += micros(a.amount);
  });

  const seenPay = {};
  input.payouts.forEach(function (p) {
    const id = trimmedText_(p.seller_payout_id);
    const label = 'Seller Payout ' + (id || '(blank id)');
    if (id === '') { errors.invalid_payouts.push(label + ': seller_payout_id is blank'); return; }
    if (seenPay[id]) { errors.invalid_payouts.push(label + ': duplicate seller_payout_id'); return; }
    seenPay[id] = true;
    const status = trimmedText_(p.status);
    if (ENUMS.SELLER_PAYOUT_STATUS.indexOf(status) < 0) { errors.invalid_payouts.push(label + ': invalid status "' + status + '"'); return; }
    if (SELLER_BALANCES.countedPayoutStatuses.indexOf(status) < 0) return; // DRAFT / VOID never count
    const seller = trimmedText_(p.seller_id);
    const currency = trimmedText_(p.currency);
    if (!known[seller]) { errors.invalid_payouts.push(label + ': unknown seller ' + seller); return; }
    if (currency === '') { errors.invalid_payouts.push(label + ': currency is blank'); return; }
    if (!isFiniteNumber_(p.amount) || !(p.amount > 0)) { errors.invalid_payouts.push(label + ': amount must be a positive number'); return; }
    bucket(seller, currency).paid += micros(p.amount);
  });

  const rows = Object.keys(acc).sort().map(function (k) {
    const b = acc[k];
    const hold = b.hold - b.released;
    if (hold < -50) errors.negative_hold_errors.push(k + ': hold balance would be ' + hold / 1e6 + ' after HOLD_RELEASE');
    const current = (b.settled + b.adjustments - b.paid) / 1e6;
    return { seller_id: b.seller_id, currency: b.currency, settled_amount: b.settled / 1e6, available_amount: current,
      paid_amount: b.paid / 1e6, seller_hold_balance: hold / 1e6, adjustments: b.adjustments / 1e6, current_balance: current, updated_at: '' };
  });

  // Timestamps and disappearance against existing rows.
  const existing = {};
  input.existing.forEach(function (e) {
    const k = key(trimmedText_(e.seller_id), trimmedText_(e.currency));
    if (existing[k]) errors.duplicate_balance_keys.push('Seller Balances has ' + k + ' twice');
    existing[k] = e;
  });
  const content = function (r) { return serializeRow_(input.columns.map(function (c) { return c === 'updated_at' ? '' : r[c]; })); };
  const fresh = {};
  rows.forEach(function (r) {
    const k = key(r.seller_id, r.currency);
    fresh[k] = true;
    const e = existing[k];
    r.updated_at = e && !isBlankCell_(e.updated_at) && content(e) === content(r) ? e.updated_at : input.now;
  });
  Object.keys(existing).filter(function (k) { return !fresh[k]; }).sort().forEach(function (k) {
    errors.disappearing_balances.push('Seller balance ' + k + ' would disappear');
  });
  return { rows: rows, errors: errors };
}

function summarizeSellerBalances_(rows) {
  const tally = function (f) { return rows.reduce(function (a, r) { a[r[f]] = (a[r[f]] || 0) + 1; return a; }, {}); };
  const sum = function (f) { return rows.reduce(function (a, r) { return a + Math.round(r[f] * 1e6); }, 0) / 1e6; };
  return { balance_rows: rows.length, seller_counts: tally('seller_id'), currency_counts: tally('currency'),
    settled_total: sum('settled_amount'), available_total: sum('available_amount'), paid_total: sum('paid_amount'),
    hold_total: sum('seller_hold_balance'), adjustment_total: sum('adjustments'), current_balance_total: sum('current_balance') };
}

function evaluateSellerBalancesRegression_(rows, summary) {
  const exp = SELLER_BALANCES_REGRESSION;
  const checks = [];
  const add = function (n, e, a, pass) { checks.push({ name: n, expected: e, actual: a, pass: pass }); };
  add('balance_rows', exp.balance_rows, summary.balance_rows, summary.balance_rows === exp.balance_rows);
  add('currency_counts', exp.currency_counts, summary.currency_counts, JSON.stringify(exp.currency_counts) === JSON.stringify(summary.currency_counts));
  const byKey = {};
  rows.forEach(function (r) { byKey[r.seller_id + '|' + r.currency] = r; });
  Object.keys(exp.balances).forEach(function (k) {
    Object.keys(exp.balances[k]).forEach(function (f) {
      const a = byKey[k] ? byKey[k][f] : null;
      add(k + '.' + f, exp.balances[k][f], a, isFiniteNumber_(a) && Math.abs(a - exp.balances[k][f]) < 0.00005);
    });
  });
  Object.keys(exp.totals).forEach(function (k) { add('totals.' + k, exp.totals[k], summary[k], Math.abs(summary[k] - exp.totals[k]) < 0.00005); });
  return { snapshot: exp.snapshot, pass: checks.every(function (c) { return c.pass; }),
    failed: checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }), checks: checks };
}

/* ---------------------------------- I/O --------------------------------- */

function sellerBalancesTab_() {
  return { targetSheet: SHEETS.SELLER_BALANCES, stagingSheet: '__STAGE_SELLER_BALANCES' };
}

/** Plain schema-table rows as objects (non-swapped user/system input tabs). */
function readPlainTableObjects_(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(sheetName + ' tab not found.');
  const columns = getColumnNames_(sheetName);
  return tableRowsFromGrid_(readSheetGrid_(sheet).values, columns, sheetName).map(function (r) { return rowToObject_(r, columns); });
}

/**
 * Seller Balances inputs and rebuild. The balance formula never uses allocations; but invalid / incomplete Seller
 * Payout Allocations (e.g. an effective payout that is not fully allocated) are reported as allocation_errors so
 * normalizeSellerBalances and its freshness check fail closed.
 */
function readSellerBalancesInputs_(ss, now) {
  const items = readSchemaTableObjects_(ss, SHEETS.SETTLEMENT_ITEMS, settlementItemsTab_()).rows;
  const current = readSchemaTableObjects_(ss, SHEETS.SELLER_BALANCES, sellerBalancesTab_());
  const columns = getColumnNames_(SHEETS.SELLER_BALANCES);
  const sellerIds = readSellersDraft_(ss).parsed.sellers.map(function (s) { return s.seller_id; }).filter(function (id) { return id !== ''; });
  const payouts = readPlainTableObjects_(ss, SHEETS.SELLER_PAYOUTS);
  const built = buildSellerBalances_({ items: items, adjustments: readPlainTableObjects_(ss, SHEETS.ADJUSTMENTS), payouts: payouts,
    sellerIds: sellerIds, existing: current.rows, now: now, columns: columns });
  const allocation = validateSellerPayoutAllocations_({ allocations: readPlainTableObjects_(ss, SHEETS.SELLER_PAYOUT_ALLOCATIONS),
    payouts: payouts, items: items, settlements: readSchemaTableObjects_(ss, SHEETS.SETTLEMENTS, settlementsTab_()).rows });
  built.errors.allocation_errors = flattenAllocationErrors_(allocation.errors).map(function (e) { return 'Seller Payout Allocations: ' + e; });
  return { current: current, columns: columns, built: built };
}

/**
 * Read-only freshness of Seller Balances: Settlement Items current, the rebuild from Settlement Items,
 * Adjustments and Seller Payouts has no validation error, and the stored table equals it (ignoring
 * only updated_at). Never throws.
 * @param {Object=} itemsFreshness an already computed readSettlementItemsFreshness_(ss)
 */
function readSellerBalancesFreshness_(ss, itemsFreshness) {
  const stale = 'Seller Balances is stale; run normalizeSellerBalances first';
  try {
    const items = itemsFreshness || readSettlementItemsFreshness_(ss);
    if (!items.current) return { current: false, reason: 'Seller Balances upstream is stale (' + items.reason + ')' };
    const input = readSellerBalancesInputs_(ss, null);
    const problems = flattenBalanceErrors_(input.built.errors).length;
    if (problems > 0) return { current: false, reason: 'Seller Balances is invalid (' + problems + ' error(s)); run normalizeSellerBalances.' };
    const updatedIdx = [input.columns.indexOf('updated_at')];
    const expected = tableChecksumExcluding_(buildTableValues_(input.columns,
      input.built.rows.map(function (o) { return objectToRow_(o, input.columns); })), updatedIdx);
    const current = expected === tableChecksumExcluding_(input.current.grid.values, updatedIdx);
    return { current: current, reason: current ? null : stale + '.' };
  } catch (err) {
    return { current: false, reason: stale + ' (' + (err && err.message ? err.message : String(err)) + ').' };
  }
}

function throwIfBalanceErrors_(label, list) {
  if (list.length === 0) return;
  const shown = list.slice(0, SELLER_BALANCES.maxReportedErrors);
  throw new Error(label + ' (' + list.length + ' error(s)): ' + shown.join(' | ') +
    (list.length > shown.length ? ' | ... ' + (list.length - shown.length) + ' more' : ''));
}

/** Rebuilds Seller Balances under the script lock. Never throws. */
function runSellerBalancesNormalizer_() {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  const details = {};
  let status = 'FAILED';
  let ss = null;
  const tab = sellerBalancesTab_();
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms.');
    ss = getSpreadsheet_();
    const recovery = recoverSwapState_(ss, tab);
    details.initial_swap_state = recovery.state;
    details.recovery_actions = recovery.actions;
    const items = readSettlementItemsFreshness_(ss);
    details.source_current = items.current;
    if (!items.current) throw new Error(items.reason);

    const input = readSellerBalancesInputs_(ss, new Date(Math.floor(Date.now() / 1000) * 1000));
    throwIfBalanceErrors_('Seller Balances input is invalid', flattenBalanceErrors_(input.built.errors));
    const rows = input.built.rows.map(function (o) { return objectToRow_(o, input.columns); });
    const summary = summarizeSellerBalances_(input.built.rows);
    Object.keys(summary).forEach(function (k) { details[k] = summary[k]; });
    const expected = computeRawChecksum_(buildTableValues_(input.columns, rows));
    details.seller_balances_checksum = expected;
    if (expected === input.current.grid.checksum) {
      status = 'NO_CHANGE';
    } else {
      writeCanonicalTable_(ss, getTableSchema_(SHEETS.SELLER_BALANCES), tab, rows);
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
      appendAuditLog_({ action: 'SELLER_BALANCES_NORMALIZE_' + status, entityType: 'SELLER_BALANCES', entityId: '',
        newStatus: status, details: redactDeep_(details) });
    } catch (auditErr) {
      Logger.log('Failed to write audit entry: %s', auditErr);
    }
    if (locked) lock.releaseLock();
  }
  return redactDeep_(Object.assign({ status: status }, details));
}

/** Read-only verification of Seller Balances. */
function buildSellerBalancesReport_() {
  const report = { balance_rows: 0, seller_counts: {}, currency_counts: {}, settled_total: 0, available_total: 0, paid_total: 0, hold_total: 0,
    adjustment_total: 0, current_balance_total: 0, duplicate_balance_keys: [], unknown_sellers: [], invalid_adjustments: [], invalid_payouts: [],
    negative_hold_errors: [], disappearing_balances: [], source_current: false, target_match: false, swap_state: null, pass: false,
    errors: [], warnings: [], regression: null };
  try {
    const ss = getSpreadsheet_();
    report.swap_state = detectSwapState_(ss, sellerBalancesTab_()).state;
    if (report.swap_state !== 'NORMAL') report.errors.push('Seller Balances swap state is ' + report.swap_state);
    const items = readSettlementItemsFreshness_(ss);
    report.source_current = items.current;
    if (!items.current) report.errors.push(items.reason);
    const input = readSellerBalancesInputs_(ss, null);
    const e = input.built.errors;
    Object.keys(e).forEach(function (k) { report[k] = e[k]; });
    if (flattenBalanceErrors_(e).length > 0) report.errors.push('Seller Balances input has ' + flattenBalanceErrors_(e).length + ' error(s).');
    const summary = summarizeSellerBalances_(input.built.rows);
    Object.keys(summary).forEach(function (k) { report[k] = summary[k]; });
    const updatedIdx = [input.columns.indexOf('updated_at')];
    report.target_match = tableChecksumExcluding_(buildTableValues_(input.columns, input.built.rows.map(function (o) { return objectToRow_(o, input.columns); })),
      updatedIdx) === tableChecksumExcluding_(input.current.grid.values, updatedIdx);
    if (!report.target_match) report.errors.push('Seller Balances is stale (run normalizeSellerBalances).');
    if (input.built.rows.some(function (r) { return r.current_balance < 0; })) report.warnings.push('Some seller balances are negative.');
    report.regression = evaluateSellerBalancesRegression_(input.built.rows, summary);
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0;
  return redactDeep_(report);
}
