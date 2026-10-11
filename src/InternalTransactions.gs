/**
 * InternalTransactions.gs
 * Internal CSV ingestion layer: Raw Internal Transactions (append-only evidence) ->
 * Source System (latest canonical snapshot) -> Transactions (canonical + ownership).
 *
 * - Raw rows are never modified here. Each raw row carries row_fingerprint =
 *   SHA-256 over its 16 CSV fields (computeInternalRowFingerprint_); a mismatch fails.
 * - Snapshot selection per transaction_id: latest imported_at wins (tie: import_batch_id,
 *   then source_row_number). A transaction_id under two payment sources fails; one batch
 *   holding two different snapshots of the same transaction_id fails. Identical repeats are fine.
 * - Gateway: exactly paypal -> PAYPAL, stripe -> STRIPE (case-insensitive); anything else fails.
 * - Ownership: exact endpoint_token === Endpoint Mapping.endpoint_key on the created date in
 *   America/New_York. No split / prefix / fuzzy matching and no fallback via sub_account or names.
 *   No mapping -> UNASSIGNED_ENDPOINT (kept, not seller money); overlapping history -> fail.
 * - status is UNMATCHED (provider matching is a later phase). settled_at / refunded_at are raw
 *   internal information only: they never create settlement, availability or adjustments.
 * - No provider matching, Payment Legs, fees, holds, balances or payouts here.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const INTERNAL_TX = Object.freeze({
  providerId: 'INTERNAL',
  rawColumns: ['order_id', 'payment_method', 'transaction_id', 'gateway', 'status', 'total', 'currency', 'sub_account',
    'store_domain', 'shield_domain', 'endpoint_token', 'created_at', 'refunded_at', 'customer', 'settled_at', 'note'],
  fingerprintVersion: 'INTERNAL_RAW_V1',
  sourceRecordPrefix: 'ISRC-',
  gatewayMap: { paypal: 'PAYPAL', stripe: 'STRIPE' },
  naiveTimezoneSetting: 'source.INTERNAL.naive_timestamp_timezone',
  initialStatus: 'UNMATCHED',
  maxReportedErrors: 30,
});

/** Current-snapshot regression expectations (first internal batch, October 2026). Report only. */
const INTERNAL_TX_REGRESSION = Object.freeze({
  snapshot: 'Internal CSV transactions-filtered-2026-10-10 (first batch)',
  transaction_rows: 356,
  raw_unique_transaction_ids: 356,
  payment_source_counts: { PAYPAL: 354, STRIPE: 2 },
  raw_status_counts: { captured: 356 },
  currency_counts: { USD: 356 },
  gross_total: 23225.30,
  refunded_nonblank: 0,
  settled_nonblank: 1,
  endpoint_counts: { glk_WuMQAJ: 143, glk_7VT7Ye: 99, glk_r8XToW: 75, glk_qP5uSk: 26, glk_g7kaNA: 10, glk_gcucLF: 3 },
  mapped_rows: 356,
  unassigned_endpoint_rows: 0,
});

/* ----------------------------- Pure helpers ----------------------------- */

/** Text form of a raw CSV field (raw is stored as text; never trimmed or otherwise changed). */
function rawFieldText_(value) {
  if (value === null || value === undefined) return '';
  if (isDateValue_(value)) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

/**
 * row_fingerprint: lowercase hex SHA-256 (UTF-8) of
 *   "INTERNAL_RAW_V1" + U+001E + join(U+001F, field_i for the 16 raw fields in order)
 * where field_i = "E" for an empty field, else "S" + JSON.stringify(text).
 * Metadata columns are not included, so the same CSV row always has the same fingerprint.
 */
function computeInternalRowFingerprint_(raw, digestHex) {
  const digest = digestHex || sha256Hex_;
  const fields = INTERNAL_TX.rawColumns.map(function (c) {
    const text = rawFieldText_(raw[c]);
    return text === '' ? 'E' : 'S' + JSON.stringify(text);
  });
  return digest(INTERNAL_TX.fingerprintVersion + '\u001e' + fields.join('\u001f'));
}

/** paypal -> PAYPAL, stripe -> STRIPE (case-insensitive, surrounding whitespace ignored); else null. */
function normalizeInternalGateway_(value) {
  const key = rawFieldText_(value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(INTERNAL_TX.gatewayMap, key) ? INTERNAL_TX.gatewayMap[key] : null;
}

/**
 * Parses an internal timestamp to a Date instant. Accepts a Date, or ISO-like
 * "YYYY-MM-DD[T ]HH:mm[:ss[.fff]]" with Z / ±HH:MM / ±HHMM. A timestamp without an offset is
 * accepted only when naiveTimeZone is configured (parsed with parseLocal(text, tz)).
 * @param {function(string, string): Date} parseLocal "yyyy-MM-dd HH:mm:ss" in tz -> Date
 */
function parseInternalTimestamp_(value, naiveTimeZone, parseLocal) {
  if (isDateValue_(value)) {
    if (isNaN(value.getTime())) throw new Error('invalid date');
    return value;
  }
  const text = rawFieldText_(value).trim();
  if (text === '') throw new Error('is blank');
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(?:\.\d{1,9})?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(text);
  if (!m) throw new Error('"' + text + '" is not a supported timestamp');
  const seconds = m[3] || ':00';
  if (m[4]) {
    const offset = m[4].toUpperCase() === 'Z' ? 'Z' : m[4].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    const fraction = seconds.indexOf('.') >= 0 ? (seconds + '000').slice(0, 7) : seconds;
    const date = new Date(m[1] + 'T' + m[2] + fraction + offset);
    if (isNaN(date.getTime())) throw new Error('"' + text + '" is not a valid timestamp');
    return date;
  }
  if (!naiveTimeZone) {
    throw new Error('"' + text + '" has no timezone offset; set Settings ' + INTERNAL_TX.naiveTimezoneSetting);
  }
  const date = parseLocal(m[1] + ' ' + m[2] + seconds.slice(0, 3), naiveTimeZone);
  if (!isDateValue_(date) || isNaN(date.getTime())) throw new Error('"' + text + '" is not a valid local timestamp');
  return date;
}

function internalSourceRecordId_(paymentSource, internalTransactionId, digestHex) {
  const digest = digestHex || sha256Hex_;
  return INTERNAL_TX.sourceRecordPrefix + digest(paymentSource + '|' + internalTransactionId);
}

function emptyInternalErrors_() {
  return { contract: [], gateway: [], conflict: [], ambiguous: [], mapping: [], data: [] };
}

/**
 * Builds Source System and Transactions objects from raw rows.
 * @param {Array<Object>} rawRows raw objects keyed by Raw Internal Transactions columns (+ _row)
 * @param {Array<Object>} mappingRecords Endpoint Mapping records (date keys)
 * @param {{naiveTimeZone: string, parseLocal: Function, ownershipTimeZone: string, digestHex?: Function}} opts
 * @return {{sourceRows: Array<Object>, transactions: Array<Object>, errors: Object, stats: Object}}
 */
function buildInternalCanonical_(rawRows, mappingRecords, opts) {
  const errors = emptyInternalErrors_();
  const digest = opts.digestHex;
  const snapshots = [];

  rawRows.forEach(function (raw) {
    const label = 'Raw row ' + raw._row;
    const id = rawFieldText_(raw.transaction_id).trim();
    if (id === '') { errors.data.push(label + ': transaction_id is blank'); return; }
    const tag = label + ' (' + id + ')';
    let bad = false;
    const fingerprint = computeInternalRowFingerprint_(raw, digest);
    if (trimmedText_(raw.row_fingerprint) !== fingerprint) {
      errors.contract.push(tag + ': row_fingerprint does not match the 16 raw fields'); bad = true;
    }
    if (trimmedText_(raw.import_batch_id) === '') { errors.contract.push(tag + ': import_batch_id is blank'); bad = true; }
    if (trimmedText_(raw.source_file_name) === '') { errors.contract.push(tag + ': source_file_name is blank'); bad = true; }
    const rowText = rawFieldText_(raw.source_row_number).trim();
    const rowNumber = /^\d+$/.test(rowText) ? Number(rowText) : NaN;
    if (!(rowNumber >= 1)) {
      errors.contract.push(tag + ': source_row_number must be a positive integer'); bad = true;
    }
    let importedAt = null;
    try { importedAt = parseInternalTimestamp_(raw.imported_at, opts.naiveTimeZone, opts.parseLocal); } catch (e) {
      errors.contract.push(tag + ': imported_at ' + e.message); bad = true;
    }
    const source = normalizeInternalGateway_(raw.gateway);
    if (!source) { errors.gateway.push(tag + ': unsupported gateway "' + rawFieldText_(raw.gateway) + '"'); bad = true; }
    let createdAt = null;
    try { createdAt = parseInternalTimestamp_(raw.created_at, opts.naiveTimeZone, opts.parseLocal); } catch (e) {
      errors.data.push(tag + ': created_at ' + e.message); bad = true;
    }
    const amountText = rawFieldText_(raw.total).trim();
    const amount = /^-?\d+(\.\d+)?$/.test(amountText) ? Number(amountText) : NaN;
    if (!isFinite(amount)) { errors.data.push(tag + ': total "' + amountText + '" is not a plain decimal number'); bad = true; }
    if (bad) return;
    snapshots.push({ raw: raw, id: id, source: source, fingerprint: fingerprint, importedAt: importedAt,
      batch: trimmedText_(raw.import_batch_id), rowNumber: rowNumber, createdAt: createdAt, amount: amount });
  });

  // Group by transaction_id and pick the latest snapshot.
  const groups = {};
  snapshots.forEach(function (s) { (groups[s.id] = groups[s.id] || []).push(s); });
  const latest = [];
  Object.keys(groups).sort().forEach(function (id) {
    const list = groups[id];
    const sources = list.map(function (s) { return s.source; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (sources.length > 1) { errors.conflict.push('transaction_id ' + id + ' appears under payment sources ' + sources.sort().join(', ')); return; }
    const byBatch = {};
    list.forEach(function (s) { (byBatch[s.batch] = byBatch[s.batch] || {})[s.fingerprint] = true; });
    const ambiguous = Object.keys(byBatch).filter(function (b) { return Object.keys(byBatch[b]).length > 1; });
    if (ambiguous.length > 0) {
      errors.ambiguous.push('transaction_id ' + id + ' has different snapshots within batch ' + ambiguous.sort().join(', '));
      return;
    }
    latest.push(list.slice().sort(function (a, b) {
      const t = a.importedAt.getTime() - b.importedAt.getTime();
      if (t !== 0) return t;
      if (a.batch !== b.batch) return a.batch < b.batch ? -1 : 1;
      return a.rowNumber - b.rowNumber;
    })[list.length - 1]);
  });

  const sourceRows = [];
  const transactions = [];
  latest.forEach(function (s) {
    const r = s.raw;
    const text = function (c) { return rawFieldText_(r[c]); };
    const sourceRecordId = internalSourceRecordId_(s.source, s.id, digest);
    const token = text('endpoint_token').trim();
    sourceRows.push({
      source_record_id: sourceRecordId, internal_transaction_id: s.id, payment_source: s.source, gateway: text('gateway'),
      created_at: s.createdAt, endpoint_token: token, sub_account: text('sub_account'), store_domain: text('store_domain'),
      shield_domain: text('shield_domain'), order_id: text('order_id'), payment_method: text('payment_method'),
      order_amount: s.amount, currency: text('currency').trim(), raw_status: text('status'), refunded_at: text('refunded_at'),
      customer: text('customer'), settled_at_raw: text('settled_at'), note: text('note'), row_fingerprint: s.fingerprint,
      import_batch_id: s.batch, source_file_name: trimmedText_(r.source_file_name), imported_at: s.importedAt,
    });

    // Ownership: exact token on the created date (never sub_account / names / partial keys).
    let mapping = null;
    if (token !== '') {
      try {
        const dateKey = providerDateKey_(s.createdAt, opts.ownershipTimeZone);
        mapping = resolveEndpointByKey_(mappingRecords, token, dateKey).mapping;
      } catch (e) {
        errors.mapping.push('transaction_id ' + s.id + ': ' + e.message);
        return;
      }
    }
    transactions.push({
      internal_transaction_id: s.id, created_at: s.createdAt, payment_source: s.source, endpoint_token: token,
      mapping_id: mapping ? mapping.mapping_id : '', mapping_version: mapping ? mapping.opened_version : '',
      seller_id: mapping ? mapping.seller_id : '', seller_name_snapshot: mapping ? mapping.seller_name_snapshot : '',
      endpoint_name_snapshot: mapping ? mapping.endpoint_name : '', store_domain: text('store_domain'),
      shield_domain: text('shield_domain'), sub_account: text('sub_account'), order_id: text('order_id'),
      payment_method: text('payment_method'), order_amount: s.amount, currency: text('currency').trim(),
      customer: text('customer'), raw_status: text('status'), refunded_at_raw: text('refunded_at'),
      settled_at_raw: text('settled_at'), ownership_status: mapping ? 'MAPPED' : 'UNASSIGNED_ENDPOINT',
      status: INTERNAL_TX.initialStatus, source_record_id: sourceRecordId, source_row_fingerprint: s.fingerprint,
      import_batch_id: s.batch, updated_at: '',
    });
  });

  sourceRows.sort(function (a, b) {
    return compareCanonicalValues_(a.payment_source, b.payment_source) ||
      compareCanonicalValues_(a.internal_transaction_id, b.internal_transaction_id);
  });
  transactions.sort(function (a, b) {
    return compareCanonicalValues_(a.created_at, b.created_at) ||
      compareCanonicalValues_(a.internal_transaction_id, b.internal_transaction_id);
  });
  const fingerprints = {};
  rawRows.forEach(function (r) { fingerprints[trimmedText_(r.row_fingerprint)] = true; });
  return {
    sourceRows: sourceRows,
    transactions: transactions,
    errors: errors,
    stats: {
      raw_rows: rawRows.length,
      raw_unique_transaction_ids: Object.keys(groups).length,
      raw_unique_fingerprints: Object.keys(fingerprints).filter(function (f) { return f !== ''; }).length,
    },
  };
}

function flattenInternalErrors_(errors) {
  return [].concat(errors.contract, errors.gateway, errors.conflict, errors.ambiguous, errors.mapping, errors.data);
}

/** Generic summary of canonical transaction objects (no snapshot-specific numbers). */
function summarizeInternalTransactions_(transactions) {
  const tally = function (field) {
    return transactions.reduce(function (acc, t) { const k = String(t[field]); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  };
  const cents = transactions.reduce(function (acc, t) { return acc + toCents_(t.order_amount); }, 0);
  return {
    transaction_rows: transactions.length,
    mapped_rows: transactions.filter(function (t) { return t.ownership_status === 'MAPPED'; }).length,
    unassigned_endpoint_rows: transactions.filter(function (t) { return t.ownership_status === 'UNASSIGNED_ENDPOINT'; }).length,
    payment_source_counts: tally('payment_source'),
    endpoint_counts: tally('endpoint_token'),
    currency_counts: tally('currency'),
    raw_status_counts: tally('raw_status'),
    seller_counts: tally('seller_id'),
    status_counts: tally('status'),
    gross_total: cents / 100,
    refunded_nonblank: transactions.filter(function (t) { return String(t.refunded_at_raw).trim() !== ''; }).length,
    settled_nonblank: transactions.filter(function (t) { return String(t.settled_at_raw).trim() !== ''; }).length,
  };
}

/** Regression report against the first internal batch (report only). */
function evaluateInternalTxRegression_(summary, stats) {
  const exp = INTERNAL_TX_REGRESSION;
  const checks = [];
  const add = function (name, e, a, pass) { checks.push({ name: name, expected: e, actual: a, pass: pass }); };
  const same = function (e, a) {
    return Object.keys(e).every(function (k) { return (a[k] || 0) === e[k]; }) &&
      Object.keys(a).every(function (k) { return Object.prototype.hasOwnProperty.call(e, k); });
  };
  ['transaction_rows', 'mapped_rows', 'unassigned_endpoint_rows', 'refunded_nonblank', 'settled_nonblank'].forEach(function (k) {
    add(k, exp[k], summary[k], summary[k] === exp[k]);
  });
  add('raw_unique_transaction_ids', exp.raw_unique_transaction_ids, stats.raw_unique_transaction_ids,
    stats.raw_unique_transaction_ids === exp.raw_unique_transaction_ids);
  ['payment_source_counts', 'raw_status_counts', 'currency_counts', 'endpoint_counts'].forEach(function (k) {
    add(k, exp[k], summary[k], same(exp[k], summary[k]));
  });
  add('gross_total', exp.gross_total, summary.gross_total, Math.round(exp.gross_total * 100) === Math.round(summary.gross_total * 100));
  return { snapshot: exp.snapshot, pass: checks.every(function (c) { return c.pass; }),
    failed: checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }), checks: checks };
}

/**
 * Freshness of stored Transactions: equal to the canonical result of the given build (current
 * raw + current Endpoint Mapping) over the whole grid, ignoring only updated_at.
 * @return {{current: boolean, expected_checksum: ?string, stored_checksum: string, reason: ?string}}
 */
function checkInternalTransactionsFresh_(built, storedValues, columns) {
  const updatedIdx = [columns.indexOf('updated_at')];
  const stored = tableChecksumExcluding_(storedValues, updatedIdx);
  const problems = flattenInternalErrors_(built.errors).length;
  if (problems > 0) {
    return { current: false, expected_checksum: null, stored_checksum: stored,
      reason: 'Transactions is stale; run normalizeInternalTransactions first (raw has ' + problems + ' error(s)).' };
  }
  const expected = tableChecksumExcluding_(buildTableValues_(columns,
    built.transactions.map(function (o) { return objectToRow_(o, columns); })), updatedIdx);
  const current = expected === stored;
  return { current: current, expected_checksum: expected, stored_checksum: stored,
    reason: current ? null : 'Transactions is stale; run normalizeInternalTransactions first.' };
}

/** Per-transaction content checksum, ignoring updated_at. */
function internalTransactionContentKey_(row, columns) {
  const idx = columns.indexOf('updated_at');
  return serializeRow_(row.map(function (v, i) { return i === idx ? '' : v; }));
}

/* ---------------------------------- I/O --------------------------------- */

function sourceSystemTab_() {
  return { targetSheet: SHEETS.SOURCE_SYSTEM, stagingSheet: '__STAGE_SOURCE_SYSTEM' };
}

function transactionsTab_() {
  return { targetSheet: SHEETS.TRANSACTIONS, stagingSheet: '__STAGE_TRANSACTIONS' };
}

function readInternalRawRows_(ss) {
  const sheet = ss.getSheetByName(SHEETS.RAW_INTERNAL_TRANSACTIONS);
  if (!sheet) throw new Error('Raw Internal Transactions tab not found. Run setupMaster first.');
  const columns = getColumnNames_(SHEETS.RAW_INTERNAL_TRANSACTIONS);
  const grid = readSheetGrid_(sheet);
  const header = grid.values[0].map(function (h) { return String(h).trim(); });
  if (header.length < columns.length || header.slice(0, columns.length).join('\u0000') !== columns.join('\u0000') ||
      header.slice(columns.length).some(function (h) { return h !== ''; })) {
    throw new Error('Raw Internal Transactions header does not match the 21-column contract.');
  }
  const out = [];
  grid.values.slice(1).forEach(function (row, i) {
    if (row.every(isBlankCell_)) return;
    const obj = rowToObject_(row.slice(0, columns.length), columns);
    obj._row = i + 2;
    out.push(obj);
  });
  return { rows: out, checksum: grid.checksum };
}

/** Reads everything needed and builds the canonical tables (read-only). */
function buildInternalFromSheets_(ss) {
  const raw = readInternalRawRows_(ss);
  const history = readEndpointMappingRecords_(ss);
  const historyErrors = historyValidationErrors_(validateMappingHistory_(history.records));
  if (historyErrors.length > 0) throw new Error('Endpoint Mapping history is invalid: ' + historyErrors.slice(0, 5).join(' | '));
  const naiveTimeZone = String(readSettingsMap_()[INTERNAL_TX.naiveTimezoneSetting] || '').trim();
  const built = buildInternalCanonical_(raw.rows, history.records, {
    naiveTimeZone: naiveTimeZone,
    parseLocal: function (text, tz) { return Utilities.parseDate(text, tz, 'yyyy-MM-dd HH:mm:ss'); },
    ownershipTimeZone: APP.TIMEZONE,
  });
  return { raw: raw, built: built, mappingChecksum: history.checksum };
}

/** Read-only freshness of Transactions against current raw + Endpoint Mapping. Never throws. */
function readInternalTransactionsFreshness_(ss) {
  try {
    const input = buildInternalFromSheets_(ss);
    const sheet = ss.getSheetByName(SHEETS.TRANSACTIONS);
    if (!sheet) throw new Error('Transactions tab not found.');
    return checkInternalTransactionsFresh_(input.built, readSheetGrid_(sheet).values, getColumnNames_(SHEETS.TRANSACTIONS));
  } catch (err) {
    return { current: false, expected_checksum: null, stored_checksum: null,
      reason: 'Transactions is stale; run normalizeInternalTransactions first (' + (err && err.message ? err.message : String(err)) + ').' };
  }
}

function throwIfInternalErrors_(errors) {
  const all = flattenInternalErrors_(errors);
  if (all.length === 0) return;
  const shown = all.slice(0, INTERNAL_TX.maxReportedErrors);
  throw new Error('Internal transaction normalization failed (' + all.length + ' error(s)): ' + shown.join(' | ') +
    (all.length > shown.length ? ' | ... ' + (all.length - shown.length) + ' more' : ''));
}

/** Raw -> Source System -> Transactions under the script lock. Never throws. */
function runInternalNormalizer_() {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  const details = {};
  let status = 'FAILED';
  let ss = null;
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms.');
    ss = getSpreadsheet_();
    const ssTab = sourceSystemTab_();
    const txTab = transactionsTab_();
    const rec1 = recoverSwapState_(ss, ssTab);
    const rec2 = recoverSwapState_(ss, txTab);
    details.initial_swap_states = { source_system: rec1.state, transactions: rec2.state };

    const input = buildInternalFromSheets_(ss);
    details.raw_checksum = input.raw.checksum;
    details.endpoint_mapping_checksum = input.mappingChecksum;
    Object.keys(input.built.stats).forEach(function (k) { details[k] = input.built.stats[k]; });
    throwIfInternalErrors_(input.built.errors);

    // Source System: whole-table rewrite only when content differs.
    const ssColumns = getColumnNames_(SHEETS.SOURCE_SYSTEM);
    const ssRows = input.built.sourceRows.map(function (o) { return objectToRow_(o, ssColumns); });
    const ssExpected = computeRawChecksum_(buildTableValues_(ssColumns, ssRows));
    const ssCurrent = readSheetGrid_(ss.getSheetByName(SHEETS.SOURCE_SYSTEM)).checksum;
    let wrote = false;
    if (ssExpected !== ssCurrent) {
      writeCanonicalTable_(ss, getTableSchema_(SHEETS.SOURCE_SYSTEM), ssTab, ssRows);
      wrote = true;
    }
    details.source_system_rows = ssRows.length;
    details.source_system_checksum = ssExpected;

    // Transactions: keep updated_at for unchanged rows; rewrite only when content differs.
    const txColumns = getColumnNames_(SHEETS.TRANSACTIONS);
    const updatedIdx = txColumns.indexOf('updated_at');
    const currentGrid = readSheetGrid_(ss.getSheetByName(SHEETS.TRANSACTIONS));
    const previous = {};
    tableRowsFromGrid_(currentGrid.values, txColumns, SHEETS.TRANSACTIONS).forEach(function (row) {
      previous[String(row[0])] = { key: internalTransactionContentKey_(row, txColumns), updatedAt: row[updatedIdx] };
    });
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const txRows = input.built.transactions.map(function (o) {
      const row = objectToRow_(o, txColumns);
      const prev = previous[o.internal_transaction_id];
      row[updatedIdx] = prev && prev.key === internalTransactionContentKey_(row, txColumns) && !isBlankCell_(prev.updatedAt)
        ? prev.updatedAt : now;
      return row;
    });
    const txExpected = tableChecksumExcluding_(buildTableValues_(txColumns, txRows), [updatedIdx]);
    const txCurrent = tableChecksumExcluding_(currentGrid.values, [updatedIdx]);
    if (txExpected !== txCurrent) {
      writeCanonicalTable_(ss, getTableSchema_(SHEETS.TRANSACTIONS), txTab, txRows);
      wrote = true;
    }
    const summary = summarizeInternalTransactions_(input.built.transactions);
    details.transaction_rows = summary.transaction_rows;
    details.mapped_rows = summary.mapped_rows;
    details.unassigned_endpoint_rows = summary.unassigned_endpoint_rows;
    details.payment_source_counts = summary.payment_source_counts;
    details.gross_total = summary.gross_total;
    details.transactions_checksum = txExpected;
    status = wrote ? 'SUCCESS' : 'NO_CHANGE';
  } catch (err) {
    details.error = redactEndpointCredentials_(err && err.message ? err.message : String(err));
    status = 'FAILED';
  } finally {
    try {
      if (ss) {
        details.final_swap_states = {
          source_system: detectSwapState_(ss, sourceSystemTab_()).state,
          transactions: detectSwapState_(ss, transactionsTab_()).state,
        };
      }
    } catch (stateErr) {
      details.final_swap_states = 'UNKNOWN';
    }
    try {
      appendAuditLog_({ action: 'INTERNAL_TRANSACTIONS_NORMALIZE_' + status, entityType: 'TRANSACTIONS',
        entityId: INTERNAL_TX.providerId, newStatus: status, details: redactDeep_(details) });
    } catch (auditErr) {
      Logger.log('Failed to write audit entry: %s', auditErr);
    }
    if (locked) lock.releaseLock();
  }
  return redactDeep_(Object.assign({ status: status }, details));
}

/** Read-only verification of Raw Internal Transactions -> Source System -> Transactions. */
function buildInternalTransactionsReport_() {
  const report = {
    raw_rows: 0, raw_unique_transaction_ids: 0, raw_unique_fingerprints: 0, canonical_source_rows: 0, transaction_rows: 0,
    mapped_rows: 0, unassigned_endpoint_rows: 0, payment_source_counts: {}, endpoint_counts: {}, currency_counts: {},
    gross_total: 0, duplicate_transaction_conflicts: [], ambiguous_same_batch_transactions: [], mapping_errors: [],
    contract_errors: [], gateway_errors: [], data_errors: [], raw_batches_without_import_batch: [],
    source_system_match: false, transactions_match: false, swap_states: {}, pass: false, errors: [], warnings: [],
    regression: null,
  };
  try {
    const ss = getSpreadsheet_();
    report.swap_states = {
      source_system: detectSwapState_(ss, sourceSystemTab_()).state,
      transactions: detectSwapState_(ss, transactionsTab_()).state,
    };
    Object.keys(report.swap_states).forEach(function (k) {
      if (report.swap_states[k] !== 'NORMAL') report.errors.push(k + ' swap state is ' + report.swap_states[k]);
    });
    const input = buildInternalFromSheets_(ss);
    const b = input.built;
    Object.keys(b.stats).forEach(function (k) { report[k] = b.stats[k]; });
    report.duplicate_transaction_conflicts = b.errors.conflict;
    report.ambiguous_same_batch_transactions = b.errors.ambiguous;
    report.mapping_errors = b.errors.mapping;
    report.contract_errors = b.errors.contract;
    report.gateway_errors = b.errors.gateway;
    report.data_errors = b.errors.data;
    if (flattenInternalErrors_(b.errors).length > 0) report.errors.push('Raw internal data has ' + flattenInternalErrors_(b.errors).length + ' error(s).');

    const summary = summarizeInternalTransactions_(b.transactions);
    report.canonical_source_rows = b.sourceRows.length;
    report.transaction_rows = summary.transaction_rows;
    report.mapped_rows = summary.mapped_rows;
    report.unassigned_endpoint_rows = summary.unassigned_endpoint_rows;
    report.payment_source_counts = summary.payment_source_counts;
    report.endpoint_counts = summary.endpoint_counts;
    report.currency_counts = summary.currency_counts;
    report.gross_total = summary.gross_total;
    if (summary.unassigned_endpoint_rows > 0) report.warnings.push(summary.unassigned_endpoint_rows + ' transaction(s) have no endpoint owner.');

    const ssColumns = getColumnNames_(SHEETS.SOURCE_SYSTEM);
    const ssExpected = computeRawChecksum_(buildTableValues_(ssColumns, b.sourceRows.map(function (o) { return objectToRow_(o, ssColumns); })));
    report.source_system_match = ssExpected === readSheetGrid_(ss.getSheetByName(SHEETS.SOURCE_SYSTEM)).checksum;
    report.transactions_match = checkInternalTransactionsFresh_(b, readSheetGrid_(ss.getSheetByName(SHEETS.TRANSACTIONS)).values,
      getColumnNames_(SHEETS.TRANSACTIONS)).current;
    if (!report.source_system_match) report.errors.push('Source System does not match raw (run normalizeInternalTransactions).');
    if (!report.transactions_match) report.errors.push('Transactions does not match raw (run normalizeInternalTransactions).');

    // Each raw batch should have a SUCCESS / NO_CHANGE Import Batches row (provider INTERNAL).
    const batches = {};
    readImportBatches_().forEach(function (r) {
      if (r.provider_id === INTERNAL_TX.providerId && (r.status === 'SUCCESS' || r.status === 'NO_CHANGE')) batches[String(r.import_batch_id)] = true;
    });
    const rawBatches = {};
    input.raw.rows.forEach(function (r) { rawBatches[trimmedText_(r.import_batch_id)] = true; });
    report.raw_batches_without_import_batch = Object.keys(rawBatches).filter(function (k) { return k !== '' && !batches[k]; }).sort();
    if (report.raw_batches_without_import_batch.length > 0) report.warnings.push('Raw batches without an Import Batches record: ' + report.raw_batches_without_import_batch.join(', '));
    report.regression = evaluateInternalTxRegression_(summary, b.stats);
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0;
  return redactDeep_(report);
}
