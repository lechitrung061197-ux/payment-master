// Unit tests for derived Seller Balances (pure parts of src/SellerBalances.gs). Fake data.
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
for (const f of ['Config', 'Utils', 'RawSnapshot', 'CanonicalTable', 'Kh001ProviderTransactions', 'SellerMapping', 'SellerBalances']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.gs'), 'utf8'), context, { filename: f + '.gs' });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const D = (iso) => vm.runInContext(`new Date(${JSON.stringify(iso)})`, context);
const SB_COLUMNS = js(H.getColumnNames_('Seller Balances'));
const T1 = D('2026-10-12T08:00:00Z');
const T2 = D('2026-10-13T08:00:00Z');

const item = (id, seller, available, hold) => ({ settlement_item_id: 'SI-' + id, seller_id: seller, currency: 'USD',
  seller_available_amount: available, seller_hold_amount: hold });
const adj = (id, o) => ({ adjustment_id: id, adjustment_type: 'MANUAL_ADJUSTMENT', seller_id: 'CUS001', currency: 'USD', amount: 10,
  status: 'APPLIED', ...o });
const pay = (id, o) => ({ seller_payout_id: id, seller_id: 'CUS001', currency: 'USD', amount: 100, status: 'SENT', ...o });
const sellerIds = ['CUS001', 'CUS002', 'CUS003', 'CUS004'];
const build = (o) => H.buildSellerBalances_({ items: o.items || [item('1', 'CUS001', 1000, 120)], adjustments: o.adjustments || [],
  payouts: o.payouts || [], sellerIds, existing: o.existing || [], now: o.now || T1, columns: SB_COLUMNS });
const errs = (b) => js(H.flattenBalanceErrors_(b.errors)).join(' | ');
const row = (b, k) => js(b.rows).find((r) => r.seller_id + '|' + r.currency === (k || 'CUS001|USD'));

// Production fixture (Phase 2J shape) lives here, not in runtime code.
const PROD_BALANCES = { CUS001: [1919.3986, 234.073], CUS002: [3037.444, 370.42], CUS003: [256.7666, 31.313], CUS004: [3156.4424, 384.932] };

test('current production shape: four sellers from Settlement Items only; runtime invariants pass', () => {
  const items = Object.entries(PROD_BALANCES).map(([id, [settled, hold]], i) => item(String(i), id, settled, hold));
  const b = build({ items });
  assert.equal(errs(b), '');
  const s = js(H.summarizeSellerBalances_(b.rows));
  assert.equal(s.balance_rows, 4);
  assert.ok(Math.abs(s.settled_total - 8370.0516) < 1e-9);
  assert.ok(Math.abs(s.hold_total - 1020.738) < 1e-9);
  assert.equal(H.evaluateSellerBalancesInvariants_(b.rows, s).pass, true);
  const r = row(b);
  assert.equal(r.current_balance, r.available_amount);
  assert.equal(r.paid_amount, 0);
});

test('APPLIED adjustments: positive increases, negative decreases; PENDING / VOID ignored', () => {
  const b = build({ adjustments: [adj('A1', { amount: 25 }), adj('A2', { amount: -5 }), adj('A3', { status: 'PENDING', amount: 999 }),
    adj('A4', { status: 'VOID', amount: 999 })] });
  assert.equal(errs(b), '');
  const r = row(b);
  assert.equal(r.adjustments, 20);
  assert.equal(r.current_balance, 1020);
  assert.equal(r.settled_amount, 1000);
});

test('HOLD_RELEASE lowers hold and credits the balance; hold cannot go materially negative', () => {
  const r = row(build({ adjustments: [adj('H1', { adjustment_type: 'HOLD_RELEASE', amount: 20 })] }));
  assert.equal(r.seller_hold_balance, 100);
  assert.equal(r.current_balance, 1020);
  assert.match(errs(build({ adjustments: [adj('H1', { adjustment_type: 'HOLD_RELEASE', amount: 121 })] })), /hold balance would be -1/);
  assert.match(errs(build({ adjustments: [adj('H1', { adjustment_type: 'HOLD_RELEASE', amount: -5 })] })), /HOLD_RELEASE amount must be positive/);
});

test('SENT and CONFIRMED payouts reduce the balance once; DRAFT / VOID ignored; negative balance allowed', () => {
  const b = build({ payouts: [pay('P1'), pay('P2', { status: 'CONFIRMED', amount: 50 }), pay('P3', { status: 'DRAFT' }), pay('P4', { status: 'VOID' })] });
  assert.equal(errs(b), '');
  assert.equal(row(b).paid_amount, 150);
  assert.equal(row(b).current_balance, 850);
  const neg = row(build({ payouts: [pay('P1', { amount: 1500 })] }));
  assert.equal(neg.current_balance, -500, 'not clamped');
  assert.equal(neg.available_amount, -500);
});

test('duplicate payout / adjustment ids, unknown sellers and invalid amounts are rejected', () => {
  assert.match(errs(build({ adjustments: [adj('A1'), adj('A1')] })), /Adjustment A1: duplicate adjustment_id/);
  assert.match(errs(build({ payouts: [pay('P1'), pay('P1')] })), /Seller Payout P1: duplicate seller_payout_id/);
  assert.match(errs(build({ adjustments: [adj('A1', { seller_id: 'CUS999' })] })), /unknown seller CUS999/);
  assert.match(errs(build({ adjustments: [adj('A1', { amount: 'ten' })] })), /amount is not numeric/);
  assert.match(errs(build({ payouts: [pay('P1', { currency: '' })] })), /currency is blank/);
  assert.match(errs(build({ items: [item('1', 'CUS999', 1, 0)] })), /unknown seller CUS999/);
});

test('rerun NO_CHANGE with updated_at preserved; content change updates it; a disappearing key fails', () => {
  const first = build({}).rows;
  const second = build({ existing: first, now: T2 });
  assert.equal(errs(second), '');
  assert.equal(second.rows[0].updated_at.getTime(), T1.getTime());
  const sum = (rows) => H.computeRawChecksum_(H.buildTableValues_(SB_COLUMNS, rows.map((o) => H.objectToRow_(o, SB_COLUMNS))));
  assert.equal(sum(second.rows), sum(first));
  const changed = build({ existing: first, now: T2, adjustments: [adj('A1')] });
  assert.equal(changed.rows[0].updated_at.getTime(), T2.getTime());
  assert.match(errs(build({ items: [item('2', 'CUS002', 5, 0)], existing: first, now: T2 })), /Seller balance CUS001\|USD would disappear/);
});

test('invariants (2P.2): pass after a legitimate payout; fail on an inconsistent row or wrong totals', () => {
  const items = Object.entries(PROD_BALANCES).map(([id, [settled, hold]], i) => item(String(i), id, settled, hold));
  const b = build({ items, payouts: [pay('P1', { seller_id: 'CUS002', amount: 3037.444, status: 'CONFIRMED' })] });
  assert.equal(errs(b), '');
  const s = js(H.summarizeSellerBalances_(b.rows));
  assert.ok(Math.abs(s.current_balance_total - 5332.6076) < 1e-9);
  assert.equal(H.evaluateSellerBalancesInvariants_(b.rows, s).pass, true, 'a valid payout never fails the runtime report');
  const rows = js(b.rows);
  rows[1].current_balance = 1;
  const bad = js(H.evaluateSellerBalancesInvariants_(rows, s));
  assert.equal(bad.pass, false);
  assert.ok(bad.failed.includes('current_balance = settled + adjustments - paid') && bad.failed.includes('available_amount = current_balance'));
  assert.ok(js(H.evaluateSellerBalancesInvariants_(js(b.rows), { ...s, paid_total: 0 })).failed.includes('summary totals = SUM(rows)'));
});
