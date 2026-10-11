// Unit tests for provider-paid availability (Payment Legs) and frozen Settlement Items (Phase 2J). Fake data.
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
for (const f of ['Config', 'Utils', 'RawSnapshot', 'CanonicalTable', 'Kh001ProviderTransactions', 'Kh001ProviderEvents', 'Kh001Settlements',
  'SellerMapping', 'EndpointKeyMigration', 'InternalTransactions', 'PaymentReconciliation', 'SellerTerms', 'PaymentLegs', 'SettlementItems']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.gs'), 'utf8'), context, { filename: f + '.gs' });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const D = (iso) => vm.runInContext(`new Date(${JSON.stringify(iso)})`, context);
const NY = (v) => H.providerDateKey_(v, 'America/New_York');
const SI_COLUMNS = js(H.getColumnNames_('Settlement Items'));
const T1 = D('2026-10-12T08:00:00Z');
const T2 = D('2026-10-13T08:00:00Z');

// ---- Availability rule ---------------------------------------------------------------------------
const paid = (o) => ({ source_payment_date: D('2026-10-06T04:00:00Z'), total_due_amount: 4270.2006, source_paid_amount: 4270.2006,
  outstanding_amount: 0, ...o });

test('provider-paid rule: fully paid -> available; blank date, partial pay or outstanding -> not available', () => {
  assert.equal(H.isSettlementProviderPaid_(paid({})), true);
  assert.equal(H.isSettlementProviderPaid_(paid({ source_paid_amount: 4270.1957 })), true, 'within 0.005');
  assert.equal(H.isSettlementProviderPaid_(paid({ source_payment_date: '' })), false);
  assert.equal(H.isSettlementProviderPaid_(paid({ source_paid_amount: 4000, outstanding_amount: 270.2006 })), false);
  assert.equal(H.isSettlementProviderPaid_(paid({ outstanding_amount: 1 })), false);
  assert.equal(H.isSettlementProviderPaid_(paid({ source_paid_amount: '' })), false, 'unpaid (blank) settlement');
});

// Minimal Payment Legs build with one settlement.
const RC = ['Transaction ID', 'Có trên PP', 'Trạng thái', 'Doanh thu (Gross)', 'Phí PayPal', 'Net', 'Phí thuê OP', 'Hold',
  'Thực nhận (chưa gồm hoàn hold)', 'Lần chốt (ngày)'];
const rcRow = (id, gross, fee) => { const n = gross - fee; return [id, 1, 'Khớp', gross, fee, n, n * 0.07, n * 0.1, n * 0.83, D('2026-10-04T07:00:00Z')]; };
function legsFor(settlementExtra, terms) {
  const rows = [rcRow('TX1', 100, 4), rcRow('TX2', 50, 2)];
  const sum = (i) => rows.reduce((a, r) => a + r[i], 0);
  const s = { settlement_id: 'ST-1', provider_id: 'KH001', payment_source: 'PAYPAL', period_end_date: D('2026-10-04T04:00:00Z'), transaction_count: 2,
    gross_amount: sum(3), processing_fee_amount: sum(4), net_amount: sum(5), provider_fee_amount: sum(6), provider_hold_created_amount: sum(7),
    transaction_payout_amount: sum(5) - sum(6) - sum(7), ...settlementExtra };
  return H.buildPaymentLegs_({
    matches: rows.map((r) => ({ match_id: 'PM-' + r[0], payment_source: 'PAYPAL', internal_transaction_id: r[0], external_transaction_id: r[0],
      provider_transaction_id: 'PT-' + r[0], provider_id: 'KH001', reconciliation_status: 'MATCHED', match_status: 'CONFIRMED' })),
    providerTransactions: rows.map((r) => ({ provider_transaction_id: 'PT-' + r[0], provider_id: 'KH001', payment_source: 'PAYPAL',
      external_transaction_id: r[0], currency: 'USD', gross_amount: r[3], processing_fee: r[4], net_amount: r[5], transaction_at: D('2026-10-02T15:00:00Z'),
      provider_reconciliation_status: 'RECONCILED' })),
    reconciledValues: [RC.map(() => ''), RC.map(() => ''), RC.map(() => ''), RC.map(() => ''), RC.map(() => ''), RC, ...rows],
    settlements: [s],
    transactions: rows.map((r) => ({ internal_transaction_id: r[0], payment_source: 'PAYPAL', ownership_status: 'MAPPED', seller_id: 'SLR-A',
      created_at: D('2026-10-02T15:00:00Z') })),
    sellerTerms: terms || [{ seller_id: 'SLR-A', payment_source: 'PAYPAL', seller_fee_rate: 0.08, effective_from: '2026-10-01', effective_to: '' }],
    frozenItems: (settlementExtra && settlementExtra.__frozen) || [],
    providerDateKeyOf: (v) => H.providerDateKey_(v, 'America/Los_Angeles'),
    settlementDateKeyOf: NY,
    transactionDateKeyOf: NY,
  });
}
const statuses = (b) => js(b.legs).map((l) => l.settlement_status);

test('settlement membership alone is SETTLED; a fully provider-paid settlement makes legs AVAILABLE', () => {
  assert.deepEqual(statuses(legsFor({})), ['SETTLED', 'SETTLED'], 'no payment facts');
  assert.deepEqual(statuses(legsFor(paid({}))), ['AVAILABLE', 'AVAILABLE']);
  assert.deepEqual(statuses(legsFor(paid({ outstanding_amount: 5 }))), ['SETTLED', 'SETTLED']);
});

// ---- Settlement Items --------------------------------------------------------------------------------
const transactions = [{ internal_transaction_id: 'TX1', payment_source: 'PAYPAL', ownership_status: 'MAPPED', seller_id: 'SLR-A' },
  { internal_transaction_id: 'TX2', payment_source: 'PAYPAL', ownership_status: 'MAPPED', seller_id: 'SLR-A' }];
const items = (legs, existing, now, txs) => H.buildSettlementItems_({ legs, transactions: txs || transactions, existingItems: existing || [],
  now: now || T1, columns: SI_COLUMNS });
const ierrs = (b) => js(H.flattenItemErrors_(b.errors)).join(' | ');
const availableLegs = () => js(legsFor(paid({})).legs).map((l) => ({ ...l, created_at: D(l.created_at) }));

test('AVAILABLE legs create exactly one frozen item each; SETTLED legs create none', () => {
  const b = items(availableLegs());
  assert.equal(ierrs(b), '');
  assert.equal(b.items.length, 2);
  assert.equal(b.newItems, 2);
  const settled = js(legsFor({}).legs);
  assert.equal(items(settled).items.length, 0);
});

test('deterministic item id; seller from the exact Transaction; economics frozen; snapshot_at set', () => {
  const i = js(items(availableLegs()).items).find((x) => x.external_transaction_id === 'TX1');
  const leg = availableLegs().find((l) => l.external_transaction_id === 'TX1');
  assert.equal(i.settlement_item_id, 'SI-' + sha('ST-1|' + leg.payment_leg_id));
  assert.equal(i.seller_id, 'SLR-A');
  ['net_amount', 'provider_fee', 'provider_hold_amount', 'seller_fee_rate', 'seller_fee', 'seller_hold_amount', 'seller_available_amount']
    .forEach((f) => assert.equal(i[f], leg[f], f));
  assert.equal(i.seller_hold_amount, i.provider_hold_amount, 'mirror hold');
  assert.equal(new Date(i.snapshot_at).getTime(), T1.getTime());
  assert.match(ierrs(items(availableLegs(), [], T1, [transactions[1]])), /TX1 not found/);
  assert.match(ierrs(items(availableLegs(), [], T1, [{ ...transactions[0], ownership_status: 'UNASSIGNED_ENDPOINT', seller_id: '' }, transactions[1]])),
    /not assigned to a seller/);
});

test('rerun keeps frozen items byte-for-byte (NO_CHANGE, snapshot_at unchanged)', () => {
  const first = items(availableLegs()).items;
  const second = items(availableLegs(), first, T2);
  assert.equal(ierrs(second), '');
  assert.equal(second.newItems, 0);
  const sum = (rows) => H.computeRawChecksum_(H.buildTableValues_(SI_COLUMNS, rows.map((o) => H.objectToRow_(o, SI_COLUMNS))));
  assert.equal(sum(second.items), sum(first));
  second.items.forEach((x) => assert.equal(new Date(x.snapshot_at).getTime(), T1.getTime()));
});

test('a frozen item that would change or disappear is a hard error; duplicates fail', () => {
  const first = items(availableLegs()).items;
  const changedLegs = availableLegs().map((l) => (l.external_transaction_id === 'TX1' ? { ...l, seller_fee_rate: 0.09, seller_fee: l.net_amount * 0.09,
    seller_available_amount: l.net_amount * 0.91 - l.seller_hold_amount } : l));
  assert.match(ierrs(items(changedLegs, first, T2)), /Frozen item SI-[0-9a-f]+ differs from its fresh leg in seller_fee_rate, seller_fee, seller_available_amount/);
  const settledAgain = availableLegs().map((l) => (l.external_transaction_id === 'TX2' ? { ...l, settlement_status: 'SETTLED' } : l));
  assert.match(ierrs(items(settledAgain, first, T2)), /is no longer AVAILABLE/);
  assert.match(ierrs(items(availableLegs().concat([availableLegs()[0]]))), /Payment Legs has payment_leg_id PL-[0-9a-f]+ 2 times/);
  assert.match(ierrs(items(availableLegs(), first.concat([first[0]]), T2)), /duplicate|twice/);
});

test('Payment Legs guard: a fresh leg that diverges from its frozen item fails before any write', () => {
  const frozen = js(items(availableLegs()).items);
  const ok = legsFor({ ...paid({}), __frozen: frozen });
  assert.deepEqual(js(ok.errors.frozen_item_conflicts), []);
  const retro = legsFor({ ...paid({}), __frozen: frozen }, [{ seller_id: 'SLR-A', payment_source: 'PAYPAL', seller_fee_rate: 0.07, effective_from: '2026-10-01', effective_to: '' }]);
  assert.match(js(retro.errors.frozen_item_conflicts).join(), /fresh Payment Leg differs from the frozen item in seller_fee_rate, seller_fee, seller_available_amount/);
  const unpaid = legsFor({ __frozen: frozen });
  assert.match(js(unpaid.errors.frozen_item_conflicts).join(), /Payment Leg would become SETTLED/);
});

test('item equations and aggregate identity: provider payout = seller available + system margin', () => {
  const b = items(availableLegs());
  const s = js(H.summarizeSettlementItems_(b.items));
  assert.ok(Math.abs(s.provider_transaction_payout_total - s.seller_available_total - s.system_margin_total) < 1e-6);
  assert.ok(Math.abs(s.seller_hold_total - s.provider_hold_total) < 1e-9);
  const broken = availableLegs().map((l) => ({ ...l, seller_hold_amount: l.provider_hold_amount + 1 }));
  assert.match(ierrs(items(broken)), /seller hold != provider hold/);
  const badAvail = availableLegs().map((l) => ({ ...l, seller_available_amount: 1 }));
  assert.match(ierrs(items(badAvail)), /seller available != net - seller fee - seller hold/);
});

test('Settlement Items regression report (report only) and its accounting identity', () => {
  const exp = js(vm.runInContext('SETTLEMENT_ITEMS_REGRESSION', context));
  const summary = { settlement_item_rows: 168, settlement_counts: exp.settlement_counts, seller_counts: exp.seller_counts };
  ['provider_transaction_payout_total', 'seller_available_total', 'system_margin_total', 'seller_hold_total', 'provider_hold_total',
    'seller_fee_total', 'provider_fee_total'].forEach((k) => { summary[k] = exp[k]; });
  assert.equal(H.evaluateSettlementItemsRegression_(summary).pass, true);
  assert.ok(Math.abs(exp.provider_transaction_payout_total - exp.seller_available_total - exp.system_margin_total) < 1e-9);
  assert.equal(H.evaluateSettlementItemsRegression_(js(H.summarizeSettlementItems_(items(availableLegs()).items))).pass, false);
});

test('existing frozen items need a valid snapshot_at: blank or invalid is a hard error, never repaired', () => {
  const first = js(items(availableLegs()).items).map((x) => ({ ...x, snapshot_at: D(x.snapshot_at) }));
  const ok = items(availableLegs(), first, T2);
  assert.equal(ierrs(ok), '');
  ok.items.forEach((x) => assert.equal(x.snapshot_at.getTime(), T1.getTime(), 'valid snapshot_at preserved exactly'));
  const blank = items(availableLegs(), first.map((x, i) => (i === 0 ? { ...x, snapshot_at: '' } : x)), T2);
  assert.deepEqual(js(blank.errors.invalid_snapshot_at), ['Frozen item ' + first[0].settlement_item_id + ': snapshot_at is blank']);
  assert.equal(blank.newItems, 0, 'not re-created as a new item');
  assert.equal(blank.items.find((x) => x.settlement_item_id === first[0].settlement_item_id).snapshot_at, '', 'not repaired');
  const text = items(availableLegs(), first.map((x, i) => (i === 1 ? { ...x, snapshot_at: '2026-10-12 08:00' } : x)), T2);
  assert.match(ierrs(text), /snapshot_at "2026-10-12 08:00" is not a valid datetime/);
  const nan = items(availableLegs(), first.map((x, i) => (i === 1 ? { ...x, snapshot_at: D('not a date') } : x)), T2);
  assert.match(ierrs(nan), /is not a valid datetime/);
  assert.equal(ierrs(items(availableLegs(), [], T2)), '', 'new items receive snapshot_at = now');
});
