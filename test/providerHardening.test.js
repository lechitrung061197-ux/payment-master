// Phase 2Q-B: KH001 provider hardening - Provider Transaction = payment entity, explicit Provider Event lifecycle
// (reversal / refund / reserve release / dispute hold / withdrawal variants), frozen settlements, stale health in
// Operations, strict typed source (no text coercion). Pure fixtures + the production-shaped simulation. Fake data.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildMasterSim } = require('./helpers/masterSim');

const sim = buildMasterSim();
const { call, mS } = sim;
const H = sim.ctx;
const js = (v) => JSON.parse(JSON.stringify(v));
const near = (a, b) => Math.abs(a - b) < 1e-6;
const D = (iso) => vm.runInContext(`new Date(${JSON.stringify(iso)})`, sim.ctx);
const FP = 'f'.repeat(64);

// ---- pure fixtures (Raw KH001 PayPal grid) -------------------------------------------------------------
const HEADER = ['Thời gian', 'Name', 'Type', 'Status', 'Currency', 'Gross', 'Fee', 'Net', 'From Email Address', 'To Email Address', 'Transaction ID',
  'Reference Txn ID', 'Invoice Number', 'Balance Impact', 'Mã cổng', 'Nhóm GD', 'Txn gốc'];
function raw(o) {
  const r = { 'Thời gian': D('2026-10-02T15:00:00Z'), Name: 'Buyer', Type: 'Express Checkout Payment', Status: 'Completed', Currency: 'USD',
    Gross: 91.98, Fee: -3.24, Net: 88.74, 'From Email Address': 'b@x.com', 'To Email Address': 's@x.com', 'Transaction ID': 'PAY1',
    'Reference Txn ID': '', 'Invoice Number': 'INV-1', 'Balance Impact': 'Credit', 'Mã cổng': 'G01', 'Nhóm GD': 'Thanh toán', 'Txn gốc': 'PAY1', ...o };
  return HEADER.map((h) => r[h]);
}
const RECONCILED = [...Array(5).fill(['']), ['Transaction ID', 'Có trên KH', 'Có trên PP', 'Trạng thái', 'Mã cổng', 'Sub account', 'Thời gian GD',
  'Số tiền KH', 'Gross PayPal', 'Chênh lệch', 'Phí PayPal', 'Net']];
const lifecycle = () => [
  HEADER,
  raw({}),
  raw({ 'Transaction ID': 'DCC1', 'Txn gốc': 'DCC1', Type: 'Direct Credit Card Payment', Gross: 50, Fee: -2, Net: 48 }),
  raw({ 'Transaction ID': 'PEND1', 'Txn gốc': 'PEND1', Status: 'Pending', 'Balance Impact': 'Memo', Gross: 20, Fee: 0, Net: 20 }),
  raw({ 'Transaction ID': 'RSV1', 'Reference Txn ID': 'PAY1', 'Txn gốc': 'PAY1', Type: 'Reserve Hold', 'Nhóm GD': 'Reserve PP', 'Balance Impact': 'Debit',
    Gross: -8.87, Fee: 0, Net: -8.87 }),
  raw({ 'Transaction ID': 'REL1', 'Reference Txn ID': 'RSV1', 'Txn gốc': 'PAY1', Type: 'Reserve Release', 'Nhóm GD': 'Reserve PP', 'Balance Impact': 'Credit',
    Gross: 8.87, Fee: 0, Net: 8.87, 'Thời gian': D('2026-10-20T15:00:00Z') }),
  raw({ 'Transaction ID': 'RFD1', 'Reference Txn ID': 'DCC1', 'Txn gốc': 'DCC1', Type: 'Payment Refund', 'Nhóm GD': 'Hoàn tiền', 'Balance Impact': 'Debit',
    Gross: -50, Fee: 1.5, Net: -48.5, 'Thời gian': D('2026-10-05T15:00:00Z') }),
  raw({ 'Transaction ID': 'HLD1', 'Reference Txn ID': 'PAY1', 'Txn gốc': 'PAY1', Type: 'General Hold', 'Nhóm GD': 'Tạm giữ dispute', 'Balance Impact': 'Debit',
    Gross: -91.98, Fee: 0, Net: -91.98, 'Thời gian': D('2026-10-06T15:00:00Z') }),
  // later reversal of the Completed PAY1: same Transaction ID, Memo, different amounts
  raw({ 'Transaction ID': 'PAY1', 'Txn gốc': 'PAY1', Status: 'Reversed', 'Balance Impact': 'Memo', Gross: -91.98, Fee: 3.24, Net: -88.74,
    'Thời gian': D('2026-10-07T15:00:00Z') }),
  raw({ 'Transaction ID': 'WD1', 'Txn gốc': 'WD1', Type: 'General Withdrawal', 'Nhóm GD': 'Rút tiền', 'Balance Impact': 'Debit', Gross: -100, Fee: 0, Net: -100 }),
  raw({ 'Transaction ID': 'WD2', 'Txn gốc': 'WD2', Type: 'User Initiated Withdrawal', 'Nhóm GD': 'Rút tiền', 'Balance Impact': 'Debit', Gross: -40, Fee: 0, Net: -40 }),
  raw({ 'Transaction ID': 'WDR1', 'Reference Txn ID': 'WD1', 'Txn gốc': 'WDR1', Type: 'Reversal of ACH Withdrawal Transaction', 'Nhóm GD': 'Rút tiền',
    Status: 'Denied', 'Balance Impact': 'Memo', Gross: 100, Fee: 0, Net: 100 }),
];
const buildPT = (grid) => H.buildKh001ProviderTransactions_(grid, RECONCILED, FP);
const ptIdx = (grid) => H.indexProviderTransactions_(buildPT(grid).rows);
const buildEvents = (grid) => H.buildKh001ProviderEvents_(grid, ptIdx(grid), FP);
const evErrors = (b) => js(H.flattenEventErrors_(b.errors)).join(' | ');
const setCell = (grid, r, h, v) => { grid[r][HEADER.indexOf(h)] = v; return grid; };

test('Provider Transactions are payment entities: Express Checkout + Direct Credit Card (Completed / Pending); a later Reversed row is not a second payment', () => {
  const pt = js(buildPT(lifecycle()).rows);
  assert.deepEqual(pt.map((r) => [r.external_transaction_id, r.raw_type, r.external_status]).sort(),
    [['DCC1', 'Direct Credit Card Payment', 'Completed'], ['PAY1', 'Express Checkout Payment', 'Completed'], ['PEND1', 'Express Checkout Payment', 'Pending']]);
  const pay1 = pt.find((r) => r.external_transaction_id === 'PAY1');
  assert.deepEqual([pay1.gross_amount, pay1.processing_fee, pay1.net_amount, pay1.balance_impact], [91.98, 3.24, 88.74, 'Credit'],
    'the Completed economics are kept; the Reversed / Memo row never replaces them');
});

test('Provider Events lifecycle: every observed combination mapped and linked; ids deterministic and collision-free', () => {
  const b = buildEvents(lifecycle());
  assert.equal(evErrors(b), '');
  const ev = Object.fromEntries(js(b.rows).map((e) => [e.provider_event_id, e]));
  const row = (id) => [ev[id].event_type, ev[id].related_external_transaction_id, ev[id].provider_transaction_id, ev[id].balance_effect_amount];
  assert.deepEqual(row('PE-KH001-PAYPAL-PAY1'), ['PAYMENT', '', 'PT-KH001-PAYPAL-PAY1', 88.74], 'legacy id unchanged');
  assert.deepEqual(row('PE-KH001-PAYPAL-PAY1-REVERSAL'), ['PAYMENT_REVERSAL', 'PAY1', 'PT-KH001-PAYPAL-PAY1', 0]);
  assert.deepEqual(row('PE-KH001-PAYPAL-DCC1'), ['PAYMENT', '', 'PT-KH001-PAYPAL-DCC1', 48]);
  assert.deepEqual(row('PE-KH001-PAYPAL-PEND1'), ['PAYMENT', '', 'PT-KH001-PAYPAL-PEND1', 0]);
  assert.deepEqual(row('PE-KH001-PAYPAL-RSV1'), ['RESERVE_HOLD', 'PAY1', 'PT-KH001-PAYPAL-PAY1', -8.87]);
  assert.deepEqual(row('PE-KH001-PAYPAL-REL1'), ['RESERVE_RELEASE', 'PAY1', 'PT-KH001-PAYPAL-PAY1', 8.87], 'release (references the hold) -> original payment');
  assert.deepEqual(row('PE-KH001-PAYPAL-RFD1'), ['REFUND', 'DCC1', 'PT-KH001-PAYPAL-DCC1', -48.5]);
  assert.deepEqual(row('PE-KH001-PAYPAL-HLD1'), ['DISPUTE_HOLD', 'PAY1', 'PT-KH001-PAYPAL-PAY1', -91.98]);
  assert.deepEqual(row('PE-KH001-PAYPAL-WD1'), ['WITHDRAWAL', '', '', -100]);
  assert.deepEqual(row('PE-KH001-PAYPAL-WD2'), ['WITHDRAWAL', '', '', -40], 'User Initiated Withdrawal');
  assert.deepEqual(row('PE-KH001-PAYPAL-WDR1'), ['WITHDRAWAL_REVERSAL', 'WD1', '', 0]);
  assert.equal(new Set(js(b.rows).map((e) => e.provider_event_id)).size, b.rows.length, 'unique event ids');
  // the stored-row verifier accepts the same rows
  const stored = js(b.rows).map((e) => ({ ...e, event_at: D(e.event_at) }));
  assert.deepEqual(js(H.flattenEventErrors_(H.checkProviderEventRows_(stored, ptIdx(lifecycle())))), []);
});

test('fail closed: unknown group / type / status, broken links, reuse of an id other than payment + reversal', () => {
  const cases = [
    [(g) => setCell(g, 6, 'Nhóm GD', 'Chargeback'), /unmapped Nhóm GD "Chargeback"/],
    [(g) => setCell(g, 6, 'Type', 'Partial Refund'), /unverified Type "Partial Refund" for Nhóm GD "Hoàn tiền"/],
    [(g) => setCell(g, 8, 'Status', 'Canceled'), /unverified Status\/Balance Impact "Canceled\/Memo" for Thanh toán \/ Express Checkout Payment/],
    [(g) => setCell(g, 11, 'Status', 'Completed'), /"Completed\/Memo" for Rút tiền \/ Reversal of ACH Withdrawal Transaction/],
    [(g) => setCell(g, 6, 'Txn gốc', 'NOPE'), /RFD1.*links to missing Provider Transaction PT-KH001-PAYPAL-NOPE|Reference Txn ID "DCC1" is neither Txn gốc "NOPE"/],
    [(g) => setCell(g, 5, 'Reference Txn ID', 'XYZ'), /Reference Txn ID "XYZ" is neither Txn gốc "PAY1" nor an event of that payment/],
    [(g) => setCell(g, 11, 'Reference Txn ID', 'WD9'), /WITHDRAWAL_REVERSAL Reference Txn ID "WD9" must be exactly one WITHDRAWAL/],
    [(g) => { g.push(raw({ 'Transaction ID': 'PAY1', 'Txn gốc': 'PAY1' })); return g; },
      /Duplicate payment Transaction ID PAY1 \(rows 2, 13\)|Duplicate event Transaction ID PAY1 .*PAYMENT \+ PAYMENT_REVERSAL \+ PAYMENT/],
    [(g) => { g.splice(1, 1); return g; }, /PAYMENT_REVERSAL PAY1 has no PAYMENT row with the same Transaction ID|links to missing Provider Transaction PT-KH001-PAYPAL-PAY1/],
  ];
  cases.forEach(([mutate, re], i) => {
    const g = mutate(lifecycle());
    let message = '';
    try { message = evErrors(H.buildKh001ProviderEvents_(g, H.indexProviderTransactions_(buildPT(g.filter((r) => r[HEADER.indexOf('Nhóm GD')] !== 'Chargeback')).rows), FP)); }
    catch (e) { message = e.message; }
    assert.match(message, re, 'case ' + i);
  });
  // Provider Transactions also refuse an unknown "Thanh toán" combination
  assert.throws(() => buildPT(setCell(lifecycle(), 2, 'Type', 'Website Payment')), /unverified Type "Website Payment" for Nhóm GD "Thanh toán"/);
  assert.throws(() => buildPT(setCell(lifecycle(), 3, 'Balance Impact', 'Credit')), /"Pending\/Credit"/);
});

test('strict typed source: numeric text and text dates still fail both normalizers (no Number() coercion)', () => {
  const g = setCell(setCell(setCell(lifecycle(), 1, 'Gross', '91.98'), 1, 'Fee', '-3.24'), 1, 'Net', '88.74');
  assert.throws(() => buildPT(g), /Non-numeric Gross\/Fee\/Net for Transaction ID PAY1/);
  assert.match(evErrors(H.buildKh001ProviderEvents_(g, ptIdx(lifecycle()), FP)), /Row 2 \(PAY1\): non-numeric Gross\/Fee\/Net/);
  assert.throws(() => buildPT(setCell(lifecycle(), 2, 'Thời gian', '10/07/2026 07:14:49')), /Thời gian is not a date-time for Transaction ID DCC1/);
});

// ---- frozen settlements (pure) ----------------------------------------------------------------------------
test('frozen settlements (pure): which are frozen, membership / economics changes rejected, new settlements allowed', () => {
  const stored = [
    { settlement_id: 'ST-1', source_settlement_number: 1, period_start_date: D('2026-10-01T04:00:00Z'), period_end_date: D('2026-10-04T04:00:00Z'),
      source_payment_date: D('2026-10-06T04:00:00Z'), currency: 'USD', transaction_count: 2, gross_amount: 100, processing_fee_amount: 4, net_amount: 96,
      provider_fee_amount: 6.72, provider_hold_created_amount: 9.6, transaction_payout_amount: 79.68, source_paid_amount: 79.68 },
    { settlement_id: 'ST-2', source_settlement_number: 2, period_start_date: D('2026-10-05T04:00:00Z'), period_end_date: D('2026-10-09T04:00:00Z'),
      source_payment_date: '', currency: 'USD', transaction_count: 1, gross_amount: 50, processing_fee_amount: 2, net_amount: 48, provider_fee_amount: 3.36,
      provider_hold_created_amount: 4.8, transaction_payout_amount: 39.84, source_paid_amount: 0 },
  ];
  const frozen = js(H.findFrozenSettlements_(stored, [{ settlement_id: 'ST-1' }], [{ target_type: 'SETTLEMENT', target_id: 'ST-1' }, { target_type: 'ADJUSTMENT', target_id: 'A1' }]));
  assert.deepEqual(frozen, { 'ST-1': ['source_paid_amount > 0', 'Settlement Items', 'Seller Payout Allocations'] });
  const key = (d) => (d === '' ? '' : H.masterDateKey_(d));
  const proposed = stored.map((s) => ({ ...s, period_start_date: key(s.period_start_date), period_end_date: key(s.period_end_date), source_payment_date: key(s.source_payment_date) }));
  const check = (rows, membership) => js(H.checkFrozenSettlements_(rows, stored, frozen, { 'ST-1': ['T1', 'T2'] }, membership || { 'ST-1': ['T1', 'T2'], 'ST-2': ['T3'] }));
  assert.deepEqual(check(proposed), [], 'unchanged rebuild passes');
  assert.match(check(proposed, { 'ST-1': ['T1', 'T3'] })[0], /Frozen settlement ST-1 .* would lose transaction\(s\) T2/);
  assert.match(check([{ ...proposed[0], provider_fee_amount: 7.22, transaction_payout_amount: 79.18 }, proposed[1]])[0],
    /would change: provider_fee_amount 6.72 -> 7.22; transaction_payout_amount 79.68 -> 79.18/);
  assert.match(check([{ ...proposed[0], transaction_count: 3, gross_amount: 120 }, proposed[1]])[0], /transaction_count 2 -> 3; gross_amount 100 -> 120/);
  assert.match(check([{ ...proposed[0], source_payment_date: '2026-10-07' }, proposed[1]])[0], /source_payment_date/);
  assert.match(check([proposed[1]])[0], /Frozen settlement ST-1 .* is missing from the rebuild/);
  assert.deepEqual(check([proposed[0], { ...proposed[1], gross_amount: 999 }, { settlement_id: 'ST-3', source_settlement_number: 3 }]), [],
    'a non-frozen settlement may still be rebuilt and a new settlement appends');
});

// ---- integration: production-shaped baseline -------------------------------------------------------------
const LA = (day, time) => new Date(day + 'T' + (time || '07:00:00') + 'Z');
const srcSheet = (n) => sim.M.SRC.sheets.find((s) => s.name === n).api;
const PPH = ['Thời gian', 'Type', 'Status', 'Currency', 'Gross', 'Fee', 'Net', 'From Email Address', 'To Email Address', 'Transaction ID', 'Reference Txn ID',
  'Invoice Number', 'Balance Impact', 'Mã cổng', 'Nhóm GD', 'Txn gốc', 'Name'];
function ppRow(o) {
  const r = { 'Thời gian': LA('2026-10-03'), Type: 'Express Checkout Payment', Status: 'Completed', Currency: 'USD', Gross: 10, Fee: -0.5, Net: 9.5,
    'From Email Address': 'b@x.com', 'To Email Address': 's', 'Transaction ID': 'X', 'Reference Txn ID': '', 'Invoice Number': 'INV', 'Balance Impact': 'Credit',
    'Mã cổng': 'G', 'Nhóm GD': 'Thanh toán', 'Txn gốc': '', Name: 'Buyer', ...o };
  if (!o['Txn gốc']) r['Txn gốc'] = r['Transaction ID'];
  return PPH.map((h) => r[h]);
}
function appendRaw(rows) {
  const a = srcSheet('RAW_PP');
  a.getRange(a.getLastRow() + 1, 1, rows.length, PPH.length).setValues(rows);
}
const settledIds = () => sim.rows('Provider Transactions').map((p) => p.external_transaction_id);
/** Production-shaped canonical baseline: 169 Provider Transactions, 343 Provider Events, CUS002 payout CONFIRMED. */
function productionBaseline() {
  const ids = settledIds();
  const reserves = ids.map((id, i) => ppRow({ 'Transaction ID': 'RSV' + String(i).padStart(4, '0'), 'Reference Txn ID': id, 'Txn gốc': id, Type: 'Reserve Hold',
    'Nhóm GD': 'Reserve PP', 'Balance Impact': 'Debit', Gross: -3.03, Fee: 0, Net: -3.03 }));
  const withdrawals = [0, 1, 2, 3, 4, 5].map((i) => ppRow({ 'Transaction ID': 'WD' + i, Type: 'General Withdrawal', 'Nhóm GD': 'Rút tiền', 'Balance Impact': 'Debit',
    Gross: -1000 - i, Fee: 0, Net: -1000 - i, 'Thời gian': LA('2026-10-0' + (4 + (i % 5))) }));
  appendRaw([ppRow({ 'Transaction ID': '80B6789902665252D', Status: 'Pending', 'Balance Impact': 'Memo', Gross: 78.73, Fee: 0, Net: 78.73 })].concat(reserves, withdrawals));
  const p = js(call('runScheduledPaymentPipeline()'));
  assert.equal(p.status, 'SUCCESS', p.error);
  // CUS002 payout as in production: CONFIRMED 3037.444, fully allocated to its two settlements
  const states = js(call('verifySellerPayoutAllocations()')).obligation_states.filter((s) => s.seller_id === 'CUS002');
  const pc = call('getColumnNames_("Seller Payouts")');
  const ac = call('getColumnNames_("Seller Payout Allocations")');
  const id = 'SP-OPS-0C99D9F9B016F5A6';
  mS('Seller Payouts').api.getRange(2, 1, 1, pc.length).setValues([pc.map((c) => ({ seller_payout_id: id, seller_id: 'CUS002', payout_date: new Date('2026-10-13T04:00:00Z'),
    currency: 'USD', amount: 3037.444, fx_rate: 1, payout_currency: 'USD', payout_amount: 3037.444, payment_method: 'Bank', reference: 'PROD', status: 'CONFIRMED', notes: '' })[c] ?? '')]);
  mS('Seller Payout Allocations').api.getRange(2, 1, 2, ac.length).setValues(states.map((s) => ac.map((c) => ({ allocation_id: call('sellerAllocationId_')(id, 'SETTLEMENT', s.target_id),
    seller_payout_id: id, seller_id: 'CUS002', target_type: 'SETTLEMENT', target_id: s.target_id, payment_source: 'PAYPAL', currency: 'USD', allocated_amount: s.due_amount,
    created_at: new Date(), notes: '' })[c] ?? '')));
  const p2 = js(call('runScheduledPaymentPipeline()'));
  assert.equal(p2.status, 'SUCCESS', p2.error);
}
function canonicalSnapshot() {
  return JSON.stringify(['Provider Transactions', 'Provider Events', 'Settlements', 'Payment Legs', 'Settlement Items', 'Seller Balances', 'Seller Payouts',
    'Seller Payout Allocations'].map((n) => [n, mS(n).cells]));
}
function assertBaseline() {
  assert.equal(sim.rows('Provider Transactions').length, 169);
  assert.equal(sim.rows('Provider Events').length, 343);
  assert.equal(sim.rows('Settlements').length, 2);
  assert.equal(sim.rows('Payment Legs').filter((l) => l.settlement_status === 'AVAILABLE').length, 168);
  assert.equal(sim.rows('Settlement Items').length, 168);
  const b = sim.rows('Seller Balances');
  const sum = (f) => Math.round(b.reduce((a, x) => a + x[f] * 1e6, 0)) / 1e6;
  assert.deepEqual([sum('settled_amount'), sum('seller_hold_balance'), sum('paid_amount'), sum('current_balance')], [8370.0516, 1020.738, 3037.444, 5332.6076]);
  assert.ok(near(sim.balances().CUS002.current_balance, 0));
  assert.deepEqual(sim.rows('Seller Payouts').map((p) => [p.seller_payout_id, p.status]), [['SP-OPS-0C99D9F9B016F5A6', 'CONFIRMED']]);
}
const opsStatus = () => {
  const ops = mS('Operations').api;
  const rows = ops.getRange(call('OPERATIONS.statusStartRow'), 1, 5, 3).getValues();
  return Object.fromEntries(rows.map((r) => [r[0], [r[1], r[2]]]));
};

test.beforeEach(() => sim.restore());

test('baseline + successful run: Operations shows CURRENT / PASS / OK; settlements #1 and #2 are frozen', () => {
  productionBaseline();
  assertBaseline();
  call('refreshOperations()');
  const s = opsStatus();
  assert.equal(s['Latest pipeline'][0], 'SUCCESS');
  assert.deepEqual([s['Accounting state'][0], s.Health[0], s.Publishing[0]], ['CURRENT', 'PASS', 'OK']);
  const report = js(call('verifyKh001Settlements()'));
  assert.deepEqual(report.frozen_settlements.map((f) => f.settlement_id), ['ST-KH001-PAYPAL-000001', 'ST-KH001-PAYPAL-000002']);
  assert.ok(report.frozen_settlements.every((f) => f.reasons.includes('Settlement Items') && f.reasons.includes('Seller Payout Allocations')));
  assert.deepEqual(report.frozen_violations, []);
});

test('corrupted production batch (219 text-typed amounts, locale-swapped dates): PROVIDER_NORMALIZE fails, canonical baseline untouched, Operations STALE', () => {
  productionBaseline();
  const before = canonicalSnapshot();
  const logs = sim.child('CUS001').log.length;
  // rows like production rows 345+: Gross/Fee/Net written as text, MM/DD dates parsed as DD/MM (Oct 7 -> Jul 10, ...)
  const swapped = ['2026-07-10', '2026-08-10', '2026-09-10', '2026-10-10'];
  const bad = Array.from({ length: 219 }, (_x, i) => ppRow({ 'Transaction ID': 'BAD' + String(i).padStart(4, '0'), 'Thời gian': LA(swapped[i % 4]),
    Gross: '56.98', Fee: '-2.48', Net: '54.50' }));
  appendRaw(bad);
  const p = js(call('runScheduledPaymentPipeline()'));
  assert.equal(p.status, 'FAILED');
  assert.equal(p.failed_stage, 'PROVIDER_NORMALIZE');
  assert.match(p.error, /KH001 provider transaction normalization failed \(219 error\(s\)\): Non-numeric Gross\/Fee\/Net for Transaction ID BAD0000/);
  assert.equal(canonicalSnapshot(), before, 'no canonical table changed');
  assertBaseline();
  assert.equal(sim.child('CUS001').log.length, logs, 'nothing published');
  call('refreshOperations()');
  const s = opsStatus();
  assert.equal(s['Latest pipeline'][0], 'FAILED');
  assert.match(s['Latest pipeline'][1], /failed at PROVIDER_NORMALIZE/);
  assert.deepEqual([s['Accounting state'][0], s.Health[0], s.Publishing[0]], ['LAST_KNOWN_GOOD', 'STALE', 'BLOCKED']);
  assert.match(s.Health[1], /^last PASS /, 'the old PASS is kept as history, not shown as current');
});

test('the same lifecycle typed correctly (after an importer fix): new payment / event types normalize, frozen settlements unchanged, balances unchanged', () => {
  productionBaseline();
  const settledBefore = JSON.stringify(sim.rows('Settlements'));
  const settled = settledIds().filter((x) => /^9X/.test(x));
  const rsvRoot = sim.rows('Provider Events').find((e) => e.external_event_id === 'RSV0002').related_external_transaction_id;
  appendRaw([
    ppRow({ 'Transaction ID': 'DCC0001', Type: 'Direct Credit Card Payment', Gross: 56.98, Fee: -2.48, Net: 54.5, 'Thời gian': LA('2026-10-11') }),
    ppRow({ 'Transaction ID': settled[0], Status: 'Reversed', 'Balance Impact': 'Memo', Gross: -10, Fee: 0, Net: -10, 'Thời gian': LA('2026-10-12') }),
    ppRow({ 'Transaction ID': 'RFD0001', 'Reference Txn ID': settled[1], 'Txn gốc': settled[1], Type: 'Payment Refund', 'Nhóm GD': 'Hoàn tiền', 'Balance Impact': 'Debit',
      Gross: -5, Fee: 0.2, Net: -4.8, 'Thời gian': LA('2026-10-12') }),
    ppRow({ 'Transaction ID': 'REL0001', 'Reference Txn ID': 'RSV0002', 'Txn gốc': rsvRoot,
      Type: 'Reserve Release', 'Nhóm GD': 'Reserve PP', 'Balance Impact': 'Credit', Gross: 3.03, Fee: 0, Net: 3.03, 'Thời gian': LA('2026-10-13') }),
    ppRow({ 'Transaction ID': 'HLD0001', 'Reference Txn ID': settled[2], 'Txn gốc': settled[2], Type: 'General Hold', 'Nhóm GD': 'Tạm giữ dispute', 'Balance Impact': 'Debit',
      Gross: -7, Fee: 0, Net: -7, 'Thời gian': LA('2026-10-13') }),
    ppRow({ 'Transaction ID': 'UWD0001', Type: 'User Initiated Withdrawal', 'Nhóm GD': 'Rút tiền', 'Balance Impact': 'Debit', Gross: -20, Fee: 0, Net: -20 }),
    ppRow({ 'Transaction ID': 'WDR0001', 'Reference Txn ID': 'WD0', Type: 'Reversal of ACH Withdrawal Transaction', 'Nhóm GD': 'Rút tiền', Status: 'Denied',
      'Balance Impact': 'Memo', Gross: 1000, Fee: 0, Net: 1000 }),
  ]);
  const p = js(call('runScheduledPaymentPipeline()'));
  assert.equal(p.status, 'SUCCESS', p.error);
  assert.equal(sim.rows('Provider Transactions').length, 170, '+1 Direct Credit Card payment; the reversal is not a payment');
  const ev = sim.rows('Provider Events');
  assert.equal(ev.length, 343 + 7);
  const types = ev.reduce((a, e) => { a[e.event_type] = (a[e.event_type] || 0) + 1; return a; }, {});
  assert.deepEqual(types, { PAYMENT: 170, PAYMENT_REVERSAL: 1, REFUND: 1, RESERVE_HOLD: 168, RESERVE_RELEASE: 1, DISPUTE_HOLD: 1, WITHDRAWAL: 7, WITHDRAWAL_REVERSAL: 1 });
  const reversed = sim.rows('Provider Transactions').find((t) => t.external_transaction_id === settled[0]);
  assert.deepEqual([reversed.external_status, reversed.balance_impact], ['Completed', 'Credit'], 'payment economics untouched by its reversal');
  assert.equal(JSON.stringify(sim.rows('Settlements')), settledBefore, 'frozen settlements #1 / #2 not reinterpreted');
  assert.equal(sim.rows('Settlement Items').length, 168);
  assert.equal(sim.rows('Payment Legs').filter((l) => l.settlement_status === 'AVAILABLE').length, 168);
  const b = sim.rows('Seller Balances');
  assert.equal(Math.round(b.reduce((a, x) => a + x.current_balance * 1e6, 0)) / 1e6, 5332.6076, 'no new seller-side effect');
});

test('frozen settlement gate (I/O): a provider edit to a settled transaction fails SETTLEMENT_REFRESH before any write; a new settlement appends', () => {
  productionBaseline();
  const before = canonicalSnapshot();
  // provider edits DoiSoat_GD of a transaction in settlement #1: provider fee +0.5, payout -0.5 (row equations still hold)
  const rc = srcSheet('DoiSoat_GD');
  const grid = rc.getRange(1, 1, rc.getLastRow(), 17).getValues();
  const r = grid.findIndex((row, i) => i >= 6 && row[12] instanceof Date && row[12].toISOString().startsWith('2026-10-04'));
  rc.getRange(r + 1, 15, 1, 1).setValues([[grid[r][14] + 0.5]]);
  rc.getRange(r + 1, 17, 1, 1).setValues([[grid[r][16] - 0.5]]);
  const p = js(call('runScheduledPaymentPipeline()'));
  assert.equal(p.status, 'FAILED');
  assert.equal(p.failed_stage, 'SETTLEMENT_REFRESH');
  assert.match(p.error, /Frozen settlement guard: the rebuild would change 1 frozen settlement\(s\); nothing written: Frozen settlement ST-KH001-PAYPAL-000001 .* would change: provider_fee_amount .*transaction_payout_amount/);
  const after = JSON.parse(canonicalSnapshot());
  const was = JSON.parse(before);
  ['Settlements', 'Payment Legs', 'Settlement Items', 'Seller Balances', 'Seller Payouts', 'Seller Payout Allocations'].forEach((n) => {
    assert.deepEqual(after.find((x) => x[0] === n), was.find((x) => x[0] === n), n + ' untouched');
  });
  assert.ok(js(call('verifyKh001Settlements()')).frozen_violations.length === 1);
  call('refreshOperations()');
  assert.deepEqual([opsStatus()['Accounting state'][0], opsStatus().Health[0]], ['LAST_KNOWN_GOOD', 'STALE']);
  // undo the edit; append settlement #3 (new period) -> appended, #1 / #2 identical
  rc.getRange(r + 1, 15, 1, 1).setValues([[grid[r][14]]]);
  rc.getRange(r + 1, 17, 1, 1).setValues([[grid[r][16]]]);
  const ph = srcSheet('PhieuDoiSoat');
  const hist = ph.getRange(1, 1, ph.getLastRow(), 17).getValues();
  const last = hist[hist.length - 1];
  const row3 = last.slice();
  row3[0] = 3; row3[1] = LA('2026-10-10'); row3[2] = LA('2026-10-14'); row3[3] = '';
  [4, 5, 6, 7, 8, 9, 10].forEach((c) => { row3[c] = 0; });
  row3[11] = last[11]; row3[14] = ''; row3[15] = ''; row3[16] = '';
  ph.getRange(ph.getLastRow() + 1, 1, 1, 17).setValues([row3]);
  const content = (rows) => JSON.stringify(rows.map((r) => ({ ...r, normalized_at: '' }))); // the partition stamp is refreshed on any rewrite
  const st12 = content(sim.rows('Settlements'));
  call('syncKh001Raw()');
  assert.ok(['SUCCESS', 'NO_CHANGE'].includes(js(call('normalizeKh001ProviderTransactions()')).status), 'Settlements depend on current Provider Transactions');
  const n = js(call('normalizeKh001Settlements()'));
  assert.equal(n.status, 'SUCCESS', n.error);
  const rows = sim.rows('Settlements');
  assert.equal(rows.length, 3);
  assert.equal(content(rows.slice(0, 2)), st12, '#1 and #2 unchanged (every value; only the partition stamp normalized_at moves)');
  assert.equal(rows[2].settlement_id, 'ST-KH001-PAYPAL-000003');
});

test('Operations health semantics (pure): FAILED before the health gate -> LAST_KNOWN_GOOD / STALE / BLOCKED; success -> CURRENT / PASS / OK', () => {
  const f = (v) => String(v);
  const pass = { at: 'T1', status: 'PASS' };
  const st = (audit) => js(H.operationsPipelineState_(Object.assign({ skipped: null, health: pass, last_pass: { at: 'T1' } }, audit), f));
  const ok = st({ pipeline: { at: 'T2', status: 'SUCCESS', run_id: 'R2', stage: '', error: '' } });
  assert.deepEqual([ok.pipeline[0], ok.accounting[0], ok.health[0], ok.publishing[0]], ['SUCCESS', 'CURRENT', 'PASS', 'OK']);
  const failed = st({ pipeline: { at: 'T3', status: 'FAILED', run_id: 'R3', stage: 'PROVIDER_NORMALIZE', error: '219 error(s)' } });
  assert.deepEqual([failed.pipeline[0], failed.accounting[0], failed.health[0], failed.health[1], failed.publishing[0]],
    ['FAILED', 'LAST_KNOWN_GOOD', 'STALE', 'last PASS T1', 'BLOCKED']);
  const gate = st({ pipeline: { at: 'T3', status: 'FAILED', run_id: 'R3', stage: 'HEALTH_CHECK', error: 'x' }, health: { at: 'T3', status: 'FAIL' } });
  assert.deepEqual([gate.accounting[0], gate.health[0], gate.publishing[0]], ['CHECK_FAILED', 'FAIL', 'BLOCKED']);
  const pub = st({ pipeline: { at: 'T3', status: 'FAILED', run_id: 'R3', stage: 'SELLER_SHEETS_SYNC', error: 'x' }, health: { at: 'T3', status: 'PASS' } });
  assert.deepEqual([pub.accounting[0], pub.health[0], pub.publishing[0]], ['CURRENT', 'PASS', 'FAILED']);
  const later = st({ pipeline: { at: 'T2', status: 'SUCCESS', run_id: 'R2', stage: '', error: '' }, health: { at: 'T4', status: 'FAIL' } });
  assert.deepEqual([later.accounting[0], later.health[0], later.publishing[0]], ['CHECK_FAILED', 'FAIL', 'BLOCKED']);
  const none = st({ pipeline: null, health: null, last_pass: null });
  assert.deepEqual([none.pipeline[0], none.accounting[0], none.health[0]], ['never', 'UNKNOWN', 'never']);
});
