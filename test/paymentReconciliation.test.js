// Unit tests for exact internal <-> provider reconciliation (pure parts of src/PaymentReconciliation.gs).
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
};
const context = vm.createContext({ Utilities });
for (const f of ['Config', 'Utils', 'RawSnapshot', 'CanonicalTable', 'Kh001ProviderTransactions', 'Kh001ProviderEvents',
  'Kh001Settlements', 'SellerMapping', 'EndpointKeyMigration', 'InternalTransactions', 'PaymentReconciliation']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.gs'), 'utf8'), context, { filename: f + '.gs' });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const PM_COLUMNS = js(H.getColumnNames_('Payment Matches'));
const D = (iso) => vm.runInContext(`new Date(${JSON.stringify(iso)})`, context);

const internal = (o) => ({ internal_transaction_id: 'TX1', payment_source: 'PAYPAL', order_amount: 65.49, currency: 'USD',
  order_id: 'ORD-1', customer: 'c@example.com', sub_account: 'sub-1', store_domain: 'shop.example', seller_id: 'SLR-000001',
  source_row_fingerprint: 'fp-internal', ...o });
const provider = (o) => ({ provider_transaction_id: 'PT-KH001-PAYPAL-' + (o && o.external_transaction_id || 'TX1'), provider_id: 'KH001',
  payment_source: 'PAYPAL', external_transaction_id: 'TX1', gross_amount: 65.49, currency: 'USD', external_status: 'Completed',
  order_reference: 'ORD-1', payer_reference: 'c@example.com', provider_sub_account: 'sub-1', source_fingerprint: 'fp-provider', ...o });
const build = (i, p) => H.buildPaymentReconciliation_(i, p);
const byKey = (b) => Object.fromEntries(js(b.rows).map((r) => [r.payment_source + '|' + (r.internal_transaction_id || r.external_transaction_id), r]));
const errs = (b) => js(H.flattenReconciliationErrors_(b.errors)).join(' | ');

// ---- Status logic ---------------------------------------------------------------------
test('exact key + exact amount -> MATCHED / AUTO / CONFIRMED with lineage', () => {
  const r = byKey(build([internal({})], [provider({})]))['PAYPAL|TX1'];
  assert.equal(r.reconciliation_status, 'MATCHED');
  assert.equal(r.match_type, 'AUTO');
  assert.equal(r.match_status, 'CONFIRMED');
  assert.equal(r.amount_difference, 0);
  assert.equal(r.provider_transaction_id, 'PT-KH001-PAYPAL-TX1');
  assert.equal(r.provider_id, 'KH001');
  assert.equal(r.internal_source_fingerprint, 'fp-internal');
  assert.equal(r.provider_source_fingerprint, 'fp-provider');
  assert.equal(r.provider_external_status, 'Completed');
  assert.ok(!PM_COLUMNS.some((c) => /seller|fee|hold|available/.test(c)), 'no seller economics in Payment Matches');
});

test('amount tolerance: |difference| < 0.005 matches, >= 0.005 is AMOUNT_MISMATCH', () => {
  const st = (g) => byKey(build([internal({})], [provider({ gross_amount: g })]))['PAYPAL|TX1'];
  assert.equal(st(65.494).reconciliation_status, 'MATCHED');
  assert.equal(st(65.486).reconciliation_status, 'MATCHED');
  assert.equal(st(65.495).reconciliation_status, 'AMOUNT_MISMATCH');
  assert.equal(st(65.485).reconciliation_status, 'AMOUNT_MISMATCH');
  const m = st(66.49);
  assert.equal(m.match_status, 'PENDING_REVIEW');
  assert.equal(m.amount_difference, 1);
  assert.match(m.notes, /Amount difference 1 USD/);
});

test('currency mismatch -> AMOUNT_MISMATCH with blank difference; trim/uppercase comparison only', () => {
  const r = byKey(build([internal({})], [provider({ currency: 'EUR' })]))['PAYPAL|TX1'];
  assert.equal(r.reconciliation_status, 'AMOUNT_MISMATCH');
  assert.equal(r.amount_difference, '');
  assert.equal(r.notes, 'Currency mismatch: internal USD vs provider EUR');
  const ok = byKey(build([internal({ currency: ' usd ' })], [provider({})]))['PAYPAL|TX1'];
  assert.equal(ok.reconciliation_status, 'MATCHED');
  assert.equal(ok.internal_currency, ' usd ', 'source value not mutated');
});

test('internal-only -> MISSING_PROVIDER; provider-only -> MISSING_INTERNAL (other side blank)', () => {
  const b = byKey(build([internal({ internal_transaction_id: 'ONLY-INT' })], [provider({ external_transaction_id: 'ONLY-PROV' })]));
  const mi = b['PAYPAL|ONLY-INT'];
  assert.equal(mi.reconciliation_status, 'MISSING_PROVIDER');
  assert.equal(mi.match_status, 'PENDING_REVIEW');
  assert.deepEqual([mi.external_transaction_id, mi.provider_transaction_id, mi.provider_id, mi.provider_gross_amount], ['', '', '', '']);
  const mp = b['PAYPAL|ONLY-PROV'];
  assert.equal(mp.reconciliation_status, 'MISSING_INTERNAL');
  assert.deepEqual([mp.internal_transaction_id, mp.internal_amount, mp.internal_currency], ['', '', '']);
});

test('PAYPAL never matches STRIPE; same id under different payment_source stays separate', () => {
  const b = build([internal({ payment_source: 'STRIPE' })], [provider({})]);
  const r = byKey(b);
  assert.equal(b.rows.length, 2);
  assert.equal(r['STRIPE|TX1'].reconciliation_status, 'MISSING_PROVIDER');
  assert.equal(r['PAYPAL|TX1'].reconciliation_status, 'MISSING_INTERNAL');
  assert.notEqual(r['STRIPE|TX1'].match_id, r['PAYPAL|TX1'].match_id);
});

test('Pending provider status may still identity-match', () => {
  assert.equal(byKey(build([internal({})], [provider({ external_status: 'Pending' })]))['PAYPAL|TX1'].reconciliation_status, 'MATCHED');
});

test('no fallback: same order/customer/sub_account/store/amount but different id never matches', () => {
  const b = build([internal({ internal_transaction_id: 'INT-9' })], [provider({ external_transaction_id: 'EXT-9' })]);
  assert.deepEqual(js(b.rows).map((r) => r.reconciliation_status).sort(), ['MISSING_INTERNAL', 'MISSING_PROVIDER']);
});

// ---- Uniqueness guards --------------------------------------------------------------------
test('duplicate internal key and duplicate provider key fail; same external id under two provider_id fails', () => {
  assert.match(errs(build([internal({}), internal({})], [provider({})])), /Duplicate internal key PAYPAL\|TX1 \(2 rows\)/);
  assert.match(errs(build([internal({})], [provider({}), provider({})])), /Duplicate provider key PAYPAL\|TX1/);
  assert.match(errs(build([internal({})], [provider({}), provider({ provider_id: 'KH002', provider_transaction_id: 'PT-KH002-PAYPAL-TX1' })])),
    /Duplicate provider key PAYPAL\|TX1 \(2 rows; provider_id KH001, KH002\)/);
});

// ---- IDs / timestamps ---------------------------------------------------------------------
test('deterministic match_id; MISSING_PROVIDER -> MATCHED keeps the same match_id', () => {
  const before = byKey(build([internal({})], []))['PAYPAL|TX1'];
  const after = byKey(build([internal({})], [provider({})]))['PAYPAL|TX1'];
  assert.equal(before.match_id, 'PM-' + sha('PAYPAL|TX1'));
  assert.equal(after.match_id, before.match_id);
  assert.equal(byKey(build([], [provider({})]))['PAYPAL|TX1'].match_id, before.match_id, 'provider-only uses the same id');
});

const T1 = D('2026-10-12T08:00:00Z');
const T2 = D('2026-10-13T08:00:00Z');
const merge = (fresh, existing, now) => H.mergeReconciliationTimestamps_(fresh, existing, now, PM_COLUMNS);

test('matched_at / matched_by set once when CONFIRMED and preserved on later runs', () => {
  const first = js(merge(build([internal({})], []).rows, [], T1).rows)[0];
  assert.equal(first.matched_at, '');
  assert.equal(first.matched_by, '');
  const existing1 = merge(build([internal({})], []).rows, [], T1).rows;
  const confirmed = merge(build([internal({})], [provider({})]).rows, existing1, T2).rows[0];
  assert.equal(confirmed.matched_at.getTime(), T2.getTime());
  assert.equal(confirmed.matched_by, 'system');
  assert.equal(confirmed.updated_at.getTime(), T2.getTime(), 'content changed');
  const rerun = merge(build([internal({})], [provider({})]).rows, [confirmed], D('2026-10-20T00:00:00Z')).rows[0];
  assert.equal(rerun.matched_at.getTime(), T2.getTime());
  assert.equal(rerun.updated_at.getTime(), T2.getTime(), 'NO_CHANGE keeps updated_at');
});

test('rerun with the same input is NO_CHANGE (identical table checksum)', () => {
  const table = (rows) => H.computeRawChecksum_(H.buildTableValues_(PM_COLUMNS, rows.map((o) => H.objectToRow_(o, PM_COLUMNS))));
  const inputs = () => build([internal({}), internal({ internal_transaction_id: 'TX2' })], [provider({}), provider({ external_transaction_id: 'P9' })]).rows;
  const run1 = merge(inputs(), [], T1).rows;
  const run2 = merge(inputs(), run1, T2).rows;
  assert.equal(table(run2), table(run1));
});

test('an existing match_id that disappears from the union is a hard error; demotions are reported', () => {
  const run1 = merge(build([internal({})], [provider({})]).rows, [], T1).rows;
  assert.match(js(merge([], run1, T2).errors).join(), /Existing Payment Matches row PM-[0-9a-f]{64} is no longer in the reconciliation union/);
  const demoted = merge(build([internal({})], [provider({ gross_amount: 70 })]).rows, run1, T2);
  assert.deepEqual(js(demoted.demoted), [run1[0].match_id]);
  assert.equal(demoted.rows[0].matched_at.getTime(), T1.getTime(), 'history kept');
});

test('verify-style comparison detects stale Payment Matches', () => {
  const stamps = ['matched_at', 'matched_by', 'updated_at'].map((c) => PM_COLUMNS.indexOf(c));
  const fresh = build([internal({})], [provider({})]).rows.map((o) => H.objectToRow_(o, PM_COLUMNS));
  const stored = merge(build([internal({})], []).rows, [], T1).rows.map((o) => H.objectToRow_(o, PM_COLUMNS));
  const sum = (rows) => H.tableChecksumExcluding_(H.buildTableValues_(PM_COLUMNS, rows), stamps);
  assert.notEqual(sum(fresh), sum(stored), 'stored MISSING_PROVIDER vs fresh MATCHED');
  const storedNow = merge(build([internal({})], [provider({})]).rows, [], T1).rows.map((o) => H.objectToRow_(o, PM_COLUMNS));
  assert.equal(sum(fresh), sum(storedNow), 'timestamps ignored');
});

// ---- Summary / regression -------------------------------------------------------------------
test('summary counts, amounts and regression report (report only)', () => {
  const ints = [internal({}), internal({ internal_transaction_id: 'TX2', order_amount: 10 }), internal({ internal_transaction_id: 'S1', payment_source: 'STRIPE', order_amount: 5 })];
  const provs = [provider({}), provider({ external_transaction_id: 'P9', gross_amount: 78.73, external_status: 'Pending' })];
  const b = build(ints, provs);
  const byId = Object.fromEntries(ints.map((r) => [r.payment_source + '|' + r.internal_transaction_id, r]));
  const s = js(H.summarizePaymentReconciliation_(b.rows, byId));
  assert.deepEqual(s.status_counts, { MATCHED: 1, MISSING_PROVIDER: 2, MISSING_INTERNAL: 1 });
  assert.deepEqual(s.missing_provider_by_source, { PAYPAL: 1, STRIPE: 1 });
  assert.equal(s.matched_amount, 65.49);
  assert.equal(s.missing_provider_internal_amount, 15);
  assert.equal(s.provider_only_amount, 78.73);
  assert.deepEqual(s.missing_internal_provider_status, { Pending: 1 });
  assert.deepEqual(s.matched_seller_counts, { 'SLR-000001': 1 });
  assert.equal(H.evaluatePaymentReconciliationRegression_(s, b.stats).pass, false);
});
