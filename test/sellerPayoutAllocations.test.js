// Unit tests for Seller Payout Allocations (Phase 2L): obligations from frozen Settlement Items, allocation
// invariants, derived UNPAID / PARTIAL / PAID, FIFO for DRAFT payouts, and "allocations never reduce a balance".
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
const context = vm.createContext({ Utilities, Logger: { log: () => {} } });
for (const f of fs.readdirSync(path.join(__dirname, '..', 'src')).filter((f) => f.endsWith('.gs')).sort()) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), context, { filename: f });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const D = (iso) => vm.runInContext(`new Date(${JSON.stringify(iso)})`, context);
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ---- fixture: HUI (CUS002) and DITECH (CUS001) shares in PAYPAL #1 / #2 and STRIPE #1 ----------------------
const SETTLEMENTS = [
  { settlement_id: 'ST-P1', payment_source: 'PAYPAL', source_settlement_number: 1, period_start_date: D('2026-10-01T04:00:00Z'),
    period_end_date: D('2026-10-04T04:00:00Z'), source_payment_date: D('2026-10-06T04:00:00Z') },
  { settlement_id: 'ST-P2', payment_source: 'PAYPAL', source_settlement_number: 2, period_start_date: D('2026-10-05T04:00:00Z'),
    period_end_date: D('2026-10-09T04:00:00Z'), source_payment_date: D('2026-10-10T04:00:00Z') },
  { settlement_id: 'ST-S1', payment_source: 'STRIPE', source_settlement_number: 1, period_start_date: D('2026-10-01T04:00:00Z'),
    period_end_date: D('2026-10-08T04:00:00Z'), source_payment_date: D('2026-10-12T04:00:00Z') },
  { settlement_id: 'ST-EMPTY', payment_source: 'PAYPAL', source_settlement_number: 9, period_end_date: D('2026-10-20T04:00:00Z'),
    source_payment_date: D('2026-10-21T04:00:00Z') },
];
let n = 0;
const item = (seller, st, available, hold, source, currency) => ({ settlement_item_id: 'SI-' + (++n), settlement_id: st, seller_id: seller,
  payment_source: source || 'PAYPAL', currency: currency || 'USD', seller_available_amount: available, seller_hold_amount: hold || 0 });
const ITEMS = [item('CUS002', 'ST-P1', 600), item('CUS002', 'ST-P1', 400), item('CUS002', 'ST-P2', 800), item('CUS002', 'ST-S1', 300, 0, 'STRIPE'),
  item('CUS001', 'ST-P1', 500)];
const payout = (id, amount, status, o) => ({ seller_payout_id: id, seller_id: 'CUS002', currency: 'USD', amount, status, payout_date: D('2026-10-15T04:00:00Z'), ...o });
const alloc = (pid, st, amount, o) => ({ allocation_id: H.sellerAllocationId_(pid, st), seller_payout_id: pid, seller_id: 'CUS002', settlement_id: st,
  payment_source: st === 'ST-S1' ? 'STRIPE' : 'PAYPAL', currency: 'USD', allocated_amount: amount, ...o });
const validate = (allocations, payouts, items) => H.validateSellerPayoutAllocations_({ allocations, payouts, items: items || ITEMS, settlements: SETTLEMENTS });
const errs = (v) => js(H.flattenAllocationErrors_(v.errors)).join(' | ');
const state = (v, st, seller) => js(v.states).find((s) => s.settlement_id === st && s.seller_id === (seller || 'CUS002'));

test('allocation_id is deterministic: SPA-<sha256(seller_payout_id|settlement_id)>', () => {
  assert.equal(H.sellerAllocationId_('SP1', 'ST-P1'), 'SPA-' + sha('SP1|ST-P1'));
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 100, { allocation_id: 'SPA-x' })], [payout('SP1', 100, 'DRAFT')])), /allocation_id must be SPA-sha256/);
});

test('obligations come only from this seller\'s frozen Settlement Items; no payouts -> UNPAID with paid 0', () => {
  const v = validate([], []);
  assert.equal(errs(v), '');
  assert.deepEqual([state(v, 'ST-P1').due_amount, state(v, 'ST-P1').paid_amount, state(v, 'ST-P1').payment_status], [1000, 0, 'UNPAID']);
  assert.equal(state(v, 'ST-P1', 'CUS001').due_amount, 500, 'DITECH share of the same provider settlement is separate');
  assert.equal(js(v.states).find((s) => s.settlement_id === 'ST-EMPTY'), undefined, 'no items -> no obligation');
  assert.deepEqual(js(v.summary.payment_status_counts), { UNPAID: 4 });
});

test('1-4: full, partial, two payouts for one settlement, one payout across two settlements', () => {
  let v = validate([alloc('SP1', 'ST-P1', 1000)], [payout('SP1', 1000, 'CONFIRMED')]);
  assert.equal(errs(v), '');
  assert.deepEqual([state(v, 'ST-P1').paid_amount, state(v, 'ST-P1').remaining_amount, state(v, 'ST-P1').payment_status], [1000, 0, 'PAID']);
  v = validate([alloc('SP1', 'ST-P1', 400)], [payout('SP1', 400, 'SENT')]);
  assert.deepEqual([state(v, 'ST-P1').paid_amount, state(v, 'ST-P1').remaining_amount, state(v, 'ST-P1').payment_status], [400, 600, 'PARTIAL']);
  v = validate([alloc('A', 'ST-P1', 400), alloc('B', 'ST-P1', 600)], [payout('A', 400, 'SENT'), payout('B', 600, 'CONFIRMED')]);
  assert.equal(errs(v), '');
  assert.deepEqual([state(v, 'ST-P1').paid_amount, state(v, 'ST-P1').payment_status], [1000, 'PAID']);
  v = validate([alloc('SP1', 'ST-P1', 1000), alloc('SP1', 'ST-P2', 500)], [payout('SP1', 1500, 'SENT')]);
  assert.equal(errs(v), '');
  assert.equal(state(v, 'ST-P1').payment_status, 'PAID');
  assert.deepEqual([state(v, 'ST-P2').payment_status, state(v, 'ST-P2').remaining_amount], ['PARTIAL', 300]);
  assert.deepEqual(js(v.summary.per_seller_paid), { CUS001: 0, CUS002: 1500 });
});

test('5-6: DRAFT allocations are provisional (settlement stays UNPAID); VOID allocations are ignored', () => {
  let v = validate([alloc('SP1', 'ST-P1', 1000)], [payout('SP1', 1000, 'DRAFT')]);
  assert.equal(errs(v), '');
  assert.deepEqual([state(v, 'ST-P1').paid_amount, state(v, 'ST-P1').payment_status], [0, 'UNPAID']);
  assert.equal(v.summary.draft_allocation_rows, 1);
  v = validate([alloc('SP1', 'ST-P1', 5000), alloc('SP1', 'ST-NOPE', 1)], [payout('SP1', 10, 'VOID')]);
  assert.equal(errs(v), '', 'VOID payout allocations are ignored entirely');
  assert.deepEqual([state(v, 'ST-P1').payment_status, v.summary.void_allocation_rows], ['UNPAID', 2]);
  v = validate([alloc('SP1', 'ST-P1', 300)], [payout('SP1', 1000, 'DRAFT')]);
  assert.equal(errs(v), '', 'a DRAFT payout may be partially allocated');
});

test('7-9: effective payouts must be fully allocated; no over-allocation; no settlement over-payment', () => {
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 800)], [payout('SP1', 1000, 'SENT')])), /Seller Payout SP1 \(SENT\): allocated 800 of 1000/);
  assert.match(errs(validate([], [payout('SP1', 1000, 'CONFIRMED')])), /allocated 0 of 1000/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 1000), alloc('SP1', 'ST-P2', 100)], [payout('SP1', 1000, 'SENT')])), /allocated 1100 > payout amount 1000/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 1100)], [payout('SP1', 1000, 'DRAFT')])), /allocated 1100 > payout amount 1000/);
  assert.match(errs(validate([alloc('A', 'ST-P1', 700), alloc('B', 'ST-P1', 400)], [payout('A', 700, 'SENT'), payout('B', 400, 'SENT')])),
    /CUS002\|ST-P1\|USD: paid 1100 > due 1000/);
  assert.equal(errs(validate([alloc('SP1', 'ST-P1', 999.99996)], [payout('SP1', 1000, 'SENT')])), '', 'within the 0.00005 tolerance');
});

test('10-12: cross-seller, wrong currency / source, duplicates, unknown references and non-positive amounts fail', () => {
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 100, { seller_id: 'CUS001' })], [payout('SP1', 100, 'DRAFT')])), /is not the payout seller CUS002/);
  const ditechOnly = ITEMS.filter((i) => !(i.seller_id === 'CUS002' && i.settlement_id === 'ST-P1'));
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 100)], [payout('SP1', 100, 'DRAFT')], ditechOnly)), /has no share of seller CUS002 \(another seller's settlement share\)/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 100, { currency: 'EUR' })], [payout('SP1', 100, 'DRAFT')])), /currency EUR differs from the payout currency USD/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 100, { currency: 'EUR' })], [payout('SP1', 100, 'DRAFT', { currency: 'EUR' })])), /has no EUR obligation in ST-P1/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 100, { payment_source: 'STRIPE' })], [payout('SP1', 100, 'DRAFT')])), /payment_source STRIPE differs/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 50), alloc('SP1', 'ST-P1', 50)], [payout('SP1', 100, 'DRAFT')])), /duplicate seller_payout_id \+ settlement_id SP1\|ST-P1/);
  assert.match(errs(validate([alloc('SP9', 'ST-P1', 50)], [])), /unknown seller_payout_id SP9/);
  assert.match(errs(validate([alloc('SP1', 'ST-X', 50)], [payout('SP1', 100, 'DRAFT')])), /unknown settlement_id ST-X/);
  assert.match(errs(validate([alloc('SP1', 'ST-EMPTY', 50)], [payout('SP1', 100, 'DRAFT')])), /has no seller obligation \(no frozen Settlement Items\)/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 0)], [payout('SP1', 100, 'DRAFT')])), /allocated_amount must be a positive number/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', -5)], [payout('SP1', 100, 'DRAFT')])), /allocated_amount must be a positive number/);
});

// ---- FIFO ------------------------------------------------------------------------------------------------
const FIFO_ITEMS = [item('CUS002', 'ST-P1', 2132.2706, 260), item('CUS002', 'ST-P2', 905.1734, 110)];
const plan = (p, allocations, payouts) => {
  const all = payouts || [p];
  const v = H.validateSellerPayoutAllocations_({ allocations, payouts: all, items: FIFO_ITEMS, settlements: SETTLEMENTS });
  const byId = {};
  all.forEach((x) => { byId[x.seller_payout_id] = x; });
  return js(H.planFifoAllocation_(p, allocations, v, byId, D('2026-10-20T10:00:00Z')));
};

test('13: FIFO allocates the oldest obligation first: 2500 -> 2132.2706 + 367.7294 (remaining 537.444)', () => {
  const p = payout('SP1', 2500, 'DRAFT');
  const r = plan(p, []);
  assert.equal(r.status, 'SUCCESS');
  assert.deepEqual(r.rows.map((x) => [x.settlement_id, x.allocated_amount]), [['ST-P1', 2132.2706], ['ST-P2', 367.7294]]);
  assert.equal(r.rows[0].allocation_id, 'SPA-' + sha('SP1|ST-P1'));
  const effective = H.validateSellerPayoutAllocations_({ allocations: r.rows, payouts: [{ ...p, status: 'SENT' }], items: FIFO_ITEMS, settlements: SETTLEMENTS });
  assert.equal(errs(effective), '');
  assert.deepEqual([state(effective, 'ST-P1').payment_status, state(effective, 'ST-P2').payment_status], ['PAID', 'PARTIAL']);
  assert.ok(near(state(effective, 'ST-P2').remaining_amount, 537.444));
  const drafts = [p, payout('SP2', 537.444, 'DRAFT')];
  const second = plan(drafts[1], r.rows, drafts);
  assert.deepEqual(second.rows.map((x) => [x.settlement_id, x.allocated_amount]), [['ST-P2', 537.444]], 'other DRAFT claims are respected');
  assert.equal(plan(payout('SP3', 4000, 'DRAFT'), []).status, 'FAILED', 'never more than the open obligations');
  const tooMuch = plan(payout('SP4', 600, 'DRAFT'), r.rows, [p, payout('SP4', 600, 'DRAFT')]);
  assert.deepEqual([tooMuch.status, tooMuch.rows], ['FAILED', []], 'only 537.444 left after the other DRAFT claim');
});

test('14: FIFO never overwrites existing allocations of the payout (NO_CHANGE, operator review)', () => {
  const r = plan(payout('SP1', 2500, 'DRAFT'), [alloc('SP1', 'ST-P2', 100)]);
  assert.equal(r.status, 'NO_CHANGE');
  assert.match(r.error, /already has allocation rows; operator review required/);
  assert.deepEqual(r.rows, []);
});

// FIFO under the lock against an in-memory Master.
function fakeMaster(tables) {
  const sheets = {};
  Object.entries(tables).forEach(([name, rows]) => {
    const cols = js(H.getColumnNames_(name));
    const grid = [cols, ...rows.map((o) => cols.map((c) => (o[c] === undefined ? '' : o[c])))];
    sheets[name] = {
      grid,
      getName: () => name, getMaxRows: () => grid.length, getMaxColumns: () => cols.length,
      getLastRow: () => grid.length,
      insertRowsAfter: (_a, k) => { for (let i = 0; i < k; i++) grid.push(cols.map(() => '')); },
      getRange: (r, c, nr, nc) => ({
        getValues: () => grid.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)),
        setValues: (vals) => vals.forEach((row, i) => { grid[r - 1 + i] = row.slice(); }),
      }),
    };
  });
  return { getId: () => 'MASTER', getSheetByName: (nm) => sheets[nm] || null, sheets };
}
function installFifo(payouts, allocations, freshItems) {
  const m = fakeMaster({ 'Seller Payout Allocations': allocations || [], 'Seller Payouts': payouts, 'Settlement Items': FIFO_ITEMS, Settlements: SETTLEMENTS });
  const audit = [];
  Object.assign(context, {
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    getSpreadsheet_: () => m,
    appendAuditLog_: (e) => audit.push(e),
    detectSwapState_: () => ({ state: 'NORMAL' }),
    readSettlementItemsFreshness_: () => freshItems || { current: true, reason: null },
  });
  return { m, audit };
}

test('autoAllocateSellerPayoutFIFO: DRAFT only, writes rows only (payout untouched), idempotent, fails closed', () => {
  const p = payout('SP1', 2500, 'DRAFT');
  const { m, audit } = installFifo([p]);
  const payoutsBefore = JSON.stringify(m.sheets['Seller Payouts'].grid);
  const r = js(H.runSellerPayoutFifo_('SP1'));
  assert.equal(r.status, 'SUCCESS', r.error);
  assert.deepEqual(r.rows.map((x) => [x.settlement_id, x.allocated_amount]), [['ST-P1', 2132.2706], ['ST-P2', 367.7294]]);
  assert.equal(m.sheets['Seller Payout Allocations'].grid.length, 3);
  assert.equal(JSON.stringify(m.sheets['Seller Payouts'].grid), payoutsBefore, 'payout status / row never changed');
  assert.equal(audit[0].action, 'SELLER_PAYOUT_ALLOCATION_FIFO_SUCCESS');
  const again = js(H.runSellerPayoutFifo_('SP1'));
  assert.equal(again.status, 'NO_CHANGE');
  assert.equal(m.sheets['Seller Payout Allocations'].grid.length, 3, 'idempotent');
  installFifo([payout('SP9', 100, 'SENT')], [alloc('SP9', 'ST-P1', 100)]);
  assert.match(js(H.runSellerPayoutFifo_('SP9')).error, /is SENT; FIFO allocates DRAFT payouts only/);
  installFifo([payout('SP1', 2500, 'SENT')]);
  assert.match(js(H.runSellerPayoutFifo_('SP1')).error, /Seller Payout Allocations is invalid; fix it first/, 'unallocated effective payout: fail closed');
  installFifo([p], [], { current: false, reason: 'Settlement Items is stale' });
  assert.match(js(H.runSellerPayoutFifo_('SP1')).error, /Settlement Items is not current/);
  installFifo([p, payout('SP0', 100, 'SENT')]);
  assert.match(js(H.runSellerPayoutFifo_('SP1')).error, /Seller Payout Allocations is invalid; fix it first/);
  installFifo([]);
  assert.match(js(H.runSellerPayoutFifo_('SP-404')).error, /Expected exactly one Seller Payout SP-404, found 0/);
});

test('15: allocations never reduce a balance: Seller Balances deducts only the effective payout', () => {
  const cols = js(H.getColumnNames_('Seller Balances'));
  const items = FIFO_ITEMS.map((i) => ({ ...i }));
  const payouts = [payout('SP1', 2500, 'SENT')];
  const b = js(H.buildSellerBalances_({ items, adjustments: [], payouts, sellerIds: ['CUS002'], existing: [], now: D('2026-10-20T10:00:00Z'), columns: cols }).rows)[0];
  assert.ok(near(b.current_balance, 3037.444 - 2500));
  assert.ok(near(b.paid_amount, 2500));
  const fifo = plan(payout('SP1', 2500, 'DRAFT'), []);
  const v = H.validateSellerPayoutAllocations_({ allocations: fifo.rows, payouts, items, settlements: SETTLEMENTS });
  assert.ok(near(js(v.summary.per_seller_remaining).CUS002, b.current_balance), 'remaining obligations = balance (payout counted once)');
});

test('19: production regression with zero payouts (report only): dues equal the seller shares, everything UNPAID', () => {
  const items = [item('CUS001', 'ST-KH001-PAYPAL-000001', 1000), item('CUS001', 'ST-KH001-PAYPAL-000002', 919.3986),
    item('CUS002', 'ST-KH001-PAYPAL-000001', 2132.2706), item('CUS002', 'ST-KH001-PAYPAL-000002', 905.1734),
    item('CUS003', 'ST-KH001-PAYPAL-000001', 256.7666), item('CUS004', 'ST-KH001-PAYPAL-000002', 3156.4424)];
  const settlements = ['ST-KH001-PAYPAL-000001', 'ST-KH001-PAYPAL-000002'].map((id, i) => ({ settlement_id: id, payment_source: 'PAYPAL',
    source_settlement_number: i + 1, period_end_date: D('2026-10-0' + (4 + i * 5) + 'T04:00:00Z'), source_payment_date: D('2026-10-1' + i + 'T04:00:00Z') }));
  const v = H.validateSellerPayoutAllocations_({ allocations: [], payouts: [], items, settlements });
  assert.equal(errs(v), '');
  assert.deepEqual(js(v.summary.payment_status_counts), { UNPAID: 6 });
  const reg = js(H.evaluateSellerAllocationsRegression_(v));
  assert.equal(reg.pass, true, JSON.stringify(reg.failed));
  assert.deepEqual(js(v.states).filter((s) => s.seller_id === 'CUS002').map((s) => [s.source_settlement_number, s.due_amount, s.paid_amount, s.payment_status]),
    [[1, 2132.2706, 0, 'UNPAID'], [2, 905.1734, 0, 'UNPAID']]);
});
