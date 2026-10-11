// Unit tests for Payment Legs (pure parts of src/PaymentLegs.gs) and the reusable freshness checks.
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
  'Kh001Settlements', 'SellerMapping', 'EndpointKeyMigration', 'InternalTransactions', 'PaymentReconciliation', 'PaymentLegs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.gs'), 'utf8'), context, { filename: f + '.gs' });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const D = (iso) => vm.runInContext(`new Date(${JSON.stringify(iso)})`, context);
const LA = (day) => D(day + 'T07:00:00Z');
const PL_COLUMNS = js(H.getColumnNames_('Payment Legs'));

// ---- Fixtures ------------------------------------------------------------------------------
const match = (id, o) => ({ match_id: 'PM-' + id, payment_source: 'PAYPAL', internal_transaction_id: id, external_transaction_id: id,
  provider_transaction_id: 'PT-KH001-PAYPAL-' + id, provider_id: 'KH001', reconciliation_status: 'MATCHED', match_status: 'CONFIRMED', ...o });
const pt = (id, gross, fee, o) => ({ provider_transaction_id: 'PT-KH001-PAYPAL-' + id, provider_id: 'KH001', payment_source: 'PAYPAL',
  external_transaction_id: id, currency: 'USD', gross_amount: gross, processing_fee: fee, net_amount: Math.round((gross - fee) * 100) / 100,
  transaction_at: D('2026-10-02T15:00:00Z'), external_status: 'Completed', provider_reconciliation_status: 'RECONCILED', ...o });
const RC = ['Transaction ID', 'Có trên PP', 'Trạng thái', 'Doanh thu (Gross)', 'Phí PayPal', 'Net', 'Phí thuê OP', 'Hold',
  'Thực nhận (chưa gồm hoàn hold)', 'Lần chốt (ngày)'];
/** DoiSoat row with given actual provider fee / hold (defaults 7% / 10% of net, unrounded). */
function rc(id, gross, fee, o) {
  const net = Math.round((gross - fee) * 100) / 100;
  const r = { 'Transaction ID': id, 'Có trên PP': 1, 'Trạng thái': 'Khớp', 'Doanh thu (Gross)': gross, 'Phí PayPal': fee, Net: net,
    'Phí thuê OP': net * 0.07, Hold: net * 0.1, 'Lần chốt (ngày)': LA('2026-10-04'), ...o };
  if (!('Thực nhận (chưa gồm hoàn hold)' in o)) r['Thực nhận (chưa gồm hoàn hold)'] = net - r['Phí thuê OP'] - r.Hold;
  return RC.map((h) => r[h]);
}
const rcGrid = (rows) => { const b = RC.map(() => ''); return [b, b, b, b, b, RC, ...rows]; };
const settlement = (n, end, rows) => {
  const sum = (f) => rows.reduce((a, r) => a + r[RC.indexOf(f)], 0);
  const net = sum('Net'); const fee = sum('Phí thuê OP'); const hold = sum('Hold');
  return { settlement_id: 'ST-KH001-PAYPAL-00000' + n, provider_id: 'KH001', payment_source: 'PAYPAL', period_end_date: D(end + 'T04:00:00Z'),
    transaction_count: rows.length, gross_amount: sum('Doanh thu (Gross)'), processing_fee_amount: sum('Phí PayPal'), net_amount: net,
    provider_fee_amount: fee, provider_hold_created_amount: hold, transaction_payout_amount: net - fee - hold };
};
function fixture(o) {
  o = o || {};
  const r1 = rc('TX1', 100, 4, {});
  const r2 = rc('TX2', 50, 2, {});
  const r3 = rc('TX3', 200, 8, { 'Lần chốt (ngày)': LA('2026-10-09') });
  return {
    matches: o.matches || [match('TX1'), match('TX2'), match('TX3'), match('MP', { reconciliation_status: 'MISSING_PROVIDER', match_status: 'PENDING_REVIEW' }),
      match('AM', { reconciliation_status: 'AMOUNT_MISMATCH', match_status: 'PENDING_REVIEW' })],
    providerTransactions: o.providerTransactions || [pt('TX1', 100, 4), pt('TX2', 50, 2), pt('TX3', 200, 8)],
    reconciledValues: rcGrid(o.reconciledRows || [r1, r2, r3]),
    settlements: o.settlements || [settlement(1, '2026-10-04', [r1, r2]), settlement(2, '2026-10-09', [r3])],
    providerDateKeyOf: (v) => H.providerDateKey_(v, 'America/Los_Angeles'),
    settlementDateKeyOf: (v) => H.providerDateKey_(v, 'America/New_York'),
  };
}
const build = (o) => H.buildPaymentLegs_(fixture(o));
const errs = (b) => js(H.flattenLegErrors_(b.errors)).join(' | ');
const legs = (b) => Object.fromEntries(js(b.legs).map((l) => [l.external_transaction_id, l]));

// ---- Eligibility / identity ------------------------------------------------------------------
test('confirmed MATCHED creates exactly one leg; other statuses create none', () => {
  const b = build();
  assert.equal(errs(b), '');
  assert.equal(b.stats.eligible_match_rows, 3);
  assert.deepEqual(Object.keys(legs(b)).sort(), ['TX1', 'TX2', 'TX3']);
  const rejected = build({ matches: [match('TX1', { match_status: 'REJECTED' }), match('TX2', { match_status: 'REVERSED' }), match('TX3')] });
  assert.deepEqual(Object.keys(legs(rejected)), ['TX3']);
});

test('deterministic payment_leg_id and exact Provider Transaction linkage', () => {
  const l = legs(build()).TX1;
  assert.equal(l.payment_leg_id, 'PL-' + sha('PAYPAL|TX1'));
  assert.equal(l.match_id, 'PM-TX1');
  assert.equal(l.provider, 'KH001');
  assert.equal(l.gross_amount, 100);
  assert.equal(l.processing_fee, 4);
  assert.equal(l.net_amount, 96);
  assert.equal(new Date(l.created_at).toISOString(), '2026-10-02T15:00:00.000Z', 'provider transaction time');
  assert.match(errs(build({ providerTransactions: [pt('TX1', 100, 4, { provider_id: 'KH009' }), pt('TX2', 50, 2), pt('TX3', 200, 8)] })),
    /TX1: Provider Transaction PT-KH001-PAYPAL-TX1 does not agree on source \/ id \/ provider/);
  assert.match(errs(build({ providerTransactions: [pt('TX2', 50, 2), pt('TX3', 200, 8)] })), /TX1: Provider Transaction PT-KH001-PAYPAL-TX1 not found/);
});

test('unsupported matched provider / source hard fails', () => {
  const b = build({ matches: [match('S1', { payment_source: 'STRIPE', provider_id: 'ST001', provider_transaction_id: 'PT-ST001-STRIPE-S1' })],
    providerTransactions: [pt('S1', 10, 1, { payment_source: 'STRIPE', provider_id: 'ST001', provider_transaction_id: 'PT-ST001-STRIPE-S1' })],
    settlements: [] });
  assert.match(errs(b), /provider ST001 \/ STRIPE is not supported for Payment Legs yet/);
});

test('duplicate provider / external keys hard fail', () => {
  const dupPt = build({ providerTransactions: [pt('TX1', 100, 4), pt('TX1', 100, 4, { provider_id: 'KH002', provider_transaction_id: 'PT-KH002-PAYPAL-TX1' }),
    pt('TX2', 50, 2), pt('TX3', 200, 8)] });
  assert.match(errs(dupPt), /Provider Transactions key PAYPAL\|TX1/);
  const dupMatch = build({ matches: [match('TX1'), match('TX1', { match_id: 'PM-X' }), match('TX2'), match('TX3')] });
  assert.match(errs(dupMatch), /eligible Payment Matches key PAYPAL\|TX1/);
});

// ---- Actual KH001 economics --------------------------------------------------------------------
test('actual provider fee / hold copied from DoiSoat; rates derived amount / net', () => {
  const l = legs(build()).TX1;
  assert.ok(Math.abs(l.provider_fee - 6.72) < 1e-9);
  assert.ok(Math.abs(l.provider_hold_amount - 9.6) < 1e-9);
  assert.ok(Math.abs(l.provider_fee_rate - 0.07) < 1e-12);
  assert.ok(Math.abs(l.provider_hold_rate - 0.1) < 1e-12);
});

test('mixed and zero hold rates are supported generically; Settings rates never override actual amounts', () => {
  const r1 = rc('TX1', 100, 4, { Hold: 0, 'Phí thuê OP': 5.5 });
  const r2 = rc('TX2', 50, 2, { Hold: 2.4, 'Phí thuê OP': 0 });
  const r3 = rc('TX3', 200, 8, { 'Lần chốt (ngày)': LA('2026-10-09') });
  const b = build({ reconciledRows: [r1, r2, r3], settlements: [settlement(1, '2026-10-04', [r1, r2]), settlement(2, '2026-10-09', [r3])] });
  assert.equal(errs(b), '');
  const l = legs(b);
  assert.equal(l.TX1.provider_hold_amount, 0);
  assert.equal(l.TX1.provider_hold_rate, 0);
  assert.equal(l.TX1.provider_fee, 5.5);
  assert.equal(l.TX2.provider_hold_amount, 2.4);
  assert.ok(Math.abs(l.TX2.provider_hold_rate - 0.05) < 1e-12);
  assert.equal(l.TX2.provider_fee, 0);
});

test('provider payout equation and negative amounts are validated', () => {
  const bad = rc('TX1', 100, 4, { 'Thực nhận (chưa gồm hoàn hold)': 80 });
  assert.match(errs(build({ reconciledRows: [bad, rc('TX2', 50, 2, {}), rc('TX3', 200, 8, {})] })), /TX1: net - provider fee - hold != Thực nhận/);
  const neg = rc('TX1', 100, 4, { Hold: -1, 'Thực nhận (chưa gồm hoàn hold)': 96 - 6.72 + 1 });
  assert.match(errs(build({ reconciledRows: [neg, rc('TX2', 50, 2, {}), rc('TX3', 200, 8, {})] })), /TX1: negative provider fee or hold/);
});

test('provider raw amount mismatch (DoiSoat vs Provider Transactions) hard fails', () => {
  const r = rc('TX1', 100.01, 4, {});
  assert.match(errs(build({ reconciledRows: [r, rc('TX2', 50, 2, {}), rc('TX3', 200, 8, {})] })), /TX1: gross 100.01 vs 100/);
  assert.match(errs(build({ reconciledRows: [rc('TX2', 50, 2, {}), rc('TX3', 200, 8, {})] })), /TX1: expected exactly 1 Raw KH001 Reconciled row, found 0/);
});

test('unreconciled provider transaction: WAITING_SETTLEMENT with actual economics blank (no 10% estimate)', () => {
  const b = build({ providerTransactions: [pt('TX1', 100, 4, { provider_reconciliation_status: 'PROVIDER_ONLY' }), pt('TX2', 50, 2), pt('TX3', 200, 8)],
    reconciledRows: [rc('TX2', 50, 2, {}), rc('TX3', 200, 8, { 'Lần chốt (ngày)': LA('2026-10-09') })],
    settlements: [settlement(1, '2026-10-04', [rc('TX2', 50, 2, {})]), settlement(2, '2026-10-09', [rc('TX3', 200, 8, {})])] });
  assert.equal(errs(b), '');
  const l = legs(b).TX1;
  assert.equal(l.settlement_status, 'WAITING_SETTLEMENT');
  ['provider_fee_rate', 'provider_fee', 'provider_hold_rate', 'provider_hold_amount', 'settlement_id'].forEach((f) => assert.equal(l[f], '', f));
  assert.equal(l.net_amount, 96);
});

// ---- Settlement membership ------------------------------------------------------------------
test('exact provider settlement date resolves settlement_id (SETTLED); blank date stays WAITING_SETTLEMENT', () => {
  const l = legs(build());
  assert.equal(l.TX1.settlement_id, 'ST-KH001-PAYPAL-000001');
  assert.equal(l.TX1.settlement_status, 'SETTLED');
  assert.equal(l.TX3.settlement_id, 'ST-KH001-PAYPAL-000002');
  const r1 = rc('TX1', 100, 4, { 'Lần chốt (ngày)': '' });
  const r2 = rc('TX2', 50, 2, {});
  const r3 = rc('TX3', 200, 8, { 'Lần chốt (ngày)': LA('2026-10-09') });
  const b = build({ reconciledRows: [r1, r2, r3], settlements: [settlement(1, '2026-10-04', [r2]), settlement(2, '2026-10-09', [r3])] });
  assert.equal(errs(b), '');
  assert.equal(legs(b).TX1.settlement_status, 'WAITING_SETTLEMENT');
  assert.equal(legs(b).TX1.settlement_id, '');
  assert.ok(Math.abs(legs(b).TX1.provider_fee - 6.72) < 1e-9, 'actual economics kept even when not settled yet');
});

test('settlement date with zero or several settlements hard fails', () => {
  const none = build({ settlements: [settlement(2, '2026-10-09', [rc('TX3', 200, 8, {})])] });
  assert.match(errs(none), /settlement date 2026-10-04 resolves to 0 KH001 settlement/);
  const r1 = rc('TX1', 100, 4, {}); const r2 = rc('TX2', 50, 2, {});
  const two = build({ settlements: [settlement(1, '2026-10-04', [r1, r2]), { ...settlement(3, '2026-10-04', []), settlement_id: 'ST-KH001-PAYPAL-000003' },
    settlement(2, '2026-10-09', [rc('TX3', 200, 8, {})])] });
  assert.match(errs(two), /settlement date 2026-10-04 resolves to 2 KH001 settlement/);
});

test('settlement aggregate cross-check (count, amounts, unrounded provider fee/hold, payout)', () => {
  const r1 = rc('TX1', 100, 4, {}); const r2 = rc('TX2', 50, 2, {}); const r3 = rc('TX3', 200, 8, { 'Lần chốt (ngày)': LA('2026-10-09') });
  const s1 = settlement(1, '2026-10-04', [r1, r2]);
  assert.equal(errs(build({ settlements: [{ ...s1, transaction_count: 3 }, settlement(2, '2026-10-09', [r3])] })).match(/legs count 2 != settlement transaction_count 3/) !== null, true);
  assert.match(errs(build({ settlements: [{ ...s1, provider_fee_amount: s1.provider_fee_amount + 0.0001 }, settlement(2, '2026-10-09', [r3])] })),
    /ST-KH001-PAYPAL-000001: legs provider fee .* != settlement/);
  assert.match(errs(build({ settlements: [{ ...s1, transaction_payout_amount: s1.transaction_payout_amount - 0.0001 }, settlement(2, '2026-10-09', [r3])] })),
    /legs transaction payout/);
});

// ---- Blank fields / timestamps -------------------------------------------------------------------
test('seller economics and refund/dispute fields stay blank; no Transactions fields', () => {
  Object.values(legs(build())).forEach((l) => {
    ['seller_fee_rate', 'seller_fee', 'seller_hold_rate', 'seller_hold_amount', 'seller_available_amount', 'refund_amount',
      'dispute_amount', 'dispute_fee'].forEach((f) => assert.equal(l[f], '', f));
    assert.notEqual(l.settlement_status, 'AVAILABLE');
  });
  assert.equal(PL_COLUMNS.length, 26);
  assert.ok(!PL_COLUMNS.includes('status'), 'Payment Legs never carries Transactions.status');
});

const T1 = D('2026-10-12T08:00:00Z');
const T2 = D('2026-10-13T08:00:00Z');
const merge = (fresh, existing, now) => H.mergePaymentLegTimestamps_(fresh, existing, now, PL_COLUMNS);

test('updated_at set on creation, preserved on NO_CHANGE, changed only with content; table checksum stable', () => {
  const first = merge(build().legs, [], T1).legs;
  first.forEach((l) => assert.equal(l.updated_at.getTime(), T1.getTime()));
  const rerun = merge(build().legs, first, T2).legs;
  rerun.forEach((l) => assert.equal(l.updated_at.getTime(), T1.getTime()));
  const sum = (rows) => H.computeRawChecksum_(H.buildTableValues_(PL_COLUMNS, rows.map((o) => H.objectToRow_(o, PL_COLUMNS))));
  assert.equal(sum(rerun), sum(first), 'rerun is NO_CHANGE');
  const unsettled = build({ reconciledRows: [rc('TX1', 100, 4, { 'Lần chốt (ngày)': '' }), rc('TX2', 50, 2, {}), rc('TX3', 200, 8, { 'Lần chốt (ngày)': LA('2026-10-09') })],
    settlements: [settlement(1, '2026-10-04', [rc('TX2', 50, 2, {})]), settlement(2, '2026-10-09', [rc('TX3', 200, 8, {})])] }).legs;
  const changed = Object.fromEntries(merge(unsettled, first, T2).legs.map((l) => [l.external_transaction_id, l]));
  assert.equal(changed.TX1.updated_at.getTime(), T2.getTime());
  assert.equal(changed.TX2.updated_at.getTime(), T1.getTime());
});

test('an existing leg disappearing from the fresh set is a hard error', () => {
  const first = merge(build().legs, [], T1).legs;
  const fewer = build({ matches: [match('TX2'), match('TX3')] });
  assert.match(js(merge(fewer.legs, first, T2).errors).join(), /Existing Payment Leg PL-[0-9a-f]{64} is no longer produced/);
});

// ---- Freshness helpers (gates C / D) ----------------------------------------------------------------
test('Payment Matches gate: stale stored matches detected; fresh ones pass', () => {
  const PM = js(H.getColumnNames_('Payment Matches'));
  const internal = [{ internal_transaction_id: 'TX1', payment_source: 'PAYPAL', order_amount: 96, currency: 'USD', source_row_fingerprint: 'f' }];
  const provider = [{ provider_transaction_id: 'PT-KH001-PAYPAL-TX1', provider_id: 'KH001', payment_source: 'PAYPAL', external_transaction_id: 'TX1',
    gross_amount: 96, currency: 'USD', external_status: 'Completed', source_fingerprint: 'p' }];
  const built = H.buildPaymentReconciliation_(internal, provider);
  const stored = H.buildTableValues_(PM, H.mergeReconciliationTimestamps_(built.rows, [], T1, PM).rows.map((o) => H.objectToRow_(o, PM)));
  assert.equal(H.checkPaymentMatchesFresh_(built, stored, PM).current, true);
  const changed = H.buildPaymentReconciliation_(internal, [{ ...provider[0], gross_amount: 97 }]);
  const c = js(H.checkPaymentMatchesFresh_(changed, stored, PM));
  assert.equal(c.current, false);
  assert.equal(c.reason, 'Payment Matches is stale; run reconcilePayments first.');
});

test('Settlements gate: stale stored KH001 settlements detected', () => {
  const SC = js(H.getColumnNames_('Settlements'));
  const built = { rows: [{ settlement_id: 'ST-KH001-PAYPAL-000001', provider_id: 'KH001', payment_source: 'PAYPAL', source_settlement_number: 1,
    period_start_date: '2026-10-01', period_end_date: '2026-10-04', source_payment_date: '', hold_release_due_from_date: '',
    hold_release_due_to_date: '', net_amount: 96, normalized_at: '' }], errors: { duplicate: [], relationship: [], cross_check: [],
    amount_invariant: [], history_equation: [], data: [] } };
  const toDate = (k) => D(k + 'T04:00:00Z');
  const stored = built.rows.map((o) => { const r = H.settlementObjectToRow_(o, SC, toDate); r[SC.indexOf('normalized_at')] = T1; return r; });
  assert.equal(H.checkKh001SettlementsFresh_(built, stored, SC, toDate).current, true);
  const edited = stored.map((r) => { const x = r.slice(); x[SC.indexOf('net_amount')] = 95; return x; });
  assert.equal(js(H.checkKh001SettlementsFresh_(built, edited, SC, toDate)).reason, 'Settlements KH001 is stale; run normalizeKh001Settlements first.');
});

// ---- Summary / regression ------------------------------------------------------------------------------
test('summary totals in micro-units, rate distribution, regression report (report only)', () => {
  const s = js(H.summarizePaymentLegs_(build().legs));
  assert.equal(s.payment_leg_rows, 3);
  assert.deepEqual(s.settlement_counts, { 'ST-KH001-PAYPAL-000001': 2, 'ST-KH001-PAYPAL-000002': 1 });
  assert.equal(s.net_total, 96 + 48 + 192);
  assert.ok(Math.abs(s.provider_fee_total - 336 * 0.07) < 1e-6);
  assert.ok(Math.abs(s.provider_transaction_payout_total - 336 * 0.83) < 1e-6);
  assert.deepEqual(s.provider_fee_rate_counts, { '7.00%': 3 });
  assert.deepEqual(s.provider_hold_rate_counts, { '10.00%': 3 });
  assert.equal(s.actual_economics_rows, 3);
  assert.equal(H.evaluatePaymentLegsRegression_(s).pass, false);
  const exp = js(vm.runInContext('PAYMENT_LEGS_REGRESSION', context));
  const ok = { ...s, ...exp, status_counts: exp.status_counts };
  assert.equal(H.evaluatePaymentLegsRegression_(ok).pass, true);
});
