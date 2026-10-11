/**
 * SellerSheets.gs
 * Seller child spreadsheets: read-only, seller-specific PROJECTIONS of Payment Master (output only).
 *
 * - Payment Master is the only accounting source of truth. Child sheets never calculate anything
 *   (values only, no formulas) and are never read back into Master accounting.
 * - Ownership filter: exact Transactions.seller_id. Legs, settlements, balances, payouts and
 *   adjustments reach a seller only through that seller's own rows; no row can cross sellers.
 * - Managed child tabs (the only tabs ever touched): Summary, Transactions, Settlements, Payouts,
 *   Adjustments, Sync Info. Any other tab is left untouched.
 * - Gates: Transactions, Provider Transactions, Payment Matches, Settlements, Seller Terms,
 *   Payment Legs, Settlement Items and Seller Balances must be current/valid, and Seller Destinations
 *   valid, before ANY child write. Leak-risk problems fail globally before any write.
 * - Idempotency: the whole snapshot is built in memory with deterministic checksums. A child whose
 *   tabs already match is NO_CHANGE (nothing written, last_content_sync_at kept). Otherwise one
 *   timestamp is used; changed data tabs are written, then Summary, then Sync Info LAST (commit
 *   marker), and the child is reread and verified before SUCCESS is reported.
 * - Unknown economics are never estimated: rows without actual provider/seller economics keep
 *   their financial fields blank and are counted as unknown_economics_transactions.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const SELLER_OUTPUT = Object.freeze({
  schemaVersion: 1,
  checksumVersion: 'seller-output-v1',
  timestampColumn: 'last_content_sync_at',
  tabs: Object.freeze({
    SUMMARY: 'Summary',
    TRANSACTIONS: 'Transactions',
    SETTLEMENTS: 'Settlements',
    PAYOUTS: 'Payouts',
    ADJUSTMENTS: 'Adjustments',
    SYNC_INFO: 'Sync Info',
  }),
  // Columns that must never appear in seller output (privacy / internal / provider economics).
  forbiddenColumns: ['endpoint_token', 'endpoint_key', 'endpoint_name_snapshot', 'mapping_id', 'mapping_version', 'customer',
    'payer_reference', 'provider_fee', 'provider_fee_rate', 'provider_fee_amount', 'provider_hold_amount', 'provider_hold_rate',
    'system_margin', 'row_fingerprint', 'source_row_fingerprint', 'source_fingerprint', 'source_file_name', 'import_batch_id',
    'source_record_id', 'notes', 'note', 'created_by', 'external_event_id', 'provider_id', 'seller_name_snapshot'],
  // Anything that looks like an endpoint token or credential inside an output value.
  credentialPattern: /glk_[A-Za-z0-9_-]+/,
  maxReportedErrors: 30,
});

/**
 * Child output columns per managed tab: [name, COL_TYPE] (type -> FORMATS). Literal values only, so this
 * file's top level does not depend on Config.gs load order.
 */
const SELLER_OUTPUT_SCHEMA = sellerOutputSchemaFrom_({
  'Summary': [
    ['seller_id', 'ID'], ['seller_name', 'TEXT'], ['currency', 'TEXT'],
    ['current_balance', 'AMOUNT4'], ['pending_settlement_amount', 'AMOUNT4'], ['settled_hold_remaining', 'AMOUNT4'],
    ['pending_hold_amount', 'AMOUNT4'], ['total_known_hold', 'AMOUNT4'], ['paid_amount', 'AMOUNT4'],
    ['adjustments', 'AMOUNT4'], ['total_known_obligation', 'AMOUNT4'], ['total_transactions', 'INTEGER'],
    ['matched_transactions', 'INTEGER'], ['missing_provider_transactions', 'INTEGER'],
    ['waiting_settlement_transactions', 'INTEGER'], ['settled_not_paid_transactions', 'INTEGER'],
    ['available_transactions', 'INTEGER'], ['unknown_economics_transactions', 'INTEGER'],
    ['last_content_sync_at', 'DATETIME'],
  ],
  'Transactions': [
    ['internal_transaction_id', 'ID'], ['order_id', 'ID'], ['created_at', 'DATETIME'], ['store_domain', 'TEXT'],
    ['payment_source', 'TEXT'], ['order_amount', 'AMOUNT'], ['currency', 'TEXT'], ['reconciliation_status', 'TEXT'],
    ['match_status', 'TEXT'], ['external_transaction_id', 'ID'], ['provider', 'ID'], ['gross_amount', 'AMOUNT'],
    ['processing_fee', 'AMOUNT'], ['net_amount', 'AMOUNT'], ['seller_fee_rate', 'RATE'], ['seller_fee', 'AMOUNT4'],
    ['seller_hold_amount', 'AMOUNT4'], ['seller_amount_after_fee_hold', 'AMOUNT4'], ['available_to_payout', 'AMOUNT4'],
    ['settlement_id', 'ID'], ['settlement_status', 'TEXT'], ['provider_payment_date', 'DATE'],
    ['accounting_state', 'TEXT'],
  ],
  'Settlements': [
    ['settlement_id', 'ID'], ['provider', 'ID'], ['payment_source', 'TEXT'], ['currency', 'TEXT'],
    ['period_end_date', 'DATE'], ['provider_payment_date', 'DATE'], ['settlement_status', 'TEXT'],
    ['transaction_count', 'INTEGER'], ['gross_amount', 'AMOUNT'], ['processing_fee', 'AMOUNT'], ['net_amount', 'AMOUNT'],
    ['seller_fee', 'AMOUNT4'], ['seller_hold_amount', 'AMOUNT4'], ['seller_amount_after_fee_hold', 'AMOUNT4'],
    ['available_to_payout', 'AMOUNT4'],
  ],
  'Payouts': [
    ['seller_payout_id', 'ID'], ['payout_date', 'DATE'], ['currency', 'TEXT'], ['amount', 'AMOUNT'],
    ['fx_rate', 'FX_RATE'], ['payout_currency', 'TEXT'], ['payout_amount', 'AMOUNT'], ['payment_method', 'TEXT'],
    ['reference', 'TEXT'], ['status', 'TEXT'],
  ],
  'Adjustments': [
    ['adjustment_id', 'ID'], ['adjustment_type', 'TEXT'], ['internal_transaction_id', 'ID'], ['settlement_id', 'ID'],
    ['currency', 'TEXT'], ['amount', 'AMOUNT'], ['effective_date', 'DATE'], ['status', 'TEXT'], ['reason', 'TEXT'],
  ],
  'Sync Info': [
    ['seller_id', 'ID'], ['seller_name', 'TEXT'], ['seller_output_schema_version', 'INTEGER'],
    ['master_schema_version', 'INTEGER'], ['last_content_sync_at', 'DATETIME'], ['summary_checksum', 'ID'],
    ['transactions_checksum', 'ID'], ['settlements_checksum', 'ID'], ['payouts_checksum', 'ID'],
    ['adjustments_checksum', 'ID'], ['combined_checksum', 'ID'],
  ],
});

function sellerOutputSchemaFrom_(spec) {
  const out = {};
  Object.keys(spec).forEach(function (tab) {
    out[tab] = Object.freeze(spec[tab].map(function (c) { return Object.freeze({ name: c[0], type: c[1] }); }));
  });
  return Object.freeze(out);
}

/** The five content tabs covered by checksums, in combined-checksum order, with their Sync Info field. */
const SELLER_OUTPUT_DATA_TABS = Object.freeze([
  { tab: 'Summary', key: 'summary_checksum' },
  { tab: 'Transactions', key: 'transactions_checksum' },
  { tab: 'Settlements', key: 'settlements_checksum' },
  { tab: 'Payouts', key: 'payouts_checksum' },
  { tab: 'Adjustments', key: 'adjustments_checksum' },
]);

/** Write order: data tabs, then Summary, then Sync Info (commit marker). */
const SELLER_OUTPUT_WRITE_ORDER = Object.freeze(['Transactions', 'Settlements', 'Payouts', 'Adjustments']);

/** Current production regression (after Phase 2J; all legs AVAILABLE). Report only. */
const SELLER_SHEETS_REGRESSION = Object.freeze({
  snapshot: 'Production after Phase 2J (356 Transactions, 168 AVAILABLE legs, no payouts/adjustments)',
  sellers: {
    CUS001: { seller_name: 'DITECH', total_transactions: 88, matched_transactions: 43, missing_provider_transactions: 45,
      available_transactions: 43, unknown_economics_transactions: 45, current_balance: 1919.3986, settled_hold_remaining: 234.073,
      pending_settlement_amount: 0, pending_hold_amount: 0, total_known_hold: 234.073, total_known_obligation: 2153.4716 },
    CUS002: { seller_name: 'HUI', total_transactions: 143, matched_transactions: 74, missing_provider_transactions: 69,
      available_transactions: 74, unknown_economics_transactions: 69, current_balance: 3037.444, settled_hold_remaining: 370.42,
      pending_settlement_amount: 0, pending_hold_amount: 0, total_known_hold: 370.42, total_known_obligation: 3407.864 },
    CUS003: { seller_name: 'DINO', total_transactions: 26, matched_transactions: 4, missing_provider_transactions: 22,
      available_transactions: 4, unknown_economics_transactions: 22, current_balance: 256.7666, settled_hold_remaining: 31.313,
      pending_settlement_amount: 0, pending_hold_amount: 0, total_known_hold: 31.313, total_known_obligation: 288.0796 },
    CUS004: { seller_name: 'VNS_1', total_transactions: 99, matched_transactions: 47, missing_provider_transactions: 52,
      available_transactions: 47, unknown_economics_transactions: 52, current_balance: 3156.4424, settled_hold_remaining: 384.932,
      pending_settlement_amount: 0, pending_hold_amount: 0, total_known_hold: 384.932, total_known_obligation: 3541.3744 },
  },
  totals: { total_transactions: 356, matched_transactions: 168, missing_provider_transactions: 188, available_transactions: 168 },
});

/* ----------------------------- Pure helpers ----------------------------- */

function sellerOutputColumns_(tab) {
  return SELLER_OUTPUT_SCHEMA[tab].map(function (c) { return c.name; });
}

/** Output columns that are on the forbidden list (must be empty; checked by tests and at build time). */
function forbiddenSellerOutputColumns_() {
  const hits = [];
  Object.keys(SELLER_OUTPUT_SCHEMA).forEach(function (tab) {
    sellerOutputColumns_(tab).forEach(function (c) { if (SELLER_OUTPUT.forbiddenColumns.indexOf(c) >= 0) hits.push(tab + '.' + c); });
  });
  return hits;
}

/** Deterministic checksum of one content tab (Summary excludes last_content_sync_at). */
function sellerTabChecksum_(tab, rows, digestHex) {
  const columns = sellerOutputColumns_(tab);
  const values = buildTableValues_(columns, rows);
  const stamp = columns.indexOf(SELLER_OUTPUT.timestampColumn);
  return tab === SELLER_OUTPUT.tabs.SUMMARY ? tableChecksumExcluding_(values, [stamp], digestHex) : computeRawChecksum_(values, digestHex);
}

/** Combined checksum over the five content-tab checksums (fixed order). */
function sellerCombinedChecksum_(checksums, digestHex) {
  const digest = digestHex || sha256Hex_;
  return digest(SELLER_OUTPUT.checksumVersion + '|' + SELLER_OUTPUT_DATA_TABS.map(function (d) { return d.tab + '=' + checksums[d.key]; }).join('|'));
}

function microsOf_(v) {
  return Math.round(v * 1e6);
}

function compareByKeys_(keys) {
  return function (a, b) {
    for (let i = 0; i < keys.length; i++) {
      const d = compareCanonicalValues_(a[keys[i]], b[keys[i]]);
      if (d !== 0) return d;
    }
    return 0;
  };
}

/**
 * Builds the seller-specific snapshot (all six tabs, timestamp blank) for every requested seller.
 * @param {{sellers: Array<{seller_id: string, seller_name: string}>, transactions: Array<Object>, matches: Array<Object>,
 *          legs: Array<Object>, settlements: Array<Object>, balances: Array<Object>, payouts: Array<Object>,
 *          adjustments: Array<Object>, masterSchemaVersion: number, digestHex?: Function}} input
 * @return {{snapshots: Object<string, Object>, errors: Array<string>}}
 */
function buildSellerSnapshots_(input) {
  const errors = [];
  const forbidden = forbiddenSellerOutputColumns_();
  if (forbidden.length > 0) throw new Error('Seller output schema contains forbidden columns: ' + forbidden.join(', '));
  const key = function (source, id) { return String(source) + '|' + String(id); };

  const matchByTx = {};
  input.matches.forEach(function (m) {
    if (trimmedText_(m.internal_transaction_id) === '') return;
    const k = key(m.payment_source, m.internal_transaction_id);
    if (matchByTx[k]) errors.push('Payment Matches has internal transaction ' + k + ' twice');
    matchByTx[k] = m;
  });
  const legByMatch = {};
  input.legs.forEach(function (l) {
    if (legByMatch[String(l.match_id)]) errors.push('Payment Legs has match_id ' + l.match_id + ' twice');
    legByMatch[String(l.match_id)] = l;
  });
  const settlementById = {};
  input.settlements.forEach(function (s) { settlementById[String(s.settlement_id)] = s; });
  const seenTx = {};
  input.transactions.forEach(function (t) {
    const k = key(t.payment_source, t.internal_transaction_id);
    if (seenTx[k]) errors.push('Transactions has ' + k + ' twice');
    seenTx[k] = true;
  });

  const snapshots = {};
  input.sellers.forEach(function (seller) {
    const sellerId = seller.seller_id;
    const own = function (row) { return trimmedText_(row.seller_id) === sellerId; };
    const txRows = [];
    const sellerLegs = [];
    input.transactions.filter(own).forEach(function (t) {
      const label = 'Transaction ' + key(t.payment_source, t.internal_transaction_id);
      const m = matchByTx[key(t.payment_source, t.internal_transaction_id)];
      if (!m) { errors.push(label + ': no Payment Matches row'); return; }
      const reconciliation = trimmedText_(m.reconciliation_status);
      const leg = reconciliation === 'MATCHED' ? legByMatch[String(m.match_id)] : null;
      if (leg && (String(leg.internal_transaction_id) !== String(t.internal_transaction_id) || String(leg.payment_source) !== String(t.payment_source))) {
        errors.push(label + ': Payment Leg ' + leg.payment_leg_id + ' belongs to another transaction');
        return;
      }
      const row = { internal_transaction_id: t.internal_transaction_id, order_id: t.order_id, created_at: t.created_at,
        store_domain: t.store_domain, payment_source: t.payment_source, order_amount: t.order_amount, currency: t.currency,
        reconciliation_status: m.reconciliation_status, match_status: m.match_status, external_transaction_id: m.external_transaction_id,
        provider: m.provider_id };
      if (leg) {
        const status = trimmedText_(leg.settlement_status);
        let paymentDate = '';
        if (trimmedText_(leg.settlement_id) !== '') {
          const s = settlementById[String(leg.settlement_id)];
          if (!s) { errors.push(label + ': settlement ' + leg.settlement_id + ' not found in Settlements'); return; }
          paymentDate = s.source_payment_date;
        }
        ['gross_amount', 'processing_fee', 'net_amount', 'seller_fee_rate', 'seller_fee', 'seller_hold_amount', 'settlement_id']
          .forEach(function (f) { row[f] = leg[f]; });
        row.seller_amount_after_fee_hold = leg.seller_available_amount;
        row.available_to_payout = status === 'AVAILABLE' && isFiniteNumber_(leg.seller_available_amount) ? leg.seller_available_amount : '';
        row.settlement_status = leg.settlement_status;
        row.provider_payment_date = paymentDate;
        row.accounting_state = status;
        sellerLegs.push(leg);
      } else {
        row.accounting_state = reconciliation !== 'MATCHED' ? reconciliation : 'MATCHED';
      }
      txRows.push(row);
    });
    txRows.sort(compareByKeys_(['created_at', 'internal_transaction_id', 'payment_source']));

    // Seller-specific settlement aggregation (this seller's legs only).
    const groups = {};
    sellerLegs.forEach(function (l) {
      if (trimmedText_(l.settlement_id) === '') return;
      const k = String(l.settlement_id) + '|' + String(l.currency);
      const g = groups[k] = groups[k] || { legs: [], settlement: settlementById[String(l.settlement_id)], first: l };
      g.legs.push(l);
    });
    const settlementRows = Object.keys(groups).map(function (k) {
      const g = groups[k];
      const sum = function (f, filter) {
        return g.legs.reduce(function (a, l) { return a + (isFiniteNumber_(l[f]) && (!filter || filter(l)) ? microsOf_(l[f]) : 0); }, 0) / 1e6;
      };
      const statuses = g.legs.map(function (l) { return trimmedText_(l.settlement_status); });
      const status = statuses.indexOf('WAITING_SETTLEMENT') >= 0 ? 'WAITING_SETTLEMENT'
        : statuses.every(function (s) { return s === 'AVAILABLE'; }) ? 'AVAILABLE' : 'SETTLED';
      return { settlement_id: g.first.settlement_id, provider: g.first.provider, payment_source: g.first.payment_source, currency: g.first.currency,
        period_end_date: g.settlement.period_end_date, provider_payment_date: g.settlement.source_payment_date, settlement_status: status,
        transaction_count: g.legs.length, gross_amount: sum('gross_amount'), processing_fee: sum('processing_fee'), net_amount: sum('net_amount'),
        seller_fee: sum('seller_fee'), seller_hold_amount: sum('seller_hold_amount'), seller_amount_after_fee_hold: sum('seller_available_amount'),
        available_to_payout: sum('seller_available_amount', function (l) { return trimmedText_(l.settlement_status) === 'AVAILABLE'; }) };
    });
    settlementRows.sort(compareByKeys_(['period_end_date', 'settlement_id', 'currency']));

    const payoutRows = input.payouts.filter(own).map(function (p) {
      return { seller_payout_id: p.seller_payout_id, payout_date: p.payout_date, currency: p.currency, amount: p.amount, fx_rate: p.fx_rate,
        payout_currency: p.payout_currency, payout_amount: p.payout_amount, payment_method: p.payment_method, reference: p.reference, status: p.status };
    }).sort(compareByKeys_(['payout_date', 'seller_payout_id']));
    const adjustmentRows = input.adjustments.filter(own).map(function (a) {
      return { adjustment_id: a.adjustment_id, adjustment_type: a.adjustment_type, internal_transaction_id: a.internal_transaction_id,
        settlement_id: a.settlement_id, currency: a.currency, amount: a.amount, effective_date: a.effective_date, status: a.status, reason: a.reason };
    }).sort(compareByKeys_(['effective_date', 'adjustment_id']));

    // Summary: one row per currency known for this seller.
    const balances = input.balances.filter(own);
    const currencies = {};
    txRows.forEach(function (r) { currencies[trimmedText_(r.currency)] = true; });
    balances.forEach(function (b) { currencies[trimmedText_(b.currency)] = true; });
    sellerLegs.forEach(function (l) { currencies[trimmedText_(l.currency)] = true; });
    delete currencies[''];
    const currencyList = Object.keys(currencies).sort();
    if (currencyList.length === 0) currencyList.push(APP.DEFAULT_CURRENCY);
    const summaryRows = currencyList.map(function (c) {
      const bal = balances.filter(function (b) { return trimmedText_(b.currency) === c; });
      if (bal.length > 1) errors.push('Seller Balances has ' + sellerId + '|' + c + ' twice');
      const b = bal[0] || {};
      const num = function (v) { return isFiniteNumber_(v) ? microsOf_(v) : 0; };
      const pendingLegs = sellerLegs.filter(function (l) { return trimmedText_(l.currency) === c && trimmedText_(l.settlement_status) !== 'AVAILABLE'; });
      const pending = pendingLegs.reduce(function (a, l) { return a + num(l.seller_available_amount); }, 0);
      const pendingHold = pendingLegs.reduce(function (a, l) { return a + num(l.seller_hold_amount); }, 0);
      const settledHold = num(b.seller_hold_balance);
      const current = num(b.current_balance);
      const tx = txRows.filter(function (r) { return trimmedText_(r.currency) === c; });
      const count = function (fn) { return tx.filter(fn).length; };
      return { seller_id: sellerId, seller_name: seller.seller_name, currency: c, current_balance: current / 1e6,
        pending_settlement_amount: pending / 1e6, settled_hold_remaining: settledHold / 1e6, pending_hold_amount: pendingHold / 1e6,
        total_known_hold: (settledHold + pendingHold) / 1e6, paid_amount: num(b.paid_amount) / 1e6, adjustments: num(b.adjustments) / 1e6,
        total_known_obligation: (current + pending + settledHold + pendingHold) / 1e6, total_transactions: tx.length,
        matched_transactions: count(function (r) { return r.reconciliation_status === 'MATCHED'; }),
        missing_provider_transactions: count(function (r) { return r.reconciliation_status === 'MISSING_PROVIDER'; }),
        waiting_settlement_transactions: count(function (r) { return r.accounting_state === 'WAITING_SETTLEMENT'; }),
        settled_not_paid_transactions: count(function (r) { return r.accounting_state === 'SETTLED'; }),
        available_transactions: count(function (r) { return r.accounting_state === 'AVAILABLE'; }),
        unknown_economics_transactions: count(function (r) { return !isFiniteNumber_(r.seller_amount_after_fee_hold); }),
        last_content_sync_at: '' };
    });

    const objects = { 'Summary': summaryRows, 'Transactions': txRows, 'Settlements': settlementRows, 'Payouts': payoutRows,
      'Adjustments': adjustmentRows };
    const values = {};
    Object.keys(objects).forEach(function (tab) {
      const columns = sellerOutputColumns_(tab);
      values[tab] = objects[tab].map(function (o) { return objectToRow_(o, columns); });
    });
    const checksums = {};
    SELLER_OUTPUT_DATA_TABS.forEach(function (d) { checksums[d.key] = sellerTabChecksum_(d.tab, values[d.tab], input.digestHex); });
    checksums.combined_checksum = sellerCombinedChecksum_(checksums, input.digestHex);
    const ids = function (rows, f) { const o = {}; rows.forEach(function (r) { o[String(r[f])] = true; }); return o; };
    snapshots[sellerId] = {
      seller_id: sellerId, seller_name: seller.seller_name, values: values, checksums: checksums,
      sync_info: { seller_id: sellerId, seller_name: seller.seller_name, seller_output_schema_version: SELLER_OUTPUT.schemaVersion,
        master_schema_version: input.masterSchemaVersion, last_content_sync_at: '', summary_checksum: checksums.summary_checksum,
        transactions_checksum: checksums.transactions_checksum, settlements_checksum: checksums.settlements_checksum,
        payouts_checksum: checksums.payouts_checksum, adjustments_checksum: checksums.adjustments_checksum,
        combined_checksum: checksums.combined_checksum },
      owned: { transactions: ids(txRows, 'internal_transaction_id'), settlements: ids(settlementRows, 'settlement_id'),
        payouts: ids(payoutRows, 'seller_payout_id'), adjustments: ids(adjustmentRows, 'adjustment_id') },
      summary: summaryRows,
      counts: { transaction_rows: txRows.length, settlement_rows: settlementRows.length, payout_rows: payoutRows.length,
        adjustment_rows: adjustmentRows.length },
    };
  });
  return { snapshots: snapshots, errors: errors };
}

/** Output values that look like an endpoint token/credential (must be none). */
function findCredentialsInSnapshot_(snapshot) {
  const hits = [];
  Object.keys(snapshot.values).forEach(function (tab) {
    const columns = sellerOutputColumns_(tab);
    snapshot.values[tab].forEach(function (row, r) {
      row.forEach(function (v, c) {
        if (typeof v === 'string' && SELLER_OUTPUT.credentialPattern.test(v)) hits.push(snapshot.seller_id + ' ' + tab + ' row ' + (r + 2) + ' ' + columns[c]);
      });
    });
  });
  return hits;
}

/** Summary rows with the sync timestamp, and the Sync Info row (commit marker). */
function sellerSummaryValuesAt_(snapshot, at) {
  const idx = sellerOutputColumns_(SELLER_OUTPUT.tabs.SUMMARY).indexOf(SELLER_OUTPUT.timestampColumn);
  return snapshot.values[SELLER_OUTPUT.tabs.SUMMARY].map(function (row) { const r = row.slice(); r[idx] = at; return r; });
}

function sellerSyncInfoValuesAt_(snapshot, at) {
  const info = Object.assign({}, snapshot.sync_info, { last_content_sync_at: at });
  return [objectToRow_(info, sellerOutputColumns_(SELLER_OUTPUT.tabs.SYNC_INFO))];
}

/**
 * Parses one child tab grid against its output schema.
 * @param {string} tab
 * @param {?{values: Array<Array<*>>, formulas: ?Array<Array<string>>}} state null when the tab does not exist
 */
function parseChildTab_(tab, state) {
  const columns = sellerOutputColumns_(tab);
  const out = { exists: !!state, header_ok: false, rows: [], errors: [], forbidden_columns: [], formula_cells: 0 };
  if (!state) { out.errors.push(tab + ': tab is missing'); return out; }
  const values = state.values || [];
  const header = (values[0] || []).map(function (h) { return String(h).trim(); });
  header.forEach(function (h) { if (SELLER_OUTPUT.forbiddenColumns.indexOf(h) >= 0) out.forbidden_columns.push(tab + '.' + h); });
  const width = columns.length;
  out.header_ok = header.length >= width && columns.every(function (c, i) { return header[i] === c; }) &&
    header.slice(width).every(function (h) { return h === ''; });
  if (!out.header_ok) out.errors.push(tab + ': header does not match the seller output schema');
  values.slice(1).forEach(function (row, i) {
    if (row.every(isBlankCell_)) return;
    if (row.slice(width).some(function (v) { return !isBlankCell_(v); })) out.errors.push(tab + ': row ' + (i + 2) + ' has values outside the managed columns');
    out.rows.push(row.slice(0, width).concat(Array(Math.max(0, width - row.length)).fill('')));
  });
  (state.formulas || []).forEach(function (row) { row.forEach(function (f) { if (f !== '' && f !== null && f !== undefined) out.formula_cells++; }); });
  if (out.formula_cells > 0) out.errors.push(tab + ': ' + out.formula_cells + ' formula cell(s); seller tabs must hold values only');
  return out;
}

/**
 * Compares a child spreadsheet state against the desired snapshot. Used by sync (NO_CHANGE decision and
 * post-write verification) and by verifySellerSheets.
 * @param {Object} snapshot buildSellerSnapshots_ entry
 * @param {{timeZone: string, tabs: Object<string, ?Object>}} state
 */
function compareChildToSnapshot_(snapshot, state) {
  const T_ = SELLER_OUTPUT.tabs;
  const r = { summary_match: false, transactions_match: false, settlements_match: false, payouts_match: false, adjustments_match: false,
    sync_info_match: false, combined_match: false, timestamp_valid: false, time_zone_ok: state.timeZone === APP.TIMEZONE,
    transaction_rows: 0, settlement_rows: 0, payout_rows: 0, adjustment_rows: 0, last_content_sync_at: null, changed_tabs: [],
    actual_checksums: {}, errors: [], warnings: [] };
  if (!r.time_zone_ok) r.errors.push('child time zone is ' + state.timeZone + '; expected ' + APP.TIMEZONE);
  const parsed = {};
  Object.keys(SELLER_OUTPUT_SCHEMA).forEach(function (tab) {
    parsed[tab] = parseChildTab_(tab, state.tabs[tab]);
    parsed[tab].errors.forEach(function (e) { r.errors.push(e); });
    parsed[tab].forbidden_columns.forEach(function (c) { r.errors.push('forbidden output column ' + c); });
  });
  SELLER_OUTPUT_DATA_TABS.forEach(function (d) {
    const p = parsed[d.tab];
    const actual = p.exists && p.header_ok ? sellerTabChecksum_(d.tab, p.rows) : null;
    r.actual_checksums[d.key] = actual;
    const match = actual !== null && actual === snapshot.checksums[d.key] && p.errors.length === 0;
    r[d.key.replace('_checksum', '_match')] = match;
    if (!match) {
      r.changed_tabs.push(d.tab);
      if (p.exists && p.header_ok) r.errors.push(d.tab + ': content differs from Payment Master');
    }
  });
  r.transaction_rows = parsed[T_.TRANSACTIONS].rows.length;
  r.settlement_rows = parsed[T_.SETTLEMENTS].rows.length;
  r.payout_rows = parsed[T_.PAYOUTS].rows.length;
  r.adjustment_rows = parsed[T_.ADJUSTMENTS].rows.length;

  // Seller isolation (independent of checksums): every visible row must be this seller's own.
  const col = function (tab, name) { return sellerOutputColumns_(tab).indexOf(name); };
  const isolate = function (tab, field, owned) {
    parsed[tab].rows.forEach(function (row) {
      const v = String(row[col(tab, field)]);
      if (!owned[v]) r.errors.push('isolation: ' + tab + ' shows ' + field + ' ' + v + ' that is not owned by ' + snapshot.seller_id);
    });
  };
  isolate(T_.TRANSACTIONS, 'internal_transaction_id', snapshot.owned.transactions);
  isolate(T_.SETTLEMENTS, 'settlement_id', snapshot.owned.settlements);
  isolate(T_.PAYOUTS, 'seller_payout_id', snapshot.owned.payouts);
  isolate(T_.ADJUSTMENTS, 'adjustment_id', snapshot.owned.adjustments);
  [T_.SUMMARY, T_.SYNC_INFO].forEach(function (tab) {
    parsed[tab].rows.forEach(function (row) {
      if (String(row[col(tab, 'seller_id')]) !== snapshot.seller_id) r.errors.push('isolation: ' + tab + ' shows seller_id ' + row[col(tab, 'seller_id')]);
    });
  });
  // No credentials / endpoint tokens anywhere in managed tabs.
  Object.keys(parsed).forEach(function (tab) {
    parsed[tab].rows.forEach(function (row, i) {
      if (row.some(function (v) { return typeof v === 'string' && SELLER_OUTPUT.credentialPattern.test(v); })) {
        r.errors.push(tab + ': row ' + (i + 2) + ' contains an endpoint token or credential');
      }
    });
  });

  // Sync Info: the commit marker.
  const info = parsed[T_.SYNC_INFO];
  const infoColumns = sellerOutputColumns_(T_.SYNC_INFO);
  if (info.exists && info.header_ok) {
    if (info.rows.length !== 1) {
      r.errors.push('Sync Info: expected exactly 1 row, found ' + info.rows.length);
    } else {
      const row = rowToObject_(info.rows[0], infoColumns);
      const stamp = row.last_content_sync_at;
      r.timestamp_valid = isDateValue_(stamp) && isFinite(stamp.getTime());
      r.last_content_sync_at = r.timestamp_valid ? stamp : null;
      if (!r.timestamp_valid) r.errors.push('Sync Info: last_content_sync_at is not a valid datetime');
      const differing = infoColumns.filter(function (c) {
        return c !== SELLER_OUTPUT.timestampColumn && serializeCell_(row[c]) !== serializeCell_(snapshot.sync_info[c]);
      });
      r.sync_info_match = differing.length === 0;
      if (!r.sync_info_match) r.errors.push('Sync Info differs from Payment Master in ' + differing.join(', '));
      const actualCombined = SELLER_OUTPUT_DATA_TABS.every(function (d) { return r.actual_checksums[d.key] !== null; })
        ? sellerCombinedChecksum_(r.actual_checksums) : null;
      r.combined_match = row.combined_checksum === snapshot.checksums.combined_checksum && actualCombined === row.combined_checksum;
      if (!r.combined_match) r.errors.push('combined checksum mismatch (child content does not match its Sync Info / Payment Master)');
      // Every Summary row carries the same sync timestamp as Sync Info.
      const stampIdx = col(T_.SUMMARY, SELLER_OUTPUT.timestampColumn);
      if (r.timestamp_valid && parsed[T_.SUMMARY].rows.some(function (s) { return serializeCell_(s[stampIdx]) !== serializeCell_(stamp); })) {
        r.errors.push('Summary.last_content_sync_at differs from Sync Info (incomplete sync)');
      }
    }
  }
  return r;
}

/** Overall sync status from per-seller results. */
function decideSellerSyncStatus_(results) {
  if (results.length === 0) return 'NO_CHANGE';
  const failed = results.filter(function (x) { return x.status === 'FAILED'; }).length;
  const ok = results.length - failed;
  if (failed > 0) return ok > 0 ? 'PARTIAL' : 'FAILED';
  return results.some(function (x) { return x.status === 'SUCCESS'; }) ? 'SUCCESS' : 'NO_CHANGE';
}

/** Report-only regression of the expected seller summaries (USD row per seller). */
function evaluateSellerSheetsRegression_(snapshots) {
  const exp = SELLER_SHEETS_REGRESSION;
  const checks = [];
  const add = function (n, e, a, pass) { checks.push({ name: n, expected: e, actual: a, pass: pass }); };
  const totals = { total_transactions: 0, matched_transactions: 0, missing_provider_transactions: 0, available_transactions: 0 };
  Object.keys(snapshots).forEach(function (id) {
    snapshots[id].summary.forEach(function (s) { Object.keys(totals).forEach(function (k) { totals[k] += s[k]; }); });
  });
  Object.keys(exp.sellers).forEach(function (id) {
    const s = snapshots[id] ? snapshots[id].summary.filter(function (x) { return x.currency === 'USD'; })[0] : null;
    Object.keys(exp.sellers[id]).forEach(function (f) {
      const e = exp.sellers[id][f];
      const a = s ? s[f] : null;
      add(id + '.' + f, e, a, typeof e === 'number' ? isFiniteNumber_(a) && Math.abs(a - e) < 0.00005 : a === e);
    });
  });
  Object.keys(exp.totals).forEach(function (k) { add('totals.' + k, exp.totals[k], totals[k], totals[k] === exp.totals[k]); });
  return { snapshot: exp.snapshot, pass: checks.every(function (c) { return c.pass; }),
    failed: checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }), checks: checks };
}

/* ---------------------------------- I/O --------------------------------- */

/**
 * Every Master layer a seller sheet is projected from must be current. Read-only, never throws.
 * @return {{current: boolean, gates: Object<string, boolean>, reasons: Array<string>}}
 */
function readSellerSheetsGates_(ss) {
  const gates = {};
  const reasons = [];
  const add = function (name, f) {
    gates[name] = !!f.current;
    if (!f.current) reasons.push(f.reason || name + ' is not current');
  };
  const upstream = readSettlementItemsUpstream_(ss);
  Object.keys(upstream).forEach(function (k) { add(k, upstream[k]); });
  const items = readSettlementItemsFreshness_(ss, upstream);
  add('settlement_items', items);
  add('seller_balances', readSellerBalancesFreshness_(ss, items));
  return { current: reasons.length === 0, gates: gates, reasons: reasons };
}

/** Reads the Master tables the projection uses and builds snapshots for the given sellers. */
function buildSellerSnapshotsFromMaster_(ss, sellers) {
  return buildSellerSnapshots_({
    sellers: sellers,
    transactions: readSchemaTableObjects_(ss, SHEETS.TRANSACTIONS, transactionsTab_()).rows,
    matches: readSchemaTableObjects_(ss, SHEETS.PAYMENT_MATCHES, paymentMatchesTab_()).rows,
    legs: readSchemaTableObjects_(ss, SHEETS.PAYMENT_LEGS, paymentLegsTab_()).rows,
    settlements: readSchemaTableObjects_(ss, SHEETS.SETTLEMENTS, settlementsTab_()).rows,
    balances: readSchemaTableObjects_(ss, SHEETS.SELLER_BALANCES, sellerBalancesTab_()).rows,
    payouts: readPlainTableObjects_(ss, SHEETS.SELLER_PAYOUTS),
    adjustments: readPlainTableObjects_(ss, SHEETS.ADJUSTMENTS),
    masterSchemaVersion: APP.SCHEMA_VERSION,
  });
}

/** Read-only state of the managed tabs of a child spreadsheet. */
function readChildState_(child) {
  const state = { timeZone: child.getSpreadsheetTimeZone(), tabs: {} };
  Object.keys(SELLER_OUTPUT_SCHEMA).forEach(function (tab) {
    const sheet = child.getSheetByName(tab);
    if (!sheet) { state.tabs[tab] = null; return; }
    const range = sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns());
    state.tabs[tab] = { values: range.getValues(), formulas: range.getFormulas() };
  });
  return state;
}

/** Replaces one managed tab's content and formatting (values only). Never touches other tabs. */
function writeChildTab_(child, tab, rows) {
  const columns = SELLER_OUTPUT_SCHEMA[tab];
  const width = columns.length;
  const height = Math.max(rows.length + 1, 2);
  const sheet = child.getSheetByName(tab) || child.insertSheet(tab);
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.clear();
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearDataValidations();
  if (sheet.getMaxRows() < height) sheet.insertRowsAfter(sheet.getMaxRows(), height - sheet.getMaxRows());
  if (sheet.getMaxRows() > height) sheet.deleteRows(height + 1, sheet.getMaxRows() - height);
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  if (sheet.getMaxColumns() > width) sheet.deleteColumns(width + 1, sheet.getMaxColumns() - width);
  // Formats first, so IDs stay text and numbers keep full precision when values are written.
  columns.forEach(function (c, i) {
    sheet.getRange(2, i + 1, height - 1, 1).setNumberFormat(FORMATS[c.type] || FORMATS.TEXT);
    sheet.setColumnWidth(i + 1, COLUMN_WIDTHS[c.type] || 140);
  });
  sheet.getRange(1, 1, 1, width).setNumberFormat('@').setValues([columns.map(function (c) { return c.name; })])
    .setFontWeight('bold').setBackground(HEADER_BACKGROUND).setBorder(null, null, true, null, null, null);
  sheet.setFrozenRows(1);
  if (rows.length > 0) sheet.getRange(2, 1, rows.length, width).setValues(rows);
  sheet.getRange(1, 1, height, width).createFilter();
}

/**
 * Writes the Sync Info commit marker. When the tab already has the exact managed shape (header + one row)
 * only row 2 is overwritten with one setValues call, so an interrupted commit leaves the previous marker.
 */
function commitChildSyncInfo_(child, row) {
  const tab = SELLER_OUTPUT.tabs.SYNC_INFO;
  const columns = SELLER_OUTPUT_SCHEMA[tab];
  const sheet = child.getSheetByName(tab);
  const shapeOk = sheet && sheet.getMaxRows() === 2 && sheet.getMaxColumns() === columns.length &&
    sheet.getRange(1, 1, 1, columns.length).getValues()[0].every(function (h, i) { return String(h).trim() === columns[i].name; }) &&
    sheet.getRange(1, 1, 2, columns.length).getFormulas().every(function (r) { return r.every(function (f) { return f === ''; }); });
  if (!shapeOk) { writeChildTab_(child, tab, [row]); return; }
  columns.forEach(function (c, i) { sheet.getRange(2, i + 1, 1, 1).setNumberFormat(FORMATS[c.type] || FORMATS.TEXT); });
  sheet.getRange(2, 1, 1, columns.length).setValues([row]);
}

/** Syncs one ACTIVE destination. Never throws; a failure affects this seller only. */
function syncOneSellerSheet_(dest, snapshot, masterId) {
  const result = { seller_id: dest.seller_id, seller_name: snapshot.seller_name, spreadsheet_id: dest.spreadsheet_id, status: 'FAILED',
    written_tabs: [], last_content_sync_at: null, combined_checksum: snapshot.checksums.combined_checksum, error: null };
  Object.keys(snapshot.counts).forEach(function (k) { result[k] = snapshot.counts[k]; });
  try {
    const child = SpreadsheetApp.openById(dest.spreadsheet_id);
    if (child.getId() === masterId) throw new Error('destination resolves to the Payment Master; refusing to write');
    const before = compareChildToSnapshot_(snapshot, readChildState_(child));
    if (before.errors.length === 0) {
      result.status = 'NO_CHANGE';
      result.last_content_sync_at = before.last_content_sync_at;
      return result;
    }
    const at = new Date(Math.floor(Date.now() / 1000) * 1000);
    if (!before.time_zone_ok) child.setSpreadsheetTimeZone(APP.TIMEZONE);
    const tabs = before.time_zone_ok
      ? SELLER_OUTPUT_WRITE_ORDER.filter(function (t) { return before.changed_tabs.indexOf(t) >= 0; })
      : SELLER_OUTPUT_WRITE_ORDER.slice();
    tabs.forEach(function (t) { writeChildTab_(child, t, snapshot.values[t]); result.written_tabs.push(t); });
    writeChildTab_(child, SELLER_OUTPUT.tabs.SUMMARY, sellerSummaryValuesAt_(snapshot, at));
    result.written_tabs.push(SELLER_OUTPUT.tabs.SUMMARY);
    commitChildSyncInfo_(child, sellerSyncInfoValuesAt_(snapshot, at)[0]); // commit marker, LAST
    result.written_tabs.push(SELLER_OUTPUT.tabs.SYNC_INFO);
    SpreadsheetApp.flush();
    const after = compareChildToSnapshot_(snapshot, readChildState_(child));
    if (after.errors.length > 0) throw new Error('post-write verification failed: ' + after.errors.slice(0, 5).join(' | '));
    if (!after.last_content_sync_at || after.last_content_sync_at.getTime() !== at.getTime()) throw new Error('Sync Info timestamp was not committed');
    result.status = 'SUCCESS';
    result.last_content_sync_at = at;
  } catch (err) {
    result.status = 'FAILED';
    result.error = redactEndpointCredentials_(err && err.message ? err.message : String(err));
  }
  return result;
}

/** Syncs every ACTIVE Seller Destination under the script lock. Never throws. */
function runSellerSheetsSync_() {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  const details = { active_destinations: 0, sellers: [], warnings: [] };
  let status = 'FAILED';
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms.');
    const ss = getSpreadsheet_();
    // 1. Destination config: any ambiguity is a leak risk -> nothing is written anywhere.
    const dest = readSellerDestinations_(ss);
    const destErrors = flattenDestinationErrors_(dest.parsed.errors);
    details.warnings = dest.parsed.warnings.slice();
    if (destErrors.length > 0) {
      throw new Error('Seller Destinations is invalid; no seller sheet written (' + destErrors.length + ' error(s)): ' +
        destErrors.slice(0, SELLER_OUTPUT.maxReportedErrors).join(' | '));
    }
    const active = dest.parsed.active;
    details.active_destinations = active.length;
    if (active.length === 0) {
      details.warnings.push('No ACTIVE Seller Destinations; nothing to sync.');
      status = 'NO_CHANGE';
    } else {
      // 2. Master freshness: never publish stale accounting.
      const gates = readSellerSheetsGates_(ss);
      details.gates = gates.gates;
      if (!gates.current) throw new Error('Payment Master is not current; no seller sheet written: ' + gates.reasons.join(' | '));
      // 3. Whole snapshot in memory; integrity / credential problems fail globally.
      const built = buildSellerSnapshotsFromMaster_(ss, active.map(function (d) { return { seller_id: d.seller_id, seller_name: d.seller_name }; }));
      if (built.errors.length > 0) {
        throw new Error('Seller snapshot is invalid; no seller sheet written (' + built.errors.length + ' error(s)): ' +
          built.errors.slice(0, SELLER_OUTPUT.maxReportedErrors).join(' | '));
      }
      const leaks = [];
      active.forEach(function (d) { findCredentialsInSnapshot_(built.snapshots[d.seller_id]).forEach(function (h) { leaks.push(h); }); });
      if (leaks.length > 0) throw new Error('Seller output contains endpoint tokens/credentials; no seller sheet written: ' + leaks.slice(0, 10).join(' | '));
      // 4. Per seller: a destination failure affects that seller only.
      active.forEach(function (d) { details.sellers.push(syncOneSellerSheet_(d, built.snapshots[d.seller_id], ss.getId())); });
      status = decideSellerSyncStatus_(details.sellers);
    }
  } catch (err) {
    details.error = redactEndpointCredentials_(err && err.message ? err.message : String(err));
    status = 'FAILED';
  } finally {
    details.status_counts = details.sellers.reduce(function (a, x) { a[x.status] = (a[x.status] || 0) + 1; return a; }, {});
    try {
      appendAuditLog_({ action: 'SELLER_SHEETS_SYNC_' + status, entityType: 'SELLER_SHEETS', entityId: '', newStatus: status,
        details: redactDeep_(details) });
    } catch (auditErr) {
      Logger.log('Failed to write audit entry: %s', auditErr);
    }
    if (locked) lock.releaseLock();
  }
  return redactDeep_(Object.assign({ status: status }, details));
}

/** Read-only verification of every ACTIVE seller child spreadsheet. Never writes. */
function buildSellerSheetsReport_() {
  const report = { active_destinations: 0, passed_destinations: 0, failed_destinations: 0, master_fresh: false, destinations_valid: false,
    gates: {}, sellers: [], regression: null, pass: false, errors: [], warnings: [] };
  try {
    const ss = getSpreadsheet_();
    const dest = readSellerDestinations_(ss);
    const destErrors = flattenDestinationErrors_(dest.parsed.errors);
    report.destinations_valid = destErrors.length === 0;
    destErrors.forEach(function (e) { report.errors.push('Seller Destinations: ' + e); });
    dest.parsed.warnings.forEach(function (w) { report.warnings.push(w); });
    const gates = readSellerSheetsGates_(ss);
    report.master_fresh = gates.current;
    report.gates = gates.gates;
    gates.reasons.forEach(function (x) { report.errors.push(x); });
    const sellers = dest.sellers.filter(function (s) { return s.seller_id !== ''; })
      .map(function (s) { return { seller_id: s.seller_id, seller_name: s.seller_name }; });
    const built = buildSellerSnapshotsFromMaster_(ss, sellers);
    built.errors.forEach(function (e) { report.errors.push(e); });
    report.regression = evaluateSellerSheetsRegression_(built.snapshots);
    const active = report.destinations_valid ? dest.parsed.active : [];
    report.active_destinations = active.length;
    if (active.length === 0) report.warnings.push('No ACTIVE Seller Destinations to verify.');
    active.forEach(function (d) {
      const snapshot = built.snapshots[d.seller_id];
      const s = { seller_id: d.seller_id, seller_name: d.seller_name, spreadsheet_id: d.spreadsheet_id, accessible: false, summary_match: false,
        transactions_match: false, settlements_match: false, payouts_match: false, adjustments_match: false, sync_info_match: false,
        combined_match: false, transaction_rows: 0, settlement_rows: 0, payout_rows: 0, adjustment_rows: 0, last_content_sync_at: null,
        pass: false, errors: [], warnings: [] };
      try {
        const child = SpreadsheetApp.openById(d.spreadsheet_id);
        s.accessible = true;
        if (child.getId() === ss.getId()) throw new Error('destination resolves to the Payment Master');
        const c = compareChildToSnapshot_(snapshot, readChildState_(child));
        ['summary_match', 'transactions_match', 'settlements_match', 'payouts_match', 'adjustments_match', 'sync_info_match', 'combined_match',
          'transaction_rows', 'settlement_rows', 'payout_rows', 'adjustment_rows', 'last_content_sync_at'].forEach(function (k) { s[k] = c[k]; });
        s.errors = c.errors.slice(0, SELLER_OUTPUT.maxReportedErrors);
        s.warnings = c.warnings;
      } catch (err) {
        s.errors.push(err && err.message ? err.message : String(err));
      }
      s.pass = s.errors.length === 0 && report.master_fresh;
      if (s.pass) report.passed_destinations++; else report.failed_destinations++;
      report.sellers.push(s);
    });
    if (report.failed_destinations > 0) report.errors.push(report.failed_destinations + ' seller destination(s) failed verification.');
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0;
  return redactDeep_(report);
}
