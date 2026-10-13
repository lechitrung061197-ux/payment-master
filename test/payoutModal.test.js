// Phase 2P: the "New Payout" modal (HtmlService) is a UI over the guarded Operations workflow. Server endpoints are
// tested on the production-shaped Master simulation; the HTML is checked statically (no client-side accounting,
// dates or writes). Fake data.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildMasterSim } = require('./helpers/masterSim');

const sim = buildMasterSim();
const { call, mS } = sim;
const js = (v) => JSON.parse(JSON.stringify(v));
const near = (a, b) => Math.abs(a - b) < 1e-6;
const SRC = path.join(__dirname, '..', 'src');
const fn = (name, ...args) => js(call(name)(...args));
const payouts = () => sim.rows('Seller Payouts');
const allocations = () => sim.rows('Seller Payout Allocations');
let token;
function payload(seller, amount, extra) {
  return Object.assign({ token, seller_id: seller, currency: 'USD', payout_date: '12/10/2026', amount: amount, payout_currency: '', fx_rate: '',
    payout_amount: '', payment_method: 'Bank transfer', reference: 'MODAL-' + seller, notes: '' }, extra || {});
}
const create = (seller, amount, extra) => fn('payoutModalCreateDraft', payload(seller, amount, extra));
const act = (p, action, reason) => fn('payoutModalTransition', p.seller_payout_id, action, p.status, reason || '');
function childStatuses(seller) {
  const phieu = sim.child(seller).sheets.find((s) => s.name === 'PhieuDoiSoat');
  return Object.entries(phieu.cells).map(([k, c]) => [k.split(',').map(Number), c && c.v]).filter(([, v]) => typeof v === 'string' && /^PAYPAL #\d+ · /.test(v))
    .sort((a, b) => a[0][0] - b[0][0]).map(([, v]) => v.split(' · ')[1]);
}
function setSellerStatus(id, status) {
  const a = mS('Sellers').api;
  const cols = call('getColumnNames_("Sellers")');
  const ids = a.getRange(2, 1, a.getLastRow() - 1, 1).getValues().map((r) => r[0]);
  a.getRange(2 + ids.indexOf(id), cols.indexOf('status') + 1).setValue(status);
}

test.beforeEach(() => { sim.restore(); token = fn('payoutModalBootstrap').token; });

test('1: bootstrap lists only ACTIVE sellers, the New York date, a request token and active payouts', () => {
  setSellerStatus('CUS003', 'INACTIVE');
  const b = fn('payoutModalBootstrap');
  assert.equal(b.status, 'SUCCESS');
  assert.deepEqual(b.sellers.map((s) => s.seller_id), ['CUS001', 'CUS002', 'CUS004']);
  assert.equal(b.master_timezone, 'America/New_York');
  assert.match(b.token, /\S/);
  assert.notEqual(b.token, fn('payoutModalBootstrap').token, 'a new request each time the modal opens');
  assert.deepEqual(b.active_payouts, []);
});

test('2 + 3 + 4: seller selection returns the canonical balance and FIFO obligations; one currency is auto-selected; Pay Full = available_to_draft', () => {
  const r = fn('payoutModalSeller', 'CUS001');
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.default_currency, 'USD', 'single currency auto-selected');
  const l = r.lines[0];
  const b = sim.balances().CUS001;
  assert.deepEqual([l.seller_id, l.seller_name, l.currency, l.current_balance, l.seller_hold_balance, l.draft_reserved, l.open_obligations, l.effective_paid, l.payment_state],
    ['CUS001', 'DITECH', 'USD', b.current_balance, b.seller_hold_balance, 0, 2, 0, 'UNPAID']);
  assert.ok(near(l.available_to_draft, 1919.3986), 'Pay Full fills available_to_draft');
  const canonical = js(call('verifySellerPayoutAllocations()')).obligation_states.filter((s) => s.seller_id === 'CUS001');
  assert.deepEqual(r.obligations.USD.map((o) => [o.target_id, o.due_amount, o.paid_amount, o.remaining_amount, o.payment_status]),
    canonical.map((s) => [s.target_id, s.due_amount, s.paid_amount, s.remaining_amount, s.payment_status]), 'same obligations, FIFO order');
  assert.match(r.obligations.USD[0].date, /^\d{2}\/\d{2}\/\d{4}$/);
  // after a DRAFT the available amount shrinks and the claim is shown
  assert.equal(create('CUS001', 500).status, 'SUCCESS');
  const r2 = fn('payoutModalSeller', 'CUS001');
  assert.ok(near(r2.lines[0].draft_reserved, 500) && near(r2.lines[0].available_to_draft, 1419.3986));
  assert.ok(near(r2.obligations.USD[0].draft_claimed, 500));
  assert.equal(r2.active_payouts.length, 1);
});

test('5: the FIFO preview equals the allocation Create Draft then writes (same canonical plan), and writes nothing', () => {
  const ob = fn('payoutModalSeller', 'CUS001').obligations.USD;
  const amount = Math.round((ob[0].remaining_amount + 200) * 1e4) / 1e4;
  const before = JSON.stringify([payouts(), allocations(), sim.audit().length]);
  const pv = fn('payoutModalPreview', payload('CUS001', amount));
  assert.equal(pv.status, 'READY', pv.error);
  assert.equal(JSON.stringify([payouts(), allocations(), sim.audit().length]), before, 'preview writes nothing');
  assert.deepEqual(pv.preview.map((x) => [x.target_id, x.status_after]), [[ob[0].target_id, 'PAID'], [ob[1].target_id, 'PARTIAL']]);
  assert.ok(near(pv.preview[1].allocated_amount, 200) && near(pv.preview[1].remaining_after, ob[1].remaining_amount - 200));
  const c = create('CUS001', amount);
  assert.equal(c.status, 'SUCCESS', c.error);
  assert.deepEqual(allocations().map((a) => [a.target_type, a.target_id, Math.round(a.allocated_amount * 1e4)]),
    pv.allocations.map((a) => [a.target_type, a.target_id, Math.round(a.allocated_amount * 1e4)]));
});

test('6: the payout date default is the New York date, never the browser / Vietnam date', () => {
  const FIXED = Date.parse('2026-10-13T02:30:00Z'); // 12/10 22:30 New York, 13/10 09:30 Ho Chi Minh City
  const RealDate = vm.runInContext('Date', sim.ctx);
  vm.runInContext(`Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(${FIXED}); } static now() { return ${FIXED}; } };`, sim.ctx);
  try {
    const b = fn('payoutModalBootstrap');
    assert.equal(b.today, '12/10/2026');
    token = b.token;
    const c = create('CUS001', 10, { payout_date: b.today });
    assert.equal(c.status, 'SUCCESS', c.error);
    assert.equal(c.payout.payout_date, '12/10/2026');
    assert.equal(call('masterDateKey_')(payouts()[0].payout_date), '2026-10-12');
  } finally {
    sim.ctx.Date = RealDate;
  }
  const html = fs.readFileSync(path.join(SRC, 'PayoutModal.html'), 'utf8');
  assert.ok(!/new Date|Date\.now|getTimezoneOffset|toLocaleDateString|Intl\.DateTimeFormat/.test(html), 'the browser never computes dates');
});

test('7 + 8: Create Draft uses the shared guarded backend; same token = idempotent; double submit never duplicates', () => {
  const c = create('CUS002', 700);
  assert.equal(c.status, 'SUCCESS', c.error);
  assert.equal(c.seller_payout_id, call('operationsPayoutId_')(token), 'deterministic id from the request token');
  assert.deepEqual([c.channel, c.allocation_status, c.payout.status, c.payout.allocation_status, c.payout.actions], ['MODAL', 'FULL', 'DRAFT', 'FULL', ['SEND', 'CANCEL']]);
  assert.match(c.next_token, /\S/);
  assert.notEqual(c.next_token, token);
  const created = sim.audit().filter((a) => a.action === 'SELLER_PAYOUT_DRAFT_CREATED');
  assert.deepEqual(created.map((a) => JSON.parse(a.details).channel), ['MODAL']);
  assert.ok(sim.audit().some((a) => a.action === 'SELLER_PAYOUT_ALLOCATION_FIFO_SUCCESS'));
  // double submit with the same token (second click / network retry)
  const again = create('CUS002', 700);
  assert.equal(again.status, 'NO_CHANGE');
  assert.equal(again.seller_payout_id, c.seller_payout_id);
  // same token, other values -> rejected
  assert.match(create('CUS002', 701).error, /Request token already used/);
  // a concurrent submit while the lock is held exits safely
  sim.M.locks.documentBusy = true;
  assert.equal(create('CUS002', 700).status, 'SKIPPED_LOCKED');
  sim.M.locks.documentBusy = false;
  assert.equal(payouts().length, 1);
  assert.equal(sim.audit().filter((a) => a.action === 'SELLER_PAYOUT_DRAFT_CREATED').length, 1);
});

test('9 + 10 + 11: SEND reduces the balance once and syncs only the seller sheet; CONFIRM never deducts again; REVERSE rolls back', () => {
  const c = create('CUS001', 1919.3986);
  const logs4 = sim.child('CUS004').log.length;
  const s = act(c.payout, 'SEND');
  assert.equal(s.status, 'SUCCESS', s.error);
  assert.deepEqual([s.payout.status, s.payout.actions, s.health, s.ledger], ['SENT', ['CONFIRM', 'REVERSE'], 'PASS', 'VALID']);
  assert.match(s.seller_sheet, /^SUCCESS/);
  assert.ok(near(sim.balances().CUS001.current_balance, 0) && near(sim.balances().CUS001.paid_amount, 1919.3986));
  assert.deepEqual(fn('payoutModalSeller', 'CUS001').lines[0].payment_state, 'PAID');
  assert.deepEqual(childStatuses('CUS001'), ['PAID', 'PAID']);
  assert.equal(sim.child('CUS004').log.length, logs4, 'other seller sheets untouched');
  const k = act(s.payout, 'CONFIRM');
  assert.equal(k.status, 'SUCCESS', k.error);
  assert.deepEqual([k.payout.status, k.payout.actions], ['CONFIRMED', ['REVERSE']]);
  assert.ok(near(sim.balances().CUS001.current_balance, 0) && near(sim.balances().CUS001.paid_amount, 1919.3986), 'no double deduction');
  assert.match(act(k.payout, 'REVERSE', '').error, /A reason is required/);
  const r = act(k.payout, 'REVERSE', 'returned by bank');
  assert.equal(r.status, 'SUCCESS', r.error);
  assert.deepEqual([r.payout.status, r.payout.actions], ['REVERSED', []]);
  assert.ok(near(sim.balances().CUS001.current_balance, 1919.3986) && near(sim.balances().CUS001.paid_amount, 0));
  assert.deepEqual(childStatuses('CUS001'), ['UNPAID', 'UNPAID']);
  assert.deepEqual([payouts().length, allocations().length], [1, 2], 'nothing deleted');
});

test('12: invalid amounts fail closed (preview and create): 0, negative, text, above available_to_draft, blank', () => {
  for (const amount of [0, -5, 'abc', '1e3', 3037.4441, '']) {
    const pv = fn('payoutModalPreview', payload('CUS002', amount));
    assert.equal(pv.status, 'FAILED', 'preview ' + amount);
    const c = create('CUS002', amount);
    assert.equal(c.status, 'FAILED', 'create ' + amount);
  }
  assert.match(create('CUS002', 3037.4441).error, /available to draft 3037\.444/);
  assert.deepEqual([payouts().length, allocations().length], [0, 0]);
});

test('13: an INACTIVE seller cannot be loaded or paid', () => {
  setSellerStatus('CUS003', 'INACTIVE');
  assert.match(fn('payoutModalSeller', 'CUS003').error, /CUS003 is INACTIVE; only ACTIVE sellers can be paid/);
  assert.match(fn('payoutModalPreview', payload('CUS003', 10)).error, /only ACTIVE sellers/);
  assert.match(create('CUS003', 10).error, /only ACTIVE sellers/);
  assert.equal(payouts().length, 0);
});

test('14: stale browser data is recomputed / rejected by the backend', () => {
  const seen = fn('payoutModalSeller', 'CUS003').lines[0].available_to_draft; // 256.7666 shown in the modal
  token = fn('payoutModalBootstrap').token;
  assert.equal(create('CUS003', 200).status, 'SUCCESS'); // another DRAFT claims most of it meanwhile
  token = fn('payoutModalBootstrap').token;
  const stale = create('CUS003', seen);
  assert.equal(stale.status, 'FAILED');
  assert.match(stale.error, /available to draft 56\.7666/);
  // a stale status: the modal shows DRAFT but the payout was cancelled elsewhere
  const view = fn('payoutModalSeller', 'CUS003').active_payouts[0];
  assert.equal(view.status, 'DRAFT');
  assert.equal(act(view, 'CANCEL').status, 'SUCCESS');
  const again = act(view, 'SEND'); // still "DRAFT" in the browser
  assert.equal(again.status, 'FAILED');
  assert.equal(payouts()[0].status, 'CANCELLED');
  // the client can never send a status value or an unknown action
  for (const a of ['SENT', 'PAID', 'DELETE', 'RETRY_ALLOCATION', '']) {
    const r = fn('payoutModalTransition', view.seller_payout_id, a, 'CANCELLED', '');
    assert.equal(r.status, 'FAILED', a);
    assert.match(r.error, /Unknown action/);
  }
  assert.match(fn('payoutModalTransition', view.seller_payout_id, 'REVERSE', '', 'x').error, /current status is required/);
  assert.equal(payouts()[0].status, 'CANCELLED');
});

test('resume: an incomplete DRAFT (FIFO failed) is offered Retry Allocation + Cancel; retry completes it without a second payout', () => {
  const real = sim.ctx.runSellerPayoutFifo_;
  sim.ctx.runSellerPayoutFifo_ = (id) => ({ status: 'FAILED', seller_payout_id: id, error: 'simulated FIFO failure', rows: [] });
  let c;
  try {
    c = create('CUS004', 400);
  } finally {
    sim.ctx.runSellerPayoutFifo_ = real;
  }
  assert.equal(c.status, 'FAILED');
  assert.equal(c.draft_created, true);
  assert.equal(c.next_token, undefined, 'no new token: the same request can be retried');
  assert.deepEqual([c.payout.status, c.payout.allocation_status, c.payout.actions], ['DRAFT', 'NONE', ['RETRY_ALLOCATION', 'CANCEL']]);
  assert.match(act(c.payout, 'SEND').error, /not fully allocated/);
  // modal closed and reopened: the DRAFT is listed and resumable
  const reopened = fn('payoutModalBootstrap');
  assert.deepEqual(reopened.active_payouts.map((p) => [p.seller_payout_id, p.actions]), [[c.seller_payout_id, ['RETRY_ALLOCATION', 'CANCEL']]]);
  const r = fn('payoutModalRetryAllocation', c.seller_payout_id);
  assert.equal(r.status, 'SUCCESS', r.error);
  assert.deepEqual([r.payout.allocation_status, r.payout.actions], ['FULL', ['SEND', 'CANCEL']]);
  assert.equal(payouts().length, 1);
  assert.equal(fn('payoutModalRetryAllocation', c.seller_payout_id).status, 'NO_CHANGE');
});

test('15: the Operations form (Advanced) still works alongside the modal', () => {
  sim.setForm({ seller: 'CUS001 · DITECH', currency: 'USD', payout_date: '12/10/2026', amount: 100, payout_currency: '', fx_rate: '', payout_amount: '',
    payment_method: 'Bank', reference: 'FORM-1', notes: '' });
  const formToken = sim.token();
  const f = js(call('createDraftSellerPayoutFromOperations()'));
  assert.equal(f.status, 'SUCCESS', f.error);
  assert.equal(f.channel, 'OPERATIONS_FORM');
  assert.notEqual(sim.token(), formToken, 'form token rotated after success');
  assert.equal(create('CUS001', 100, { reference: 'MODAL-2' }).status, 'SUCCESS');
  assert.equal(payouts().length, 2);
  sim.selectPayout(f.seller_payout_id);
  assert.equal(js(call('markSelectedSellerPayoutSent()')).status, 'SUCCESS', 'selected-row actions still work');
});

test('16: accounting regression unchanged (no payout: 168 items, 8370.0516 / 1020.738, 7 UNPAID); the modal read paths write nothing', () => {
  const before = JSON.stringify(sim.M.MASTER.sheets.filter((s) => s.name !== 'Audit Log').map((s) => [s.name, s.cells]));
  fn('payoutModalBootstrap');
  ['CUS001', 'CUS002', 'CUS003', 'CUS004'].forEach((id) => fn('payoutModalSeller', id));
  fn('payoutModalPreview', payload('CUS002', 1000));
  fn('payoutModalPayout', 'SP-NONE');
  assert.equal(JSON.stringify(sim.M.MASTER.sheets.filter((s) => s.name !== 'Audit Log').map((s) => [s.name, s.cells])), before);
  const b = sim.rows('Seller Balances');
  assert.ok(near(b.reduce((a, x) => a + x.available_amount, 0), 8370.0516));
  assert.ok(near(b.reduce((a, x) => a + x.seller_hold_balance, 0), 1020.738));
  assert.equal(sim.rows('Settlement Items').length, 168);
  const states = js(call('verifySellerPayoutAllocations()')).obligation_states;
  assert.deepEqual([states.length, states.every((s) => s.payment_status === 'UNPAID')], [7, true]);
  assert.deepEqual([call('APP.SCHEMA_VERSION'), call('SELLER_OUTPUT.schemaVersion')], [18, 4]);
  assert.equal(js(call('runScheduledPaymentPipeline()')).status, 'SUCCESS');
});

test('HTML: a UI only - calls only the whitelisted endpoints, renders with textContent, no client accounting', () => {
  assert.equal(call('PAYOUT_MODAL.htmlFile'), 'src/PayoutModal');
  const html = fs.readFileSync(path.join(SRC, 'PayoutModal.html'), 'utf8');
  const called = [...html.matchAll(/call\('(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(called)].sort(), ['payoutModalBootstrap', 'payoutModalCreateDraft', 'payoutModalPayout', 'payoutModalPreview',
    'payoutModalRetryAllocation', 'payoutModalSeller', 'payoutModalTransition'].sort());
  called.forEach((n) => assert.equal(typeof sim.ctx[n], 'function', n));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html), 'no HTML injection sinks');
  assert.ok(!/setValue|getRange|Seller Payouts|status\s*:\s*'SENT'/.test(html), 'no direct sheet access / status payloads');
  assert.ok(/google\.script\.run/.test(html));
});
