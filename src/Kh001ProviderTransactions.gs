/**
 * Kh001ProviderTransactions.gs
 * KH001 normalizer: Master raw tabs -> canonical Provider Transactions (KH001 partition).
 *
 * - Primary source: "Raw KH001 PayPal" (RAW_PP). One canonical row per row whose
 *   "Nhóm GD" is exactly "Thanh toán". Status is NOT filtered (Pending is included).
 * - "Raw KH001 Reconciled" (DoiSoat_GD) only enriches rows (exact Transaction ID join).
 *   Reconciled rows without a RAW_PP payment (e.g. "Thiếu trên PayPal") create nothing.
 * - Reads only Master raw tabs; never opens the external KH001 spreadsheet.
 * - No fees, holds, settlements, matching or seller logic.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const KH001_PROVIDER_TX = Object.freeze({
  providerId: 'KH001',
  paymentSource: 'PAYPAL',
  normalizerVersion: 'KH001_PROVIDER_TX_V1',
  idPrefix: 'PT-KH001-PAYPAL-',
  paypalHeaderRow: 1,
  reconciledHeaderRow: 6,
  paymentGroupHeader: 'Nhóm GD',
  paymentGroupValue: 'Thanh toán',
  paypalRequiredHeaders: [
    'Mã cổng', 'Type', 'Status', 'Currency', 'Gross', 'Fee', 'Net', 'From Email Address',
    'To Email Address', 'Transaction ID', 'Invoice Number', 'Balance Impact', 'Thời gian', 'Nhóm GD',
  ],
  reconciledRequiredHeaders: [
    'Transaction ID', 'Có trên KH', 'Có trên PP', 'Trạng thái', 'Mã cổng', 'Sub account',
    'Thời gian GD', 'Số tiền KH', 'Gross PayPal', 'Chênh lệch', 'Phí PayPal', 'Net',
  ],
  reconciliationStatusMap: {
    'Khớp': 'RECONCILED',
    'Lệch số tiền': 'AMOUNT_MISMATCH',
  },
  providerOnlyStatus: 'PROVIDER_ONLY',
  amountTolerance: 0.005,
  maxReportedErrors: 20,
});

/**
 * Current-snapshot regression expectations (October 2026 production snapshot).
 * Used only by the verifier's regression report; never by the normalizer.
 */
const KH001_PROVIDER_TX_REGRESSION = Object.freeze({
  snapshot: 'KH001 2026-10 production snapshot',
  row_count: 169,
  unique_transaction_count: 169,
  status_counts: { Completed: 168, Pending: 1 },
  currency_counts: { USD: 169 },
  reconciliation_counts: { RECONCILED: 168, AMOUNT_MISMATCH: 0, PROVIDER_ONLY: 1 },
  provider_only_transaction_ids: ['80B6789902665252D'],
  totals: { gross: 10706.35, processing_fee: 420.24, net: 10286.11 },
  completed_totals: { gross: 10627.62, processing_fee: 420.24, net: 10207.38 },
});

/* ----------------------------- Pure helpers ----------------------------- */

/** Unicode NFC + trim, so composed/decomposed Vietnamese text compares equal. */
function normalizeLabel_(value) {
  return String(value === null || value === undefined ? '' : value).normalize('NFC').trim();
}

/** Text value for canonical TEXT/ID columns (Dates as ISO, never locale strings). */
function canonicalText_(value) {
  if (isBlankCell_(value)) return '';
  if (isDateValue_(value)) return value.toISOString();
  return String(value);
}

/**
 * Header name -> 0-based index (names NFC-normalized and trimmed).
 * Throws when a required header is missing or appears more than once.
 */
function buildHeaderMap_(headerRow, requiredHeaders, label) {
  const map = {};
  const duplicates = [];
  headerRow.forEach(function (h, i) {
    const name = normalizeLabel_(h);
    if (name === '') return;
    if (Object.prototype.hasOwnProperty.call(map, name)) duplicates.push(name);
    else map[name] = i;
  });
  const required = requiredHeaders.map(normalizeLabel_);
  const missing = required.filter(function (r) { return !Object.prototype.hasOwnProperty.call(map, r); });
  const ambiguous = required.filter(function (r) { return duplicates.indexOf(r) >= 0; });
  const errors = [];
  if (missing.length > 0) errors.push('Missing required header(s) in ' + label + ': ' + missing.join(', '));
  if (ambiguous.length > 0) errors.push('Duplicate required header(s) in ' + label + ': ' + ambiguous.join(', '));
  if (errors.length > 0) throw new Error(errors.join('. ') + '.');
  return map;
}

/** Maps a DoiSoat_GD "Trạng thái" value; throws on anything not explicitly mapped. */
function mapKh001ReconciliationStatus_(rawStatus) {
  const key = normalizeLabel_(rawStatus);
  const map = KH001_PROVIDER_TX.reconciliationStatusMap;
  const normalizedKeys = Object.keys(map).reduce(function (acc, k) {
    acc[normalizeLabel_(k)] = map[k];
    return acc;
  }, {});
  if (Object.prototype.hasOwnProperty.call(normalizedKeys, key)) return normalizedKeys[key];
  throw new Error('Unmapped KH001 reconciliation status: "' + rawStatus + '"');
}

function kh001ProviderTransactionId_(externalTransactionId) {
  return KH001_PROVIDER_TX.idPrefix + externalTransactionId;
}

/** SHA-256 of raw checksums + normalizer version; independent of time. */
function computeKh001SourceFingerprint_(paypalChecksum, reconciledChecksum, digestHex) {
  const digest = digestHex || sha256Hex_;
  return digest(paypalChecksum + '|' + reconciledChecksum + '|' + KH001_PROVIDER_TX.normalizerVersion);
}

function isFiniteNumber_(v) {
  return typeof v === 'number' && isFinite(v);
}

function amountInvariantHolds_(gross, fee, net) {
  return Math.abs(gross - fee - net) <= KH001_PROVIDER_TX.amountTolerance + 1e-9;
}

/**
 * Builds the KH001 canonical rows (objects keyed by Provider Transactions columns,
 * normalized_at blank) from raw grids. Validates everything and throws one error
 * listing the problems; nothing is returned partially.
 * @param {Array<Array<*>>} paypalValues   full "Raw KH001 PayPal" grid
 * @param {Array<Array<*>>} reconciledValues full "Raw KH001 Reconciled" grid
 * @param {string} sourceFingerprint
 * @return {{rows: Array<Object>, paymentRows: number}}
 */
function buildKh001ProviderTransactions_(paypalValues, reconciledValues, sourceFingerprint) {
  const cfg = KH001_PROVIDER_TX;
  if (paypalValues.length < cfg.paypalHeaderRow) throw new Error('Raw KH001 PayPal has no header row.');
  if (reconciledValues.length < cfg.reconciledHeaderRow) {
    throw new Error('Raw KH001 Reconciled has no header row ' + cfg.reconciledHeaderRow + '.');
  }
  const pp = buildHeaderMap_(paypalValues[cfg.paypalHeaderRow - 1], cfg.paypalRequiredHeaders, 'Raw KH001 PayPal');
  const rc = buildHeaderMap_(reconciledValues[cfg.reconciledHeaderRow - 1], cfg.reconciledRequiredHeaders,
    'Raw KH001 Reconciled');
  const col = function (map, name) { return map[normalizeLabel_(name)]; };

  // Index reconciled rows by exact Transaction ID (sheet row numbers, 1-based).
  const reconciledById = {};
  for (let r = cfg.reconciledHeaderRow; r < reconciledValues.length; r++) {
    const id = canonicalText_(reconciledValues[r][col(rc, 'Transaction ID')]);
    if (id === '') continue;
    (reconciledById[id] = reconciledById[id] || []).push(r + 1);
  }

  const paymentGroup = normalizeLabel_(cfg.paymentGroupValue);
  const errors = [];
  const seen = {};
  const rows = [];
  let paymentRows = 0;

  for (let r = cfg.paypalHeaderRow; r < paypalValues.length; r++) {
    const row = paypalValues[r];
    const sheetRow = r + 1;
    if (normalizeLabel_(row[col(pp, 'Nhóm GD')]) !== paymentGroup) continue;
    paymentRows++;

    const id = canonicalText_(row[col(pp, 'Transaction ID')]);
    if (id === '') { errors.push('Raw KH001 PayPal row ' + sheetRow + ': blank Transaction ID'); continue; }
    if (seen[id]) {
      errors.push('Duplicate payment Transaction ID ' + id + ' (rows ' + seen[id] + ', ' + sheetRow + ')');
      continue;
    }
    seen[id] = sheetRow;

    const gross = row[col(pp, 'Gross')];
    const rawFee = row[col(pp, 'Fee')];
    const net = row[col(pp, 'Net')];
    if (!isFiniteNumber_(gross) || !isFiniteNumber_(rawFee) || !isFiniteNumber_(net)) {
      errors.push('Non-numeric Gross/Fee/Net for Transaction ID ' + id);
      continue;
    }
    const fee = Math.abs(rawFee);
    if (!amountInvariantHolds_(gross, fee, net)) {
      errors.push('Amount invariant failed for Transaction ID ' + id + ': ' + gross + ' - ' + fee + ' != ' + net);
      continue;
    }
    const at = row[col(pp, 'Thời gian')];
    if (!isDateValue_(at) || isNaN(at.getTime())) {
      errors.push('Thời gian is not a date-time for Transaction ID ' + id);
      continue;
    }

    const matches = reconciledById[id] || [];
    if (matches.length > 1) {
      errors.push('Transaction ID ' + id + ' appears in Raw KH001 Reconciled rows ' + matches.join(', '));
      continue;
    }
    let reconciliation = {
      status: cfg.providerOnlyStatus, rawStatus: '', subAccount: '', difference: '', row: '',
    };
    if (matches.length === 1) {
      const rcRow = reconciledValues[matches[0] - 1];
      const rawStatus = rcRow[col(rc, 'Trạng thái')];
      let status;
      try {
        status = mapKh001ReconciliationStatus_(rawStatus);
      } catch (e) {
        errors.push(e.message + ' (Transaction ID ' + id + ')');
        continue;
      }
      const difference = rcRow[col(rc, 'Chênh lệch')];
      if (!isBlankCell_(difference) && !isFiniteNumber_(difference)) {
        errors.push('Non-numeric Chênh lệch for Transaction ID ' + id);
        continue;
      }
      reconciliation = {
        status: status,
        rawStatus: canonicalText_(rawStatus),
        subAccount: canonicalText_(rcRow[col(rc, 'Sub account')]),
        difference: isBlankCell_(difference) ? '' : difference,
        row: matches[0],
      };
    }

    rows.push({
      provider_transaction_id: kh001ProviderTransactionId_(id),
      provider_id: cfg.providerId,
      payment_source: cfg.paymentSource,
      gateway_id: canonicalText_(row[col(pp, 'Mã cổng')]),
      external_transaction_id: id,
      transaction_at: at,
      currency: canonicalText_(row[col(pp, 'Currency')]),
      gross_amount: gross,
      processing_fee: fee,
      net_amount: net,
      external_status: canonicalText_(row[col(pp, 'Status')]),
      raw_type: canonicalText_(row[col(pp, 'Type')]),
      balance_impact: canonicalText_(row[col(pp, 'Balance Impact')]),
      order_reference: canonicalText_(row[col(pp, 'Invoice Number')]),
      payer_reference: canonicalText_(row[col(pp, 'From Email Address')]),
      provider_sub_account: reconciliation.subAccount,
      provider_reconciliation_status: reconciliation.status,
      provider_reconciliation_raw_status: reconciliation.rawStatus,
      reconciliation_difference: reconciliation.difference,
      source_paypal_row: sheetRow,
      source_reconciled_row: reconciliation.row,
      source_fingerprint: sourceFingerprint,
      normalizer_version: cfg.normalizerVersion,
      normalized_at: '',
    });
  }

  if (errors.length > 0) {
    const shown = errors.slice(0, cfg.maxReportedErrors);
    const more = errors.length > shown.length ? ' | ... ' + (errors.length - shown.length) + ' more' : '';
    throw new Error('KH001 provider transaction normalization failed (' + errors.length + ' error(s)): ' +
      shown.join(' | ') + more);
  }
  return { rows: rows, paymentRows: paymentRows };
}

function toCents_(v) {
  return isFiniteNumber_(v) ? Math.round(v * 100) : 0;
}

/**
 * Generic summary of canonical provider transaction objects (no snapshot-specific numbers).
 */
function summarizeProviderTransactions_(rows) {
  const ids = rows.map(function (r) { return String(r.external_transaction_id); });
  const counts = {};
  ids.forEach(function (id) { counts[id] = (counts[id] || 0) + 1; });
  const tally = function (field) {
    return rows.reduce(function (acc, r) {
      const k = String(r[field]);
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
  };
  const sum = function (subset) {
    const cents = subset.reduce(function (acc, r) {
      acc.gross += toCents_(r.gross_amount);
      acc.fee += toCents_(r.processing_fee);
      acc.net += toCents_(r.net_amount);
      return acc;
    }, { gross: 0, fee: 0, net: 0 });
    return { gross: cents.gross / 100, processing_fee: cents.fee / 100, net: cents.net / 100 };
  };
  const invariantErrors = rows
    .filter(function (r) {
      return !isFiniteNumber_(r.gross_amount) || !isFiniteNumber_(r.processing_fee) || !isFiniteNumber_(r.net_amount) ||
        r.processing_fee < 0 || !amountInvariantHolds_(r.gross_amount, r.processing_fee, r.net_amount);
    })
    .map(function (r) { return String(r.external_transaction_id); });

  return {
    row_count: rows.length,
    unique_transaction_count: Object.keys(counts).length,
    duplicate_ids: Object.keys(counts).filter(function (k) { return counts[k] > 1; }).sort(),
    amount_invariant_errors: invariantErrors,
    status_counts: tally('external_status'),
    currency_counts: tally('currency'),
    reconciliation_counts: tally('provider_reconciliation_status'),
    provider_only_transaction_ids: rows
      .filter(function (r) { return r.provider_reconciliation_status === KH001_PROVIDER_TX.providerOnlyStatus; })
      .map(function (r) { return String(r.external_transaction_id); })
      .sort(),
    totals: sum(rows),
    completed_totals: sum(rows.filter(function (r) { return r.external_status === 'Completed'; })),
  };
}

/** Compares a summary with the current-snapshot regression expectations (report only). */
function evaluateKh001ProviderTxRegression_(summary) {
  const exp = KH001_PROVIDER_TX_REGRESSION;
  const checks = [];
  const add = function (name, expected, actual, pass) {
    checks.push({ name: name, expected: expected, actual: actual, pass: pass });
  };
  const sameCounts = function (e, a) {
    return Object.keys(e).every(function (k) { return (a[k] || 0) === e[k]; }) &&
      Object.keys(a).every(function (k) { return Object.prototype.hasOwnProperty.call(e, k); });
  };
  const near = function (e, a) { return Math.round(e * 100) === Math.round(a * 100); };

  add('row_count', exp.row_count, summary.row_count, summary.row_count === exp.row_count);
  add('unique_transaction_count', exp.unique_transaction_count, summary.unique_transaction_count,
    summary.unique_transaction_count === exp.unique_transaction_count);
  add('status_counts', exp.status_counts, summary.status_counts, sameCounts(exp.status_counts, summary.status_counts));
  add('currency_counts', exp.currency_counts, summary.currency_counts,
    sameCounts(exp.currency_counts, summary.currency_counts));
  add('reconciliation_counts', exp.reconciliation_counts, summary.reconciliation_counts,
    sameCounts(exp.reconciliation_counts, summary.reconciliation_counts));
  add('provider_only_transaction_ids', exp.provider_only_transaction_ids, summary.provider_only_transaction_ids,
    JSON.stringify(exp.provider_only_transaction_ids) === JSON.stringify(summary.provider_only_transaction_ids));
  ['gross', 'processing_fee', 'net'].forEach(function (k) {
    add('totals.' + k, exp.totals[k], summary.totals[k], near(exp.totals[k], summary.totals[k]));
    add('completed_totals.' + k, exp.completed_totals[k], summary.completed_totals[k],
      near(exp.completed_totals[k], summary.completed_totals[k]));
  });
  return {
    snapshot: exp.snapshot,
    pass: checks.every(function (c) { return c.pass; }),
    failed: checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }),
    checks: checks,
  };
}

/**
 * Read-only dependency freshness check used by downstream normalizers.
 * Rebuilds the KH001 partition in memory from the given raw grids (same normalizer and
 * source fingerprint as normalizeKh001ProviderTransactions) and compares it with the
 * stored KH001 rows over full row content, excluding only normalized_at, in stored order.
 * Detects a partition that is stale (raw changed, normalizer not rerun) as well as
 * manual edits that kept IDs and source_fingerprint intact.
 * @param {{values: Array<Array<*>>, checksum: string}} paypalGrid "Raw KH001 PayPal"
 * @param {{values: Array<Array<*>>, checksum: string}} reconciledGrid "Raw KH001 Reconciled"
 * @param {Array<Array<*>>} storedRows Provider Transactions data rows (all providers)
 * @param {Array<string>} columns Provider Transactions columns
 * @return {{current: boolean, expected_checksum: ?string, stored_checksum: string,
 *           expected_rows: ?number, stored_rows: number, reason: ?string}}
 */
function checkKh001ProviderTransactionsCurrent_(paypalGrid, reconciledGrid, storedRows, columns) {
  const providerIdx = columns.indexOf('provider_id');
  const stored = storedRows.filter(function (r) { return r[providerIdx] === KH001_PROVIDER_TX.providerId; });
  const storedChecksum = tableChecksumExcluding_(buildTableValues_(columns, stored), [columns.indexOf('normalized_at')]);
  const result = {
    current: false,
    expected_checksum: null,
    stored_checksum: storedChecksum,
    expected_rows: null,
    stored_rows: stored.length,
    reason: null,
  };
  let built;
  try {
    const fingerprint = computeKh001SourceFingerprint_(paypalGrid.checksum, reconciledGrid.checksum);
    built = buildKh001ProviderTransactions_(paypalGrid.values, reconciledGrid.values, fingerprint);
  } catch (e) {
    result.reason = 'Provider Transactions cannot be rebuilt from the current raw snapshot: ' + e.message;
    return result;
  }
  result.expected_rows = built.rows.length;
  result.expected_checksum = kh001PartitionChecksum_(built.rows.map(function (o) { return objectToRow_(o, columns); }), columns);
  result.current = result.expected_checksum === storedChecksum;
  if (!result.current) {
    result.reason = 'Provider Transactions KH001 partition is stale or modified; run normalizeKh001ProviderTransactions first ' +
      '(expected ' + result.expected_rows + ' rows / ' + result.expected_checksum + ', stored ' + result.stored_rows +
      ' rows / ' + storedChecksum + ').';
  }
  return result;
}

/* ---------------------------------- I/O --------------------------------- */

/** Target/staging descriptor (a function so no other file's constant is read at load time). */
function providerTransactionsTab_() {
  return { targetSheet: SHEETS.PROVIDER_TRANSACTIONS, stagingSheet: '__STAGE_PROVIDER_TRANSACTIONS' };
}

const PROVIDER_TX_KEY_COLUMNS = ['provider_id', 'payment_source', 'external_transaction_id'];
const PROVIDER_TX_SORT_COLUMNS = ['provider_id', 'payment_source', 'transaction_at', 'external_transaction_id'];

/** Reads both Master raw tabs (whole grids) and computes the source fingerprint. Read-only. */
function readKh001ProviderInputs_(ss) {
  const read = function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) throw new Error('Raw tab "' + name + '" not found. Run syncKh001Raw first.');
    return readSheetGrid_(sheet);
  };
  const paypal = read(SHEETS.RAW_KH001_PAYPAL);
  const reconciled = read(SHEETS.RAW_KH001_RECONCILED);
  return {
    paypal: paypal,
    reconciled: reconciled,
    fingerprint: computeKh001SourceFingerprint_(paypal.checksum, reconciled.checksum),
  };
}

/** KH001 partition (header + sorted rows) checksum, excluding normalized_at. */
function kh001PartitionChecksum_(rowsAsArrays, columns) {
  const sorted = sortCanonicalRows_(rowsAsArrays, PROVIDER_TX_SORT_COLUMNS.map(function (c) {
    return columns.indexOf(c);
  }));
  return tableChecksumExcluding_(buildTableValues_(columns, sorted), [columns.indexOf('normalized_at')]);
}

/** Normalizes KH001 into Provider Transactions under the script lock. Never throws. */
function runKh001ProviderTransactionsNormalizer_() {
  const cfg = KH001_PROVIDER_TX;
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  const details = { normalizer_version: cfg.normalizerVersion };
  let status = 'FAILED';
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms.');
    const ss = getSpreadsheet_();
    const table = getTableSchema_(SHEETS.PROVIDER_TRANSACTIONS);
    const columns = table.columns.map(function (c) { return c.name; });

    const input = readKh001ProviderInputs_(ss);
    details.source_fingerprint = input.fingerprint;
    details.paypal_checksum = input.paypal.checksum;
    details.reconciled_checksum = input.reconciled.checksum;

    const built = buildKh001ProviderTransactions_(input.paypal.values, input.reconciled.values, input.fingerprint);
    const partition = built.rows.map(function (o) { return objectToRow_(o, columns); });
    const summary = summarizeProviderTransactions_(built.rows);
    details.input_payment_rows = built.paymentRows;
    details.output_rows = summary.row_count;
    details.output_checksum = kh001PartitionChecksum_(partition, columns);
    details.status_counts = summary.status_counts;
    details.reconciliation_counts = summary.reconciliation_counts;
    details.currency_counts = summary.currency_counts;

    const result = replaceCanonicalPartition_(ss, {
      table: table,
      tab: providerTransactionsTab_(),
      providerId: cfg.providerId,
      partitionRows: partition,
      keyColumns: PROVIDER_TX_KEY_COLUMNS,
      sortColumns: PROVIDER_TX_SORT_COLUMNS,
      stampColumn: 'normalized_at',
    });
    details.swap_state = result.swapState;
    details.swap_actions = result.swapActions;
    details.table_rows = result.tableRows;
    status = result.status;
  } catch (err) {
    details.error = err && err.message ? err.message : String(err);
    status = 'FAILED';
  } finally {
    try {
      appendAuditLog_({
        action: cfg.providerId + '_PROVIDER_TRANSACTIONS_NORMALIZE_' + status,
        entityType: 'PROVIDER_TRANSACTIONS',
        entityId: cfg.providerId,
        newStatus: status,
        details: details,
      });
    } catch (auditErr) {
      Logger.log('Failed to write audit entry: %s', auditErr);
    }
    if (locked) lock.releaseLock();
  }
  return Object.assign({ provider: cfg.providerId, status: status }, details);
}

/** Read-only verification of the KH001 partition against the current raw snapshot. */
function buildKh001ProviderTransactionsReport_() {
  const cfg = KH001_PROVIDER_TX;
  const report = {
    provider: cfg.providerId,
    normalizer_version: cfg.normalizerVersion,
    source: {},
    output: {},
    status_counts: {},
    currency_counts: {},
    reconciliation_counts: {},
    provider_only_transaction_ids: [],
    totals: {},
    completed_totals: {},
    swap_state: null,
    target_match: false,
    pass: false,
    errors: [],
    regression: null,
  };
  try {
    const ss = getSpreadsheet_();
    const table = getTableSchema_(SHEETS.PROVIDER_TRANSACTIONS);
    const columns = table.columns.map(function (c) { return c.name; });

    const input = readKh001ProviderInputs_(ss);
    report.source = {
      paypal_rows: input.paypal.rows,
      paypal_columns: input.paypal.columns,
      paypal_checksum: input.paypal.checksum,
      reconciled_rows: input.reconciled.rows,
      reconciled_columns: input.reconciled.columns,
      reconciled_checksum: input.reconciled.checksum,
      source_fingerprint: input.fingerprint,
    };

    let expectedChecksum = null;
    try {
      const built = buildKh001ProviderTransactions_(input.paypal.values, input.reconciled.values, input.fingerprint);
      report.source.payment_rows = built.paymentRows;
      expectedChecksum = kh001PartitionChecksum_(built.rows.map(function (o) { return objectToRow_(o, columns); }),
        columns);
    } catch (e) {
      report.errors.push('Normalizer validation: ' + e.message);
    }

    report.swap_state = detectSwapState_(ss, providerTransactionsTab_()).state;
    if (report.swap_state !== 'NORMAL') report.errors.push('Swap state is ' + report.swap_state + '.');

    const target = ss.getSheetByName(SHEETS.PROVIDER_TRANSACTIONS);
    if (!target) throw new Error('Provider Transactions tab not found.');
    const allRows = tableRowsFromGrid_(readSheetGrid_(target).values, columns, SHEETS.PROVIDER_TRANSACTIONS);
    const providerIdx = columns.indexOf('provider_id');
    const kh001Rows = allRows.filter(function (r) { return r[providerIdx] === cfg.providerId; });
    const summary = summarizeProviderTransactions_(kh001Rows.map(function (r) { return rowToObject_(r, columns); }));

    // Whole-table unique key check (all providers).
    const tableDuplicates = findDuplicateKeys_(allRows, PROVIDER_TX_KEY_COLUMNS.map(function (c) {
      return columns.indexOf(c);
    }));
    const outputChecksum = kh001PartitionChecksum_(kh001Rows, columns);

    report.output = {
      row_count: summary.row_count,
      unique_transaction_count: summary.unique_transaction_count,
      output_checksum: outputChecksum,
      expected_checksum: expectedChecksum,
      duplicate_ids: summary.duplicate_ids,
      table_duplicate_keys: tableDuplicates,
      amount_invariant_errors: summary.amount_invariant_errors,
      table_rows_all_providers: allRows.length,
    };
    report.status_counts = summary.status_counts;
    report.currency_counts = summary.currency_counts;
    report.reconciliation_counts = summary.reconciliation_counts;
    report.provider_only_transaction_ids = summary.provider_only_transaction_ids;
    report.totals = summary.totals;
    report.completed_totals = summary.completed_totals;

    // Stored order must equal canonical order, so compare the stored rows directly.
    const storedChecksum = tableChecksumExcluding_(buildTableValues_(columns, kh001Rows),
      [columns.indexOf('normalized_at')]);
    report.target_match = expectedChecksum !== null && storedChecksum === expectedChecksum;
    if (!report.target_match) report.errors.push('Provider Transactions KH001 partition does not match raw snapshot.');
    if (summary.duplicate_ids.length > 0) report.errors.push('Duplicate external_transaction_id in KH001 partition.');
    if (tableDuplicates.length > 0) report.errors.push('Duplicate unique keys in Provider Transactions.');
    if (summary.amount_invariant_errors.length > 0) report.errors.push('Amount invariant errors present.');

    report.regression = evaluateKh001ProviderTxRegression_(summary);
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0 && report.target_match;
  return report;
}
