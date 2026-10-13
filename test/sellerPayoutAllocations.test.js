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
const alloc = (pid, st, amount, o) => ({ allocation_id: H.sellerAllocationId_(pid, 'SETTLEMENT', st), seller_payout_id: pid, seller_id: 'CUS002',
  target_type: 'SETTLEMENT', target_id: st, payment_source: st === 'ST-S1' ? 'STRIPE' : 'PAYPAL', currency: 'USD', allocated_amount: amount, ...o });
const adjAlloc = (pid, adjId, amount, o) => ({ allocation_id: H.sellerAllocationId_(pid, 'ADJUSTMENT', adjId), seller_payout_id: pid, seller_id: 'CUS002',
  target_type: 'ADJUSTMENT', target_id: adjId, payment_source: '', currency: 'USD', allocated_amount: amount, ...o });
const validate = (allocations, payouts, items, adjustments) => H.validateSellerPayoutAllocations_({ allocations, payouts, items: items || ITEMS,
  settlements: SETTLEMENTS, adjustments: adjustments || [] });
const errs = (v) => js(H.flattenAllocationErrors_(v.errors)).join(' | ');
const state = (v, st, seller) => js(v.states).find((s) => s.target_id === st && s.seller_id === (seller || 'CUS002'));

test('allocation_id is deterministic: SPA-<sha256(seller_payout_id|target_type|target_id)>', () => {
  assert.equal(H.sellerAllocationId_('SP1', 'SETTLEMENT', 'ST-P1'), 'SPA-' + sha('SP1|SETTLEMENT|ST-P1'));
  assert.equal(H.sellerAllocationId_('SP1', 'ADJUSTMENT', 'ADJ-1'), 'SPA-' + sha('SP1|ADJUSTMENT|ADJ-1'));
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 100, { allocation_id: 'SPA-x' })], [payout('SP1', 100, 'DRAFT')])), /allocation_id must be SPA-sha256/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 100, { target_type: 'INVOICE', allocation_id: H.sellerAllocationId_('SP1', 'INVOICE', 'ST-P1') })],
    [payout('SP1', 100, 'DRAFT')])), /target_type must be SETTLEMENT or ADJUSTMENT/);
});

test('obligations come only from this seller\'s frozen Settlement Items; no payouts -> UNPAID with paid 0', () => {
  const v = validate([], []);
  assert.equal(errs(v), '');
  assert.deepEqual([state(v, 'ST-P1').due_amount, state(v, 'ST-P1').paid_amount, state(v, 'ST-P1').payment_status], [1000, 0, 'UNPAID']);
  assert.equal(state(v, 'ST-P1', 'CUS001').due_amount, 500, 'DITECH share of the same provider settlement is separate');
  assert.equal(js(v.states).find((s) => s.target_id === 'ST-EMPTY'), undefined, 'no items -> no obligation');
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
  v = validate([alloc('SP1', 'ST-P1', 5000), alloc('SP1', 'ST-P2', 900)], [payout('SP1', 10, 'VOID')]);
  assert.equal(errs(v), '', 'VOID: structurally valid rows have no financial effect (no over-allocation / over-payment)');
  assert.deepEqual([state(v, 'ST-P1').payment_status, state(v, 'ST-P1').paid_amount, v.summary.void_allocation_rows], ['UNPAID', 0, 2]);
  v = validate([alloc('SP1', 'ST-P1', 300)], [payout('SP1', 1000, 'DRAFT')]);
  assert.equal(errs(v), '', 'a DRAFT payout may be partially allocated');
});

test('7-9: effective payouts must be fully allocated; no over-allocation; no settlement over-payment', () => {
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 800)], [payout('SP1', 1000, 'SENT')])), /Seller Payout SP1 \(SENT\): allocated 800 of 1000/);
  assert.match(errs(validate([], [payout('SP1', 1000, 'CONFIRMED')])), /allocated 0 of 1000/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 1000), alloc('SP1', 'ST-P2', 100)], [payout('SP1', 1000, 'SENT')])), /allocated 1100 > payout amount 1000/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 1100)], [payout('SP1', 1000, 'DRAFT')])), /allocated 1100 > payout amount 1000/);
  assert.match(errs(validate([alloc('A', 'ST-P1', 700), alloc('B', 'ST-P1', 400)], [payout('A', 700, 'SENT'), payout('B', 400, 'SENT')])),
    /SETTLEMENT\|CUS002\|ST-P1\|USD: paid 1100 > due 1000/);
  assert.equal(errs(validate([alloc('SP1', 'ST-P1', 999.99996)], [payout('SP1', 1000, 'SENT')])), '', 'within the 0.00005 tolerance');
});

test('10-12: cross-seller, wrong currency / source, duplicates, unknown references and non-positive amounts fail', () => {
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 100, { seller_id: 'CUS001' })], [payout('SP1', 100, 'DRAFT')])), /is not the payout seller CUS002/);
  const ditechOnly = ITEMS.filter((i) => !(i.seller_id === 'CUS002' && i.settlement_id === 'ST-P1'));
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 100)], [payout('SP1', 100, 'DRAFT')], ditechOnly)), /has no share of seller CUS002 \(another seller's settlement share\)/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 100, { currency: 'EUR' })], [payout('SP1', 100, 'DRAFT')])), /currency EUR differs from the payout currency USD/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 100, { currency: 'EUR' })], [payout('SP1', 100, 'DRAFT', { currency: 'EUR' })])), /has no EUR obligation in ST-P1/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 100, { payment_source: 'STRIPE' })], [payout('SP1', 100, 'DRAFT')])), /payment_source STRIPE differs/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 50), alloc('SP1', 'ST-P1', 50)], [payout('SP1', 100, 'DRAFT')])), /duplicate seller_payout_id \+ target_type \+ target_id SP1\|SETTLEMENT\|ST-P1/);
  assert.match(errs(validate([alloc('SP9', 'ST-P1', 50)], [])), /unknown seller_payout_id SP9/);
  assert.match(errs(validate([alloc('SP1', 'ST-X', 50)], [payout('SP1', 100, 'DRAFT')])), /unknown settlement_id ST-X/);
  assert.match(errs(validate([alloc('SP1', 'ST-EMPTY', 50)], [payout('SP1', 100, 'DRAFT')])), /has no seller obligation \(no frozen Settlement Items\)/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', 0)], [payout('SP1', 100, 'DRAFT')])), /allocated_amount must be a positive number/);
  assert.match(errs(validate([alloc('SP1', 'ST-P1', -5)], [payout('SP1', 100, 'DRAFT')])), /allocated_amount must be a positive number/);
});

// ---- FIFO ------------------------------------------------------------------------------------------------
const FIFO_ITEMS = [item('CUS002', 'ST-P1', 2132.2706, 260), item('CUS002', 'ST-P2', 905.1734, 110)];
const plan = (p, allocations, payouts, adjustments) => {
  const all = payouts || [p];
  const v = H.validateSellerPayoutAllocations_({ allocations, payouts: all, items: FIFO_ITEMS, settlements: SETTLEMENTS, adjustments: adjustments || [] });
  const byId = {};
  all.forEach((x) => { byId[x.seller_payout_id] = x; });
  return js(H.planFifoAllocation_(p, allocations, v, byId, D('2026-10-20T10:00:00Z')));
};

test('13: FIFO allocates the oldest obligation first: 2500 -> 2132.2706 + 367.7294 (remaining 537.444)', () => {
  const p = payout('SP1', 2500, 'DRAFT');
  const r = plan(p, []);
  assert.equal(r.status, 'SUCCESS');
  assert.deepEqual(r.rows.map((x) => [x.target_type, x.target_id, x.allocated_amount]), [['SETTLEMENT', 'ST-P1', 2132.2706], ['SETTLEMENT', 'ST-P2', 367.7294]]);
  assert.equal(r.rows[0].allocation_id, 'SPA-' + sha('SP1|SETTLEMENT|ST-P1'));
  const effective = H.validateSellerPayoutAllocations_({ allocations: r.rows, payouts: [{ ...p, status: 'SENT' }], items: FIFO_ITEMS, settlements: SETTLEMENTS, adjustments: [] });
  assert.equal(errs(effective), '');
  assert.deepEqual([state(effective, 'ST-P1').payment_status, state(effective, 'ST-P2').payment_status], ['PAID', 'PARTIAL']);
  assert.ok(near(state(effective, 'ST-P2').remaining_amount, 537.444));
  const drafts = [p, payout('SP2', 537.444, 'DRAFT')];
  const second = plan(drafts[1], r.rows, drafts);
  assert.deepEqual(second.rows.map((x) => [x.target_id, x.allocated_amount]), [['ST-P2', 537.444]], 'other DRAFT claims are respected');
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
  const m = fakeMaster({ 'Seller Payout Allocations': allocations || [], 'Seller Payouts': payouts, 'Settlement Items': FIFO_ITEMS, Settlements: SETTLEMENTS,
    Adjustments: [] });
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
  assert.deepEqual(r.rows.map((x) => [x.target_id, x.allocated_amount]), [['ST-P1', 2132.2706], ['ST-P2', 367.7294]]);
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
  const v = H.validateSellerPayoutAllocations_({ allocations: fifo.rows, payouts, items, settlements: SETTLEMENTS, adjustments: [] });
  assert.ok(near(js(v.summary.per_seller_remaining).CUS002, b.current_balance), 'remaining obligations = balance (payout counted once)');
});

test('19: production fixture with zero payouts: dues equal the seller shares, everything UNPAID; runtime invariants pass', () => {
  const items = [item('CUS001', 'ST-KH001-PAYPAL-000001', 1000), item('CUS001', 'ST-KH001-PAYPAL-000002', 919.3986),
    item('CUS002', 'ST-KH001-PAYPAL-000001', 2132.2706), item('CUS002', 'ST-KH001-PAYPAL-000002', 905.1734),
    item('CUS003', 'ST-KH001-PAYPAL-000001', 256.7666), item('CUS004', 'ST-KH001-PAYPAL-000002', 3156.4424)];
  const settlements = ['ST-KH001-PAYPAL-000001', 'ST-KH001-PAYPAL-000002'].map((id, i) => ({ settlement_id: id, payment_source: 'PAYPAL',
    source_settlement_number: i + 1, period_end_date: D('2026-10-0' + (4 + i * 5) + 'T04:00:00Z'), source_payment_date: D('2026-10-1' + i + 'T04:00:00Z') }));
  const v = H.validateSellerPayoutAllocations_({ allocations: [], payouts: [], items, settlements, adjustments: [] });
  assert.equal(errs(v), '');
  assert.deepEqual(js(v.summary.payment_status_counts), { UNPAID: 6 });
  const reg = js(H.evaluateSellerAllocationsInvariants_(v, []));
  assert.equal(reg.pass, true, JSON.stringify(reg.failed));
  // the CUS002 production payout (2P.2): CONFIRMED 3037.444 = 2132.2706 -> settlement #1 + 905.1734 -> settlement #2
  const id = 'SP-OPS-0C99D9F9B016F5A6';
  const payout = { seller_payout_id: id, seller_id: 'CUS002', currency: 'USD', amount: 3037.444, status: 'CONFIRMED', payout_date: D('2026-10-13T04:00:00Z') };
  const alloc = (sid, amt) => ({ allocation_id: H.sellerAllocationId_(id, 'SETTLEMENT', sid), seller_payout_id: id, seller_id: 'CUS002', target_type: 'SETTLEMENT',
    target_id: sid, payment_source: 'PAYPAL', currency: 'USD', allocated_amount: amt });
  const allocs = [alloc('ST-KH001-PAYPAL-000001', 2132.2706), alloc('ST-KH001-PAYPAL-000002', 905.1734)];
  const paid = H.validateSellerPayoutAllocations_({ allocations: allocs, payouts: [payout], items, settlements, adjustments: [] });
  assert.equal(errs(paid), '');
  assert.equal(js(H.evaluateSellerAllocationsInvariants_(paid, [payout])).pass, true, 'a valid payout never fails the runtime report');
  assert.deepEqual(js(paid.summary.payment_status_counts), { PAID: 2, UNPAID: 4 });
  const broken = js(H.evaluateSellerAllocationsInvariants_(paid, [{ ...payout, amount: 3100 }]));
  assert.deepEqual(broken.failed, ['effective payout allocation = payout amount']);
  assert.deepEqual(js(v.states).filter((s) => s.seller_id === 'CUS002').map((s) => [s.source_settlement_number, s.due_amount, s.paid_amount, s.payment_status]),
    [[1, 2132.2706, 0, 'UNPAID'], [2, 905.1734, 0, 'UNPAID']]);
});

// ---- ADJUSTMENT targets (positive APPLIED seller credits) --------------------------------------------------
const HUI_ITEMS = [item('CUS002', 'ST-P1', 2132.2706, 260), item('CUS002', 'ST-P2', 905.1734, 110)];
const adjustment = (id, type, amount, o) => ({ adjustment_id: id, adjustment_type: type, seller_id: 'CUS002', currency: 'USD', amount, status: 'APPLIED',
  payment_source: '', effective_date: D('2026-10-14T04:00:00Z'), ...o });
const HOLD = adjustment('ADJ-HR', 'HOLD_RELEASE', 70.42, { payment_source: 'PAYPAL' });
const hv = (allocations, payouts, adjustments) => H.validateSellerPayoutAllocations_({ allocations, payouts, items: HUI_ITEMS, settlements: SETTLEMENTS,
  adjustments: adjustments || [HOLD] });
const balance = (payouts, adjustments) => js(H.buildSellerBalances_({ items: HUI_ITEMS, adjustments: adjustments || [HOLD], payouts, sellerIds: ['CUS002'],
  existing: [], now: D('2026-10-21T00:00:00Z'), columns: js(H.getColumnNames_('Seller Balances')) }).rows)[0];
const adjState = (v, id) => js(v.states).find((s) => s.target_type === 'ADJUSTMENT' && s.target_id === id);

test('A: APPLIED HOLD_RELEASE +70.42 is a payout obligation (UNPAID); balance 3037.444 + 70.42 = 3107.864', () => {
  const v = hv([], []);
  assert.equal(errs(v), '');
  assert.deepEqual([adjState(v, 'ADJ-HR').due_amount, adjState(v, 'ADJ-HR').payment_status, adjState(v, 'ADJ-HR').payment_source], [70.42, 'UNPAID', 'PAYPAL']);
  assert.ok(near(balance([]).current_balance, 3107.864));
  assert.ok(near(v.summary.settlement_due, 3037.444) && near(v.summary.adjustment_due, 70.42) && near(v.summary.total_payoutable_due, 3107.864));
  assert.deepEqual(js(v.summary.payment_status_counts_by_target), { SETTLEMENT: { UNPAID: 2 }, ADJUSTMENT: { UNPAID: 1 } });
});

test('B: a CONFIRMED payout of 70.42 allocated to the HOLD_RELEASE pays it; the balance is reduced once', () => {
  const p = payout('SP-H', 70.42, 'CONFIRMED');
  const v = hv([adjAlloc('SP-H', 'ADJ-HR', 70.42, { payment_source: 'PAYPAL' })], [p]);
  assert.equal(errs(v), '');
  assert.equal(adjState(v, 'ADJ-HR').payment_status, 'PAID');
  assert.deepEqual(js(v.states).filter((s) => s.target_type === 'SETTLEMENT').map((s) => s.payment_status), ['UNPAID', 'UNPAID']);
  assert.ok(near(balance([p]).current_balance, 3037.444), '3107.864 - 70.42, deducted once');
});

test('C: one payout spans a settlement and an adjustment: 1000 + 70 -> both PAID; balance reduced by exactly 1070', () => {
  const items = [item('CUS002', 'ST-P1', 1000, 100)];
  const credit = adjustment('ADJ-C', 'HOLD_RELEASE', 70);
  const p = payout('SP-C', 1070, 'SENT');
  const v = H.validateSellerPayoutAllocations_({ allocations: [alloc('SP-C', 'ST-P1', 1000), adjAlloc('SP-C', 'ADJ-C', 70)], payouts: [p], items,
    settlements: SETTLEMENTS, adjustments: [credit] });
  assert.equal(errs(v), '');
  assert.deepEqual(js(v.states).map((s) => [s.target_type, s.payment_status, s.remaining_amount]), [['SETTLEMENT', 'PAID', 0], ['ADJUSTMENT', 'PAID', 0]]);
  const b = js(H.buildSellerBalances_({ items, adjustments: [credit], payouts: [p], sellerIds: ['CUS002'], existing: [], now: D('2026-10-21T00:00:00Z'),
    columns: js(H.getColumnNames_('Seller Balances')) }).rows)[0];
  assert.ok(near(b.current_balance, 0) && near(b.paid_amount, 1070), '1000 + 70 - 1070 exactly once');
});

test('D: FIFO pays the older settlements first, then the later HOLD_RELEASE', () => {
  const p = payout('SP-F', 3107.864, 'DRAFT');
  const v = hv([], [p]);
  const r = js(H.planFifoAllocation_(p, [], v, { 'SP-F': p }, D('2026-10-21T00:00:00Z')));
  assert.equal(r.status, 'SUCCESS');
  assert.deepEqual(r.rows.map((x) => [x.target_type, x.target_id, x.allocated_amount, x.payment_source]),
    [['SETTLEMENT', 'ST-P1', 2132.2706, 'PAYPAL'], ['SETTLEMENT', 'ST-P2', 905.1734, 'PAYPAL'], ['ADJUSTMENT', 'ADJ-HR', 70.42, 'PAYPAL']]);
  const early = adjustment('ADJ-EARLY', 'MANUAL_ADJUSTMENT', 10, { effective_date: D('2026-10-08T04:00:00Z') });
  const small = payout('SP-S', 50, 'DRAFT');
  const r2 = js(H.planFifoAllocation_(small, [], hv([], [small], [early, HOLD]), { 'SP-S': small }, D('2026-10-21T00:00:00Z')));
  assert.deepEqual(r2.rows.map((x) => [x.target_id, x.allocated_amount, x.payment_source]), [['ST-P1', 50, 'PAYPAL']], 'ST-P1 (paid 10-06) before the 10-08 credit');
  const after = js(H.planFifoAllocation_(small, [adjAlloc('SP-X', 'ADJ-HR', 20, { payment_source: 'PAYPAL' })], hv([], [small, payout('SP-X', 20, 'DRAFT')]),
    { 'SP-S': small, 'SP-X': payout('SP-X', 20, 'DRAFT') }, D('2026-10-21T00:00:00Z')));
  assert.equal(after.status, 'SUCCESS', 'existing manual rows of other payouts only reserve capacity');
  const undated = adjustment('ADJ-U', 'MANUAL_ADJUSTMENT', 10, { effective_date: '' });
  const u = js(H.planFifoAllocation_(small, [], hv([], [small], [undated]), { 'SP-S': small }, D('2026-10-21T00:00:00Z')));
  assert.deepEqual([u.status, u.rows], ['FAILED', []]);
  assert.match(u.error, /APPLIED adjustment\(s\) without a valid effective_date \(ADJ-U\) make the payable balance ambiguous/);
});

test('E-H: positive MANUAL_ADJUSTMENT is payoutable; negative, zero, PENDING and VOID adjustments are not', () => {
  const credit = adjustment('ADJ-M', 'MANUAL_ADJUSTMENT', 25);
  let v = hv([adjAlloc('SP1', 'ADJ-M', 25)], [payout('SP1', 25, 'SENT')], [credit]);
  assert.equal(errs(v), '');
  assert.equal(adjState(v, 'ADJ-M').payment_status, 'PAID');
  for (const [label, adj] of [['REFUND', adjustment('ADJ-N', 'REFUND', -10)], ['DISPUTE', adjustment('ADJ-N', 'DISPUTE', -20)],
    ['DISPUTE_FEE', adjustment('ADJ-N', 'DISPUTE_FEE', -15)], ['negative manual', adjustment('ADJ-N', 'MANUAL_ADJUSTMENT', -5)],
    ['zero', adjustment('ADJ-N', 'MANUAL_ADJUSTMENT', 0)], ['PENDING', adjustment('ADJ-N', 'MANUAL_ADJUSTMENT', 30, { status: 'PENDING' })],
    ['VOID', adjustment('ADJ-N', 'HOLD_RELEASE', 30, { status: 'VOID' })]]) {
    v = hv([adjAlloc('SP1', 'ADJ-N', 5)], [payout('SP1', 5, 'DRAFT')], [adj]);
    assert.match(errs(v), /adjustment ADJ-N is not a payout obligation \(needs status APPLIED and a positive amount/, label);
    assert.equal(adjState(v, 'ADJ-N'), undefined, label + ' is never an obligation');
  }
});

test('I-L: adjustment seller / currency / payment_source rules; blank-source manual credit stays blank', () => {
  const other = adjustment('ADJ-O', 'MANUAL_ADJUSTMENT', 25, { seller_id: 'CUS001' });
  assert.match(errs(hv([adjAlloc('SP1', 'ADJ-O', 25)], [payout('SP1', 25, 'DRAFT')], [other])), /adjustment ADJ-O belongs to seller CUS001/);
  const eur = adjustment('ADJ-E', 'MANUAL_ADJUSTMENT', 25, { currency: 'EUR' });
  assert.match(errs(hv([adjAlloc('SP1', 'ADJ-E', 25)], [payout('SP1', 25, 'DRAFT')], [eur])), /differs from the adjustment currency EUR/);
  assert.match(errs(hv([adjAlloc('SP1', 'ADJ-HR', 25)], [payout('SP1', 25, 'DRAFT')])), /payment_source \(blank\) must equal the adjustment payment_source \(PAYPAL\)/);
  assert.match(errs(hv([adjAlloc('SP1', 'ADJ-HR', 25, { payment_source: 'STRIPE' })], [payout('SP1', 25, 'DRAFT')])), /payment_source STRIPE must equal/);
  const manual = adjustment('ADJ-B', 'MANUAL_ADJUSTMENT', 25);
  assert.equal(errs(hv([adjAlloc('SP1', 'ADJ-B', 25)], [payout('SP1', 25, 'SENT')], [manual])), '', 'blank source manual credit');
  assert.match(errs(hv([adjAlloc('SP1', 'ADJ-B', 25, { payment_source: 'PAYPAL' })], [payout('SP1', 25, 'SENT')], [manual])), /must equal the adjustment payment_source \(blank\)/,
    'a source is never invented');
  const fifo = js(H.planFifoAllocation_(payout('SP2', 25, 'DRAFT'), [], hv([], [payout('SP2', 25, 'DRAFT')], [manual]), { SP2: payout('SP2', 25, 'DRAFT') },
    D('2026-10-21T00:00:00Z')));
  assert.equal(fifo.rows.find((x) => x.target_id === 'ADJ-B'), undefined, 'ADJ-B is later than the settlements');
  assert.match(errs(hv([adjAlloc('SP1', 'ADJ-404', 25)], [payout('SP1', 25, 'DRAFT')])), /unknown adjustment_id ADJ-404/);
  assert.match(errs(hv([adjAlloc('SP1', 'ADJ-HR', 80, { payment_source: 'PAYPAL' })], [payout('SP1', 80, 'SENT')])), /ADJUSTMENT\|ADJ-HR: paid 80 > due 70.42/);
});

test('M: VOID parent payout: valid rows have no financial effect, but malformed rows still fail validation', () => {
  const voided = payout('SP-V', 50, 'VOID');
  const ok = hv([adjAlloc('SP-V', 'ADJ-HR', 70.42, { payment_source: 'PAYPAL' }), alloc('SP-V', 'ST-P1', 9999)], [voided]);
  assert.equal(errs(ok), '');
  assert.deepEqual([adjState(ok, 'ADJ-HR').paid_amount, state(ok, 'ST-P1').paid_amount, ok.summary.void_allocation_rows], [0, 0, 2]);
  for (const [label, row, re] of [['bad id', alloc('SP-V', 'ST-P1', 10, { allocation_id: 'SPA-bad' }), /allocation_id must be/],
    ['unknown target', alloc('SP-V', 'ST-NOPE', 10), /unknown settlement_id ST-NOPE/], ['wrong seller', alloc('SP-V', 'ST-P1', 10, { seller_id: 'CUS001' }), /is not the payout seller/],
    ['wrong currency', alloc('SP-V', 'ST-P1', 10, { currency: 'EUR' }), /currency EUR differs/], ['bad amount', alloc('SP-V', 'ST-P1', -1), /positive number/],
    ['bad type', alloc('SP-V', 'ST-P1', 10, { target_type: 'X', allocation_id: H.sellerAllocationId_('SP-V', 'X', 'ST-P1') }), /target_type must be/],
    ['bad source', alloc('SP-V', 'ST-P1', 10, { payment_source: 'STRIPE' }), /payment_source STRIPE differs/]]) {
    assert.match(errs(hv([row], [voided])), re, 'VOID does not hide a malformed row: ' + label);
  }
  assert.match(errs(hv([alloc('SP-V', 'ST-P1', 10), alloc('SP-V', 'ST-P1', 10)], [voided])), /duplicate seller_payout_id/);
});

// ---- Temporal payable-balance guard ---------------------------------------------------------------------------
const T_SETTLEMENTS = [{ settlement_id: 'ST-T', payment_source: 'PAYPAL', source_settlement_number: 1, period_end_date: D('2026-09-30T04:00:00Z'),
  source_payment_date: D('2026-10-01T04:00:00Z') }];
const T_ITEMS = [item('CUS002', 'ST-T', 100)];
const day = (d) => D('2026-10-' + d + 'T04:00:00Z');
const refund = (d, amount) => adjustment('RF-' + d, 'REFUND', amount || -20, { effective_date: day(d), payment_source: 'PAYPAL' });
const credit = (d, amount) => adjustment('HR-' + d, 'HOLD_RELEASE', amount, { effective_date: day(d), payment_source: 'PAYPAL' });
const tp = (id, amount, status, d) => payout(id, amount, status, { payout_date: d === null ? '' : day(d) });
const tv = (allocations, payouts, adjustments) => H.validateSellerPayoutAllocations_({ allocations, payouts, items: T_ITEMS, settlements: T_SETTLEMENTS,
  adjustments });
const tAlloc = (pid, amount) => alloc(pid, 'ST-T', amount);
const tBalance = (payouts, adjustments) => js(H.buildSellerBalances_({ items: T_ITEMS, adjustments, payouts, sellerIds: ['CUS002'], existing: [],
  now: day(25), columns: js(H.getColumnNames_('Seller Balances')) }).rows)[0].current_balance;
const tFifo = (p, allocations, payouts, adjustments) => {
  const byId = {};
  payouts.forEach((x) => { byId[x.seller_payout_id] = x; });
  return js(H.planFifoAllocation_(p, allocations, tv(allocations, payouts, adjustments), byId, day(25)));
};

test('T-A: settlement 100, refund -20, payout 80 -> valid; balance 0; settlement PARTIAL with 20 "Chưa payout" (cash only)', () => {
  const adj = [refund('05')];
  const p = tp('SP-80', 80, 'SENT', '10');
  const v = tv([tAlloc('SP-80', 80)], [p], adj);
  assert.equal(errs(v), '');
  assert.deepEqual([state(v, 'ST-T').payment_status, state(v, 'ST-T').paid_amount, state(v, 'ST-T').remaining_amount], ['PARTIAL', 80, 20]);
  assert.ok(near(tBalance([p], adj), 0), 'Seller Balance 100 - 20 - 80 = 0 (no double count)');
});

test('T-B/C: FIFO refuses a payout above the payable balance as of its date; a second payout before new credit fails closed', () => {
  const adj = [refund('05')];
  const draft100 = tp('SP-100', 100, 'DRAFT', '10');
  const b = tFifo(draft100, [], [draft100], adj);
  assert.deepEqual([b.status, b.rows], ['FAILED', []]);
  assert.match(b.error, /exceeds the seller payable balance \(payable as of 2026-10-10: 80\)/);
  const draft80 = tp('SP-80', 80, 'DRAFT', '10');
  assert.deepEqual(tFifo(draft80, [], [draft80], adj).rows.map((r) => [r.target_id, r.allocated_amount]), [['ST-T', 80]]);
  const sent80 = tp('SP-80', 80, 'SENT', '10');
  const draft20 = tp('SP-20', 20, 'DRAFT', '11');
  assert.equal(tFifo(draft20, [tAlloc('SP-80', 80)], [sent80, draft20], adj).status, 'FAILED', 'FIFO: nothing payable on Oct 11');
  const manual = tv([tAlloc('SP-80', 80), tAlloc('SP-20', 20)], [sent80, tp('SP-20', 20, 'SENT', '11')], adj);
  assert.match(errs(manual), /CUS002\|USD 2026-10-11: payout\(s\) SP-20 exceed the payable balance as of that date by 20/,
    'a manual allocation cannot bypass the guard even though 20 is "Chưa payout"');
});

test('T-D: a later HOLD_RELEASE +20 makes 20 payable again; FIFO allocates by obligation order within the payable balance', () => {
  const adj = [refund('05'), credit('15', 20)];
  const sent80 = tp('SP-80', 80, 'SENT', '10');
  assert.ok(near(tBalance([sent80], adj), 20));
  const draft = tp('SP-20', 20, 'DRAFT', '16');
  const r = tFifo(draft, [tAlloc('SP-80', 80)], [sent80, draft], adj);
  assert.equal(r.status, 'SUCCESS', r.error);
  assert.deepEqual(r.rows.map((x) => [x.target_type, x.target_id, x.allocated_amount]), [['SETTLEMENT', 'ST-T', 20]], 'oldest obligation first');
  const v = tv([tAlloc('SP-80', 80)].concat(r.rows), [sent80, { ...draft, status: 'SENT' }], adj);
  assert.equal(errs(v), '');
  assert.ok(near(tBalance([sent80, { ...draft, status: 'SENT' }], adj), 0));
  assert.equal(tFifo(tp('SP-X', 20, 'DRAFT', '14'), [tAlloc('SP-80', 80)], [sent80, tp('SP-X', 20, 'DRAFT', '14')], adj).status, 'FAILED',
    'before the HOLD_RELEASE date nothing is payable');
});

test('T-E/F/G: no payout before the settlement is paid or before an adjustment is effective; effective payouts need a payout_date', () => {
  assert.match(errs(tv([tAlloc('SP-E', 50)], [payout('SP-E', 50, 'SENT', { payout_date: D('2026-09-30T04:00:00Z') })], [])),
    /SETTLEMENT ST-T is available on 2026-10-01, after the payout date 2026-09-30/);
  const adj = [credit('15', 20)];
  assert.match(errs(tv([tAlloc('SP-F', 100), adjAlloc('SP-F', 'HR-15', 20, { payment_source: 'PAYPAL' })], [tp('SP-F', 120, 'SENT', '12')], adj)),
    /ADJUSTMENT HR-15 is available on 2026-10-15, after the payout date 2026-10-12/);
  for (const status of ['SENT', 'CONFIRMED']) {
    assert.match(errs(tv([tAlloc('SP-G', 50)], [tp('SP-G', 50, status, null)], [])), new RegExp('Seller Payout SP-G \\(' + status + '\\): payout_date must be a valid date'));
  }
  assert.equal(errs(tv([tAlloc('SP-G', 50)], [tp('SP-G', 50, 'DRAFT', null)], [])), '', 'a DRAFT may exist without a payout date ...');
  const noDate = tp('SP-G', 50, 'DRAFT', null);
  assert.match(tFifo(noDate, [], [noDate], []).error, /needs a valid payout_date for FIFO/, '... but FIFO requires one');
  const early = tp('SP-EA', 50, 'DRAFT', '30');
  early.payout_date = D('2026-09-30T04:00:00Z');
  assert.equal(tFifo(early, [], [early], []).status, 'FAILED', 'FIFO never allocates to an obligation available after the payout date');
});

test('T-H: a later refund never invalidates a historical payout; the current balance may go negative', () => {
  const p = tp('SP-H', 100, 'CONFIRMED', '10');
  const adj = [refund('20')];
  const v = tv([tAlloc('SP-H', 100)], [p], adj);
  assert.equal(errs(v), '');
  assert.equal(state(v, 'ST-T').payment_status, 'PAID');
  assert.ok(near(tBalance([p], adj), -20));
});

test('T-I/J: same-day payouts are checked together; VOID payouts have no balance effect but rows stay structurally validated', () => {
  const both = tv([tAlloc('SP-1', 60), tAlloc('SP-2', 40)], [tp('SP-1', 60, 'SENT', '10'), tp('SP-2', 50, 'SENT', '10')], []);
  assert.match(errs(both), /unallocated|allocated 40 of 50/);
  const over = tv([tAlloc('SP-1', 60), adjAlloc('SP-2', 'HR-01', 50, { payment_source: 'PAYPAL' })],
    [tp('SP-1', 60, 'SENT', '10'), tp('SP-2', 50, 'CONFIRMED', '10')], [credit('01', 50)].concat([refund('02', -60)]));
  assert.match(errs(over), /2026-10-10: payout\(s\) SP-1, SP-2 exceed the payable balance as of that date by 20/, "90 payable (100 + 50 - 60), 110 paid the same day");
  const voided = tp('SP-V', 5000, 'VOID', '02');
  const v = tv([tAlloc('SP-V', 100)], [voided], []);
  assert.equal(errs(v), '', 'VOID: no temporal / balance effect');
  assert.match(errs(tv([alloc('SP-V', 'ST-T', 100, { allocation_id: 'SPA-bad' })], [voided], [])), /allocation_id must be/, 'still structurally validated');
});
