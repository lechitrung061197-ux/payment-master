/**
 * Kh001ProviderEvents.gs
 * KH001 normalizer: "Raw KH001 PayPal" -> canonical Provider Events (KH001 partition).
 *
 * - One event per raw row with a non-blank "Nhóm GD". Only verified groups are mapped
 *   (Thanh toán -> PAYMENT, Reserve PP -> RESERVE_HOLD, Rút tiền -> WITHDRAWAL); any other
 *   group, raw Type, Status/Balance Impact combination fails normalization.
 * - PayPal signed amounts are kept as-is (Fee stays negative): gross + fee = net.
 * - balance_effect_amount follows Balance Impact: Credit/Debit = net, Memo = 0.
 * - PAYMENT / RESERVE_HOLD must link to an existing Provider Transaction; WITHDRAWAL has no link.
 * - Before any write or NO_CHANGE, the KH001 Provider Transactions partition must equal what
 *   its normalizer produces from the CURRENT raw tabs (dependency freshness gate).
 * - RESERVE_HOLD is the actual PayPal reserve. It is not the KH001 contractual hold and no
 *   percentage is derived here. No settlements, fees, holds or withdrawal allocation.
 * - Reads only Master tabs (Raw KH001 PayPal for events; Raw KH001 Reconciled and Provider
 *   Transactions only for the dependency/integrity checks).
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const KH001_PROVIDER_EVENTS = Object.freeze({
  providerId: 'KH001',
  paymentSource: 'PAYPAL',
  normalizerVersion: 'KH001_PROVIDER_EVENTS_V1',
  idPrefix: 'PE-KH001-PAYPAL-',
  paypalHeaderRow: 1,
  requiredHeaders: [
    'Mã cổng', 'Type', 'Status', 'Currency', 'Gross', 'Fee', 'Net', 'Transaction ID', 'Reference Txn ID',
    'Invoice Number', 'Balance Impact', 'Thời gian', 'Nhóm GD', 'Txn gốc',
  ],
  amountTolerance: 0.005,
  maxReportedErrors: 20,
  /**
   * Verified mappings only. relation:
   *   SELF      provider_transaction_id = own Transaction ID;      Txn gốc == Transaction ID
   *   REFERENCE provider_transaction_id = Reference Txn ID;       Txn gốc == Reference Txn ID
   *   NONE      no provider transaction;                          Txn gốc == Transaction ID
   */
  rules: [
    { group: 'Thanh toán', eventType: 'PAYMENT', rawTypes: ['Express Checkout Payment'],
      statusImpacts: [['Completed', 'Credit'], ['Pending', 'Memo']], relation: 'SELF' },
    { group: 'Reserve PP', eventType: 'RESERVE_HOLD', rawTypes: ['Reserve Hold'],
      statusImpacts: [['Completed', 'Debit']], relation: 'REFERENCE' },
    { group: 'Rút tiền', eventType: 'WITHDRAWAL', rawTypes: ['General Withdrawal'],
      statusImpacts: [['Completed', 'Debit']], relation: 'NONE' },
  ],
  /** Balance Impact -> how net_amount moves the provider balance. */
  balanceImpacts: { Credit: 'NET', Debit: 'NET', Memo: 'ZERO' },
});

/**
 * Current-snapshot regression expectations (October 2026 production snapshot).
 * Report only; never used by the normalizer or by the generic verifier pass.
 */
const KH001_PROVIDER_EVENTS_REGRESSION = Object.freeze({
  snapshot: 'KH001 2026-10 production snapshot',
  source_rows: 3000,
  source_columns: 47,
  row_count: 343,
  unique_event_count: 343,
  event_type_counts: { PAYMENT: 169, RESERVE_HOLD: 168, WITHDRAWAL: 6 },
  status_counts: { Completed: 342, Pending: 1 },
  balance_impact_counts: { Credit: 168, Debit: 174, Memo: 1 },
  currency_counts: { USD: 343 },
  totals_by_event_type: {
    PAYMENT: { gross: 10706.35, fee: -420.24, net: 10286.11 },
    RESERVE_HOLD: { gross: -510.29, fee: 0, net: -510.29 },
    WITHDRAWAL: { gross: -9577.79, fee: 0, net: -9577.79 },
  },
  total_net: 198.03,
  total_balance_effect: 119.30,
  linked_counts: { PAYMENT: 169, RESERVE_HOLD: 168, WITHDRAWAL: 0 },
});

/* ----------------------------- Pure helpers ----------------------------- */

function kh001ProviderEventId_(externalEventId) {
  return KH001_PROVIDER_EVENTS.idPrefix + externalEventId;
}

/** SHA-256 of the raw PayPal checksum + normalizer version; independent of time. */
function computeKh001EventsFingerprint_(paypalChecksum, digestHex) {
  const digest = digestHex || sha256Hex_;
  return digest(paypalChecksum + '|' + KH001_PROVIDER_EVENTS.normalizerVersion);
}

function findKh001EventRule_(group) {
  const key = normalizeLabel_(group);
  return KH001_PROVIDER_EVENTS.rules.find(function (r) { return normalizeLabel_(r.group) === key; }) || null;
}

/**
 * Balance movement for a row: Credit/Debit -> net_amount (Credit must be >= 0, Debit <= 0),
 * Memo -> 0. Returns { amount } or { error }.
 */
function computeBalanceEffect_(balanceImpact, net) {
  const mode = KH001_PROVIDER_EVENTS.balanceImpacts[normalizeLabel_(balanceImpact)];
  if (!mode) return { error: 'Unverified Balance Impact "' + balanceImpact + '"' };
  if (mode === 'ZERO') return { amount: 0 };
  const impact = normalizeLabel_(balanceImpact);
  if (impact === 'Credit' && net < 0) return { error: 'Credit with negative net ' + net };
  if (impact === 'Debit' && net > 0) return { error: 'Debit with positive net ' + net };
  return { amount: net };
}

function signedInvariantHolds_(gross, fee, net) {
  return Math.abs(gross + fee - net) <= KH001_PROVIDER_EVENTS.amountTolerance + 1e-9;
}

/**
 * Index of KH001 Provider Transactions rows: provider_transaction_id -> row object.
 * @param {Array<Object>} providerTransactionRows rows as objects (any provider)
 */
function indexProviderTransactions_(providerTransactionRows) {
  const index = {};
  providerTransactionRows.forEach(function (r) {
    index[String(r.provider_transaction_id)] = r;
  });
  return index;
}

/** Checks an event's link against Provider Transactions. Returns an error message or null. */
function checkEventRelationship_(event, ptIndex) {
  if (event.event_type === 'WITHDRAWAL') {
    return event.provider_transaction_id === '' && event.related_external_transaction_id === ''
      ? null
      : 'WITHDRAWAL ' + event.external_event_id + ' must not link to a provider transaction';
  }
  const expectedTxId = event.event_type === 'PAYMENT' ? event.external_event_id : event.related_external_transaction_id;
  if (!expectedTxId) return event.event_type + ' ' + event.external_event_id + ' has no related transaction';
  if (event.provider_transaction_id !== kh001ProviderTransactionId_(expectedTxId)) {
    return event.event_type + ' ' + event.external_event_id + ' has provider_transaction_id ' +
      event.provider_transaction_id + ', expected ' + kh001ProviderTransactionId_(expectedTxId);
  }
  const pt = ptIndex[event.provider_transaction_id];
  if (!pt) {
    return event.event_type + ' ' + event.external_event_id + ' links to missing Provider Transaction ' +
      event.provider_transaction_id;
  }
  if (pt.provider_id !== KH001_PROVIDER_EVENTS.providerId || pt.payment_source !== KH001_PROVIDER_EVENTS.paymentSource ||
      String(pt.external_transaction_id) !== expectedTxId) {
    return event.event_type + ' ' + event.external_event_id + ' links to Provider Transaction ' +
      event.provider_transaction_id + ' with mismatching provider/source/external id';
  }
  return null;
}

function emptyEventErrors_() {
  return { mapping: [], balance_impact: [], amount_invariant: [], relationship: [], duplicate: [], data: [] };
}

function flattenEventErrors_(errors) {
  return [].concat(errors.duplicate, errors.mapping, errors.balance_impact, errors.amount_invariant,
    errors.relationship, errors.data);
}

/**
 * Builds KH001 event objects (keyed by Provider Events columns, normalized_at blank)
 * from the full "Raw KH001 PayPal" grid. Structural header problems throw; row
 * problems are collected by category and returned (see assertNoEventErrors_).
 * @param {Array<Array<*>>} paypalValues
 * @param {Object} ptIndex from indexProviderTransactions_
 * @param {string} sourceFingerprint
 * @return {{rows: Array<Object>, eventRows: number, errors: Object}}
 */
function buildKh001ProviderEvents_(paypalValues, ptIndex, sourceFingerprint) {
  const cfg = KH001_PROVIDER_EVENTS;
  if (paypalValues.length < cfg.paypalHeaderRow) throw new Error('Raw KH001 PayPal has no header row.');
  const map = buildHeaderMap_(paypalValues[cfg.paypalHeaderRow - 1], cfg.requiredHeaders, 'Raw KH001 PayPal');
  const col = function (name) { return map[normalizeLabel_(name)]; };

  const errors = emptyEventErrors_();
  const seen = {};
  const rows = [];
  let eventRows = 0;

  for (let r = cfg.paypalHeaderRow; r < paypalValues.length; r++) {
    const row = paypalValues[r];
    const sheetRow = r + 1;
    const group = normalizeLabel_(row[col('Nhóm GD')]);
    const id = canonicalText_(row[col('Transaction ID')]);
    if (group === '') {
      // A transaction without a group would otherwise be dropped silently.
      if (id !== '') errors.mapping.push('Row ' + sheetRow + ': Transaction ID ' + id + ' has blank Nhóm GD');
      continue;
    }
    eventRows++;
    const label = 'Row ' + sheetRow + (id ? ' (' + id + ')' : '');

    const rule = findKh001EventRule_(group);
    if (!rule) { errors.mapping.push(label + ': unmapped Nhóm GD "' + group + '"'); continue; }
    if (id === '') { errors.data.push(label + ': blank Transaction ID'); continue; }
    if (seen[id]) { errors.duplicate.push('Duplicate event Transaction ID ' + id + ' (rows ' + seen[id] + ', ' + sheetRow + ')'); continue; }
    seen[id] = sheetRow;

    const rawType = normalizeLabel_(row[col('Type')]);
    const status = normalizeLabel_(row[col('Status')]);
    const impact = normalizeLabel_(row[col('Balance Impact')]);
    if (rule.rawTypes.map(normalizeLabel_).indexOf(rawType) < 0) {
      errors.mapping.push(label + ': unverified Type "' + rawType + '" for ' + rule.eventType);
      continue;
    }
    const comboOk = rule.statusImpacts.some(function (c) {
      return normalizeLabel_(c[0]) === status && normalizeLabel_(c[1]) === impact;
    });
    if (!comboOk) {
      errors.mapping.push(label + ': unverified Status/Balance Impact "' + status + '/' + impact + '" for ' + rule.eventType);
      continue;
    }

    const gross = row[col('Gross')];
    const fee = row[col('Fee')];
    const net = row[col('Net')];
    if (!isFiniteNumber_(gross) || !isFiniteNumber_(fee) || !isFiniteNumber_(net)) {
      errors.amount_invariant.push(label + ': non-numeric Gross/Fee/Net');
      continue;
    }
    if (!signedInvariantHolds_(gross, fee, net)) {
      errors.amount_invariant.push(label + ': ' + gross + ' + ' + fee + ' != ' + net);
      continue;
    }
    const effect = computeBalanceEffect_(impact, net);
    if (effect.error) { errors.balance_impact.push(label + ': ' + effect.error); continue; }

    const at = row[col('Thời gian')];
    if (!isDateValue_(at) || isNaN(at.getTime())) { errors.data.push(label + ': Thời gian is not a date-time'); continue; }

    const reference = canonicalText_(row[col('Reference Txn ID')]);
    const root = canonicalText_(row[col('Txn gốc')]);
    let related = '';
    let providerTransactionId = '';
    if (rule.relation === 'REFERENCE') {
      if (reference === '') { errors.relationship.push(label + ': ' + rule.eventType + ' requires Reference Txn ID'); continue; }
      if (root !== reference) {
        errors.relationship.push(label + ': Txn gốc "' + root + '" != Reference Txn ID "' + reference + '"');
        continue;
      }
      related = reference;
      providerTransactionId = kh001ProviderTransactionId_(reference);
    } else {
      if (root !== id) {
        errors.relationship.push(label + ': Txn gốc "' + root + '" != Transaction ID "' + id + '"');
        continue;
      }
      if (rule.relation === 'SELF') providerTransactionId = kh001ProviderTransactionId_(id);
    }

    const event = {
      provider_event_id: kh001ProviderEventId_(id),
      provider_id: cfg.providerId,
      payment_source: cfg.paymentSource,
      gateway_id: canonicalText_(row[col('Mã cổng')]),
      external_event_id: id,
      related_external_transaction_id: related,
      provider_transaction_id: providerTransactionId,
      event_type: rule.eventType,
      event_at: at,
      external_status: canonicalText_(row[col('Status')]),
      currency: canonicalText_(row[col('Currency')]),
      gross_amount: gross,
      fee_amount: fee,
      net_amount: net,
      balance_impact: canonicalText_(row[col('Balance Impact')]),
      balance_effect_amount: effect.amount,
      raw_type: canonicalText_(row[col('Type')]),
      raw_group: canonicalText_(row[col('Nhóm GD')]),
      source_paypal_row: sheetRow,
      source_fingerprint: sourceFingerprint,
      normalizer_version: cfg.normalizerVersion,
      normalized_at: '',
    };
    const linkError = checkEventRelationship_(event, ptIndex);
    if (linkError) { errors.relationship.push(label + ': ' + linkError); continue; }
    rows.push(event);
  }
  return { rows: rows, eventRows: eventRows, errors: errors };
}

/** Throws one error listing every problem found by buildKh001ProviderEvents_. */
function assertNoEventErrors_(errors) {
  const all = flattenEventErrors_(errors);
  if (all.length === 0) return;
  const shown = all.slice(0, KH001_PROVIDER_EVENTS.maxReportedErrors);
  const more = all.length > shown.length ? ' | ... ' + (all.length - shown.length) + ' more' : '';
  throw new Error('KH001 provider events normalization failed (' + all.length + ' error(s)): ' + shown.join(' | ') + more);
}

/**
 * Generic checks on stored event rows (objects): duplicates, signed amount invariant,
 * balance effect consistency and relationships. Used by the verifier.
 */
function checkProviderEventRows_(rows, ptIndex) {
  const errors = emptyEventErrors_();
  const counts = {};
  rows.forEach(function (e) {
    const id = String(e.external_event_id);
    counts[id] = (counts[id] || 0) + 1;
    if (!isFiniteNumber_(e.gross_amount) || !isFiniteNumber_(e.fee_amount) || !isFiniteNumber_(e.net_amount) ||
        !signedInvariantHolds_(e.gross_amount, e.fee_amount, e.net_amount)) {
      errors.amount_invariant.push(id);
    }
    const effect = isFiniteNumber_(e.net_amount) ? computeBalanceEffect_(e.balance_impact, e.net_amount) : { error: 'x' };
    if (effect.error || !isFiniteNumber_(e.balance_effect_amount) ||
        Math.round(effect.amount * 100) !== Math.round(e.balance_effect_amount * 100)) {
      errors.balance_impact.push(id);
    }
    if (KH001_PROVIDER_EVENTS.rules.map(function (r) { return r.eventType; }).indexOf(e.event_type) < 0) {
      errors.mapping.push(id);
    }
    const link = checkEventRelationship_({
      event_type: e.event_type,
      external_event_id: id,
      related_external_transaction_id: String(e.related_external_transaction_id),
      provider_transaction_id: String(e.provider_transaction_id),
    }, ptIndex);
    if (link) errors.relationship.push(link);
  });
  errors.duplicate = Object.keys(counts).filter(function (k) { return counts[k] > 1; }).sort();
  return errors;
}

/** Generic summary of event objects (no snapshot-specific numbers). */
function summarizeProviderEvents_(rows) {
  const tally = function (field) {
    return rows.reduce(function (acc, r) {
      const k = String(r[field]);
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
  };
  const cents = {};
  const linked = {};
  let totalNet = 0;
  let totalEffect = 0;
  rows.forEach(function (r) {
    const t = String(r.event_type);
    cents[t] = cents[t] || { gross: 0, fee: 0, net: 0, balance_effect: 0 };
    cents[t].gross += toCents_(r.gross_amount);
    cents[t].fee += toCents_(r.fee_amount);
    cents[t].net += toCents_(r.net_amount);
    cents[t].balance_effect += toCents_(r.balance_effect_amount);
    linked[t] = (linked[t] || 0) + (String(r.provider_transaction_id) !== '' ? 1 : 0);
    totalNet += toCents_(r.net_amount);
    totalEffect += toCents_(r.balance_effect_amount);
  });
  const totals = {};
  Object.keys(cents).sort().forEach(function (t) {
    totals[t] = { gross: cents[t].gross / 100, fee: cents[t].fee / 100, net: cents[t].net / 100,
      balance_effect: cents[t].balance_effect / 100 };
  });
  const ids = {};
  rows.forEach(function (r) { ids[String(r.external_event_id)] = true; });
  return {
    row_count: rows.length,
    unique_event_count: Object.keys(ids).length,
    event_type_counts: tally('event_type'),
    status_counts: tally('external_status'),
    currency_counts: tally('currency'),
    balance_impact_counts: tally('balance_impact'),
    totals_by_event_type: totals,
    total_net: totalNet / 100,
    total_balance_effect: totalEffect / 100,
    linked_counts: linked,
  };
}

/** Compares a summary with the current-snapshot regression expectations (report only). */
function evaluateKh001ProviderEventsRegression_(summary, source) {
  const exp = KH001_PROVIDER_EVENTS_REGRESSION;
  const checks = [];
  const add = function (name, expected, actual, pass) { checks.push({ name: name, expected: expected, actual: actual, pass: pass }); };
  const sameCounts = function (e, a) {
    return Object.keys(e).every(function (k) { return (a[k] || 0) === e[k]; }) &&
      Object.keys(a).every(function (k) { return Object.prototype.hasOwnProperty.call(e, k); });
  };
  const near = function (e, a) { return isFiniteNumber_(a) && Math.round(e * 100) === Math.round(a * 100); };

  add('source_rows', exp.source_rows, source.paypal_rows, source.paypal_rows === exp.source_rows);
  add('source_columns', exp.source_columns, source.paypal_columns, source.paypal_columns === exp.source_columns);
  add('row_count', exp.row_count, summary.row_count, summary.row_count === exp.row_count);
  add('unique_event_count', exp.unique_event_count, summary.unique_event_count, summary.unique_event_count === exp.unique_event_count);
  ['event_type_counts', 'status_counts', 'balance_impact_counts', 'currency_counts', 'linked_counts'].forEach(function (k) {
    add(k, exp[k], summary[k], sameCounts(exp[k], summary[k] || {}));
  });
  Object.keys(exp.totals_by_event_type).forEach(function (t) {
    ['gross', 'fee', 'net'].forEach(function (f) {
      const actual = summary.totals_by_event_type[t] ? summary.totals_by_event_type[t][f] : null;
      add('totals_by_event_type.' + t + '.' + f, exp.totals_by_event_type[t][f], actual, near(exp.totals_by_event_type[t][f], actual));
    });
  });
  add('total_net', exp.total_net, summary.total_net, near(exp.total_net, summary.total_net));
  add('total_balance_effect', exp.total_balance_effect, summary.total_balance_effect,
    near(exp.total_balance_effect, summary.total_balance_effect));
  return {
    snapshot: exp.snapshot,
    pass: checks.every(function (c) { return c.pass; }),
    failed: checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }),
    checks: checks,
  };
}

/* ---------------------------------- I/O --------------------------------- */

const PROVIDER_EVENT_KEY_COLUMNS = ['provider_id', 'payment_source', 'external_event_id'];
const PROVIDER_EVENT_SORT_COLUMNS = ['provider_id', 'payment_source', 'event_at', 'external_event_id'];

function providerEventsTab_() {
  return { targetSheet: SHEETS.PROVIDER_EVENTS, stagingSheet: '__STAGE_PROVIDER_EVENTS' };
}

/**
 * Reads the Provider Transactions dependency (read-only): requires a NORMAL swap state
 * (recovery of that tab belongs to its own normalizer), indexes its rows for referential
 * integrity, and checks that its KH001 partition is exactly what the Provider Transactions
 * normalizer would produce from the CURRENT Raw KH001 PayPal + Raw KH001 Reconciled.
 * Raw KH001 Reconciled is read only for this freshness check, not as event data.
 * @param {{values: Array<Array<*>>, checksum: string}} paypalGrid already-read Raw KH001 PayPal
 * @return {{index: Object, dependency: Object}}
 */
function readProviderTransactionsDependency_(ss, paypalGrid) {
  const state = detectSwapState_(ss, providerTransactionsTab_()).state;
  if (state !== 'NORMAL') {
    throw new Error('Provider Transactions swap state is ' + state + '; run normalizeKh001ProviderTransactions first.');
  }
  const reconciledSheet = ss.getSheetByName(SHEETS.RAW_KH001_RECONCILED);
  if (!reconciledSheet) throw new Error('Raw tab "' + SHEETS.RAW_KH001_RECONCILED + '" not found. Run syncKh001Raw first.');
  const reconciled = readSheetGrid_(reconciledSheet);

  const sheet = ss.getSheetByName(SHEETS.PROVIDER_TRANSACTIONS);
  const columns = getColumnNames_(SHEETS.PROVIDER_TRANSACTIONS);
  const rows = tableRowsFromGrid_(readSheetGrid_(sheet).values, columns, SHEETS.PROVIDER_TRANSACTIONS);
  const check = checkKh001ProviderTransactionsCurrent_(paypalGrid, reconciled, rows, columns);
  return {
    index: indexProviderTransactions_(rows.map(function (r) { return rowToObject_(r, columns); })),
    dependency: {
      provider_transactions_current: check.current,
      swap_state: state,
      reconciled_checksum: reconciled.checksum,
      expected_checksum: check.expected_checksum,
      stored_checksum: check.stored_checksum,
      expected_rows: check.expected_rows,
      stored_rows: check.stored_rows,
      reason: check.reason,
    },
  };
}

function readKh001EventsInput_(ss) {
  const sheet = ss.getSheetByName(SHEETS.RAW_KH001_PAYPAL);
  if (!sheet) throw new Error('Raw tab "' + SHEETS.RAW_KH001_PAYPAL + '" not found. Run syncKh001Raw first.');
  const paypal = readSheetGrid_(sheet);
  return { paypal: paypal, fingerprint: computeKh001EventsFingerprint_(paypal.checksum) };
}

/** Normalizes KH001 into Provider Events under the script lock. Never throws. */
function runKh001ProviderEventsNormalizer_() {
  const cfg = KH001_PROVIDER_EVENTS;
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  const details = { normalizer_version: cfg.normalizerVersion };
  let status = 'FAILED';
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms.');
    const ss = getSpreadsheet_();
    const table = getTableSchema_(SHEETS.PROVIDER_EVENTS);
    const columns = table.columns.map(function (c) { return c.name; });

    const input = readKh001EventsInput_(ss);
    details.source_fingerprint = input.fingerprint;
    details.paypal_checksum = input.paypal.checksum;

    // Dependency freshness gate: must pass before any write or NO_CHANGE result.
    const dep = readProviderTransactionsDependency_(ss, input.paypal);
    details.provider_transactions_checksum = dep.dependency.stored_checksum;
    if (!dep.dependency.provider_transactions_current) throw new Error(dep.dependency.reason);

    const built = buildKh001ProviderEvents_(input.paypal.values, dep.index, input.fingerprint);
    details.input_event_rows = built.eventRows;
    assertNoEventErrors_(built.errors);

    const partition = built.rows.map(function (o) { return objectToRow_(o, columns); });
    const summary = summarizeProviderEvents_(built.rows);
    details.output_rows = summary.row_count;
    details.output_checksum = partitionChecksum_(partition, columns, PROVIDER_EVENT_SORT_COLUMNS, 'normalized_at');
    details.event_type_counts = summary.event_type_counts;
    details.total_balance_effect = summary.total_balance_effect;

    const result = replaceCanonicalPartition_(ss, {
      table: table,
      tab: providerEventsTab_(),
      providerId: cfg.providerId,
      partitionRows: partition,
      keyColumns: PROVIDER_EVENT_KEY_COLUMNS,
      sortColumns: PROVIDER_EVENT_SORT_COLUMNS,
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
        action: cfg.providerId + '_PROVIDER_EVENTS_NORMALIZE_' + status,
        entityType: 'PROVIDER_EVENTS',
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

/** Read-only verification of the KH001 Provider Events partition. */
function buildKh001ProviderEventsReport_() {
  const cfg = KH001_PROVIDER_EVENTS;
  const report = {
    provider: cfg.providerId,
    normalizer_version: cfg.normalizerVersion,
    source: {},
    output: {},
    event_type_counts: {},
    status_counts: {},
    currency_counts: {},
    balance_impact_counts: {},
    totals_by_event_type: {},
    total_balance_effect: null,
    linked_counts: {},
    dependency: null,
    target_match: false,
    swap_state: null,
    pass: false,
    errors: [],
    regression: null,
  };
  try {
    const ss = getSpreadsheet_();
    const columns = getColumnNames_(SHEETS.PROVIDER_EVENTS);
    const input = readKh001EventsInput_(ss);
    report.source = {
      paypal_rows: input.paypal.rows,
      paypal_columns: input.paypal.columns,
      paypal_checksum: input.paypal.checksum,
      source_fingerprint: input.fingerprint,
      selected_event_rows: null,
    };

    const dep = readProviderTransactionsDependency_(ss, input.paypal);
    const ptIndex = dep.index;
    report.dependency = dep.dependency;
    if (!dep.dependency.provider_transactions_current) report.errors.push(dep.dependency.reason);
    let expectedChecksum = null;
    const built = buildKh001ProviderEvents_(input.paypal.values, ptIndex, input.fingerprint);
    report.source.selected_event_rows = built.eventRows;
    const buildErrors = flattenEventErrors_(built.errors);
    if (buildErrors.length === 0) {
      expectedChecksum = partitionChecksum_(built.rows.map(function (o) { return objectToRow_(o, columns); }),
        columns, PROVIDER_EVENT_SORT_COLUMNS, 'normalized_at');
    } else {
      report.errors.push('Normalizer validation failed with ' + buildErrors.length + ' error(s).');
    }

    report.swap_state = detectSwapState_(ss, providerEventsTab_()).state;
    if (report.swap_state !== 'NORMAL') report.errors.push('Swap state is ' + report.swap_state + '.');

    const target = ss.getSheetByName(SHEETS.PROVIDER_EVENTS);
    if (!target) throw new Error('Provider Events tab not found.');
    const allRows = tableRowsFromGrid_(readSheetGrid_(target).values, columns, SHEETS.PROVIDER_EVENTS);
    const providerIdx = columns.indexOf('provider_id');
    const kh001Rows = allRows.filter(function (r) { return r[providerIdx] === cfg.providerId; });
    const objects = kh001Rows.map(function (r) { return rowToObject_(r, columns); });
    const stored = checkProviderEventRows_(objects, ptIndex);
    const tableDuplicates = findDuplicateKeys_(allRows, PROVIDER_EVENT_KEY_COLUMNS.map(function (c) { return columns.indexOf(c); }));
    const summary = summarizeProviderEvents_(objects);

    const merge = function (a, b) { return a.concat(b.filter(function (x) { return a.indexOf(x) < 0; })); };
    report.output = {
      row_count: summary.row_count,
      unique_event_count: summary.unique_event_count,
      output_checksum: partitionChecksum_(kh001Rows, columns, PROVIDER_EVENT_SORT_COLUMNS, 'normalized_at'),
      expected_checksum: expectedChecksum,
      duplicate_event_ids: merge(stored.duplicate, built.errors.duplicate),
      table_duplicate_keys: tableDuplicates,
      amount_invariant_errors: merge(stored.amount_invariant, built.errors.amount_invariant),
      relationship_errors: merge(stored.relationship, built.errors.relationship),
      mapping_errors: merge(stored.mapping, built.errors.mapping),
      balance_impact_errors: merge(stored.balance_impact, built.errors.balance_impact),
      data_errors: built.errors.data,
      table_rows_all_providers: allRows.length,
    };
    report.event_type_counts = summary.event_type_counts;
    report.status_counts = summary.status_counts;
    report.currency_counts = summary.currency_counts;
    report.balance_impact_counts = summary.balance_impact_counts;
    report.totals_by_event_type = summary.totals_by_event_type;
    report.total_balance_effect = summary.total_balance_effect;
    report.linked_counts = summary.linked_counts;

    // Stored order must equal canonical order: compare stored rows without re-sorting.
    const storedChecksum = tableChecksumExcluding_(buildTableValues_(columns, kh001Rows), [columns.indexOf('normalized_at')]);
    report.target_match = expectedChecksum !== null && storedChecksum === expectedChecksum;
    if (!report.target_match) report.errors.push('Provider Events KH001 partition does not match raw snapshot.');
    ['duplicate_event_ids', 'table_duplicate_keys', 'amount_invariant_errors', 'relationship_errors',
      'mapping_errors', 'balance_impact_errors', 'data_errors'].forEach(function (k) {
      if (report.output[k].length > 0) report.errors.push(k + ': ' + report.output[k].length);
    });

    report.regression = evaluateKh001ProviderEventsRegression_(summary, report.source);
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0 && report.target_match && report.swap_state === 'NORMAL';
  return report;
}
