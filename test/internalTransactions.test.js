// Unit tests for internal CSV ingestion (pure parts of src/InternalTransactions.gs). All data is fake.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  computeDigest: (_alg, text) => [...crypto.createHash('sha256').update(text, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
  formatDate: (date, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date),
};
const context = vm.createContext({ Utilities });
for (const f of ['Config', 'Utils', 'RawSnapshot', 'CanonicalTable', 'Kh001ProviderTransactions', 'Kh001ProviderEvents',
  'Kh001Settlements', 'SellerMapping', 'EndpointKeyMigration', 'InternalTransactions']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.gs'), 'utf8'), context, { filename: f + '.gs' });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const RAW_COLUMNS = js(H.getColumnNames_('Raw Internal Transactions'));
const TX_COLUMNS = js(H.getColumnNames_('Transactions'));
const SS_COLUMNS = js(H.getColumnNames_('Source System'));
const NY = 'America/New_York';
// Test-only "local time" parser: fixed offsets per zone are enough for these fixtures.
const parseLocal = (text, tz) => vm.runInContext(`new Date(${JSON.stringify(text.replace(' ', 'T') + (tz === 'UTC' ? 'Z' : '-04:00'))})`, context);

// ---- Fixtures ---------------------------------------------------------------------------
const SELLER_COLUMNS = js(H.getColumnNames_('Sellers'));
function sellerRow(id, name, from, eps) {
  const row = SELLER_COLUMNS.map(() => '');
  const set = (c, v) => { row[SELLER_COLUMNS.indexOf(c)] = v; };
  set('seller_id', id); set('seller_name', name); set('status', 'ACTIVE'); set('effective_from', from);
  eps.forEach(([n, k], i) => { set('endpoint_' + (i + 1) + '_name', n); set('endpoint_' + (i + 1) + '_key', k); });
  return row;
}
function mappingHistory(steps) {
  let records = [];
  steps.forEach((rows, i) => {
    const draft = H.parseSellersDraft_([SELLER_COLUMNS, ...rows], (v) => H.providerDateKey_(v, NY));
    const plan = H.planSellerMappingPublish_(draft.sellers, records, 'T' + i);
    if (plan.status === 'CHANGES') records = js(plan.newRecords).map((r, j) => ({ ...r, _index: j }));
  });
  return records;
}
const MAP = () => mappingHistory([[sellerRow('SLR-000001', 'Seller One', '2026-10-01', [['Shop A', 'glk_testA'], ['Shop B', 'glk_testB']]),
  sellerRow('SLR-000002', 'Seller Two', '2026-10-01', [['Shop C', 'glk_testC']])]]);

function raw(o) {
  const r = {
    order_id: '1001', payment_method: 'paypal_checkout', transaction_id: 'TX1', gateway: 'paypal', status: 'captured',
    total: '65.49', currency: 'USD', sub_account: 'sub-1', store_domain: 'shop.example', shield_domain: 'shield.example',
    endpoint_token: 'glk_testA', created_at: '2026-10-02T15:00:00Z', refunded_at: '', customer: 'buyer@example.com',
    settled_at: '', note: '', import_batch_id: 'IB-INTERNAL-1', source_file_name: 'export.csv', source_row_number: 2,
    imported_at: '2026-10-10T08:00:00Z', _row: 2, ...o,
  };
  if (!('row_fingerprint' in o)) r.row_fingerprint = H.computeInternalRowFingerprint_(r);
  return r;
}
const build = (rows, mapping, opts) => H.buildInternalCanonical_(rows, mapping || MAP(), { naiveTimeZone: '', parseLocal,
  ownershipTimeZone: NY, ...(opts || {}) });
const errs = (b) => js(H.flattenInternalErrors_(b.errors)).join(' | ');
const txById = (b) => Object.fromEntries(js(b.transactions).map((t) => [t.internal_transaction_id, t]));

// ---- Raw contract / fingerprint -------------------------------------------------------------
test('exact 16-column raw contract followed by 5 metadata columns', () => {
  assert.deepEqual(RAW_COLUMNS, ['order_id', 'payment_method', 'transaction_id', 'gateway', 'status', 'total', 'currency',
    'sub_account', 'store_domain', 'shield_domain', 'endpoint_token', 'created_at', 'refunded_at', 'customer', 'settled_at',
    'note', 'import_batch_id', 'source_file_name', 'source_row_number', 'row_fingerprint', 'imported_at']);
  assert.deepEqual(js(vm.runInContext('INTERNAL_TX.rawColumns', context)), RAW_COLUMNS.slice(0, 16));
  assert.equal(SS_COLUMNS.length, 22);
  assert.equal(TX_COLUMNS.length, 26);
});

test('row_fingerprint is deterministic, follows the documented algorithm and ignores metadata', () => {
  const r = raw({});
  const fields = RAW_COLUMNS.slice(0, 16).map((c) => (r[c] === '' ? 'E' : 'S' + JSON.stringify(String(r[c]))));
  assert.equal(r.row_fingerprint, sha('INTERNAL_RAW_V1\u001e' + fields.join('\u001f')));
  assert.equal(H.computeInternalRowFingerprint_(raw({ import_batch_id: 'OTHER', imported_at: 'x', source_row_number: 99 })), r.row_fingerprint);
  assert.notEqual(H.computeInternalRowFingerprint_(raw({ status: 'refunded' })), r.row_fingerprint);
  assert.notEqual(H.computeInternalRowFingerprint_(raw({ total: '65.490' })), r.row_fingerprint, 'raw text is not normalized');
});

test('tampered raw row (fingerprint mismatch) and bad metadata fail the contract', () => {
  assert.match(errs(build([raw({ row_fingerprint: 'deadbeef' })])), /row_fingerprint does not match the 16 raw fields/);
  assert.match(errs(build([raw({ import_batch_id: '' })])), /import_batch_id is blank/);
  assert.match(errs(build([raw({ source_row_number: 0 })])), /source_row_number must be a positive integer/);
  assert.equal(errs(build([raw({ source_row_number: '7' })])), '', 'numeric text accepted');
});

// ---- Snapshot selection -------------------------------------------------------------------
test('identical repeated snapshots produce one canonical row', () => {
  const b = build([raw({}), raw({ _row: 3, source_row_number: 3 }), raw({ _row: 4, import_batch_id: 'IB-INTERNAL-2', imported_at: '2026-10-11T08:00:00Z' })]);
  assert.equal(errs(b), '');
  assert.equal(b.transactions.length, 1);
  assert.equal(b.stats.raw_rows, 3);
  assert.equal(b.stats.raw_unique_transaction_ids, 1);
  assert.equal(b.stats.raw_unique_fingerprints, 1);
});

test('later imported snapshot wins; earlier raw is kept; tie broken by batch id then row number', () => {
  const b = build([raw({}), raw({ _row: 3, import_batch_id: 'IB-INTERNAL-2', imported_at: '2026-10-12T08:00:00Z', status: 'refunded',
    refunded_at: '2026-10-11T10:00:00Z' })]);
  const t = txById(b).TX1;
  assert.equal(t.raw_status, 'refunded');
  assert.equal(t.refunded_at_raw, '2026-10-11T10:00:00Z');
  assert.equal(t.import_batch_id, 'IB-INTERNAL-2');
  const tie = build([raw({ import_batch_id: 'IB-B', status: 'b' }), raw({ _row: 3, import_batch_id: 'IB-A', status: 'a' })]);
  assert.equal(txById(tie).TX1.raw_status, 'b', 'same imported_at: higher batch id wins');
});

test('same-batch conflicting snapshots fail', () => {
  const b = build([raw({}), raw({ _row: 3, source_row_number: 3, total: '70.00' })]);
  assert.match(errs(b), /transaction_id TX1 has different snapshots within batch IB-INTERNAL-1/);
});

test('same transaction changing gateway fails', () => {
  const b = build([raw({}), raw({ _row: 3, import_batch_id: 'IB-INTERNAL-2', gateway: 'stripe', imported_at: '2026-10-11T08:00:00Z' })]);
  assert.match(errs(b), /transaction_id TX1 appears under payment sources PAYPAL, STRIPE/);
});

// ---- Gateway ----------------------------------------------------------------------------------
test('PayPal / Stripe mapping is exact and case-insensitive; unknown or blank gateway fails', () => {
  assert.equal(H.normalizeInternalGateway_('PayPal'), 'PAYPAL');
  assert.equal(H.normalizeInternalGateway_(' STRIPE '), 'STRIPE');
  assert.equal(H.normalizeInternalGateway_('paypal-express'), null);
  const b = build([raw({ transaction_id: 'TX2', gateway: 'Stripe' }), raw({ _row: 3, transaction_id: 'TX3', gateway: 'square' }),
    raw({ _row: 4, transaction_id: 'TX4', gateway: '' })]);
  assert.match(errs(b), /\(TX3\): unsupported gateway "square"/);
  assert.match(errs(b), /\(TX4\): unsupported gateway ""/);
  assert.equal(txById(build([raw({ gateway: 'Stripe' })])).TX1.payment_source, 'STRIPE');
});

// ---- Ownership ---------------------------------------------------------------------------------
test('exact endpoint token mapping fills seller and mapping snapshot fields', () => {
  const t = txById(build([raw({})])).TX1;
  assert.equal(t.ownership_status, 'MAPPED');
  assert.equal(t.seller_id, 'SLR-000001');
  assert.equal(t.seller_name_snapshot, 'Seller One');
  assert.equal(t.endpoint_name_snapshot, 'Shop A');
  assert.equal(t.mapping_version, 'SMV-000001');
  assert.equal(t.mapping_id, H.mappingIdFor_('SLR-000001', 'glk_testA', '2026-10-01'));
  assert.equal(t.status, 'UNMATCHED');
});

test('no split / prefix / case-folding: non-exact tokens stay UNASSIGNED_ENDPOINT', () => {
  const b = build([
    raw({ transaction_id: 'T-SUFFIX', endpoint_token: 'glk_testA.SECRETSUFFIX' }),
    raw({ _row: 3, transaction_id: 'T-PREFIX', endpoint_token: 'glk_test' }),
    raw({ _row: 4, transaction_id: 'T-CASE', endpoint_token: 'GLK_TESTA' }),
    raw({ _row: 5, transaction_id: 'T-BLANK', endpoint_token: '' }),
  ]);
  assert.equal(errs(b), '');
  Object.values(txById(b)).forEach((t) => {
    assert.equal(t.ownership_status, 'UNASSIGNED_ENDPOINT', t.internal_transaction_id);
    assert.equal(t.seller_id, '');
    assert.equal(t.mapping_id, '');
    assert.equal(t.seller_name_snapshot, '');
  });
  assert.equal(b.transactions.length, 4, 'unassigned transactions are kept');
});

test('sub_account / endpoint name is never used as a fallback', () => {
  const t = txById(build([raw({ endpoint_token: 'glk_unknown', sub_account: 'Shop A', store_domain: 'Shop A' })])).TX1;
  assert.equal(t.ownership_status, 'UNASSIGNED_ENDPOINT');
  assert.equal(t.sub_account, 'Shop A');
});

test('ownership is effective-dated on the created date in America/New_York', () => {
  const moved = mappingHistory([
    [sellerRow('SLR-000001', 'Seller One', '2026-10-01', [['Shop A', 'glk_testA']]), sellerRow('SLR-000002', 'Seller Two', '2026-10-01', [])],
    [sellerRow('SLR-000001', 'Seller One', '2026-11-01', []), sellerRow('SLR-000002', 'Seller Two', '2026-11-01', [['Shop A', 'glk_testA']])],
  ]);
  const b = build([
    raw({ transaction_id: 'OCT31-NY', created_at: '2026-11-01T03:30:00Z' }),       // 2026-10-31 23:30 New York
    raw({ _row: 3, transaction_id: 'NOV1-NY', created_at: '2026-11-01T04:30:00Z' }), // 2026-11-01 00:30 New York
    raw({ _row: 4, transaction_id: 'BEFORE', created_at: '2026-09-30T12:00:00Z' }),
  ], moved);
  const t = txById(b);
  assert.equal(t['OCT31-NY'].seller_id, 'SLR-000001');
  assert.equal(t['NOV1-NY'].seller_id, 'SLR-000002');
  assert.equal(t['NOV1-NY'].mapping_version, 'SMV-000002');
  assert.equal(t.BEFORE.ownership_status, 'UNASSIGNED_ENDPOINT', 'before the first mapping');
});

test('overlapping mapping history fails hard', () => {
  const m = MAP();
  const a = m.find((r) => r.endpoint_key === 'glk_testA');
  const overlap = m.concat([{ ...a, seller_id: 'SLR-000002', mapping_id: H.mappingIdFor_('SLR-000002', 'glk_testA', '2026-10-01') }]);
  assert.match(errs(build([raw({})], overlap)), /transaction_id TX1: Overlapping Endpoint Mapping history for endpoint_key "glk_testA"/);
});

// ---- Raw-only fields / parsing --------------------------------------------------------------------
test('settled_at and refunded_at are raw only: no settlement, availability or status change', () => {
  const t = txById(build([raw({ settled_at: '2026-10-05T00:00:00Z', refunded_at: '2026-10-06T00:00:00Z' })])).TX1;
  assert.equal(t.settled_at_raw, '2026-10-05T00:00:00Z');
  assert.equal(t.refunded_at_raw, '2026-10-06T00:00:00Z');
  assert.equal(t.status, 'UNMATCHED');
  assert.ok(!TX_COLUMNS.some((c) => /available|settlement_id|settled_amount/.test(c)));
});

test('timestamps: Z and offsets accepted; naive rejected unless a timezone is configured', () => {
  const ms = (v, tz) => H.parseInternalTimestamp_(v, tz || '', parseLocal).getTime();
  assert.equal(ms('2026-10-02T15:00:00Z'), Date.UTC(2026, 9, 2, 15));
  assert.equal(ms('2026-10-02 22:00:00+07:00'), Date.UTC(2026, 9, 2, 15));
  assert.equal(ms('2026-10-02T15:00:00.250Z'), Date.UTC(2026, 9, 2, 15, 0, 0, 250));
  assert.throws(() => ms('2026-10-02 15:00:00'), /has no timezone offset; set Settings source.INTERNAL.naive_timestamp_timezone/);
  assert.equal(ms('2026-10-02 15:00:00', 'UTC'), Date.UTC(2026, 9, 2, 15));
  assert.throws(() => ms('02/10/2026 15:00'), /not a supported timestamp/);
  assert.match(errs(build([raw({ created_at: '' })])), /created_at is blank/);
});

test('total must be a plain decimal; amount kept exact', () => {
  assert.match(errs(build([raw({ total: '1,234.50' })])), /total "1,234.50" is not a plain decimal number/);
  assert.equal(txById(build([raw({ total: '1234.50' })])).TX1.order_amount, 1234.5);
});

// ---- Canonical output / idempotence ---------------------------------------------------------------
test('source_record_id deterministic; Source System row carries raw text', () => {
  const s = js(build([raw({})]).sourceRows)[0];
  assert.equal(s.source_record_id, 'ISRC-' + sha('PAYPAL|TX1'));
  assert.equal(s.gateway, 'paypal');
  assert.equal(s.raw_status, 'captured');
  assert.equal(H.objectToRow_(s, SS_COLUMNS).length, 22);
});

test('NO_CHANGE: same raw gives identical canonical tables; content key ignores updated_at', () => {
  const rows = () => [raw({}), raw({ _row: 3, transaction_id: 'TX2', endpoint_token: 'glk_testC', created_at: '2026-10-01T12:00:00Z' })];
  const tx = (b) => b.transactions.map((o) => H.objectToRow_(o, TX_COLUMNS));
  const upd = [TX_COLUMNS.indexOf('updated_at')];
  const a = H.tableChecksumExcluding_(H.buildTableValues_(TX_COLUMNS, tx(build(rows()))), upd);
  const b = H.tableChecksumExcluding_(H.buildTableValues_(TX_COLUMNS, tx(build(rows().reverse()))), upd);
  assert.equal(a, b, 'raw row order does not matter');
  assert.equal(H.decideCanonicalWrite_(a, b), 'NO_CHANGE');
  const row = tx(build(rows()))[0];
  const stamped = row.slice(); stamped[upd[0]] = 'T';
  assert.equal(H.internalTransactionContentKey_(row, TX_COLUMNS), H.internalTransactionContentKey_(stamped, TX_COLUMNS));
  assert.deepEqual(js(build(rows()).transactions).map((t) => t.internal_transaction_id), ['TX2', 'TX1'], 'sorted by created_at');
});

test('summary and regression report (report only)', () => {
  const b = build([raw({}), raw({ _row: 3, transaction_id: 'TX2', gateway: 'stripe', endpoint_token: 'glk_none', total: '10.01', settled_at: 'x' })]);
  const s = js(H.summarizeInternalTransactions_(b.transactions));
  assert.deepEqual(s.payment_source_counts, { PAYPAL: 1, STRIPE: 1 });
  assert.equal(s.gross_total, 75.5);
  assert.equal(s.mapped_rows, 1);
  assert.equal(s.unassigned_endpoint_rows, 1);
  assert.equal(s.settled_nonblank, 1);
  assert.equal(H.evaluateInternalTxRegression_(s, b.stats).pass, false);
});
