/**
 * PaymentReconciliation.gs
 * Exact internal <-> provider reconciliation: Transactions + Provider Transactions -> Payment Matches.
 *
 * - Key: (payment_source, transaction id) by exact string equality only — internal
 *   (payment_source, internal_transaction_id) vs provider (payment_source, external_transaction_id).
 *   No fuzzy / prefix / order / customer / amount-only / sub_account / store / seller fallback.
 * - Both key sets must be unique; a provider key appearing twice (even under different
 *   provider_id) fails: one provider payment never confirms more than one internal transaction.
 * - Union of keys: both -> MATCHED (currency equal after trim+uppercase and |provider gross -
 *   internal amount| < 0.005; AUTO / CONFIRMED) or AMOUNT_MISMATCH (AUTO / PENDING_REVIEW);
 *   internal only -> MISSING_PROVIDER; provider only -> MISSING_INTERNAL (both PENDING_REVIEW).
 *   Provider external_status does not decide identity.
 * - match_id = PM-<sha256(payment_source|id)>, stable across status changes. matched_at /
 *   matched_by are set the first time a row is CONFIRMED and preserved; updated_at changes only
 *   when row content changes. An existing match_id missing from the fresh union fails.
 * - Upstream freshness gates (before any write): Transactions must equal the canonical result
 *   of current Raw Internal Transactions + Endpoint Mapping, and the KH001 partition of Provider
 *   Transactions must equal the canonical result of the current KH001 raw tabs. A NORMAL swap
 *   state alone is not enough.
 * - Writes only Payment Matches (SafeSwap, whole table, under the script lock) and Audit Log.
 *   Transactions.status is NOT changed here.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const PAYMENT_RECONCILIATION = Object.freeze({
  matchIdPrefix: 'PM-',
  toleranceMicros: 5000, // 0.005 in 1e-6 units; MATCHED requires |difference| < 0.005
  systemActor: 'system',
  timestampColumns: ['matched_at', 'matched_by', 'updated_at'],
  maxReportedErrors: 30,
});

/** Current production regression (after Phase 2F). Report only. */
const PAYMENT_RECONCILIATION_REGRESSION = Object.freeze({
  snapshot: 'Production after Phase 2F (356 internal / 169 provider)',
  internal_rows: 356,
  provider_rows: 169,
  union_rows: 357,
  status_counts: { MATCHED: 168, AMOUNT_MISMATCH: 0, MISSING_PROVIDER: 188, MISSING_INTERNAL: 1 },
  missing_provider_by_source: { PAYPAL: 186, STRIPE: 2 },
  missing_internal_by_source: { PAYPAL: 1 },
  missing_internal_provider_status: { Pending: 1 },
  matched_amount: 10627.62,
  missing_provider_internal_amount: 12597.68,
  provider_only_amount: 78.73,
  matched_seller_counts: { CUS001: 43, CUS002: 74, CUS003: 4, CUS004: 47 },
});

/* ----------------------------- Pure helpers ----------------------------- */

function reconciliationKey_(paymentSource, id) {
  return String(paymentSource) + '|' + String(id);
}

function paymentMatchId_(paymentSource, id, digestHex) {
  const digest = digestHex || sha256Hex_;
  return PAYMENT_RECONCILIATION.matchIdPrefix + digest(String(paymentSource) + '|' + String(id));
}

/** ISO currency comparison form (trim + uppercase); source values are not changed. */
function currencyCompareKey_(value) {
  return rawFieldText_(value).trim().toUpperCase();
}

/**
 * Builds the reconciliation union (rows without timestamps).
 * @param {Array<Object>} internalRows Transactions rows as objects
 * @param {Array<Object>} providerRows Provider Transactions rows as objects (all providers)
 * @return {{rows: Array<Object>, errors: {duplicate_internal_keys: Array<string>,
 *           duplicate_provider_keys: Array<string>, data: Array<string>}, stats: Object}}
 */
function buildPaymentReconciliation_(internalRows, providerRows, digestHex) {
  const errors = { duplicate_internal_keys: [], duplicate_provider_keys: [], data: [] };
  const index = function (rows, sourceField, idField, label, dupList) {
    const map = {};
    const counts = {};
    rows.forEach(function (r) {
      const source = rawFieldText_(r[sourceField]);
      const id = rawFieldText_(r[idField]);
      if (source === '' || id === '') { errors.data.push(label + ' row with blank ' + sourceField + ' or ' + idField); return; }
      const key = reconciliationKey_(source, id);
      counts[key] = (counts[key] || []).concat([r.provider_id ? String(r.provider_id) : '']);
      map[key] = r;
    });
    Object.keys(counts).sort().forEach(function (k) {
      if (counts[k].length > 1) {
        const providers = counts[k].filter(function (p) { return p !== ''; });
        dupList.push(k + ' (' + counts[k].length + ' rows' + (providers.length ? '; provider_id ' + providers.join(', ') : '') + ')');
      }
    });
    return map;
  };
  const internal = index(internalRows, 'payment_source', 'internal_transaction_id', 'Transactions', errors.duplicate_internal_keys);
  const provider = index(providerRows, 'payment_source', 'external_transaction_id', 'Provider Transactions', errors.duplicate_provider_keys);

  const keys = Object.keys(internal).concat(Object.keys(provider).filter(function (k) { return !internal[k]; }));
  const rows = [];
  keys.forEach(function (key) {
    const i = internal[key];
    const p = provider[key];
    const source = rawFieldText_((i || p).payment_source);
    const id = rawFieldText_(i ? i.internal_transaction_id : p.external_transaction_id);
    const row = {
      match_id: paymentMatchId_(source, id, digestHex), payment_source: source,
      internal_transaction_id: i ? id : '', external_transaction_id: p ? rawFieldText_(p.external_transaction_id) : '',
      provider_transaction_id: p ? rawFieldText_(p.provider_transaction_id) : '', provider_id: p ? rawFieldText_(p.provider_id) : '',
      reconciliation_status: '', match_type: 'AUTO', match_status: 'PENDING_REVIEW',
      internal_currency: i ? rawFieldText_(i.currency) : '', provider_currency: p ? rawFieldText_(p.currency) : '',
      internal_amount: i ? i.order_amount : '', provider_gross_amount: p ? p.gross_amount : '', amount_difference: '',
      provider_external_status: p ? rawFieldText_(p.external_status) : '',
      internal_source_fingerprint: i ? rawFieldText_(i.source_row_fingerprint) : '',
      provider_source_fingerprint: p ? rawFieldText_(p.source_fingerprint) : '',
      matched_at: '', matched_by: '', updated_at: '', notes: '',
    };
    if (i && p) {
      if (!isFiniteNumber_(i.order_amount) || !isFiniteNumber_(p.gross_amount)) {
        errors.data.push(key + ': non-numeric internal order_amount or provider gross_amount');
        return;
      }
      if (currencyCompareKey_(i.currency) !== currencyCompareKey_(p.currency)) {
        row.reconciliation_status = 'AMOUNT_MISMATCH';
        row.notes = 'Currency mismatch: internal ' + currencyCompareKey_(i.currency) + ' vs provider ' + currencyCompareKey_(p.currency);
      } else {
        const diffMicros = Math.round((p.gross_amount - i.order_amount) * 1e6);
        row.amount_difference = diffMicros === 0 ? 0 : diffMicros / 1e6;
        if (Math.abs(diffMicros) < PAYMENT_RECONCILIATION.toleranceMicros) {
          row.reconciliation_status = 'MATCHED';
          row.match_status = 'CONFIRMED';
        } else {
          row.reconciliation_status = 'AMOUNT_MISMATCH';
          row.notes = 'Amount difference ' + row.amount_difference + ' ' + currencyCompareKey_(i.currency);
        }
      }
    } else {
      row.reconciliation_status = i ? 'MISSING_PROVIDER' : 'MISSING_INTERNAL';
    }
    rows.push(row);
  });
  rows.sort(function (a, b) {
    return compareCanonicalValues_(a.payment_source, b.payment_source) ||
      compareCanonicalValues_(a.internal_transaction_id || a.external_transaction_id, b.internal_transaction_id || b.external_transaction_id);
  });
  return { rows: rows, errors: errors, stats: { internal_rows: internalRows.length, provider_rows: providerRows.length } };
}

function flattenReconciliationErrors_(errors) {
  return [].concat(errors.duplicate_internal_keys.map(function (k) { return 'Duplicate internal key ' + k; }),
    errors.duplicate_provider_keys.map(function (k) { return 'Duplicate provider key ' + k; }), errors.data);
}

/** Row content without timestamp columns (decides updated_at). */
function reconciliationContentKey_(row, columns) {
  return serializeRow_(columns.map(function (c) {
    return PAYMENT_RECONCILIATION.timestampColumns.indexOf(c) >= 0 ? '' : row[c];
  }));
}

/**
 * Merges timestamps from existing Payment Matches rows (objects) into fresh rows.
 * matched_at / matched_by: kept once set; set to now / system the first time a row is CONFIRMED.
 * updated_at: kept when content is unchanged, else now. Existing match_ids absent from the
 * fresh union are returned as errors (never silently deleted).
 */
function mergeReconciliationTimestamps_(freshRows, existingRows, now, columns) {
  const existing = {};
  existingRows.forEach(function (e) { existing[String(e.match_id)] = e; });
  const freshIds = {};
  const rows = freshRows.map(function (f) {
    freshIds[f.match_id] = true;
    const e = existing[f.match_id];
    const row = Object.assign({}, f);
    if (e && !isBlankCell_(e.matched_at)) row.matched_at = e.matched_at;
    else if (f.match_status === 'CONFIRMED') row.matched_at = now;
    if (e && !isBlankCell_(e.matched_by)) row.matched_by = e.matched_by;
    else if (f.match_status === 'CONFIRMED') row.matched_by = PAYMENT_RECONCILIATION.systemActor;
    row.updated_at = e && !isBlankCell_(e.updated_at) &&
      reconciliationContentKey_(e, columns) === reconciliationContentKey_(row, columns) &&
      serializeCell_(e.matched_at) === serializeCell_(row.matched_at) && serializeCell_(e.matched_by) === serializeCell_(row.matched_by)
      ? e.updated_at : now;
    return row;
  });
  const disappeared = Object.keys(existing).filter(function (id) { return !freshIds[id]; }).sort();
  return {
    rows: rows,
    errors: disappeared.map(function (id) { return 'Existing Payment Matches row ' + id + ' is no longer in the reconciliation union'; }),
    demoted: rows.filter(function (r) { return r.match_status !== 'CONFIRMED' && !isBlankCell_(r.matched_at); })
      .map(function (r) { return r.match_id; }),
  };
}

/**
 * Freshness of stored Payment Matches against a fresh reconciliation build: same rows and
 * content over the whole grid, ignoring only matched_at / matched_by / updated_at.
 */
function checkPaymentMatchesFresh_(built, storedValues, columns) {
  const stamps = PAYMENT_RECONCILIATION.timestampColumns.map(function (c) { return columns.indexOf(c); });
  const stored = tableChecksumExcluding_(storedValues, stamps);
  const problems = flattenReconciliationErrors_(built.errors).length;
  if (problems > 0) {
    return { current: false, expected_checksum: null, stored_checksum: stored,
      reason: 'Payment Matches is stale; run reconcilePayments first (reconciliation input has ' + problems + ' error(s)).' };
  }
  const expected = tableChecksumExcluding_(buildTableValues_(columns, built.rows.map(function (o) { return objectToRow_(o, columns); })), stamps);
  const current = expected === stored;
  return { current: current, expected_checksum: expected, stored_checksum: stored,
    reason: current ? null : 'Payment Matches is stale; run reconcilePayments first.' };
}

/** Generic summary of reconciliation rows (no snapshot-specific numbers). */
function summarizePaymentReconciliation_(rows, internalById) {
  const tally = function (list, keyOf) {
    return list.reduce(function (acc, r) { const k = keyOf(r); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  };
  const sum = function (list, field) {
    return list.reduce(function (acc, r) { return acc + toCents_(r[field]); }, 0) / 100;
  };
  const by = function (status) { return rows.filter(function (r) { return r.reconciliation_status === status; }); };
  const matched = by('MATCHED');
  const amountMismatch = by('AMOUNT_MISMATCH');
  const missingProvider = by('MISSING_PROVIDER');
  const missingInternal = by('MISSING_INTERNAL');
  return {
    union_rows: rows.length,
    matched_rows: matched.length,
    amount_mismatch_rows: amountMismatch.length,
    missing_provider_rows: missingProvider.length,
    missing_internal_rows: missingInternal.length,
    status_counts: tally(rows, function (r) { return r.reconciliation_status; }),
    payment_source_counts: tally(rows, function (r) { return r.payment_source; }),
    missing_provider_by_source: tally(missingProvider, function (r) { return r.payment_source; }),
    missing_internal_by_source: tally(missingInternal, function (r) { return r.payment_source; }),
    missing_internal_provider_status: tally(missingInternal, function (r) { return r.provider_external_status; }),
    matched_amount: sum(matched, 'internal_amount'),
    missing_provider_internal_amount: sum(missingProvider, 'internal_amount'),
    provider_only_amount: sum(missingInternal, 'provider_gross_amount'),
    currency_mismatches: amountMismatch.filter(function (r) { return r.amount_difference === ''; }).map(function (r) { return r.match_id; }),
    amount_mismatches: amountMismatch.filter(function (r) { return r.amount_difference !== ''; }).map(function (r) { return r.match_id; }),
    matched_seller_counts: tally(matched, function (r) {
      const i = internalById ? internalById[reconciliationKey_(r.payment_source, r.internal_transaction_id)] : null;
      return i ? String(i.seller_id || '(unassigned)') : '(unknown)';
    }),
  };
}

function evaluatePaymentReconciliationRegression_(summary, stats) {
  const exp = PAYMENT_RECONCILIATION_REGRESSION;
  const checks = [];
  const add = function (n, e, a, pass) { checks.push({ name: n, expected: e, actual: a, pass: pass }); };
  const same = function (e, a) {
    return Object.keys(e).every(function (k) { return (a[k] || 0) === e[k]; }) &&
      Object.keys(a).every(function (k) { return Object.prototype.hasOwnProperty.call(e, k) || !a[k]; });
  };
  add('internal_rows', exp.internal_rows, stats.internal_rows, stats.internal_rows === exp.internal_rows);
  add('provider_rows', exp.provider_rows, stats.provider_rows, stats.provider_rows === exp.provider_rows);
  add('union_rows', exp.union_rows, summary.union_rows, summary.union_rows === exp.union_rows);
  ['status_counts', 'missing_provider_by_source', 'missing_internal_by_source', 'missing_internal_provider_status',
    'matched_seller_counts'].forEach(function (k) { add(k, exp[k], summary[k], same(exp[k], summary[k])); });
  ['matched_amount', 'missing_provider_internal_amount', 'provider_only_amount'].forEach(function (k) {
    add(k, exp[k], summary[k], Math.round(exp[k] * 100) === Math.round(summary[k] * 100));
  });
  return { snapshot: exp.snapshot, pass: checks.every(function (c) { return c.pass; }),
    failed: checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }), checks: checks };
}

/* ---------------------------------- I/O --------------------------------- */

function paymentMatchesTab_() {
  return { targetSheet: SHEETS.PAYMENT_MATCHES, stagingSheet: '__STAGE_PAYMENT_MATCHES' };
}

/** Reads a schema table as objects; requires a NORMAL swap state for that tab. */
function readSchemaTableObjects_(ss, sheetName, tab) {
  const state = detectSwapState_(ss, tab).state;
  if (state !== 'NORMAL') throw new Error(sheetName + ' swap state is ' + state + '; run its normalizer first.');
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(sheetName + ' tab not found.');
  const columns = getColumnNames_(sheetName);
  const grid = readSheetGrid_(sheet);
  return { grid: grid, rows: tableRowsFromGrid_(grid.values, columns, sheetName).map(function (r) { return rowToObject_(r, columns); }) };
}

/** Read-only freshness of the KH001 Provider Transactions partition against current KH001 raw. */
function readProviderTransactionsFreshness_(ss) {
  const stale = 'Provider Transactions KH001 is stale; run normalizeKh001ProviderTransactions first.';
  try {
    const sheet = ss.getSheetByName(SHEETS.RAW_KH001_PAYPAL);
    if (!sheet) throw new Error('Raw tab "' + SHEETS.RAW_KH001_PAYPAL + '" not found.');
    const dep = readProviderTransactionsDependency_(ss, readSheetGrid_(sheet)).dependency;
    return { current: dep.provider_transactions_current, expected_checksum: dep.expected_checksum,
      stored_checksum: dep.stored_checksum, reason: dep.provider_transactions_current ? null : stale };
  } catch (err) {
    return { current: false, expected_checksum: null, stored_checksum: null,
      reason: stale + ' (' + (err && err.message ? err.message : String(err)) + ')' };
  }
}

/** Both upstream canonical inputs must be current before reconciliation may write. */
function readReconciliationUpstream_(ss) {
  return { internal: readInternalTransactionsFreshness_(ss), provider: readProviderTransactionsFreshness_(ss) };
}

function readReconciliationInputs_(ss) {
  const internal = readSchemaTableObjects_(ss, SHEETS.TRANSACTIONS, transactionsTab_());
  const provider = readSchemaTableObjects_(ss, SHEETS.PROVIDER_TRANSACTIONS, providerTransactionsTab_());
  const built = buildPaymentReconciliation_(internal.rows, provider.rows);
  const internalById = {};
  internal.rows.forEach(function (r) { internalById[reconciliationKey_(r.payment_source, r.internal_transaction_id)] = r; });
  return { internal: internal, provider: provider, built: built, internalById: internalById };
}

/** Read-only freshness of Payment Matches against current Transactions + Provider Transactions. */
function readPaymentMatchesFreshness_(ss) {
  try {
    const input = readReconciliationInputs_(ss);
    const current = readSchemaTableObjects_(ss, SHEETS.PAYMENT_MATCHES, paymentMatchesTab_());
    return checkPaymentMatchesFresh_(input.built, current.grid.values, getColumnNames_(SHEETS.PAYMENT_MATCHES));
  } catch (err) {
    return { current: false, expected_checksum: null, stored_checksum: null,
      reason: 'Payment Matches is stale; run reconcilePayments first (' + (err && err.message ? err.message : String(err)) + ').' };
  }
}

function throwIfReconciliationErrors_(label, list) {
  if (list.length === 0) return;
  const shown = list.slice(0, PAYMENT_RECONCILIATION.maxReportedErrors);
  throw new Error(label + ' (' + list.length + ' error(s)): ' + shown.join(' | ') +
    (list.length > shown.length ? ' | ... ' + (list.length - shown.length) + ' more' : ''));
}

/** Rebuilds Payment Matches under the script lock. Never throws. */
function runPaymentReconciliation_() {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  const details = {};
  let status = 'FAILED';
  let ss = null;
  const tab = paymentMatchesTab_();
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms.');
    ss = getSpreadsheet_();
    const recovery = recoverSwapState_(ss, tab);
    details.initial_swap_state = recovery.state;
    details.recovery_actions = recovery.actions;

    // Upstream freshness gates: nothing is written unless both canonical inputs are current.
    const upstream = readReconciliationUpstream_(ss);
    details.internal_transactions_current = upstream.internal.current;
    details.provider_transactions_current = upstream.provider.current;
    if (!upstream.internal.current) throw new Error(upstream.internal.reason);
    if (!upstream.provider.current) throw new Error(upstream.provider.reason);

    const input = readReconciliationInputs_(ss);
    details.internal_rows = input.built.stats.internal_rows;
    details.provider_rows = input.built.stats.provider_rows;
    throwIfReconciliationErrors_('Reconciliation input is invalid', flattenReconciliationErrors_(input.built.errors));

    const columns = getColumnNames_(SHEETS.PAYMENT_MATCHES);
    const current = readSchemaTableObjects_(ss, SHEETS.PAYMENT_MATCHES, tab);
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const merged = mergeReconciliationTimestamps_(input.built.rows, current.rows, now, columns);
    throwIfReconciliationErrors_('Payment Matches rows would disappear', merged.errors);
    if (merged.demoted.length > 0) details.demoted_match_ids = merged.demoted;

    const rows = merged.rows.map(function (o) { return objectToRow_(o, columns); });
    const expected = computeRawChecksum_(buildTableValues_(columns, rows));
    const summary = summarizePaymentReconciliation_(merged.rows, input.internalById);
    ['union_rows', 'matched_rows', 'amount_mismatch_rows', 'missing_provider_rows', 'missing_internal_rows', 'status_counts',
      'matched_amount', 'missing_provider_internal_amount', 'provider_only_amount'].forEach(function (k) { details[k] = summary[k]; });
    details.payment_matches_checksum = expected;
    if (expected === current.grid.checksum) {
      status = 'NO_CHANGE';
    } else {
      writeCanonicalTable_(ss, getTableSchema_(SHEETS.PAYMENT_MATCHES), tab, rows);
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
      appendAuditLog_({ action: 'PAYMENT_RECONCILIATION_' + status, entityType: 'PAYMENT_MATCHES', entityId: '',
        newStatus: status, details: redactDeep_(details) });
    } catch (auditErr) {
      Logger.log('Failed to write audit entry: %s', auditErr);
    }
    if (locked) lock.releaseLock();
  }
  return redactDeep_(Object.assign({ status: status }, details));
}

/** Read-only verification of Payment Matches against a fresh exact reconciliation. */
function buildPaymentReconciliationReport_() {
  const report = {
    internal_rows: 0, provider_rows: 0, union_rows: 0, matched_rows: 0, amount_mismatch_rows: 0, missing_provider_rows: 0,
    missing_internal_rows: 0, status_counts: {}, payment_source_counts: {}, matched_amount: 0,
    missing_provider_internal_amount: 0, provider_only_amount: 0, duplicate_internal_keys: [], duplicate_provider_keys: [],
    currency_mismatches: [], amount_mismatches: [], disappearing_match_ids: [], confirmed_without_matched_at: [],
    internal_transactions_current: false, provider_transactions_current: false,
    payment_matches_match: false, swap_state: null, pass: false, errors: [], warnings: [], regression: null,
  };
  try {
    const ss = getSpreadsheet_();
    const tab = paymentMatchesTab_();
    report.swap_state = detectSwapState_(ss, tab).state;
    if (report.swap_state !== 'NORMAL') report.errors.push('Payment Matches swap state is ' + report.swap_state);
    const upstream = readReconciliationUpstream_(ss);
    report.internal_transactions_current = upstream.internal.current;
    report.provider_transactions_current = upstream.provider.current;
    if (!upstream.internal.current) report.errors.push(upstream.internal.reason);
    if (!upstream.provider.current) report.errors.push(upstream.provider.reason);
    const input = readReconciliationInputs_(ss);
    const b = input.built;
    report.internal_rows = b.stats.internal_rows;
    report.provider_rows = b.stats.provider_rows;
    report.duplicate_internal_keys = b.errors.duplicate_internal_keys;
    report.duplicate_provider_keys = b.errors.duplicate_provider_keys;
    const inputErrors = flattenReconciliationErrors_(b.errors);
    if (inputErrors.length > 0) report.errors.push('Reconciliation input has ' + inputErrors.length + ' error(s).');

    const summary = summarizePaymentReconciliation_(b.rows, input.internalById);
    Object.keys(summary).forEach(function (k) { if (k in report) report[k] = summary[k]; });

    const columns = getColumnNames_(SHEETS.PAYMENT_MATCHES);
    const current = readSchemaTableObjects_(ss, SHEETS.PAYMENT_MATCHES, tab);
    const merged = mergeReconciliationTimestamps_(b.rows, current.rows, null, columns);
    report.disappearing_match_ids = merged.errors;
    if (merged.errors.length > 0) report.errors.push('Existing Payment Matches rows are missing from the union.');
    if (merged.demoted.length > 0) report.warnings.push('Previously confirmed rows no longer MATCHED: ' + merged.demoted.join(', '));
    report.payment_matches_match = checkPaymentMatchesFresh_(b, current.grid.values, columns).current;
    report.confirmed_without_matched_at = current.rows
      .filter(function (r) { return r.match_status === 'CONFIRMED' && (isBlankCell_(r.matched_at) || isBlankCell_(r.matched_by)); })
      .map(function (r) { return r.match_id; });
    if (!report.payment_matches_match) report.errors.push('Payment Matches is stale (run reconcilePayments).');
    if (report.confirmed_without_matched_at.length > 0) report.errors.push('CONFIRMED rows without matched_at / matched_by.');
    if (summary.amount_mismatch_rows > 0) report.warnings.push(summary.amount_mismatch_rows + ' AMOUNT_MISMATCH row(s) need review.');
    report.regression = evaluatePaymentReconciliationRegression_(summary, b.stats);
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0;
  return redactDeep_(report);
}
