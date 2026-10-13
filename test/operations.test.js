// Phase 2O: Operations tab (operator view + command form) and controlled Seller Payout operations, tested on the real
// engine with a production-shaped Master (test/helpers/masterSim.js). Fake data.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildMasterSim } = require('./helpers/masterSim');

const sim = buildMasterSim();
const { call, mS } = sim;
const js = (v) => JSON.parse(JSON.stringify(v));
const near = (a, b) => Math.abs(a - b) < 1e-6;
const SRC = path.join(__dirname, '..', 'src');
const BALANCES = { CUS001: [1919.3986, 234.073], CUS002: [3037.444, 370.42], CUS003: [256.7666, 31.313], CUS004: [3156.4424, 384.932] };
const SELLER = { CUS001: 'CUS001 · DITECH', CUS002: 'CUS002 · HUI', CUS003: 'CUS003 · DINO', CUS004: 'CUS004 · VNS_1' };

const run = (expr) => js(call(expr));
const payouts = () => sim.rows('Seller Payouts');
const allocations = () => sim.rows('Seller Payout Allocations');
const actions = (since) => sim.audit().slice(since || 0).map((a) => a.action);
const statesOf = (seller) => js(sim.states()).filter((s) => s.seller_id === seller);
function draft(seller, amount, extra) {
  sim.setForm(Object.assign({ seller: SELLER[seller], currency: 'USD', payout_date: '12/10/2026', amount: amount, payout_currency: '', fx_rate: '',
    payout_amount: '', payment_method: 'Bank transfer', reference: 'REF-' + seller + '-' + amount, notes: '' }, extra || {}));
  return run('createDraftSellerPayoutFromOperations()');
}
function transition(fn, payoutId, reason) {
  sim.selectPayout(payoutId);
  return run(fn + '(' + (reason === undefined ? '' : JSON.stringify(reason)) + ')');
}
const sent = (id) => transition('markSelectedSellerPayoutSent', id);
/** Seller sheet section D labels "PAYPAL #n · STATUS" of a child. */
function childStatuses(seller) {
  const phieu = sim.child(seller).sheets.find((s) => s.name === 'PhieuDoiSoat');
  return Object.entries(phieu.cells).map(([k, c]) => [k.split(',').map(Number), c && c.v]).filter(([, v]) => typeof v === 'string' && /^PAYPAL #\d+ · /.test(v))
    .sort((a, b) => a[0][0] - b[0][0]).map(([, v]) => v.split(' · ')[1]);
}

test.beforeEach(() => sim.restore());

// ------------------------------------------------------------------ M. production regression before any payout
test('M: current production state is exact before any payout (168 items, balances, 8370.0516, 8%, 7 UNPAID, no payouts, child schema 4)', () => {
  const b = sim.balances();
  Object.entries(BALANCES).forEach(([id, [avail, hold]]) => {
    assert.ok(near(b[id].available_amount, avail) && near(b[id].current_balance, avail), id + ' available');
    assert.ok(near(b[id].seller_hold_balance, hold), id + ' hold');
  });
  assert.ok(near(Object.values(b).reduce((a, x) => a + x.available_amount, 0), 8370.0516));
  const items = sim.rows('Settlement Items');
  assert.equal(items.length, 168);
  assert.deepEqual([...new Set(items.map((i) => i.seller_fee_rate))], [0.08]);
  assert.ok(items.every((i) => near(i.seller_hold_amount, i.provider_hold_amount)), 'hold mirrors provider');
  const states = js(sim.states());
  assert.equal(states.length, 7);
  assert.ok(states.every((s) => s.payment_status === 'UNPAID'));
  assert.deepEqual([payouts().length, allocations().length], [0, 0]);
  assert.equal(call('SELLER_OUTPUT.schemaVersion'), 4);
  assert.equal(call('APP.SCHEMA_VERSION'), 18);
  assert.ok(run('verifyPaymentPipelineHealth()').pass);
});

// ------------------------------------------------------------------ 1. Operations is a view, not an authority
test('1: Operations is a view: no accounting module reads it, and tampered Operations cells change nothing', () => {
  const readers = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs') && /SHEETS\.OPERATIONS/.test(fs.readFileSync(path.join(SRC, f), 'utf8')));
  assert.deepEqual(readers, ['Operations.gs'], 'only Operations.gs (render / form / selection) touches the tab');
  const ops = mS('Operations').api;
  const payableRow = ops.getRange(1, 1, 60, 1).getValues().map((r) => r[0]).indexOf('CUS003') + 1;
  ops.getRange(payableRow, 4, 1, 4).setValues([[999999, 0, 0, 999999]]); // fake current_balance / available_to_draft
  ops.getRange(call('OPERATIONS.statusStartRow') + 5, 2).setValue(999999);
  const r = draft('CUS003', 500);
  assert.equal(r.status, 'FAILED');
  assert.match(r.error, /exceeds what CUS003 can still be paid: available to draft 256\.7666/);
  assert.equal(payouts().length, 0);
  assert.equal(run('normalizeSellerBalances()').status, 'NO_CHANGE');
  assert.ok(near(sim.balances().CUS003.current_balance, 256.7666));
  assert.equal(ops.getRange(payableRow, 4).getValue(), 256.7666, 'refresh re-renders from canonical data');
});

// ------------------------------------------------------------------ 2-4. create DRAFT + FIFO, idempotency, no financial effect
test('2: create DRAFT from the form: one Seller Payouts row (DRAFT) and FIFO allocation rows, oldest obligation first', () => {
  const before = sim.audit().length;
  const ob = statesOf('CUS001');
  const firstDue = ob[0].due_amount;
  const r = draft('CUS001', 1000 + firstDue - 1000 + 100); // whole first obligation + 100 of the second
  assert.equal(r.status, 'SUCCESS', r.error);
  assert.match(r.seller_payout_id, /^SP-OPS-[0-9A-F]{16}$/);
  const p = payouts();
  assert.equal(p.length, 1);
  assert.deepEqual([p[0].seller_payout_id, p[0].seller_id, p[0].status, p[0].currency, p[0].payout_currency, p[0].fx_rate, p[0].payment_method],
    [r.seller_payout_id, 'CUS001', 'DRAFT', 'USD', 'USD', 1, 'Bank transfer']);
  assert.ok(near(p[0].payout_amount, p[0].amount));
  assert.equal(call('masterDateKey_')(p[0].payout_date), '2026-10-12');
  const a = allocations();
  assert.deepEqual(a.map((x) => x.target_id), [ob[0].target_id, ob[1].target_id], 'oldest obligation first');
  assert.ok(near(a[0].allocated_amount, firstDue) && near(a[1].allocated_amount, 100));
  assert.ok(a.every((x) => x.seller_id === 'CUS001' && x.seller_payout_id === r.seller_payout_id));
  const acts = actions(before);
  assert.ok(acts.indexOf('SELLER_PAYOUT_DRAFT_CREATED') >= 0 && acts.indexOf('SELLER_PAYOUT_DRAFT_CREATED') < acts.indexOf('SELLER_PAYOUT_ALLOCATION_FIFO_SUCCESS'),
    'DRAFT_CREATED is written as soon as the canonical row exists, before FIFO');
  assert.equal(acts.filter((a) => a === 'SELLER_PAYOUT_DRAFT_CREATED').length, 1);
  const created = sim.audit().find((x) => x.action === 'SELLER_PAYOUT_DRAFT_CREATED');
  const d = JSON.parse(created.details);
  assert.deepEqual([d.seller_payout_id, d.seller_id, d.currency, d.payout_currency, d.payment_method, d.reference, d.allocation_status, d.request],
    [r.seller_payout_id, 'CUS001', 'USD', 'USD', 'Bank transfer', 'REF-CUS001-' + (firstDue + 100), 'PENDING', 'NEW']);
  assert.equal(created.new_status, 'DRAFT');
  assert.equal(r.allocation_status, 'FULL');
  assert.equal(JSON.parse(sim.audit().find((x) => x.action === 'SELLER_PAYOUT_ALLOCATION_FIFO_SUCCESS').details).rows.length, 2);
  assert.equal(sim.formValue('amount'), '', 'amount cleared after success');
});

test('3: retry with the same request token returns the existing payout (NO_CHANGE); a double click never creates a second payout', () => {
  const token = sim.token();
  const r = draft('CUS002', 500);
  assert.equal(r.status, 'SUCCESS');
  assert.notEqual(sim.token(), token, 'token rotated after success');
  // double click: the second call sees the rotated token and the cleared amount
  const again = run('createDraftSellerPayoutFromOperations()');
  assert.equal(again.status, 'FAILED');
  assert.match(again.error, /Amount must be a positive number/);
  // retry of the same request (e.g. the first call timed out before the token rotated)
  mS('Operations').api.getRange(call('OPERATIONS.tokenRow'), 2).setValue(token);
  const retry = draft('CUS002', 500);
  assert.equal(retry.status, 'NO_CHANGE', retry.error);
  assert.equal(retry.seller_payout_id, r.seller_payout_id);
  // same token, different values: refused
  mS('Operations').api.getRange(call('OPERATIONS.tokenRow'), 2).setValue(token);
  const other = draft('CUS002', 600);
  assert.equal(other.status, 'FAILED');
  assert.match(other.error, /Request token already used/);
  assert.equal(payouts().length, 1);
  assert.equal(allocations().length, 1);
});

test('4: a DRAFT never reduces the seller balance', () => {
  assert.equal(draft('CUS001', 1500).status, 'SUCCESS');
  assert.equal(run('normalizeSellerBalances()').status, 'NO_CHANGE');
  assert.ok(near(sim.balances().CUS001.current_balance, 1919.3986));
  assert.ok(near(sim.balances().CUS001.paid_amount, 0));
  assert.ok(statesOf('CUS001').every((s) => s.payment_status === 'UNPAID'), 'DRAFT is not paid');
});

// ------------------------------------------------------------------ 5-7. claims, limits, temporal guard
test('5: a second DRAFT cannot claim what another DRAFT already claims', () => {
  assert.equal(draft('CUS003', 200).status, 'SUCCESS');
  const second = draft('CUS003', 100);
  assert.equal(second.status, 'FAILED');
  assert.match(second.error, /available to draft 56\.7666/);
  const rest = draft('CUS003', 56.7666);
  assert.equal(rest.status, 'SUCCESS', rest.error);
  assert.equal(payouts().length, 2);
  const a = allocations();
  assert.ok(near(a.reduce((s, x) => s + x.allocated_amount, 0), 256.7666), 'claims never exceed the obligation');
});

test('6: a payout above the payable / available amount fails before anything is written', () => {
  const r = draft('CUS004', 3156.4425);
  assert.equal(r.status, 'FAILED');
  assert.match(r.error, /available to draft 3156\.4424/);
  assert.deepEqual([payouts().length, allocations().length], [0, 0]);
  assert.ok(actions().includes('SELLER_PAYOUT_OPERATION_FAILED'));
});

test('7: a payout dated before the obligations are available fails (temporal guard)', () => {
  const early = draft('CUS001', 10, { payout_date: '05/10/2026' }); // provider payment dates: 06/10 and 10/10
  assert.equal(early.status, 'FAILED');
  assert.match(early.error, /payable balance of CUS001 as of 05\/10\/2026 \(0 after other DRAFT payouts\)/);
  const ob = statesOf('CUS001');
  const mid = draft('CUS001', ob[0].due_amount + 1, { payout_date: '07/10/2026' }); // only the first obligation is available by then
  assert.equal(mid.status, 'FAILED');
  assert.match(mid.error, /as of 07\/10\/2026/);
  assert.equal(payouts().length, 0);
});

// ------------------------------------------------------------------ 8-14. lifecycle
test('8: a DRAFT that is unallocated or only partially allocated cannot become SENT', () => {
  const cols = call('getColumnNames_("Seller Payouts")');
  mS('Seller Payouts').api.getRange(2, 1, 1, cols.length).setValues([cols.map((c) => ({ seller_payout_id: 'SP-MANUAL-1', seller_id: 'CUS001',
    payout_date: sim.makeDate(Date.parse('2026-10-12T04:00:00Z')), currency: 'USD', amount: 300, status: 'DRAFT' })[c] ?? '')]);
  run('refreshOperations()');
  const r = sent('SP-MANUAL-1');
  assert.equal(r.status, 'FAILED');
  assert.match(r.error, /not fully allocated \(0 of 300\); it stays DRAFT/);
  assert.equal(payouts()[0].status, 'DRAFT');
  // partially allocated: allocation 100 of an amount raised to 400
  const d = draft('CUS001', 100);
  const row = payouts().findIndex((p) => p.seller_payout_id === d.seller_payout_id) + 2;
  mS('Seller Payouts').api.getRange(row, cols.indexOf('amount') + 1).setValue(400);
  mS('Seller Payouts').api.getRange(row, cols.indexOf('payout_amount') + 1).setValue(400);
  run('refreshOperations()');
  const partial = sent(d.seller_payout_id);
  assert.equal(partial.status, 'FAILED');
  assert.match(partial.error, /not fully allocated \(100 of 400\)/);
  assert.deepEqual(payouts().map((p) => p.status), ['DRAFT', 'DRAFT']);
  assert.ok(near(sim.balances().CUS001.current_balance, 1919.3986));
});

test('9 + 10 + 11: DRAFT fully allocated -> SENT reduces the balance exactly once; SENT -> CONFIRMED does not reduce again', () => {
  const d = draft('CUS001', 1000);
  const before = sim.audit().length;
  const s = sent(d.seller_payout_id);
  assert.equal(s.status, 'SUCCESS', s.error);
  assert.deepEqual([s.old_status, s.new_status, s.ledger, s.health], ['DRAFT', 'SENT', 'VALID', 'PASS']);
  assert.equal(payouts()[0].status, 'SENT');
  const b = sim.balances().CUS001;
  assert.ok(near(b.current_balance, 919.3986) && near(b.paid_amount, 1000));
  assert.ok(actions(before).includes('SELLER_PAYOUT_SENT'));
  const audit = sim.audit().find((x) => x.action === 'SELLER_PAYOUT_SENT');
  assert.deepEqual([audit.old_status, audit.new_status], ['DRAFT', 'SENT']);
  assert.equal(run('normalizeSellerBalances()').status, 'NO_CHANGE', 'exactly once: nothing left to apply');
  assert.equal(run('runScheduledPaymentPipeline()').status, 'SUCCESS');
  assert.ok(near(sim.balances().CUS001.current_balance, 919.3986), 'a pipeline run does not deduct again');
  const c = transition('markSelectedSellerPayoutConfirmed', d.seller_payout_id);
  assert.equal(c.status, 'SUCCESS', c.error);
  assert.equal(payouts()[0].status, 'CONFIRMED');
  assert.ok(near(sim.balances().CUS001.current_balance, 919.3986) && near(sim.balances().CUS001.paid_amount, 1000), 'CONFIRMED: no second deduction');
  assert.ok(sim.audit().some((x) => x.action === 'SELLER_PAYOUT_CONFIRMED' && x.old_status === 'SENT' && x.new_status === 'CONFIRMED'));
  // only the allowed transitions
  const again = transition('markSelectedSellerPayoutSent', d.seller_payout_id);
  assert.equal(again.status, 'FAILED');
  assert.match(again.error, /is CONFIRMED; only DRAFT -> SENT is allowed/);
  assert.match(transition('cancelSelectedSellerPayout', d.seller_payout_id).error, /only DRAFT -> CANCELLED/);
});

test('12 + 13: partial payout -> PAID / PARTIAL; full payout -> every obligation PAID (Master and the seller sheet)', () => {
  const ob = statesOf('CUS001');
  const d1 = draft('CUS001', Math.round((ob[0].due_amount + 100) * 1e4) / 1e4);
  assert.equal(sent(d1.seller_payout_id).status, 'SUCCESS');
  assert.deepEqual(statesOf('CUS001').map((s) => s.payment_status), ['PAID', 'PARTIAL']);
  assert.deepEqual(childStatuses('CUS001'), ['PAID', 'PARTIAL'], 'seller sheet shows the Master-derived status');
  const rest = Math.round((1919.3986 - ob[0].due_amount - 100) * 1e4) / 1e4;
  const d2 = draft('CUS001', rest);
  assert.equal(d2.status, 'SUCCESS', d2.error);
  assert.equal(sent(d2.seller_payout_id).status, 'SUCCESS');
  assert.deepEqual(statesOf('CUS001').map((s) => s.payment_status), ['PAID', 'PAID']);
  assert.deepEqual(childStatuses('CUS001'), ['PAID', 'PAID']);
  assert.ok(near(sim.balances().CUS001.current_balance, 0));
  const over = draft('CUS001', 0.01);
  assert.equal(over.status, 'FAILED', 'nothing left to pay');
});

test('14: REVERSED restores the balance and the obligation status; nothing is deleted; reason required', () => {
  const d = draft('CUS001', 1919.3986);
  assert.equal(sent(d.seller_payout_id).status, 'SUCCESS');
  assert.deepEqual(childStatuses('CUS001'), ['PAID', 'PAID']);
  const noReason = transition('reverseSelectedSellerPayout', d.seller_payout_id, '');
  assert.equal(noReason.status, 'FAILED');
  assert.match(noReason.error, /A reason is required/);
  assert.equal(payouts()[0].status, 'SENT');
  const r = transition('reverseSelectedSellerPayout', d.seller_payout_id, 'Bank returned the transfer');
  assert.equal(r.status, 'SUCCESS', r.error);
  const p = payouts();
  assert.deepEqual([p.length, p[0].status], [1, 'REVERSED']);
  assert.match(p[0].notes, /REVERSED \d{4}-\d{2}-\d{2}: Bank returned the transfer/);
  assert.equal(allocations().length, 2, 'allocations kept');
  assert.ok(near(sim.balances().CUS001.current_balance, 1919.3986) && near(sim.balances().CUS001.paid_amount, 0));
  assert.deepEqual(statesOf('CUS001').map((s) => s.payment_status), ['UNPAID', 'UNPAID']);
  assert.deepEqual(childStatuses('CUS001'), ['UNPAID', 'UNPAID']);
  const audit = sim.audit().find((x) => x.action === 'SELLER_PAYOUT_REVERSED');
  assert.deepEqual([audit.old_status, audit.new_status, JSON.parse(audit.details).reason], ['SENT', 'REVERSED', 'Bank returned the transfer']);
  assert.ok(!payouts().some((x) => x.amount < 0), 'no negative payout is created');
  // CONFIRMED -> REVERSED is allowed too
  const d2 = draft('CUS004', 50);
  sent(d2.seller_payout_id);
  transition('markSelectedSellerPayoutConfirmed', d2.seller_payout_id);
  assert.equal(transition('reverseSelectedSellerPayout', d2.seller_payout_id, 'wrong account').status, 'SUCCESS');
  assert.ok(near(sim.balances().CUS004.current_balance, 3156.4424));
});

test('15: CANCELLED DRAFT frees its provisional claim; allocations stay as audit trail', () => {
  const d = draft('CUS003', 256.7666);
  assert.equal(d.status, 'SUCCESS');
  assert.equal(draft('CUS003', 1).status, 'FAILED', 'fully claimed');
  const c = transition('cancelSelectedSellerPayout', d.seller_payout_id, 'duplicate request');
  assert.equal(c.status, 'SUCCESS', c.error);
  assert.equal(payouts()[0].status, 'CANCELLED');
  assert.equal(allocations().length, 1, 'kept');
  const again = draft('CUS003', 256.7666);
  assert.equal(again.status, 'SUCCESS', again.error);
  assert.ok(near(sim.balances().CUS003.current_balance, 256.7666), 'no financial effect');
  assert.ok(sim.audit().some((x) => x.action === 'SELLER_PAYOUT_CANCELLED' && JSON.parse(x.details).reason === 'duplicate request'));
});

// ------------------------------------------------------------------ 16-19. integrity and safety
test('16: cross-seller allocation is impossible (FIFO stays inside the seller; a tampered row blocks SENT)', () => {
  const d = draft('CUS001', 500);
  assert.ok(allocations().every((a) => a.seller_id === 'CUS001'));
  const cols = call('getColumnNames_("Seller Payout Allocations")');
  mS('Seller Payout Allocations').api.getRange(2, cols.indexOf('seller_id') + 1).setValue('CUS004');
  const r = sent(d.seller_payout_id);
  assert.equal(r.status, 'FAILED');
  assert.match(r.error, /Seller Balances is (not current|invalid)|seller_id CUS004 is not the payout seller CUS001/);
  assert.match(js(call('verifySellerPayoutAllocations()')).cross_seller_errors.join(), /seller_id CUS004 is not the payout seller CUS001/);
  assert.equal(payouts()[0].status, 'DRAFT');
});

test('17: currency mismatch is impossible; same currency is normalized; another payout currency needs explicit FX + amount', () => {
  const eur = draft('CUS001', 100, { currency: 'EUR' });
  assert.equal(eur.status, 'FAILED');
  assert.match(eur.error, /CUS001 has no EUR balance or payout obligation/);
  const fx = draft('CUS001', 100, { fx_rate: 1.1 });
  assert.match(fx.error, /Same-currency payout: FX Rate must be 1 or blank/);
  const amt = draft('CUS001', 100, { payout_amount: 99 });
  assert.match(amt.error, /Payout Amount must equal Amount/);
  const vnd = draft('CUS001', 100, { payout_currency: 'VND' });
  assert.match(vnd.error, /Payout in VND: FX Rate is required.*Payout in VND: Payout Amount is required/);
  assert.equal(payouts().length, 0);
  const ok = draft('CUS001', 100, { payout_currency: 'VND', fx_rate: 25300, payout_amount: 2530000 });
  assert.equal(ok.status, 'SUCCESS', ok.error);
  const p = payouts()[0];
  assert.deepEqual([p.currency, p.amount, p.payout_currency, p.fx_rate, p.payout_amount], ['USD', 100, 'VND', 25300, 2530000]);
  assert.equal(sent(ok.seller_payout_id).status, 'SUCCESS');
  assert.ok(near(sim.balances().CUS001.current_balance, 1819.3986), 'the balance moves in the obligation currency (amount)');
});

test('18: a wrong / ambiguous selection never mutates anything', () => {
  const d = draft('CUS001', 100);
  const snapshot = JSON.stringify([payouts(), allocations()]);
  const ops = mS('Operations').api;
  const tries = [
    () => { sim.M.MASTER.active = mS('Seller Payouts').api; sim.M.MASTER.activeRange = mS('Seller Payouts').api.getRange(2, 1, 1, 1); },
    () => sim.selectPayout(null, call('OPERATIONS.statusStartRow')), // a status row
    () => sim.selectPayout(null, ops.getRange(1, 1, 80, 1).getValues().map((r) => r[0]).indexOf('CUS001') + 1), // payable table row
    () => sim.selectPayout(null, ops.getRange(1, 1, 80, 1).getValues().map((r) => r[0]).indexOf('seller_payout_id') + 1), // header row
    () => { sim.M.MASTER.active = ops; sim.M.MASTER.activeRange = ops.getRange(sim.selectPayout(d.seller_payout_id), 1, 2, 12); }, // two rows
  ];
  tries.forEach((select, i) => {
    select();
    const r = run('markSelectedSellerPayoutSent()');
    assert.equal(r.status, 'FAILED', 'case ' + i);
    assert.match(r.error, /Select|not a payout row/);
  });
  // stale view: the row shows DRAFT but the payout was changed directly in Seller Payouts
  const cols = call('getColumnNames_("Seller Payouts")');
  mS('Seller Payouts').api.getRange(2, cols.indexOf('status') + 1).setValue('CANCELLED');
  const stale = sent(d.seller_payout_id);
  assert.equal(stale.status, 'FAILED');
  mS('Seller Payouts').api.getRange(2, cols.indexOf('status') + 1).setValue('DRAFT');
  assert.equal(JSON.stringify([payouts(), allocations()]), snapshot);
  assert.ok(near(sim.balances().CUS001.current_balance, 1919.3986));
});

test('19: document lock busy (pipeline running) -> the operation exits safely, nothing changed, audited', () => {
  const d = draft('CUS001', 100);
  sim.selectPayout(d.seller_payout_id);
  sim.M.locks.documentBusy = true;
  const before = sim.audit().length;
  for (const fn of ['createDraftSellerPayoutFromOperations()', 'markSelectedSellerPayoutSent()', 'reverseSelectedSellerPayout("x")']) {
    const r = run(fn);
    assert.equal(r.status, 'SKIPPED_LOCKED', fn);
  }
  assert.ok(actions(before).every((a) => a === 'SELLER_PAYOUT_OPERATION_SKIPPED_LOCKED'));
  sim.M.locks.documentBusy = false;
  assert.deepEqual(payouts().map((p) => p.status), ['DRAFT']);
  assert.equal(sim.M.locks.script, false, 'no lock left behind');
  // the pipeline and an operation never run together: the pipeline itself skips while an operation holds the lock
  sim.M.locks.documentBusy = true;
  assert.equal(run('runScheduledPaymentPipeline()').status, 'SKIPPED_LOCKED');
});

// ------------------------------------------------------------------ 20-25. output-only children, views, pipeline, health
test('20: seller child status is never read back: tampering a child changes nothing in Master and is overwritten on sync', () => {
  const ops = fs.readFileSync(path.join(SRC, 'Operations.gs'), 'utf8');
  assert.ok(!/openById/.test(ops), 'Operations never opens a seller spreadsheet itself');
  const d = draft('CUS001', 100);
  assert.equal(sent(d.seller_payout_id).status, 'SUCCESS');
  const phieu = sim.child('CUS001').sheets.find((s) => s.name === 'PhieuDoiSoat');
  const cells = Object.entries(phieu.cells).filter(([, c]) => c && typeof c.v === 'string' && /^PAYPAL #\d+ · /.test(c.v));
  cells.forEach(([, c]) => { c.v = c.v.replace(/· \w+$/, '· PAID'); });
  assert.deepEqual(statesOf('CUS001').map((s) => s.payment_status), ['PARTIAL', 'UNPAID'], 'Master derives from Seller Payouts + Allocations only');
  assert.equal(run('normalizeSellerBalances()').status, 'NO_CHANGE');
  assert.equal(run('syncSellerSheet("CUS001")').status, 'SUCCESS');
  assert.deepEqual(childStatuses('CUS001'), ['PARTIAL', 'UNPAID'], 'child rewritten from Master');
});

test('21: Operator / Technical view only hides / shows tabs; the pipeline and accounting are unaffected; setup never changes the view', () => {
  const op = run('applyOperatorView()');
  assert.equal(op.status, 'SUCCESS');
  const visible = () => sim.M.MASTER.sheets.filter((s) => !s.hidden).map((s) => s.name);
  assert.deepEqual(visible().sort(), ['Adjustments', 'Dashboard', 'Disputes', 'Operations', 'Seller Destinations', 'Seller Payouts', 'Seller Terms', 'Sellers'].sort());
  assert.ok(sim.M.MASTER.sheets.filter((s) => s.name.startsWith('__STAGE_')).every((s) => s.hidden));
  const balancesBefore = JSON.stringify(sim.rows('Seller Balances').map((b) => [b.seller_id, b.current_balance, b.seller_hold_balance]));
  const p = run('runScheduledPaymentPipeline()');
  assert.equal(p.status, 'SUCCESS', p.error);
  assert.deepEqual(visible().sort(), ['Adjustments', 'Dashboard', 'Disputes', 'Operations', 'Seller Destinations', 'Seller Payouts', 'Seller Terms', 'Sellers'].sort(),
    'the operator view survives a pipeline run');
  assert.equal(JSON.stringify(sim.rows('Seller Balances').map((b) => [b.seller_id, b.current_balance, b.seller_hold_balance])), balancesBefore, 'hidden state changes no number');
  assert.ok(p.stages.every((x) => ['SUCCESS', 'NO_CHANGE', 'PASS'].includes(x.status)));
  const d = draft('CUS001', 100);
  assert.equal(sent(d.seller_payout_id).status, 'SUCCESS');
  assert.ok(sim.M.MASTER.sheets.find((s) => s.name === 'Seller Balances').hidden, 'and a payout operation (which rewrites Seller Balances)');
  call('setupMaster()');
  assert.ok(sim.M.MASTER.sheets.find((s) => s.name === 'Seller Balances').hidden, 'setupMaster does not change the view');
  const tech = run('applyTechnicalView()');
  assert.equal(tech.status, 'SUCCESS');
  const master = Object.values(js(call('SHEETS')));
  assert.ok(master.every((n) => !sim.M.MASTER.sheets.find((s) => s.name === n).hidden), 'every Master tab visible');
  assert.ok(sim.M.MASTER.sheets.filter((s) => s.name.startsWith('__STAGE_')).every((s) => s.hidden), 'staging stays hidden');
  assert.equal(run('runScheduledPaymentPipeline()').status, 'SUCCESS');
});

test('22: dd/MM/yyyy dates: strict parsing of the form, display in the payouts table, text-formatted input cell', () => {
  const k = (v) => call('parseOperationsDateKey_')(v);
  assert.deepEqual(['05/10/2026', '5/10/2026', '29/02/2028', '31/12/2026'].map(k), ['2026-10-05', '2026-10-05', '2028-02-29', '2026-12-31']);
  assert.deepEqual(['31/02/2026', '10/13/2026', '2026-10-05', '05-10-2026', '', 'x'].map(k), [null, null, null, null, null, null]);
  assert.equal(call('formatOperationsDate_')('2026-10-05'), '05/10/2026');
  const fields = call('OPERATIONS.formFields.map(function (f) { return f[0]; })');
  const dateRow = call('OPERATIONS.formStartRow') + fields.indexOf('payout_date');
  assert.equal(mS('Operations').fmts[dateRow + ',2'], '@', 'typed dates are never re-parsed by the en_US locale');
  const d = draft('CUS001', 100, { payout_date: '11/10/2026' });
  assert.equal(d.status, 'SUCCESS', d.error);
  assert.equal(call('masterDateKey_')(payouts()[0].payout_date), '2026-10-11', '11/10 is 11 October, not November 10');
  const ops = mS('Operations').api;
  const row = ops.getRange(1, 1, 80, 1).getValues().map((r) => r[0]).indexOf(d.seller_payout_id) + 1;
  assert.equal(ops.getRange(row, 3).getValue(), '11/10/2026');
});

test('23 + 25: the scheduled pipeline passes with payout data; a payout transition syncs only the affected seller sheet', () => {
  const d1 = draft('CUS001', 300);
  draft('CUS004', 200); // stays DRAFT
  sim.M.opened.length = 0;
  const logs = { CUS001: sim.child('CUS001').log.length, CUS004: sim.child('CUS004').log.length };
  assert.equal(sent(d1.seller_payout_id).status, 'SUCCESS');
  assert.ok(sim.child('CUS001').log.length > logs.CUS001, 'CUS001 sheet written');
  assert.equal(sim.child('CUS004').log.length, logs.CUS004, 'CUS004 sheet untouched');
  assert.ok(!sim.M.opened.includes(sim.childOf.CUS004), 'CUS004 sheet not even opened');
  assert.ok(!sim.M.opened.includes(sim.M.SRC.id), 'provider source not opened by a payout operation');
  const p = run('runScheduledPaymentPipeline()');
  assert.equal(p.status, 'SUCCESS', p.error);
  assert.ok(run('verifyPaymentPipelineHealth()').pass);
  assert.ok(near(sim.balances().CUS001.current_balance, 1619.3986) && near(sim.balances().CUS004.current_balance, 3156.4424));
  assert.equal(run('verifySellerSheets()').pass, true);
});

test('24: pipeline health catches a payout inconsistency made outside Operations (fail closed, no seller publish)', () => {
  const d = draft('CUS001', 100);
  const cols = call('getColumnNames_("Seller Payouts")');
  const sheet = mS('Seller Payouts').api;
  sheet.getRange(2, cols.indexOf('amount') + 1).setValue(150); // allocation 100 of 150
  sheet.getRange(2, cols.indexOf('status') + 1).setValue('SENT'); // bypassing Operations
  const h = run('verifyPaymentPipelineHealth()');
  assert.equal(h.pass, false);
  assert.ok(h.checks.some((c) => c.name === 'payout_allocations_valid' && !c.pass && /allocated 100 of 150/.test(c.detail)));
  const logs = sim.child('CUS001').log.length;
  const p = run('runScheduledPaymentPipeline()');
  assert.equal(p.status, 'FAILED');
  assert.equal(p.failed_stage, 'SELLER_BALANCES_REFRESH');
  assert.equal(sim.child('CUS001').log.length, logs, 'nothing published');
  assert.equal(d.status, 'SUCCESS');
});

// ------------------------------------------------------------------ pure helpers and layout
test('pure: available_to_draft = min(balance - DRAFT reserved, open obligations not claimed by a DRAFT); DRAFT is never paid', () => {
  const lines = js(call('buildOperationsLines_')({
    balances: [{ seller_id: 'S', currency: 'USD', current_balance: 100, seller_hold_balance: 10, paid_amount: 0 }],
    states: [{ seller_id: 'S', currency: 'USD', payment_status: 'UNPAID', remaining_amount: 70 }, { seller_id: 'S', currency: 'USD', payment_status: 'UNPAID', remaining_amount: 50 }],
    payouts: [{ seller_payout_id: 'P1', seller_id: 'S', currency: 'USD', amount: 40, status: 'DRAFT' }, { seller_payout_id: 'P2', seller_id: 'S', currency: 'USD', amount: 5, status: 'CANCELLED' }],
    allocations: [{ seller_payout_id: 'P1', seller_id: 'S', currency: 'USD', allocated_amount: 40 }, { seller_payout_id: 'P2', seller_id: 'S', currency: 'USD', allocated_amount: 5 }],
  }));
  const l = lines['S|USD'];
  assert.deepEqual([l.draft_reserved, l.draft_claimed, l.available_to_draft, l.open_count, l.payment_state], [40e6, 40e6, 60e6, 2, 'UNPAID']);
  const view = js(call('planOperationsView_')('OPERATOR', ['Operations', 'Transactions', '__STAGE_X', 'My notes', 'Sellers'], js(call('operationsMasterTabs_()'))));
  assert.deepEqual(view, { show: ['Operations', 'Sellers'], hide: ['Transactions', '__STAGE_X'] }, 'custom tabs untouched');
  assert.equal(call('operationsPayoutId_')('abc'), call('operationsPayoutId_')('abc'));
  assert.notEqual(call('operationsPayoutId_')('abc'), call('operationsPayoutId_')('abd'));
});

test('layout: setup creates Operations idempotently and never overwrites operator input', () => {
  sim.setForm({ seller: SELLER.CUS002, amount: 12.5, notes: 'keep me' });
  mS('Operations').api.getRange(5, 14).setValue('custom note in column N');
  const token = sim.token();
  call('setupMaster()');
  assert.equal(sim.formValue('seller'), SELLER.CUS002);
  assert.equal(sim.formValue('amount'), 12.5);
  assert.equal(sim.formValue('notes'), 'keep me');
  assert.equal(sim.token(), token);
  assert.equal(mS('Operations').api.getRange(5, 14).getValue(), 'custom note in column N');
  assert.equal(sim.M.MASTER.sheets[0].name, 'Operations');
  const vm = run('verifyMaster()');
  assert.deepEqual([vm.missingTabs, vm.extraTabs, vm.headerIssues], [[], [], []]);
});

test('menu: one "Payment Master" menu (Sync / Payouts / Sellers / View); every handler exists; confirmations and the required reason are enforced', () => {
  const alerts = [];
  let answer = 'YES';
  let promptText = '';
  const ui = { Button: { OK: 'OK', YES: 'YES', NO: 'NO', CANCEL: 'CANCEL' }, ButtonSet: { OK: 'OK', YES_NO: 'YES_NO', OK_CANCEL: 'OK_CANCEL' },
    alert: (title, msg, set) => { alerts.push([title, msg]); return set === 'YES_NO' ? answer : 'OK'; },
    prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => promptText }),
    createMenu: (name) => { const m = { name, items: [], subs: [], addItem: (l, f) => { m.items.push([l, f]); return m; }, addSubMenu: (x) => { m.subs.push(x); return m; },
      addToUi: () => { ui.menu = m; } }; return m; } };
  sim.M.globals.SpreadsheetApp.getUi = () => ui;
  call('onOpen()');
  assert.equal(ui.menu.name, 'Payment Master');
  assert.deepEqual(ui.menu.subs.map((m) => [m.name, m.items.map((i) => i[0])]), [
    ['Sync', ['Run Full Sync', 'Verify Health', 'Sync Seller Sheets']],
    ['Payouts', ['New Payout', 'Refresh Operations', 'Mark Selected SENT', 'Mark Selected CONFIRMED', 'Cancel Selected DRAFT', 'Reverse Selected Payout', 'Verify Seller Payouts']],
    ['Sellers', ['Create Seller Sheet', 'Sync Seller Sheets', 'Verify Seller Sheets']],
    ['View', ['Operator View', 'Technical View']]]);
  const advanced = ui.menu.subs.find((m) => m.name === 'Payouts').subs.find((m) => m.name === 'Advanced');
  assert.deepEqual(advanced.items.map((i) => i[0]), ['Create Draft from Operations Form', 'New Payout Request (reset form)']);
  ui.menu.subs.concat([advanced]).forEach((m) => m.items.forEach(([, fn]) => assert.equal(typeof sim.ctx[fn], 'function', fn)));
  const d = draft('CUS001', 100);
  sim.selectPayout(d.seller_payout_id);
  answer = 'NO';
  assert.equal(call('menuMarkSelectedPayoutSent()'), null, 'NO: nothing happens');
  assert.equal(payouts()[0].status, 'DRAFT');
  answer = 'YES';
  assert.equal(js(call('menuMarkSelectedPayoutSent()')).status, 'SUCCESS');
  sim.selectPayout(d.seller_payout_id);
  promptText = '   ';
  assert.equal(call('menuReverseSelectedPayout()'), null);
  assert.match(alerts[alerts.length - 1][1], /A reason is required; nothing changed/);
  assert.equal(payouts()[0].status, 'SENT');
  assert.ok(alerts.every(([, m]) => !m.includes(sim.MASTER_ID) && !m.includes(sim.TEMPLATE_ID)), 'IDs never shown');
  delete sim.M.globals.SpreadsheetApp.getUi;
});

// ------------------------------------------------------------------ 2O.1: token lifecycle on a partial DRAFT creation
test('2O.1: FIFO fails after the DRAFT row exists -> FAILED, 1 DRAFT, token kept; retries reuse it; token rotates only after full allocation', () => {
  const realFifo = sim.ctx.runSellerPayoutFifo_;
  let fifoCalls = 0;
  sim.ctx.runSellerPayoutFifo_ = (id) => { fifoCalls++; return { status: 'FAILED', seller_payout_id: id, error: 'simulated FIFO failure', rows: [] }; };
  try {
    const before = sim.audit().length;
    const token = sim.token();
    const r = draft('CUS001', 500);
    assert.equal(r.status, 'FAILED');
    assert.deepEqual([r.draft_created, r.draft_created_now, r.payout_status, r.allocation_status, r.allocated_amount], [true, true, 'DRAFT', 'NONE', 0]);
    assert.match(r.error, /DRAFT SP-OPS-[0-9A-F]+ was created but is not fully allocated \(0 of 500\): simulated FIFO failure/);
    assert.deepEqual(payouts().map((p) => [p.seller_payout_id, p.status]), [[r.seller_payout_id, 'DRAFT']]);
    assert.equal(sim.token(), token, 'final render kept the token');
    assert.equal(sim.formValue('amount'), 500, 'form kept for the retry');
    // audit: DRAFT_CREATED (PENDING) then OPERATION_FAILED with the partial-creation facts
    const rows = sim.audit().slice(before);
    const createdRows = rows.filter((x) => x.action === 'SELLER_PAYOUT_DRAFT_CREATED');
    assert.equal(createdRows.length, 1);
    assert.equal(JSON.parse(createdRows[0].details).allocation_status, 'PENDING');
    const failed = rows.filter((x) => x.action === 'SELLER_PAYOUT_OPERATION_FAILED');
    assert.equal(failed.length, 1);
    const fd = JSON.parse(failed[0].details);
    assert.deepEqual([fd.draft_created, fd.seller_payout_id, fd.payout_status, fd.fifo_error, fd.allocated_amount],
      [true, r.seller_payout_id, 'DRAFT', 'simulated FIFO failure', 0]);
    assert.match(fd.required_action, /same request token\) to retry this DRAFT/);
    // repeated failed retries: same payout, no extra DRAFT, no second DRAFT_CREATED, token kept
    for (let i = 0; i < 3; i++) {
      const again = run('createDraftSellerPayoutFromOperations()');
      assert.equal(again.status, 'FAILED');
      assert.equal(again.seller_payout_id, r.seller_payout_id);
      assert.deepEqual([again.draft_created, again.draft_created_now, again.request], [true, false, 'RETRY']);
      assert.match(again.error, / exists but is not fully allocated/);
    }
    assert.equal(payouts().length, 1);
    assert.equal(sim.token(), token);
    assert.equal(fifoCalls, 4);
    assert.equal(sim.audit().slice(before).filter((x) => x.action === 'SELLER_PAYOUT_DRAFT_CREATED').length, 1);
    // an incomplete request cannot be reset away
    const reset = run('newOperationsPayoutRequest()');
    assert.equal(reset.status, 'FAILED');
    assert.match(reset.error, /not fully allocated .* the request token was kept/);
    assert.equal(sim.token(), token);
    // the DRAFT cannot be marked SENT meanwhile
    assert.match(sent(r.seller_payout_id).error, /not fully allocated \(0 of 500\)/);
    // FIFO works again: the same click completes the same payout, then (only then) the token rotates
    sim.ctx.runSellerPayoutFifo_ = realFifo;
    const ok = run('createDraftSellerPayoutFromOperations()');
    assert.equal(ok.status, 'SUCCESS', ok.error);
    assert.deepEqual([ok.seller_payout_id, ok.request, ok.allocation_status, ok.draft_created_now], [r.seller_payout_id, 'RETRY', 'FULL', false]);
    assert.equal(payouts().length, 1);
    assert.ok(near(allocations().reduce((a, x) => a + x.allocated_amount, 0), 500));
    assert.notEqual(sim.token(), token, 'rotated after full allocation');
    assert.equal(sim.formValue('amount'), '');
    assert.equal(sim.audit().slice(before).filter((x) => x.action === 'SELLER_PAYOUT_DRAFT_CREATED').length, 1, 'no second DRAFT_CREATED for the retry');
    // refresh never rotates a non-blank token
    const t2 = sim.token();
    run('refreshOperations()');
    assert.equal(sim.token(), t2);
  } finally {
    sim.ctx.runSellerPayoutFifo_ = realFifo;
  }
});

test('2O.1: same token with different notes is a different request: rejected, payout untouched, token kept', () => {
  const token = sim.token();
  const r = draft('CUS002', 300, { notes: 'first request' });
  assert.equal(r.status, 'SUCCESS');
  mS('Operations').api.getRange(call('OPERATIONS.tokenRow'), 2).setValue(token); // replay of the completed request's token
  const snapshot = JSON.stringify([payouts(), allocations()]);
  const other = draft('CUS002', 300, { notes: 'second request' });
  assert.equal(other.status, 'FAILED');
  assert.match(other.error, /Request token already used by Seller Payout .* with other values; nothing changed/);
  assert.equal(JSON.stringify([payouts(), allocations()]), snapshot);
  assert.equal(sim.token(), token, 'kept until an explicit New Payout Request');
  const same = draft('CUS002', 300, { notes: 'first request' });
  assert.equal(same.status, 'NO_CHANGE', same.error);
  assert.notEqual(sim.token(), token, 'a completed same request may rotate');
  // explicit reset of a complete / unused request rotates the token
  const t3 = sim.token();
  assert.equal(run('newOperationsPayoutRequest()').status, 'SUCCESS');
  assert.notEqual(sim.token(), t3);
  assert.equal(payouts().length, 1);
});
