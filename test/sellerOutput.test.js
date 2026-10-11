// Unit tests for the seller output contract v2 (SellerOutput.gs): template preflight, the four-tab model,
// the HUI production regression and the multi-provider (PAYPAL 8% / STRIPE 5%) fixture. Fake data.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeSpreadsheet, TEMPLATE } = require('./helpers/sellerFakes');
const { makeMaster, huiSpec } = require('./helpers/sellerMaster');

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
const makeDate = (ms) => vm.runInContext(`new Date(${ms})`, context);
const NY = (v) => H.providerDateKey_(v, 'America/New_York');
const near = (a, b) => Math.abs(a - b) < 1e-6;
const build = (spec) => {
  const out = H.buildSellerOutputs_({ ...makeMaster(D, spec), sellers: spec.sellers, dateKeyOf: NY });
  assert.deepEqual(js(out.errors), []);
  return out.snapshots;
};
const template = () => makeSpreadsheet({ id: 'TEMPLATE_ID_0000000000000000001', makeDate });
const validate = (ss, mode) => js(H.validateSellerWorkbook_(H.readSellerWorkbook_(ss.api), { mode: mode || 'template', hiddenIds: ['MASTER_ID_000000000000000000001'] }));
const D_COLS = js(vm.runInContext('SELLER_TEMPLATE.doiSoatHeaders', context));
const doiSoat = (snap) => snap.blocks.DoiSoat_GD.rows.map((r) => Object.fromEntries(D_COLS.map((c, i) => [c, r[i]])));

// ---- Template preflight --------------------------------------------------------------------------------
test('template contract: the VNS template replica passes with the observed layout', () => {
  const v = validate(template());
  assert.deepEqual(v.errors, []);
  assert.deepEqual([v.layouts.DoiSoat_GD.headerRow, v.layouts.DoiSoat_GD.dataStart, v.layouts.DoiSoat_GD.dataEnd], [6, 7, 1006]);
  assert.deepEqual([v.layouts.TongHop_Thang.dataStart, v.layouts.TongHop_Thang.dataEnd, v.layouts.TongHop_Thang.footerRow], [5, 8, 9]);
  const p = v.layouts.PhieuDoiSoat;
  assert.deepEqual([p.seller, p.pending, p.srcStart, p.srcEnd, p.totalRow, p.bRows[0], p.bRows[13], p.cRows[0], p.checkRow, p.histStart, p.histEnd, p.pendRow, p.startRow],
    [4, 7, 11, 20, 21, 24, 37, 41, 45, 50, 78, 79, 85]);
  assert.deepEqual([v.layouts.Dispute.dataStart, v.layouts.Dispute.dataEnd], [8, 500]);
  assert.equal(Object.keys(v.layouts.DoiSoat_GD.approved).length, 14, '4 COUNTIF + 10 SUBTOTAL presentation formulas');
});

test('template contract: unexpected / RAW / old Phase 2K tabs, hidden required tabs and _Sync in a template fail (nothing deleted)', () => {
  for (const [name, hidden, re] of [['RAW_PP', false, /unexpected visible tab "RAW_PP" \(provider raw tab\)/], ['Summary', false, /old Phase 2K tab/],
    ['Notes', true, /unexpected hidden tab "Notes"/], ['_Sync', true, /unexpected hidden tab "_Sync"/]]) {
    const ss = template();
    ss.api.insertSheet(name);
    if (hidden) ss.api.getSheetByName(name).hideSheet();
    assert.match(validate(ss).errors.join(' | '), re);
    assert.ok(ss.sheets.some((s) => s.name === name), 'never deleted');
  }
  const hiddenTab = template();
  hiddenTab.api.getSheetByName('Dispute').hideSheet();
  assert.match(validate(hiddenTab).errors.join(), /tab "Dispute" must be visible/);
  const missing = template();
  missing.sheets.splice(1, 1);
  assert.match(validate(missing).errors.join(), /required tab "TongHop_Thang" is missing/);
});

test('template contract: formulas only at approved presentation cells; forbidden references and data-row formulas fail', () => {
  const set = (tab, r, c, f) => { const ss = template(); ss.api.getSheetByName(tab).getRange(r, c).setFormula(f); return validate(ss).errors.join(' | '); };
  assert.match(set('DoiSoat_GD', 7, 16, '=O7*0.08'), /unexpected formula at R7C16/);
  assert.match(set('TongHop_Thang', 5, 8, '=G5*0.08'), /unexpected formula at R5C8/);
  assert.match(set('PhieuDoiSoat', 24, 2, '=SUM(1,2)'), /unexpected formula at R24C2/);
  assert.match(set('DoiSoat_GD', 3, 3, '=IMPORTRANGE("x","RAW_PP!A1")'), /forbidden reference in formula at R3C3/);
  assert.match(set('Dispute', 9, 14, '=RAW_KH!A1'), /forbidden reference/);
  const ss = template();
  ss.api.getSheetByName('DoiSoat_GD').getRange(4, 8).setValue('');
  assert.match(validate(ss).errors.join(), /SUBTOTAL anchor in H4 is missing/);
  const noDay = template();
  noDay.api.getSheetByName('Dispute').getRange(30, 14).setValue('');
  assert.match(validate(noDay).errors.join(), /approved presentation formula missing at R30C14/);
});

test('template contract: headers / anchors are exact; tokens, protected IDs and e-mails are rejected', () => {
  const edit = (tab, r, c, v) => { const ss = template(); ss.api.getSheetByName(tab).getRange(r, c).setValue(v); return validate(ss).errors.join(' | '); };
  assert.match(edit('DoiSoat_GD', 6, 12, 'Seller rate'), /expected exactly one header row|header row 6 does not match/);
  assert.match(edit('TongHop_Thang', 9, 1, 'Footer'), /footer note "Logic:"/);
  assert.match(edit('PhieuDoiSoat', 30, 1, 'Điều chỉnh'), /section B labels do not match/);
  assert.match(edit('Dispute', 7, 13, 'Balance'), /header row 7 does not match/);
  assert.match(edit('PhieuDoiSoat', 2, 3, 'glk_AbC123'), /endpoint token or credential/);
  assert.match(edit('PhieuDoiSoat', 2, 3, 'see MASTER_ID_000000000000000000001'), /protected spreadsheet ID/);
  assert.match(edit('Dispute', 2, 13, 'support@seller.com'), /e-mail address/);
});

// ---- HUI regression ------------------------------------------------------------------------------------
test('HUI (CUS002) regression: totals, identity, PAYPAL 8%; provider 7% fee never shown', () => {
  const hui = build(huiSpec()).CUS002;
  const t = hui.totals;
  assert.deepEqual([t.total_transactions, t.matched_transactions, t.missing_provider_transactions], [143, 74, 69]);
  [['total_order_amount', 7362.27], ['matched_gross', 3860.51], ['processing_fee', 156.31], ['net', 3704.2], ['seller_fee', 296.336],
    ['seller_hold', 370.42], ['current_balance', 3037.444], ['known_obligation', 3407.864], ['missing_provider_order_amount', 3501.76]]
    .forEach(([k, e]) => assert.ok(near(t[k], e), k + ' ' + t[k]));
  assert.ok(near(t.current_balance + t.seller_hold + t.seller_fee + t.processing_fee + t.missing_provider_order_amount, t.total_order_amount), 'identity');
  assert.deepEqual(js(t.seller_fee_rates), { PAYPAL: [0.08] });
  const reg = js(H.evaluateSellerSheetsRegression_({ CUS002: hui }));
  assert.deepEqual(reg.checks.filter((c) => c.name.startsWith('CUS002') && !c.pass), []);
  const phieu = hui.blocks.PhieuDoiSoat;
  assert.deepEqual(js(phieu.info).slice(0, 1).concat([phieu.info[3], phieu.info[4], phieu.info[5]]), ['HUI (CUS002)', 3501.76, '69 GD', 370.42]);
  assert.ok(near(phieu.b[0], 3860.51) && near(phieu.b[1], 156.31) && near(phieu.b[2], 296.336) && near(phieu.b[3], 370.42) && near(phieu.b[10], 3037.444));
  assert.ok(near(phieu.b[13], 370.42));
  assert.deepEqual(js(phieu.c), [[74, 3860.51], [0, 0], [69, 3501.76], [0, 0]]);
  assert.match(phieu.check[0], /^OK — 74\/74/);
  const month = hui.blocks.TongHop_Thang.rows[0];
  assert.deepEqual([month[3], month[2]], [143, 1]);
  assert.ok(near(month[7], 296.336) && near(month[16], 3037.444) && near(month[17], 3407.864) && near(month[10], 370.42));
  const providerFee = Math.round(3704.2 * 0.07 * 1e6) / 1e6;
  const text = JSON.stringify(hui.blocks);
  assert.ok(!text.includes(String(providerFee)) && !text.includes('0.07'), 'provider fee / rate absent');
  assert.ok(!/glk_|buyer@example|SUB-1x/.test(text));
});

// ---- Multi-provider --------------------------------------------------------------------------------------
function multiSpec() {
  return {
    sellers: [{ seller_id: 'CUS002', seller_name: 'HUI' }],
    txs: [
      { id: 'P1', seller: 'CUS002', order: 104, leg: { fee: 4, rate: 0.08, settlement: 'ST-1' } },
      { id: 'P2', seller: 'CUS002', order: 54, leg: { fee: 4, rate: 0.08, settlement: 'ST-1' } },
      { id: 'S1', seller: 'CUS002', source: 'STRIPE', provider: 'STRIPE01', order: 203, leg: { fee: 3, rate: 0.05, settlement: 'ST-S1' } },
      { id: 'S2', seller: 'CUS002', source: 'STRIPE', order: 77.5, status: 'MISSING_PROVIDER', created: '2026-10-05T15:00:00Z' },
    ],
    settlements: [
      { settlement_id: 'ST-1', payment_source: 'PAYPAL', source_settlement_number: 1, period_start_date: D('2026-10-01T04:00:00Z'), period_end_date: D('2026-10-04T04:00:00Z'),
        source_payment_date: D('2026-10-06T04:00:00Z') },
      { settlement_id: 'ST-S1', payment_source: 'STRIPE', source_settlement_number: 1, period_start_date: D('2026-10-01T04:00:00Z'), period_end_date: D('2026-10-03T04:00:00Z'),
        source_payment_date: D('2026-10-05T04:00:00Z') }],
    terms: [{ seller_id: 'CUS002', payment_source: 'PAYPAL', seller_fee_rate: 0.08, effective_from: '2026-10-01', effective_to: '' },
      { seller_id: 'CUS002', payment_source: 'STRIPE', seller_fee_rate: 0.05, effective_from: '2026-10-01', effective_to: '' }],
  };
}

test('multi-provider: one DoiSoat_GD with PAYPAL 8% and STRIPE 5% rows; STRIPE MISSING_PROVIDER economics blank', () => {
  const snap = build(multiSpec()).CUS002;
  const rows = doiSoat(snap);
  const by = (id) => rows.find((r) => r['Transaction ID'] === id);
  assert.deepEqual([by('P1')['Cổng thanh toán'], by('P1')['Tỷ lệ VNS'], by('P1')['Trạng thái']], ['PAYPAL', 0.08, 'Khớp']);
  assert.deepEqual([by('S1')['Cổng thanh toán'], by('S1')['Tỷ lệ VNS'], by('S1')['Phí VNS']], ['STRIPE', 0.05, 200 * 0.05]);
  assert.equal(by('S1')['Doanh thu (Gross)'], 203, 'gross from provider economics');
  const miss = by('S2');
  assert.deepEqual([miss['Có trên hệ thống'], miss['Có trên cổng'], miss['Trạng thái'], miss['Cổng thanh toán'], miss['Số tiền đơn'], miss['Sub account']],
    [1, 0, 'Thiếu trên cổng', 'STRIPE', 77.5, 'SUB-1']);
  ['Gross cổng', 'Chênh lệch', 'Refund / Dispute', 'Tỷ lệ VNS', 'Doanh thu (Gross)', 'Phí cổng', 'Net', 'Phí VNS', 'Hold', 'Lần chốt (ngày)',
    'Ngày VNS nhận tiền', 'Trạng thái chốt', 'Thực nhận'].forEach((c) => assert.equal(miss[c], '', 'blank ' + c));
  assert.ok(by('P1')['Thời gian GD'].getTime() > 0);
  assert.equal(new Date(by('P1')['Lần chốt (ngày)']).toISOString(), '2026-10-04T12:00:00.000Z', 'date-only value anchored at 12:00 UTC to avoid date drift in the supported seller-template time zones');
});

test('multi-provider: TongHop_Thang Phí VNS = SUM of frozen seller_fee (not Net x one rate); PhieuDoiSoat section A per source', () => {
  const snap = build(multiSpec()).CUS002;
  const m = snap.blocks.TongHop_Thang.rows[0];
  const fees = 100 * 0.08 + 50 * 0.08 + 200 * 0.05;
  assert.ok(near(m[7], fees));
  assert.ok(!near(m[7], m[6] * 0.08), 'not net x 8%');
  assert.equal(m[2], 2, 'two payment sources used');
  assert.equal(m[3], 4);
  const src = js(snap.blocks.PhieuDoiSoat.sources);
  assert.deepEqual(src.map((r) => [r[0], r[1], r[5]]), [['PAYPAL', 2, 0.08], ['STRIPE', 1, 0.05]]);
  assert.ok(near(snap.blocks.PhieuDoiSoat.total[5], fees));
  assert.equal(snap.blocks.PhieuDoiSoat.total[4], '', 'no single rate on the total row');
  const history = js(snap.blocks.PhieuDoiSoat.history);
  assert.deepEqual(history.map((r) => r[0]), ['STRIPE #1 · UNPAID', 'PAYPAL #1 · UNPAID'], 'provider-aware labels: both sources have a settlement #1');
  assert.ok(near(history[1][6], snap.totals.current_balance), 'G = running balance after the settlement');
  assert.ok(near(history[1][8], history[1][4]) && history[1][7] === 0, 'unpaid period: paid 0, remaining = due');
});

test('Section A shows no single rate when a source has several effective rates in the period', () => {
  const spec = multiSpec();
  spec.txs.push({ id: 'P3', seller: 'CUS002', order: 104, created: '2026-10-03T15:00:00Z', leg: { fee: 4, rate: 0.07, settlement: 'ST-1' } });
  const src = js(build(spec).CUS002.blocks.PhieuDoiSoat.sources);
  assert.deepEqual(src.find((r) => r[0] === 'PAYPAL')[5], '');
  assert.ok(near(src.find((r) => r[0] === 'PAYPAL')[6], 100 * 0.08 + 50 * 0.08 + 100 * 0.07), 'fee total still exact');
});

test('ledgers: only SENT/CONFIRMED payouts and APPLIED adjustments count; section D carries the balance; DRAFT never deducted', () => {
  const spec = multiSpec();
  spec.payouts = [{ seller_payout_id: 'SP1', seller_id: 'CUS002', payout_date: D('2026-10-09T04:00:00Z'), currency: 'USD', amount: 100, status: 'SENT',
    payment_method: 'Bank', reference: 'R1', fx_rate: 25300, payout_currency: 'VND', payout_amount: 2530000 },
  { seller_payout_id: 'SP2', seller_id: 'CUS002', payout_date: D('2026-10-09T04:00:00Z'), currency: 'USD', amount: 999, status: 'DRAFT' }];
  spec.allocations = [{ allocation_id: H.sellerAllocationId_('SP1', 'ST-1'), seller_payout_id: 'SP1', seller_id: 'CUS002', settlement_id: 'ST-1', payment_source: 'PAYPAL', currency: 'USD', allocated_amount: 100 }];
  spec.adjustments = [{ adjustment_id: 'A1', adjustment_type: 'HOLD_RELEASE', seller_id: 'CUS002', currency: 'USD', amount: 5, status: 'APPLIED',
    effective_date: D('2026-10-10T04:00:00Z') }, { adjustment_id: 'A2', adjustment_type: 'MANUAL_ADJUSTMENT', seller_id: 'CUS002', currency: 'USD',
    amount: 50, status: 'PENDING', effective_date: D('2026-10-10T04:00:00Z') }];
  const snap = build(spec).CUS002;
  const b = snap.blocks.PhieuDoiSoat.b;
  assert.ok(near(b[4], 5) && near(b[9], 100) && near(b[11 - 0], 25300) && near(b[12], 2530000));
  assert.ok(near(b[10], snap.totals.current_balance));
  const h = js(snap.blocks.PhieuDoiSoat.history);
  assert.deepEqual(h.map((r) => r[0]), ['STRIPE #1 · UNPAID', 'PAYPAL #1 · PARTIAL', 'Payout', 'HOLD_RELEASE']);
  assert.ok(near(h[2][7], 100), 'payout deducted once');
  assert.ok(near(h[3][10], 5) && near(h[3][11], snap.totals.seller_hold));
  assert.ok(!JSON.stringify(snap.blocks).includes('999'), 'DRAFT payout never published');
});

test('isolation and integrity: other sellers never appear; unsupported currency / missing match fail closed', () => {
  const spec = multiSpec();
  spec.sellers.push({ seller_id: 'CUS003', seller_name: 'DINO' });
  spec.txs.push({ id: 'D1', seller: 'CUS003', order: 30, leg: { fee: 1, rate: 0.08, settlement: 'ST-1' } });
  const snaps = build(spec);
  assert.ok(!doiSoat(snaps.CUS002).some((r) => r['Transaction ID'] === 'D1'));
  assert.deepEqual(js(doiSoat(snaps.CUS003).map((r) => r['Transaction ID'])), ['D1']);
  const master = makeMaster(D, multiSpec());
  master.transactions[0].currency = 'EUR';
  assert.match(js(H.buildSellerOutputs_({ ...master, sellers: multiSpec().sellers, dateKeyOf: NY }).errors).join(), /is not USD/);
  const m2 = makeMaster(D, multiSpec());
  m2.matches = m2.matches.slice(1);
  assert.match(js(H.buildSellerOutputs_({ ...m2, sellers: multiSpec().sellers, dateKeyOf: NY }).errors).join(), /P1 has no Payment Matches row/);
});

test('Dispute: only canonical cases attributable to the seller; no customer data; applied effects shown; none -> no rows', () => {
  assert.deepEqual(js(build(multiSpec()).CUS002.blocks.Dispute.rows), [], 'no canonical dispute -> clean (no rows)');
  const spec = multiSpec();
  spec.sellers.push({ seller_id: 'CUS003', seller_name: 'DINO' });
  spec.txs.push({ id: 'D1', seller: 'CUS003', order: 30, leg: { fee: 1, rate: 0.08, settlement: 'ST-1' } });
  const dispute = (id, seller, tx, o) => ({ dispute_id: id, payment_source: 'PAYPAL', external_dispute_id: 'PP-' + id, external_transaction_id: tx,
    internal_transaction_id: tx, payment_leg_id: '', seller_id: seller, provider: 'KH001', currency: 'USD', dispute_amount: 20, dispute_fee: 15,
    reason: 'Item not received', dispute_status: 'OPEN', opened_at: D('2026-10-07T15:00:00Z'), due_at: D('2026-10-17T15:00:00Z'), resolved_at: '',
    notes: 'buyer phone 0900 / internal', ...o });
  spec.disputes = [dispute('DS1', 'CUS002', 'P1'), dispute('DS2', 'CUS003', 'D1'), dispute('DS3', 'CUS002', 'D1')];
  spec.adjustments = [{ adjustment_id: 'AD1', adjustment_type: 'DISPUTE_FEE', seller_id: 'CUS002', currency: 'USD', amount: -15, status: 'APPLIED',
    dispute_id: 'DS1', internal_transaction_id: 'P1', effective_date: D('2026-10-08T04:00:00Z') }];
  const snaps = build(spec);
  const rows = js(snaps.CUS002.blocks.Dispute.rows);
  assert.deepEqual(rows.map((r) => r[1]), ['PP-DS1'], "another seller's case and a case on another seller's transaction are excluded");
  const [row] = rows;
  assert.deepEqual([row[2], row[3], row[4], row[5], row[7], row[9], row[10], row[11], row[12]], ['P1', 'PAYPAL', 'O-P1', 'Item not received', 'OPEN', 20, 'USD', 15, -15]);
  assert.equal(row.length, 17, 'column N (Số ngày còn lại) is never written');
  assert.ok(!JSON.stringify(rows).includes('buyer phone'), 'internal notes / PII never output');
  assert.deepEqual(js(snaps.CUS002.blocks.DoiSoat_GD.rows).find((r) => r[0] === 'P1')[10], -15, 'Refund / Dispute from canonical APPLIED adjustments');
  assert.equal(snaps.CUS002.blocks.TongHop_Thang.rows[0][12], 1, 'Số dispute');
});

test('TongHop_Thang hold / available are recognised in the provider-paid (AVAILABLE) month, like Seller Balances', () => {
  const spec = {
    sellers: [{ seller_id: 'CUS002', seller_name: 'HUI' }],
    txs: [{ id: 'X1', seller: 'CUS002', order: 104, created: '2026-09-30T15:00:00Z', leg: { fee: 4, rate: 0.08, settlement: 'ST-9' } }],
    settlements: [{ settlement_id: 'ST-9', payment_source: 'PAYPAL', source_settlement_number: 3, period_start_date: D('2026-09-28T04:00:00Z'),
      period_end_date: D('2026-09-30T04:00:00Z'), source_payment_date: D('2026-10-02T04:00:00Z') }],
    adjustments: [{ adjustment_id: 'HR1', adjustment_type: 'HOLD_RELEASE', seller_id: 'CUS002', currency: 'USD', amount: 4, status: 'APPLIED',
      effective_date: D('2026-11-20T05:00:00Z') }],
    terms: [{ seller_id: 'CUS002', payment_source: 'PAYPAL', seller_fee_rate: 0.08, effective_from: '2026-09-01', effective_to: '' }],
  };
  const rows = js(build(spec).CUS002.blocks.TongHop_Thang.rows);
  const col = js(vm.runInContext('SELLER_TEMPLATE.tongHopHeaders', context));
  const m = (i) => Object.fromEntries(col.map((c, j) => [c, rows[i][j]]));
  const [sep, oct, nov] = [m(0), m(1), m(2)];
  assert.deepEqual([sep['Tháng'], oct['Tháng'], nov['Tháng']].map((d) => d.slice(0, 7)), ['2026-09', '2026-10', '2026-11']);
  // Transaction-month figures stay in September ...
  assert.deepEqual([sep['Số GD'], sep['Doanh thu (Gross)'], sep['Net']], [1, 104, 100]);
  assert.ok(near(sep['Phí VNS'], 8));
  // ... while hold / available are recognised when the provider paid (October).
  assert.deepEqual([sep['Hold phát sinh'], sep['Số dư hold cuối tháng'], sep['Available seller']], [0, 0, 0]);
  assert.ok(near(oct['Hold phát sinh'], 10) && near(oct['Số dư hold cuối tháng'], 10) && near(oct['Available seller'], 82));
  assert.deepEqual([oct['Số GD'], oct['Phí VNS']], [0, 0]);
  // An actual HOLD_RELEASE in a later month lowers the month-end hold by exactly that amount.
  assert.ok(near(nov['Hold đã hoàn'], 4) && near(nov['Số dư hold cuối tháng'], 6) && near(nov['Hold phát sinh'], 0));
  assert.ok(near(nov['Balance còn lại'], 86), 'released hold is credited to the balance');
});

test('template fixture formats: Tỷ lệ VNS is a 0.00% cell in DoiSoat_GD and PhieuDoiSoat section A (current template)', () => {
  const nf = TEMPLATE.numberFormats;
  const cellsOf = (name) => TEMPLATE.sheets.find((s) => s.name === name).cells;
  for (let r = 7; r <= 1006; r += 333) assert.equal(nf[cellsOf('DoiSoat_GD')[r + ',12'].s], '0.00%', 'DoiSoat_GD L' + r);
  for (let r = 11; r <= 21; r++) assert.equal(nf[cellsOf('PhieuDoiSoat')[r + ',6'].s], '0.00%', 'PhieuDoiSoat F' + r);
  assert.notEqual(nf[cellsOf('PhieuDoiSoat')['11,7'].s], '0.00%', 'only the rate column is a percentage');
});

test('16-17 Section D: PAYPAL #1 · PAID / PAYPAL #2 · PARTIAL / STRIPE #1 · UNPAID from allocations; payouts deducted once', () => {
  const spec = multiSpec();
  spec.txs.push({ id: 'P3', seller: 'CUS002', order: 104, created: '2026-10-06T15:00:00Z', leg: { fee: 4, rate: 0.08, settlement: 'ST-2' } });
  spec.settlements.push({ settlement_id: 'ST-2', payment_source: 'PAYPAL', source_settlement_number: 2, period_start_date: D('2026-10-05T04:00:00Z'),
    period_end_date: D('2026-10-09T04:00:00Z'), source_payment_date: D('2026-10-10T04:00:00Z') });
  // Dues: PAYPAL #1 = 82 + 41 = 123, PAYPAL #2 = 82, STRIPE #1 = 170.
  spec.payouts = [{ seller_payout_id: 'SP-A', seller_id: 'CUS002', payout_date: D('2026-10-11T04:00:00Z'), currency: 'USD', amount: 150, status: 'CONFIRMED',
    payment_method: 'Bank', reference: 'W1' }, { seller_payout_id: 'SP-D', seller_id: 'CUS002', payout_date: D('2026-10-12T04:00:00Z'), currency: 'USD',
    amount: 40, status: 'DRAFT' }];
  const a = (pid, st, amt) => ({ allocation_id: H.sellerAllocationId_(pid, st), seller_payout_id: pid, seller_id: 'CUS002', settlement_id: st,
    payment_source: 'PAYPAL', currency: 'USD', allocated_amount: amt });
  spec.allocations = [a('SP-A', 'ST-1', 123), a('SP-A', 'ST-2', 27), a('SP-D', 'ST-2', 40)];
  const snap = build(spec).CUS002;
  const h = js(snap.blocks.PhieuDoiSoat.history);
  assert.deepEqual(h.map((r) => r[0]), ['STRIPE #1 · UNPAID', 'PAYPAL #1 · PAID', 'PAYPAL #2 · PARTIAL', 'Payout']);
  const row = (label) => h.find((r) => r[0] === label);
  assert.deepEqual([row('PAYPAL #1 · PAID')[4], row('PAYPAL #1 · PAID')[7], row('PAYPAL #1 · PAID')[8]], [123, 123, 0], 'due / allocated / remaining');
  assert.deepEqual([row('PAYPAL #2 · PARTIAL')[4], row('PAYPAL #2 · PARTIAL')[7], row('PAYPAL #2 · PARTIAL')[8]], [82, 27, 55], 'DRAFT allocation not counted');
  assert.deepEqual([row('STRIPE #1 · UNPAID')[7], row('STRIPE #1 · UNPAID')[8]], [0, 170]);
  // Running balance: + due per settlement, - the actual payout once; allocations move nothing.
  const pay = row('Payout');
  assert.deepEqual([pay[5], pay[7], pay[8]], [375, 150, 225]);
  assert.ok(near(pay[8], snap.totals.current_balance), 'ledger ends at the Seller Balances current balance');
  assert.ok(near(snap.blocks.PhieuDoiSoat.b[9], 150) && near(snap.blocks.PhieuDoiSoat.b[10], 225), 'section B deducts the payout once');
  const month = js(snap.blocks.TongHop_Thang.rows).find((r) => r[14] !== 0);
  assert.equal(month[14], 150, 'TongHop_Thang Đã payout seller = actual effective payouts, not allocation totals');
  const broken = multiSpec();
  broken.payouts = [{ seller_payout_id: 'SP-X', seller_id: 'CUS002', payout_date: D('2026-10-11T04:00:00Z'), currency: 'USD', amount: 10, status: 'SENT' }];
  assert.match(js(H.buildSellerOutputs_({ ...makeMaster(D, broken), sellers: broken.sellers, dateKeyOf: NY }).errors).join(),
    /Seller Payout Allocations: Seller Payout SP-X \(SENT\): allocated 0 of 10/, 'unallocated effective payout fails closed');
});
