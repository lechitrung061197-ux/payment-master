// Phase 2P.2: payout hardening - future payout dates, payment proof before SENT, bounded CONFIRMED lists, runtime
// invariants instead of "0 payout" snapshots, cross-currency consistency. Production-shaped simulation; fake data.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildMasterSim, zonedMidnight } = require('./helpers/masterSim');

const sim = buildMasterSim();
const { call, mS } = sim;
const js = (v) => JSON.parse(JSON.stringify(v));
const near = (a, b) => Math.abs(a - b) < 1e-6;
const fn = (name, ...args) => js(call(name)(...args));
const payouts = () => sim.rows('Seller Payouts');
const allocations = () => sim.rows('Seller Payout Allocations');
const balance = (id) => sim.balances()[id];
let token;
function payload(seller, amount, extra) {
  return Object.assign({ token, seller_id: seller, currency: 'USD', payout_date: '12/10/2026', amount, payout_currency: '', fx_rate: '', payout_amount: '',
    payment_method: 'Bank transfer', reference: 'REF-' + seller + '-' + amount, notes: '' }, extra || {});
}
function create(seller, amount, extra) {
  token = fn('payoutModalBootstrap').token;
  return fn('payoutModalCreateDraft', payload(seller, amount, extra));
}
const act = (p, action, reason) => fn('payoutModalTransition', p.seller_payout_id, action, p.status, reason || '');
const view = (id) => fn('payoutModalPayout', id).payout;
/** Runs fn with the server clock fixed at an instant (the Master date is derived from it in America/New_York). */
function atClock(iso, f) {
  const real = vm.runInContext('Date', sim.ctx);
  vm.runInContext(`Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(${Date.parse(iso)}); } static now() { return ${Date.parse(iso)}; } };`, sim.ctx);
  try { return f(); } finally { sim.ctx.Date = real; }
}
function setPayoutCell(id, column, value) {
  const cols = call('getColumnNames_("Seller Payouts")');
  const row = payouts().findIndex((p) => p.seller_payout_id === id) + 2;
  mS('Seller Payouts').api.getRange(row, cols.indexOf(column) + 1).setValue(value);
}
/** Appends canonical payout + allocation rows directly (to build history quickly), then rebuilds Seller Balances. */
function writeLedger(rows) {
  const pc = call('getColumnNames_("Seller Payouts")');
  const ac = call('getColumnNames_("Seller Payout Allocations")');
  rows.forEach((r) => {
    const ps = mS('Seller Payouts').api;
    ps.getRange(ps.getLastRow() + 1, 1, 1, pc.length).setValues([pc.map((c) => ({ seller_payout_id: r.id, seller_id: r.seller, payout_date: zonedMidnight(r.date, 'America/New_York'),
      currency: 'USD', amount: r.amount, fx_rate: 1, payout_currency: 'USD', payout_amount: r.amount, payment_method: r.method || 'Bank', reference: r.reference || r.id,
      status: r.status, notes: '' })[c] ?? '')]);
    r.allocs.forEach(([target, amt]) => {
      const as = mS('Seller Payout Allocations').api;
      as.getRange(as.getLastRow() + 1, 1, 1, ac.length).setValues([ac.map((c) => ({ allocation_id: call('sellerAllocationId_')(r.id, 'SETTLEMENT', target), seller_payout_id: r.id,
        seller_id: r.seller, target_type: 'SETTLEMENT', target_id: target, payment_source: 'PAYPAL', currency: 'USD', allocated_amount: amt, created_at: new Date(), notes: '' })[c] ?? '')]);
    });
  });
  const n = js(call('normalizeSellerBalances()'));
  assert.ok(['SUCCESS', 'NO_CHANGE'].includes(n.status), n.error);
}
const settlementsOf = (seller) => js(call('verifySellerPayoutAllocations()')).obligation_states.filter((s) => s.seller_id === seller);

test.beforeEach(() => sim.restore());

// ------------------------------------------------------------------ 1. future payout date
test('future DRAFT can be created; DRAFT -> SENT is rejected until the Master (New York) date reaches the payout date', () => {
  atClock('2026-10-13T02:30:00Z', () => { // 12/10 22:30 New York (13/10 already in Vietnam)
    const d = create('CUS001', 100, { payout_date: '13/10/2026' });
    assert.equal(d.status, 'SUCCESS', d.error);
    assert.equal(d.payout.payout_date, '13/10/2026');
    const s = act(d.payout, 'SEND');
    assert.equal(s.status, 'FAILED');
    assert.match(s.error, /Payout date 13\/10\/2026 is in the future \(Master today 12\/10\/2026, America\/New_York\); it cannot be marked SENT before that date/);
    assert.equal(payouts()[0].status, 'DRAFT');
    assert.ok(near(balance('CUS001').current_balance, 1919.3986), 'no balance change');
    // the Operations selected-row path enforces the same guard
    sim.selectPayout(d.seller_payout_id);
    assert.match(js(call('markSelectedSellerPayoutSent()')).error, /is in the future/);
  });
  atClock('2026-10-13T04:30:00Z', () => { // 13/10 00:30 New York: the date is reached
    const p = view(payouts()[0].seller_payout_id);
    const s = act(p, 'SEND');
    assert.equal(s.status, 'SUCCESS', s.error);
    assert.ok(near(balance('CUS001').current_balance, 1819.3986));
    const c = act(s.payout, 'CONFIRM');
    assert.equal(c.status, 'SUCCESS', c.error);
    assert.ok(near(balance('CUS001').current_balance, 1819.3986) && near(balance('CUS001').paid_amount, 100), 'CONFIRMED: no double deduction');
  });
});

// ------------------------------------------------------------------ 2. payment proof
test('payment proof: a DRAFT may be prepared without method / reference; SEND requires both (backend authority)', () => {
  const d = create('CUS001', 100, { payment_method: '', reference: '' });
  assert.equal(d.status, 'SUCCESS', d.error);
  assert.equal(d.payout.needs_proof, true);
  let s = act(d.payout, 'SEND');
  assert.equal(s.status, 'FAILED');
  assert.match(s.error, /payment_method is required to mark it SENT.*reference is required to mark it SENT/);
  setPayoutCell(d.seller_payout_id, 'payment_method', 'Bank');
  s = act(view(d.seller_payout_id), 'SEND');
  assert.match(s.error, /reference is required to mark it SENT/);
  assert.ok(!/payment_method is required/.test(s.error));
  assert.ok(near(balance('CUS001').current_balance, 1919.3986));
  // the guarded proof action (DRAFT only) completes it, then SEND works
  const proof = fn('payoutModalSetPaymentProof', d.seller_payout_id, 'DRAFT', 'Bank transfer', 'VCB-0001');
  assert.equal(proof.status, 'SUCCESS', proof.error);
  assert.deepEqual([proof.payout.payment_method, proof.payout.reference, proof.payout.needs_proof], ['Bank transfer', 'VCB-0001', false]);
  assert.ok(sim.audit().some((a) => a.action === 'SELLER_PAYOUT_PROOF_UPDATED'));
  s = act(proof.payout, 'SEND');
  assert.equal(s.status, 'SUCCESS', s.error);
  assert.match(fn('payoutModalSetPaymentProof', d.seller_payout_id, 'SENT', 'Bank', 'X').error, /only a DRAFT's payment proof can be set/);
  assert.match(fn('payoutModalSetPaymentProof', d.seller_payout_id, 'DRAFT', 'Bank', 'X').error, /only a DRAFT/);
});

test('payment proof: duplicate method + reference rejected (create, set proof, SEND); CANCELLED may be reused; REVERSED may not', () => {
  const a = create('CUS001', 100, { payment_method: 'Bank transfer', reference: 'VCB-777' });
  assert.equal(a.status, 'SUCCESS');
  const dup = create('CUS004', 100, { payment_method: ' bank  TRANSFER ', reference: 'vcb-777 ' });
  assert.equal(dup.status, 'FAILED');
  assert.match(dup.error, /"bank  TRANSFER \/ vcb-777" is already used by SP-OPS-[0-9A-F]+ \(DRAFT\)|already used by/);
  const b = create('CUS004', 100, { payment_method: '', reference: '' });
  assert.match(fn('payoutModalSetPaymentProof', b.seller_payout_id, 'DRAFT', 'Bank transfer', 'VCB-777').error, /already used by/);
  setPayoutCell(b.seller_payout_id, 'payment_method', 'Bank transfer'); // typed directly into Seller Payouts
  setPayoutCell(b.seller_payout_id, 'reference', 'VCB-777');
  const s = act(view(b.seller_payout_id), 'SEND');
  assert.equal(s.status, 'FAILED');
  assert.match(s.error, /is already used by SP-OPS-[0-9A-F]+ \(DRAFT\)/);
  assert.equal(balance('CUS004').paid_amount, 0);
  // once the other DRAFT no longer carries it, the payout's own reference is not a duplicate of itself
  setPayoutCell(b.seller_payout_id, 'reference', '');
  assert.equal(act(view(a.seller_payout_id), 'SEND').status, 'SUCCESS');
  // CANCELLED releases the reference
  const c = create('CUS003', 50, { payment_method: 'Wise', reference: 'W-1' });
  assert.equal(act(c.payout, 'CANCEL').status, 'SUCCESS');
  const reuse = create('CUS003', 50, { payment_method: 'Wise', reference: 'W-1', notes: 'second try' });
  assert.equal(reuse.status, 'SUCCESS', reuse.error);
  // REVERSED keeps it
  const sentA = view(a.seller_payout_id);
  assert.equal(act(sentA, 'REVERSE', 'returned').status, 'SUCCESS');
  const afterReverse = create('CUS004', 100, { payment_method: 'Bank transfer', reference: 'VCB-777' });
  assert.equal(afterReverse.status, 'FAILED');
  assert.match(afterReverse.error, /already used by SP-OPS-[0-9A-F]+ \(REVERSED\)/);
});

// ------------------------------------------------------------------ 3. bounded CONFIRMED lists
test('open list = every DRAFT / SENT (never dropped); CONFIRMED capped at the 20 most recent, still reversible', () => {
  const target = settlementsOf('CUS004').sort((x, y) => y.due_amount - x.due_amount)[0].target_id;
  const rows = [];
  for (let i = 0; i < 25; i++) {
    rows.push({ id: 'SP-HIST-' + String(i).padStart(2, '0'), seller: 'CUS004', amount: 10, status: 'CONFIRMED', date: '2026-10-' + String(10 + (i % 3)).padStart(2, '0'),
      reference: 'H-' + i, allocs: [[target, 10]] });
  }
  rows.push({ id: 'SP-OLD-SENT', seller: 'CUS004', amount: 5, status: 'SENT', date: '2026-10-10', reference: 'OLD-S', allocs: [[target, 5]] });
  writeLedger(rows);
  const old = create('CUS004', 5, { payout_date: '10/10/2026', reference: 'OLD-D' }); // an old DRAFT
  assert.equal(old.status, 'SUCCESS', old.error);
  const b = fn('payoutModalBootstrap');
  assert.equal(b.lists.recent_confirmed.length, 20);
  assert.ok(b.lists.recent_confirmed.every((p) => p.status === 'CONFIRMED' && p.actions.join() === 'REVERSE'));
  assert.deepEqual(b.lists.open_payouts.map((p) => p.seller_payout_id).sort(), [old.seller_payout_id, 'SP-OLD-SENT'].sort(), 'DRAFT / SENT never dropped');
  const newest = b.lists.recent_confirmed.map((p) => p.payout_date);
  assert.deepEqual(newest.slice(0, 1), ['12/10/2026']);
  // Operations table: every DRAFT / SENT + at most 20 closed
  const ops = mS('Operations').api;
  const colA = ops.getRange(1, 1, ops.getLastRow(), 1).getValues().map((r) => r[0]);
  const t = call('locateOperationsPayoutTable_')(colA.slice(31), 32);
  const shown = ops.getRange(t.first, 1, t.last - t.first + 1, 12).getValues();
  assert.equal(shown.filter((r) => ['DRAFT', 'SENT'].includes(r[9])).length, 2);
  assert.equal(shown.filter((r) => !['DRAFT', 'SENT'].includes(r[9])).length, 20);
  // a listed CONFIRMED can still be reversed
  const r = act(b.lists.recent_confirmed[0], 'REVERSE', 'audit correction');
  assert.equal(r.status, 'SUCCESS', r.error);
  assert.equal(r.payout.status, 'REVERSED');
});

// ------------------------------------------------------------------ 5. cross-currency consistency
test('cross currency: payout_amount = amount × fx (fx = payout units per 1 USD); inconsistent values rejected in Preview and Create', () => {
  const ok = { payout_currency: 'VND', fx_rate: 25300, payout_amount: 2530000 };
  assert.equal(fn('payoutModalPreview', payload('CUS001', 100, ok)).status, 'READY');
  assert.equal(fn('payoutModalPreview', payload('CUS001', 100.1234, { payout_currency: 'VND', fx_rate: 25300, payout_amount: 2533122.02 })).status, 'READY',
    'rounding within max(0.01, 1e-6 relative)');
  for (const bad of [{ payout_amount: 2500000 }, { payout_amount: 2530010 }, { fx_rate: 26000 }]) {
    const p = Object.assign({}, ok, bad);
    const pv = fn('payoutModalPreview', payload('CUS001', 100, p));
    assert.equal(pv.status, 'FAILED', JSON.stringify(bad));
    assert.match(pv.error, /must equal Amount × FX Rate = 100 × \d+ = \d+ VND \(± [\d.]+; FX = VND per 1 USD\)/);
    assert.equal(create('CUS001', 100, p).status, 'FAILED');
  }
  assert.equal(payouts().length, 0);
  const c = create('CUS001', 100, ok);
  assert.equal(c.status, 'SUCCESS', c.error);
  assert.deepEqual([c.payout.payout_currency, c.payout.fx_rate, c.payout.payout_amount], ['VND', 25300, 2530000]);
  // an inconsistent cross-currency row typed into Seller Payouts cannot be SENT
  setPayoutCell(c.seller_payout_id, 'payout_amount', 2000000);
  assert.match(act(view(c.seller_payout_id), 'SEND').error, /must equal Amount × FX Rate/);
  setPayoutCell(c.seller_payout_id, 'payout_amount', 2530000);
  assert.equal(act(view(c.seller_payout_id), 'SEND').status, 'SUCCESS');
  // same currency unchanged: fx 1, payout amount = amount; fx != 1 rejected
  const same = create('CUS002', 100);
  assert.deepEqual([same.payout.payout_currency, same.payout.fx_rate, same.payout.payout_amount], ['USD', 1, 100]);
  assert.match(create('CUS002', 100, { fx_rate: 1.01 }).error, /Same-currency payout: FX Rate must be 1 or blank/);
});

// ------------------------------------------------------------------ 4. runtime invariants
test('runtime invariant reports pass after a legitimate payout (no "0 payout" snapshot left at runtime)', () => {
  const d = create('CUS001', 1919.3986);
  assert.equal(act(d.payout, 'SEND').status, 'SUCCESS');
  const balances = js(call('verifySellerBalances()'));
  assert.equal(balances.pass, true, balances.errors.join());
  assert.equal(balances.regression.pass, true, JSON.stringify(balances.regression.failed));
  const alloc = js(call('verifySellerPayoutAllocations()'));
  assert.equal(alloc.pass, true, alloc.errors.join());
  assert.equal(alloc.regression.pass, true, JSON.stringify(alloc.regression.failed));
  const sheets = js(call('verifySellerSheets()'));
  assert.equal(sheets.pass, true, sheets.errors.join());
  assert.equal(sheets.regression.pass, true, JSON.stringify(sheets.regression.failed));
  assert.equal(js(call('verifyPaymentPipelineHealth()')).pass, true);
  const src = require('node:fs').readdirSync(require('node:path').join(__dirname, '..', 'src')).filter((f) => f.endsWith('.gs'))
    .map((f) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', f), 'utf8')).join('\n');
  assert.ok(!/SELLER_BALANCES_REGRESSION|SELLER_ALLOCATIONS_REGRESSION|SELLER_SHEETS_REGRESSION/.test(src), 'payout-dependent snapshots removed from runtime');
});

// ------------------------------------------------------------------ production-shaped regression (CUS002 payout CONFIRMED)
// The simulation splits CUS002 between the two settlements differently from production; the exact production split
// (2132.2706 -> #1, 905.1734 -> #2) is asserted on the production fixture in sellerPayoutAllocations.test.js (test 19).
test('production state: CUS002 SP-OPS-0C99D9F9B016F5A6 CONFIRMED 3037.444 fully allocated to its two settlements - all numbers and reports hold', () => {
  const st = settlementsOf('CUS002');
  const byNumber = Object.fromEntries(st.map((s) => [s.source_settlement_number, s.target_id]));
  const due = Object.fromEntries(st.map((s) => [s.source_settlement_number, s.due_amount]));
  assert.ok(near(due[1] + due[2], 3037.444));
  writeLedger([{ id: 'SP-OPS-0C99D9F9B016F5A6', seller: 'CUS002', amount: 3037.444, status: 'CONFIRMED', date: '2026-10-13', reference: 'PROD-REF',
    allocs: [[byNumber[1], due[1]], [byNumber[2], due[2]]] }]);
  const p = js(call('runScheduledPaymentPipeline()'));
  assert.equal(p.status, 'SUCCESS', p.error);
  assert.equal(sim.rows('Settlement Items').length, 168);
  const b = sim.rows('Seller Balances');
  const sum = (f) => Math.round(b.reduce((a, x) => a + x[f] * 1e6, 0)) / 1e6;
  assert.deepEqual([sum('settled_amount'), sum('seller_hold_balance'), sum('current_balance')], [8370.0516, 1020.738, 5332.6076]);
  assert.ok(near(balance('CUS002').paid_amount, 3037.444) && near(balance('CUS002').current_balance, 0));
  const states = js(call('verifySellerPayoutAllocations()')).obligation_states;
  assert.equal(states.filter((s) => s.payment_status !== 'PAID').length, 5);
  assert.deepEqual(states.filter((s) => s.seller_id === 'CUS002').map((s) => s.payment_status), ['PAID', 'PAID']);
  assert.deepEqual(payouts().map((x) => [x.seller_payout_id, x.status]), [['SP-OPS-0C99D9F9B016F5A6', 'CONFIRMED']]);
  assert.deepEqual(allocations().map((a) => [a.target_id, a.allocated_amount]), [[byNumber[1], due[1]], [byNumber[2], due[2]]]);
  ['verifySellerBalances()', 'verifySellerPayoutAllocations()', 'verifySellerSheets()'].forEach((f) => {
    const r = js(call(f));
    assert.equal(r.pass, true, f + ' ' + r.errors.join());
    assert.equal(r.regression.pass, true, f + ' regression ' + JSON.stringify(r.regression.failed));
  });
  assert.equal(js(call('verifyPaymentPipelineHealth()')).pass, true);
  // the CONFIRMED production payout stays reversible from the modal (not dropped by the bounded list)
  assert.deepEqual(fn('payoutModalBootstrap').lists.recent_confirmed.map((x) => [x.seller_payout_id, x.actions]), [['SP-OPS-0C99D9F9B016F5A6', ['REVERSE']]]);
  assert.deepEqual([call('APP.SCHEMA_VERSION'), call('SELLER_OUTPUT.schemaVersion')], [18, 4]);
});
