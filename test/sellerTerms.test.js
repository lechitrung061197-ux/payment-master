// Unit tests for Seller Terms and seller economics in Payment Legs (Phase 2I). All data is fake.
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
  'Kh001Settlements', 'SellerMapping', 'EndpointKeyMigration', 'InternalTransactions', 'PaymentReconciliation', 'SellerTerms', 'PaymentLegs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.gs'), 'utf8'), context, { filename: f + '.gs' });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const D = (iso) => vm.runInContext(`new Date(${JSON.stringify(iso)})`, context);
const NY = (v) => H.providerDateKey_(v, 'America/New_York');
const PL_COLUMNS = js(H.getColumnNames_('Payment Legs'));

const sellers = [{ seller_id: 'SLR-A', seller_name: 'Seller A' }, { seller_id: 'SLR-B', seller_name: 'Seller B' }];
const term = (o) => ({ seller_id: 'SLR-A', payment_source: 'PAYPAL', seller_name_snapshot: 'Seller A', seller_fee_rate: 0.08, effective_from: '2026-10-01', effective_to: '', ...o });
const parse = (rows, s) => H.parseSellerTerms_(rows, s || sellers, NY);
const errs = (p) => js(H.flattenSellerTermErrors_(p.errors)).join(' | ');

// ---- Seed --------------------------------------------------------------------------------------
test('initial seed: one row per seller from the global rate, starting at the earliest mapping date', () => {
  const records = [{ seller_id: 'SLR-A', effective_from: '2026-10-01' }, { seller_id: 'SLR-A', effective_from: '2026-11-01' },
    { seller_id: 'SLR-B', effective_from: '2026-10-05' }];
  const plan = js(H.planSellerTermsSeed_([...sellers, { seller_id: 'SLR-C', seller_name: 'No mapping' }, { seller_id: '', seller_name: 'No id' }],
    0.08, records, '2026-12-31'));
  assert.deepEqual(plan.map((t) => [t.seller_id, t.seller_name_snapshot, t.seller_fee_rate, t.effective_from, t.effective_to]), [
    ['SLR-A', 'Seller A', 0.08, '2026-10-01', ''], ['SLR-B', 'Seller B', 0.08, '2026-10-05', ''], ['SLR-C', 'No mapping', 0.08, '2026-10-01', '']]);
  assert.throws(() => H.planSellerTermsSeed_(sellers, 1.2, records, '2026-12-31'), /0 <= rate < 1/);
  assert.equal(js(H.planSellerTermsSeed_(sellers, 0.08, [], '2026-12-31'))[0].effective_from, '2026-12-31', 'no mapping history -> today');
});

// ---- Validation / resolution ------------------------------------------------------------------------
test('effective-date resolution; a future fee change does not alter the prior transaction rate', () => {
  const p = parse([term({ effective_to: '2026-10-31' }), term({ seller_fee_rate: 0.07, effective_from: '2026-11-01' }),
    term({ seller_id: 'SLR-B', seller_name_snapshot: 'Seller B', seller_fee_rate: 0.09 })]);
  assert.equal(errs(p), '');
  assert.equal(H.resolveSellerTerm_(p.terms, 'SLR-A', 'PAYPAL', '2026-10-31').seller_fee_rate, 0.08);
  assert.equal(H.resolveSellerTerm_(p.terms, 'SLR-A', 'PAYPAL', '2026-11-01').seller_fee_rate, 0.07);
  assert.equal(H.resolveSellerTerm_(p.terms, 'SLR-B', 'PAYPAL', '2026-10-15').seller_fee_rate, 0.09, 'different sellers, different rates');
  assert.throws(() => H.resolveSellerTerm_(p.terms, 'SLR-A', 'PAYPAL', '2026-09-30'), /No Seller Terms row for SLR-A \/ PAYPAL on 2026-09-30/);
});

test('overlapping terms, several open rows and duplicate periods are rejected', () => {
  assert.match(errs(parse([term({ effective_to: '2026-11-15' }), term({ effective_from: '2026-11-01', seller_fee_rate: 0.07 })])), /SLR-A\/PAYPAL: rows 2 and 3 overlap/);
  assert.match(errs(parse([term({}), term({ effective_from: '2026-11-01' })])), /SLR-A\/PAYPAL: 2 open-ended rows/);
  assert.match(errs(parse([term({}), term({})])), /SLR-A\/PAYPAL: duplicate period 2026-10-01..open/);
  assert.throws(() => H.resolveSellerTerm_([...parse([term({})]).terms, ...parse([term({})]).terms], 'SLR-A', 'PAYPAL', '2026-10-05'), /Several Seller Terms rows/);
});

test('unknown sellers, invalid rates and dates are rejected; name changes are warnings', () => {
  const p = parse([term({ seller_id: 'SLR-X' }), term({ seller_fee_rate: 1 }), term({ seller_fee_rate: -0.01 }), term({ seller_fee_rate: '8%' }),
    term({ effective_from: '' }), term({ effective_from: '2026-10-10', effective_to: '2026-10-01' })]);
  const e = errs(p);
  assert.match(e, /unknown seller SLR-X/);
  assert.equal(js(p.errors.invalid_rates).length, 3);
  assert.match(e, /effective_from is required/);
  assert.match(e, /effective_to 2026-10-01 is before effective_from 2026-10-10/);
  const ok = parse([term({ seller_name_snapshot: 'Old name' }), term({ seller_id: 'SLR-B', seller_name_snapshot: 'Seller B' })]);
  assert.equal(errs(ok), '');
  assert.equal(js(ok.snapshot_name_mismatches).length, 1);
  assert.match(js(ok.warnings).join(), /seller_name_snapshot value\(s\) differ/);
});

test('every seller with a seller_id needs Seller Terms: a missing seller is a blocking error', () => {
  const missing = parse([term({})]);
  assert.deepEqual(js(missing.missing_sellers), ['SLR-B']);
  assert.deepEqual(js(missing.errors.missing_sellers), ['SLR-B: seller has no valid Seller Terms row; add an effective-dated term']);
  assert.match(errs(missing), /SLR-B: seller has no valid Seller Terms row/);
  const onlyInvalid = parse([term({}), term({ seller_id: 'SLR-B', seller_name_snapshot: 'Seller B', seller_fee_rate: 2 })]);
  assert.deepEqual(js(onlyInvalid.missing_sellers), ['SLR-B'], 'an invalid row does not count as coverage');
  const complete = parse([term({}), term({ seller_id: 'SLR-B', seller_name_snapshot: 'Seller B' })]);
  assert.equal(errs(complete), '');
  assert.deepEqual(js(complete.missing_sellers), []);
  assert.equal(errs(parse([term({})], [...sellers.slice(0, 1), { seller_id: '', seller_name: 'Draft without id' }])), '', 'blank seller_id needs no terms');
});

// ---- Seller economics in Payment Legs ------------------------------------------------------------
const LA = (day) => D(day + 'T07:00:00Z');
const RC = ['Transaction ID', 'Có trên PP', 'Trạng thái', 'Doanh thu (Gross)', 'Phí PayPal', 'Net', 'Phí thuê OP', 'Hold',
  'Thực nhận (chưa gồm hoàn hold)', 'Lần chốt (ngày)'];
function rc(id, gross, fee, providerFee, hold, date) {
  const net = Math.round((gross - fee) * 100) / 100;
  return [id, 1, 'Khớp', gross, fee, net, providerFee, hold, net - providerFee - hold, date === undefined ? LA('2026-10-04') : date];
}
const match = (id) => ({ match_id: 'PM-' + id, payment_source: 'PAYPAL', internal_transaction_id: id, external_transaction_id: id,
  provider_transaction_id: 'PT-KH001-PAYPAL-' + id, provider_id: 'KH001', reconciliation_status: 'MATCHED', match_status: 'CONFIRMED' });
const pt = (id, gross, fee, o) => ({ provider_transaction_id: 'PT-KH001-PAYPAL-' + id, provider_id: 'KH001', payment_source: 'PAYPAL',
  external_transaction_id: id, currency: 'USD', gross_amount: gross, processing_fee: fee, net_amount: Math.round((gross - fee) * 100) / 100,
  transaction_at: D('2026-10-02T15:00:00Z'), provider_reconciliation_status: 'RECONCILED', ...o });
const tx = (id, seller, created, o) => ({ internal_transaction_id: id, payment_source: 'PAYPAL', ownership_status: 'MAPPED', seller_id: seller,
  created_at: D(created || '2026-10-02T15:00:00Z'), ...o });
function settlementFor(rows) {
  const sum = (i) => rows.reduce((a, r) => a + r[i], 0);
  const net = sum(5); const fee = sum(6); const hold = sum(7);
  return { settlement_id: 'ST-1', provider_id: 'KH001', payment_source: 'PAYPAL', period_end_date: D('2026-10-04T04:00:00Z'),
    transaction_count: rows.length, gross_amount: sum(3), processing_fee_amount: sum(4), net_amount: net, provider_fee_amount: fee,
    provider_hold_created_amount: hold, transaction_payout_amount: net - fee - hold };
}
function buildLegs(o) {
  const rows = o.rows || [rc('TX1', 100, 4, 6.72, 9.6), rc('TX2', 50, 2, 3.36, 0)];
  return H.buildPaymentLegs_({
    matches: o.matches || rows.map((r) => match(r[0])),
    providerTransactions: o.pts || rows.map((r) => pt(r[0], r[3], r[4])),
    reconciledValues: [RC.map(() => ''), RC.map(() => ''), RC.map(() => ''), RC.map(() => ''), RC.map(() => ''), RC, ...rows],
    settlements: [settlementFor(rows.filter((r) => r[9] !== ''))],
    transactions: o.transactions || rows.map((r) => tx(r[0], 'SLR-A')),
    sellerTerms: o.terms || parse([term({}), term({ seller_id: 'SLR-B', seller_name_snapshot: 'Seller B', seller_fee_rate: 0.05 })]).terms,
    providerDateKeyOf: (v) => H.providerDateKey_(v, 'America/Los_Angeles'),
    settlementDateKeyOf: NY,
    transactionDateKeyOf: NY,
  });
}
const legErrs = (b) => js(H.flattenLegErrors_(b.errors)).join(' | ');
const byId = (b) => Object.fromEntries(js(b.legs).map((l) => [l.external_transaction_id, l]));

test('seller fee on NET (not gross); seller hold mirrors exact provider hold; available and margin equations', () => {
  const b = buildLegs({});
  assert.equal(legErrs(b), '');
  const l = byId(b).TX1;
  assert.ok(Math.abs(l.seller_fee - 96 * 0.08) < 1e-12, 'net x rate, unrounded');
  assert.notEqual(l.seller_fee, 100 * 0.08);
  assert.equal(l.seller_hold_amount, l.provider_hold_amount);
  assert.equal(l.seller_hold_rate, l.provider_hold_rate);
  assert.ok(Math.abs(l.seller_available_amount - (96 - 7.68 - 9.6)) < 1e-9);
  const s = js(H.summarizePaymentLegs_(b.legs, b.legSellers));
  assert.ok(Math.abs(s.system_margin_total - ((96 * 0.08 - 6.72) + (48 * 0.08 - 3.36))) < 1e-6);
  assert.deepEqual(s.seller_hold_mismatches, []);
  assert.deepEqual(s.seller_available_equation_errors, []);
  assert.equal(s.by_seller['SLR-A'].count, 2);
});

test('provider hold 0 -> seller hold 0; Settings default hold is never used', () => {
  const l = byId(buildLegs({})).TX2;
  assert.equal(l.provider_hold_amount, 0);
  assert.equal(l.seller_hold_amount, 0);
  assert.equal(l.seller_hold_rate, 0);
  assert.ok(Math.abs(l.seller_available_amount - (48 - 48 * 0.08)) < 1e-9);
});

test('different sellers use their own effective rate; future change does not touch earlier transactions', () => {
  const terms = parse([term({ effective_to: '2026-10-31' }), term({ seller_fee_rate: 0.07, effective_from: '2026-11-01' }),
    term({ seller_id: 'SLR-B', seller_name_snapshot: 'Seller B', seller_fee_rate: 0.05 })]).terms;
  const rows = [rc('TX1', 100, 4, 6.72, 9.6), rc('TX2', 50, 2, 3.36, 4.8), rc('TX3', 200, 8, 13.44, 19.2)];
  const b = buildLegs({ rows, terms, transactions: [tx('TX1', 'SLR-A', '2026-10-31T23:00:00-04:00'), tx('TX2', 'SLR-A', '2026-11-01T00:30:00-04:00'), tx('TX3', 'SLR-B')] });
  assert.equal(legErrs(b), '');
  const l = byId(b);
  assert.equal(l.TX1.seller_fee_rate, 0.08, 'Oct 31 New York');
  assert.equal(l.TX2.seller_fee_rate, 0.07, 'Nov 1 New York');
  assert.equal(l.TX3.seller_fee_rate, 0.05);
});

test('mapped seller required; missing Transaction, unknown term or no term fails', () => {
  assert.match(legErrs(buildLegs({ transactions: [tx('TX1', '', null, { ownership_status: 'UNASSIGNED_ENDPOINT' }), tx('TX2', 'SLR-A')] })),
    /TX1: internal Transaction TX1 is not assigned to a seller/);
  assert.match(legErrs(buildLegs({ transactions: [tx('TX2', 'SLR-A')] })), /TX1: internal Transaction TX1 not found/);
  assert.match(legErrs(buildLegs({ transactions: [tx('TX1', 'SLR-Z'), tx('TX2', 'SLR-A')] })), /No Seller Terms row for SLR-Z/);
  assert.match(legErrs(buildLegs({ transactions: [tx('TX1', 'SLR-A', '2026-09-01T12:00:00Z'), tx('TX2', 'SLR-A')] })), /No Seller Terms row for SLR-A \/ PAYPAL on 2026-09-01/);
});

test('provider economics absent -> seller fee only; no seller hold / available estimate', () => {
  const rows = [rc('TX2', 50, 2, 3.36, 0)];
  const b = buildLegs({ rows, matches: [match('TX1'), match('TX2')], pts: [pt('TX1', 100, 4, { provider_reconciliation_status: 'PROVIDER_ONLY' }), pt('TX2', 50, 2)],
    transactions: [tx('TX1', 'SLR-A'), tx('TX2', 'SLR-A')] });
  assert.equal(legErrs(b), '');
  const l = byId(b).TX1;
  assert.equal(l.seller_fee_rate, 0.08);
  assert.ok(Math.abs(l.seller_fee - 96 * 0.08) < 1e-12);
  ['seller_hold_rate', 'seller_hold_amount', 'seller_available_amount', 'provider_hold_amount'].forEach((f) => assert.equal(l[f], '', f));
});

test('rerun NO_CHANGE; updated_at changes only when content (e.g. a seller rate) changes', () => {
  const T1 = D('2026-10-12T08:00:00Z');
  const T2 = D('2026-10-13T08:00:00Z');
  const merge = (fresh, existing, now) => H.mergePaymentLegTimestamps_(fresh, existing, now, PL_COLUMNS).legs;
  const first = merge(buildLegs({}).legs, [], T1);
  const again = merge(buildLegs({}).legs, first, T2);
  again.forEach((l) => assert.equal(l.updated_at.getTime(), T1.getTime()));
  const changedTerms = parse([term({ seller_fee_rate: 0.09 })]).terms;
  const changed = Object.fromEntries(merge(buildLegs({ terms: changedTerms }).legs, first, T2).map((l) => [l.external_transaction_id, l]));
  assert.equal(changed.TX1.updated_at.getTime(), T2.getTime());
  assert.equal(changed.TX1.seller_fee_rate, 0.09);
});

test('Phase 2I regression report (report only)', () => {
  const exp = js(vm.runInContext('PAYMENT_LEGS_REGRESSION', context));
  const summary = { payment_leg_rows: exp.payment_leg_rows, payment_source_counts: exp.payment_source_counts, provider_counts: exp.provider_counts,
    settlement_counts: exp.settlement_counts, status_counts: exp.status_counts, provider_fee_rate_counts: exp.provider_fee_rate_counts,
    provider_hold_rate_counts: exp.provider_hold_rate_counts, seller_fee_rate_counts: exp.seller_fee_rate_counts,
    seller_hold_rate_counts: exp.seller_hold_rate_counts, by_seller: exp.by_seller };
  ['gross_total', 'processing_fee_total', 'net_total', 'provider_fee_total', 'provider_hold_total', 'provider_transaction_payout_total',
    'seller_fee_total', 'seller_hold_total', 'seller_available_total', 'system_margin_total'].forEach((k) => { summary[k] = exp[k]; });
  assert.equal(H.evaluatePaymentLegsRegression_(summary).pass, true);
  const off = js(H.evaluatePaymentLegsRegression_({ ...summary, by_seller: { ...exp.by_seller, CUS003: { ...exp.by_seller.CUS003, seller_fee: 25.0505 } } }));
  assert.deepEqual(off.failed, ['by_seller.CUS003.seller_fee']);
  // Arithmetic consistency of the expected numbers themselves.
  assert.ok(Math.abs(exp.net_total - exp.seller_fee_total - exp.seller_hold_total - exp.seller_available_total) < 1e-6);
  assert.ok(Math.abs(exp.seller_fee_total - exp.provider_fee_total - exp.system_margin_total) < 1e-6);
  assert.ok(Math.abs(exp.provider_transaction_payout_total - exp.seller_available_total - exp.system_margin_total) < 1e-6);
});
