// Unit tests for the KH001 settlement headers normalizer (pure parts of src/Kh001Settlements.gs).
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
  // Only the 'yyyy-MM-dd' pattern is used by the normalizer.
  formatDate: (date, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date),
};
const context = vm.createContext({ Utilities });
for (const f of ['Config', 'Utils', 'RawSnapshot', 'CanonicalTable', 'Kh001ProviderTransactions', 'Kh001ProviderEvents', 'Kh001Settlements']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.gs'), 'utf8'), context, { filename: f + '.gs' });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const D = (iso) => vm.runInContext(`new Date(${JSON.stringify(iso)})`, context);
const LA = (day) => D(day + 'T07:00:00Z'); // midnight America/Los_Angeles (PDT)
const TZ = 'America/Los_Angeles';
const FP = 'a'.repeat(64);
const COLUMNS = js(H.getColumnNames_('Settlements'));
const SORT = ['provider_id', 'payment_source', 'source_settlement_number'];
const dateFromKey = (k) => D(k + 'T04:00:00Z'); // deterministic stand-in for Utilities.parseDate

// ---- Fixtures ---------------------------------------------------------------
const HIST = ['Lần', 'Từ ngày', 'Đến ngày', 'Ngày thanh toán', 'Phát sinh phải trả', 'Còn nợ lần trước', 'Tổng phải trả',
  'Đã thanh toán (USD)', 'Còn nợ', 'Hold giữ lần này', 'Hold được hoàn lần này', 'Số dư hold', 'Hold lần này hoàn từ ngày',
  '… đến ngày', 'Hình thức / chứng từ', 'Tỷ giá lần này (VND/USD)', 'Đã thanh toán (VND)'];
const WIDTH = HIST.length + 3; // offset column + 2 trailing scratch columns
function histRow(o) {
  const r = {
    'Lần': 1, 'Từ ngày': LA('2026-10-01'), 'Đến ngày': LA('2026-10-04'), 'Ngày thanh toán': LA('2026-10-06'),
    'Phát sinh phải trả': 119.52, 'Còn nợ lần trước': 0, 'Tổng phải trả': 119.52, 'Đã thanh toán (USD)': 119.52, 'Còn nợ': 0,
    'Hold giữ lần này': 14.4, 'Hold được hoàn lần này': 0, 'Số dư hold': 14.4, 'Hold lần này hoàn từ ngày': LA('2026-11-30'),
    '… đến ngày': LA('2026-12-03'), 'Hình thức / chứng từ': 'Bank transfer #1', 'Tỷ giá lần này (VND/USD)': 25300,
    'Đã thanh toán (VND)': 3023856, ...o,
  };
  return ['', ...HIST.map((h) => r[h]), 'scratch', 123];
}
const blankRow = () => Array(WIDTH).fill('');
function titled(text) { const r = blankRow(); r[1] = text; return r; }
function settlementsGrid(rows) {
  return [
    titled('PHIẾU ĐỐI SOÁT KH001'),
    titled('A. KỲ ĐANG CHỌN'),
    ['', 'Lần', 'Từ ngày', 'Đến ngày', ...Array(WIDTH - 4).fill('')], // section A look-alike header (must be ignored)
    ['', 3, LA('2026-10-10'), LA('2026-10-12'), ...Array(WIDTH - 4).fill('')],
    titled('B. TỔNG HỢP'),
    blankRow(),
    titled('D.  Lịch sử chốt & thanh toán — công nợ'),
    blankRow(),
    ['', ...HIST, '', ''], // trailing unlabeled scratch columns
    ...rows,
    blankRow(),
    titled('Ghi chú'),
  ];
}
const defaultHistory = () => [
  histRow({}),
  histRow({ 'Lần': 2, 'Từ ngày': LA('2026-10-05'), 'Đến ngày': LA('2026-10-09'), 'Ngày thanh toán': LA('2026-10-10'),
    'Phát sinh phải trả': 159.36, 'Tổng phải trả': 159.36, 'Đã thanh toán (USD)': 159.36, 'Hold giữ lần này': 19.2,
    'Số dư hold': 19.2, 'Đã thanh toán (VND)': 4031808, 'Hình thức / chứng từ': 'Bank transfer #2',
    'Hold lần này hoàn từ ngày': LA('2026-12-04'), '… đến ngày': LA('2026-12-08') }),
];

const RC = ['Transaction ID', 'Có trên KH', 'Có trên PP', 'Trạng thái', 'Lần chốt (ngày)', 'Doanh thu (Gross)', 'Phí PayPal',
  'Net', 'Phí thuê OP', 'Hold', 'Thực nhận (chưa gồm hoàn hold)', 'Ngày hết hold'];
function rcRow(o) {
  const r = { 'Transaction ID': 'T1', 'Có trên KH': 1, 'Có trên PP': 1, 'Trạng thái': 'Khớp', 'Lần chốt (ngày)': LA('2026-10-04'),
    'Doanh thu (Gross)': 100, 'Phí PayPal': 4, Net: 96, 'Phí thuê OP': 6.72, Hold: 9.6, 'Thực nhận (chưa gồm hoàn hold)': 79.68,
    'Ngày hết hold': '', ...o };
  return RC.map((h) => r[h]);
}
function reconciledGrid(rows) {
  const blank = RC.map(() => '');
  return [blank, blank, blank, blank, blank, RC, ...rows, blank];
}
const defaultReconciled = () => [
  rcRow({}),
  // 2026-10-05 05:00Z = 2026-10-04 22:00 in Los Angeles -> settlement #1 (UTC/New York date would be 10-05)
  rcRow({ 'Transaction ID': 'T2', 'Lần chốt (ngày)': D('2026-10-05T05:00:00Z'), 'Doanh thu (Gross)': 50, 'Phí PayPal': 2, Net: 48,
    'Phí thuê OP': 3.36, Hold: 4.8, 'Thực nhận (chưa gồm hoàn hold)': 39.84 }),
  rcRow({ 'Transaction ID': 'T3', 'Lần chốt (ngày)': LA('2026-10-09'), 'Doanh thu (Gross)': 200, 'Phí PayPal': 8, Net: 192,
    'Phí thuê OP': 13.44, Hold: 19.2, 'Thực nhận (chưa gồm hoàn hold)': 159.36 }),
  rcRow({ 'Transaction ID': 'KH-ONLY', 'Có trên PP': 0, 'Trạng thái': 'Thiếu trên PayPal' }),
  rcRow({ 'Transaction ID': 'T9', 'Lần chốt (ngày)': '' }), // not settled yet
];
const PT = (id, status) => ({ provider_transaction_id: 'PT-KH001-PAYPAL-' + id, provider_id: 'KH001', payment_source: 'PAYPAL',
  external_transaction_id: id, external_status: status || 'Completed' });
const ptIndex = (ids) => H.indexProviderTransactions_((ids || ['T1', 'T2', 'T3', 'T9']).map((id) => PT(id)));
function build(o) {
  o = o || {};
  return H.buildKh001Settlements_(settlementsGrid(o.history || defaultHistory()), reconciledGrid(o.reconciled || defaultReconciled()),
    o.ptIndex || ptIndex(), { sourceFingerprint: FP, timeZone: TZ });
}
const errs = (b) => js(H.flattenSettlementErrors_(b.errors)).join(' | ');
const rowsByNo = (b) => Object.fromEntries(js(b.rows).map((r) => [r.source_settlement_number, r]));

// ---- Discovery ----------------------------------------------------------------
test('section D is discovered by normalized text; section A look-alike header is ignored', () => {
  const grid = settlementsGrid(defaultHistory());
  assert.equal(H.findSettlementHistorySection_(grid), 6);
  const hdr = H.findSettlementHistoryHeader_(grid, 6);
  assert.equal(hdr.headerRow, 8);
  assert.equal(hdr.map[H.normalizeSourceKey_('… đến ngày')], 14);
  assert.equal(H.normalizeSourceKey_('…  Đến   ngày'), '... đến ngày');
});

test('missing/duplicate section D and missing history header fail', () => {
  const noD = settlementsGrid(defaultHistory()).filter((r) => !String(r[1]).startsWith('D.'));
  assert.throws(() => H.findSettlementHistorySection_(noD), /Section "D\. LỊCH SỬ CHỐT/);
  const twice = settlementsGrid(defaultHistory()).concat([titled('D. LỊCH SỬ CHỐT (copy)')]);
  assert.throws(() => H.findSettlementHistorySection_(twice), /found more than once/);
  const grid = settlementsGrid(defaultHistory());
  grid[8] = grid[8].map((h) => (h === 'Số dư hold' ? 'Hold balance' : h));
  assert.throws(() => H.findSettlementHistoryHeader_(grid, 6), /is missing: số dư hold/);
});

test('trailing unlabeled scratch columns and placeholder rows are ignored', () => {
  const placeholder = ['', 3, ...Array(HIST.length - 1).fill(''), 'scratch', 9];
  const b = build({ history: defaultHistory().concat([placeholder]) });
  assert.equal(errs(b), '');
  assert.equal(b.rows.length, 2);
  assert.ok(js(b.warnings).some((w) => /Settlement #3 .* empty placeholder/.test(w)));
});

// ---- IDs / duplicates -----------------------------------------------------------
test('settlement ID is deterministic and zero-padded to 6 digits', () => {
  assert.equal(H.kh001SettlementId_(1), 'ST-KH001-PAYPAL-000001');
  assert.equal(H.kh001SettlementId_(12), 'ST-KH001-PAYPAL-000012');
  assert.equal(H.kh001SettlementId_(1234567), 'ST-KH001-PAYPAL-1234567');
  assert.deepEqual(js(build().rows).map((r) => r.settlement_id), ['ST-KH001-PAYPAL-000001', 'ST-KH001-PAYPAL-000002']);
});

test('duplicate settlement number fails', () => {
  const b = build({ history: defaultHistory().concat([histRow({ 'Đến ngày': LA('2026-10-20') })]) });
  assert.match(errs(b), /Duplicate settlement number 1 \(rows 10, 12\)/);
});

// ---- Membership / grouping ------------------------------------------------------
test('membership uses provider-timezone (Los Angeles) date keys', () => {
  const r = rowsByNo(build());
  assert.equal(r[1].transaction_count, 2, 'T2 at 22:00 LA on 10-04 belongs to #1');
  assert.equal(r[2].transaction_count, 1);
  assert.equal(r[1].period_end_date, '2026-10-04');
  assert.equal(r[1].source_payment_date, '2026-10-06');
  assert.equal(H.providerDateKey_(D('2026-10-05T05:00:00Z'), 'America/New_York'), '2026-10-05');
  assert.equal(H.providerDateKey_(D('2026-10-05T05:00:00Z'), TZ), '2026-10-04');
  assert.equal(H.providerDateKey_('2026-10-04', TZ), '2026-10-04');
  assert.throws(() => H.providerDateKey_('04/10/2026', TZ), /not a date/);
});

test('settlement grouping sums actual reconciled economics; missing-PayPal and unsettled rows excluded', () => {
  const b = build();
  assert.equal(b.includedTransactions, 3);
  const r1 = rowsByNo(b)[1];
  assert.equal(r1.gross_amount, 150);
  assert.equal(r1.processing_fee_amount, 6);
  assert.equal(r1.net_amount, 144);
  assert.ok(Math.abs(r1.provider_fee_amount - 10.08) < 1e-9);
  assert.ok(Math.abs(r1.provider_hold_created_amount - 14.4) < 1e-9);
  assert.ok(Math.abs(r1.transaction_payout_amount - 119.52) < 1e-9);
});

test('Lần chốt date without a history row fails as a relationship error', () => {
  const b = build({ reconciled: defaultReconciled().concat([rcRow({ 'Transaction ID': 'T4', 'Lần chốt (ngày)': LA('2026-10-15') })]) });
  assert.match(errs(b), /T4\): Lần chốt 2026-10-15 matches no settlement history Đến ngày/);
});

test('included transactions must resolve to a KH001 Provider Transaction', () => {
  assert.match(errs(build({ ptIndex: ptIndex(['T1', 'T3']) })), /\(T2\): no KH001\/PAYPAL Provider Transaction PT-KH001-PAYPAL-T2/);
  const wrong = H.indexProviderTransactions_([PT('T1'), { ...PT('T2'), payment_source: 'STRIPE' }, PT('T3')]);
  assert.match(errs(build({ ptIndex: wrong })), /no KH001\/PAYPAL Provider Transaction PT-KH001-PAYPAL-T2/);
  const pending = H.indexProviderTransactions_([PT('T1'), PT('T2', 'Pending'), PT('T3')]);
  assert.ok(js(build({ ptIndex: pending }).warnings).some((w) => /T2\): Provider Transaction status is "Pending"/.test(w)));
});

test('a transaction settled twice fails', () => {
  const b = build({ reconciled: defaultReconciled().concat([rcRow({})]) });
  assert.match(errs(b), /Transaction ID T1 settled twice/);
});

// ---- Equations ------------------------------------------------------------------
test('transaction row equations: gross - fee = net and net - provider fee - hold = payout', () => {
  assert.match(errs(build({ reconciled: [rcRow({ Net: 95 })] })), /gross - processing fee != net/);
  assert.match(errs(build({ reconciled: [rcRow({ 'Thực nhận (chưa gồm hoàn hold)': 80 })] })), /net - provider fee - hold != payout/);
  assert.match(errs(build({ reconciled: [rcRow({ Hold: '' })] })), /non-numeric Hold/);
});

test('actual unrounded provider fee/hold are preserved (no rate recalculation, no per-row rounding)', () => {
  const rows = [
    rcRow({ 'Doanh thu (Gross)': 33.33, 'Phí PayPal': 1.4, Net: 31.93, 'Phí thuê OP': 2.2351, Hold: 3.193, 'Thực nhận (chưa gồm hoàn hold)': 26.5019 }),
    rcRow({ 'Transaction ID': 'T2', 'Doanh thu (Gross)': 33.33, 'Phí PayPal': 1.4, Net: 31.93, 'Phí thuê OP': 2.2351, Hold: 3.193,
      'Thực nhận (chưa gồm hoàn hold)': 26.5019 }),
  ];
  const history = [histRow({ 'Phát sinh phải trả': 53.0038, 'Tổng phải trả': 53.0038, 'Đã thanh toán (USD)': 53.0038,
    'Đã thanh toán (VND)': 53.0038 * 25300, 'Số dư hold': 6.386 })];
  const r = rowsByNo(build({ reconciled: rows, history }))[1];
  assert.ok(Math.abs(r.provider_fee_amount - 4.4702) < 1e-9, 'not 2 x round(2.2351, 2)');
  assert.ok(Math.abs(r.provider_hold_created_amount - 6.386) < 1e-9);
  assert.ok(Math.abs(r.provider_adjustments) < 1e-9);
});

test('provider adjustment residual = period due - transaction payout - hold released (warned, not classified)', () => {
  const history = [histRow({ 'Phát sinh phải trả': 110.52, 'Tổng phải trả': 110.52, 'Đã thanh toán (USD)': 110.52,
    'Đã thanh toán (VND)': 110.52 * 25300 })];
  const b = build({ history, reconciled: defaultReconciled().slice(0, 2) });
  assert.equal(errs(b), '');
  assert.ok(Math.abs(rowsByNo(b)[1].provider_adjustments - -9) < 1e-9);
  assert.ok(js(b.warnings).some((w) => /Settlement #1: unclassified provider adjustment/.test(w)));
});

test('due / carry-in / outstanding equations', () => {
  const bad1 = [histRow({ 'Tổng phải trả': 200 })];
  assert.match(errs(build({ history: bad1, reconciled: defaultReconciled().slice(0, 2) })), /total due != period due \+ carry in/);
  const bad2 = [histRow({ 'Còn nợ': 5 })];
  assert.match(errs(build({ history: bad2, reconciled: defaultReconciled().slice(0, 2) })), /outstanding != total due - paid/);
  const partial = [histRow({ 'Đã thanh toán (USD)': 100, 'Còn nợ': 19.52, 'Đã thanh toán (VND)': 2530000 })];
  assert.equal(errs(build({ history: partial, reconciled: defaultReconciled().slice(0, 2) })), '');
});

test('FX equation: paid VND = paid USD x rate within 1 VND; payout currency VND only when populated', () => {
  const bad = [histRow({ 'Đã thanh toán (VND)': 3023900 })];
  assert.match(errs(build({ history: bad, reconciled: defaultReconciled().slice(0, 2) })), /paid \(VND\) != paid \(USD\) x fx rate/);
  const r = rowsByNo(build())[1];
  assert.equal(r.payout_currency, 'VND');
  assert.equal(r.source_paid_payout_amount, 3023856);
  const noVnd = rowsByNo(build({ history: [histRow({ 'Đã thanh toán (VND)': '' })], reconciled: defaultReconciled().slice(0, 2) }))[1];
  assert.equal(noVnd.payout_currency, '');
});

// ---- Hold history ---------------------------------------------------------------
test('source hold balance is preserved; expected roll-forward and difference are reported', () => {
  const b = build();
  const r = rowsByNo(b);
  assert.equal(r[1].provider_hold_balance, 14.4);
  assert.equal(r[2].provider_hold_balance, 19.2, 'source value kept even though it is not cumulative');
  assert.ok(Math.abs(r[1].expected_provider_hold_balance - 14.4) < 1e-9);
  assert.ok(Math.abs(r[2].expected_provider_hold_balance - 33.6) < 1e-9);
  assert.ok(Math.abs(r[1].hold_balance_difference) < 1e-9);
  assert.ok(Math.abs(r[2].hold_balance_difference - -14.4) < 1e-9);
  const rec = js(b.holdReconciliation);
  assert.deepEqual(rec.map((x) => x.matches), [true, false]);
  assert.ok(js(b.warnings).some((w) => /Settlement #2: provider hold balance 19.2 vs expected roll-forward 33.6/.test(w)));
  assert.equal(errs(b), '', 'a hold difference is reported, not an error');
});

test('hold release reduces the expected roll-forward', () => {
  const history = defaultHistory();
  history[1] = histRow({ 'Lần': 2, 'Từ ngày': LA('2026-10-05'), 'Đến ngày': LA('2026-10-09'), 'Hold được hoàn lần này': 14.4,
    'Phát sinh phải trả': 173.76, 'Tổng phải trả': 173.76, 'Đã thanh toán (USD)': 173.76, 'Đã thanh toán (VND)': 173.76 * 25300,
    'Số dư hold': 19.2, 'Hold giữ lần này': 19.2 });
  const r = rowsByNo(build({ history }))[2];
  assert.ok(Math.abs(r.expected_provider_hold_balance - 19.2) < 1e-9);
  assert.ok(Math.abs(r.hold_balance_difference) < 1e-9);
  assert.ok(Math.abs(r.provider_adjustments) < 1e-9);
});

// ---- Determinism / canonical write ---------------------------------------------
test('source fingerprint is deterministic', () => {
  const a = H.computeKh001SettlementsFingerprint_('s1', 'r1');
  assert.equal(a, H.computeKh001SettlementsFingerprint_('s1', 'r1'));
  assert.notEqual(a, H.computeKh001SettlementsFingerprint_('s2', 'r1'));
  assert.notEqual(a, H.computeKh001SettlementsFingerprint_('s1', 'r2'));
  assert.equal(a, crypto.createHash('sha256').update('s1|r1|KH001_SETTLEMENT_HEADERS_V1').digest('hex'));
});

const toRows = (b) => b.rows.map((o) => H.settlementObjectToRow_(o, COLUMNS, dateFromKey));

test('date keys become Master date values; checksum ignores normalized_at and is order independent', () => {
  const rows = toRows(build());
  assert.equal(rows[0][COLUMNS.indexOf('period_end_date')].getTime(), dateFromKey('2026-10-04').getTime());
  const c = H.partitionChecksum_(rows, COLUMNS, SORT, 'normalized_at');
  assert.equal(c, H.partitionChecksum_(toRows(build()).reverse(), COLUMNS, SORT, 'normalized_at'));
  const stamped = rows.map((r) => { const x = r.slice(); x[COLUMNS.indexOf('normalized_at')] = D('2026-10-11T00:00:00Z'); return x; });
  assert.equal(c, H.partitionChecksum_(stamped, COLUMNS, SORT, 'normalized_at'));
});

test('SUCCESS then NO_CHANGE; manual target edit triggers rebuild', () => {
  const sortIdx = SORT.map((c) => COLUMNS.indexOf(c));
  const stamp = [COLUMNS.indexOf('normalized_at')];
  const table = () => H.buildTableValues_(COLUMNS, H.sortCanonicalRows_(toRows(build()), sortIdx));
  const expected = H.tableChecksumExcluding_(table(), stamp);
  assert.equal(H.decideCanonicalWrite_(expected, null), 'WRITE', 'first run');
  assert.equal(H.decideCanonicalWrite_(expected, H.tableChecksumExcluding_(table(), stamp)), 'NO_CHANGE');
  const edited = table();
  edited[1][COLUMNS.indexOf('provider_hold_balance')] = 0;
  assert.equal(H.decideCanonicalWrite_(expected, H.tableChecksumExcluding_(edited, stamp)), 'WRITE');
});

test('KH001 partition refresh preserves other providers', () => {
  const pid = COLUMNS.indexOf('provider_id');
  const other = H.objectToRow_({ settlement_id: 'ST-KH002-STRIPE-000001', provider_id: 'KH002', payment_source: 'STRIPE',
    source_settlement_number: 1 }, COLUMNS);
  const merged = H.mergeProviderPartition_([other, H.objectToRow_({ provider_id: 'KH001', source_settlement_number: 9 }, COLUMNS)],
    toRows(build()), pid, 'KH001');
  assert.equal(merged.length, 3);
  assert.ok(merged.includes(other));
  const keyIdx = SORT.map((c) => COLUMNS.indexOf(c));
  assert.deepEqual(js(H.findDuplicateKeys_(merged, keyIdx)), []);
});

// ---- Regression -------------------------------------------------------------------
test('regression report passes only for the expected snapshot', () => {
  const exp = js(vm.runInContext('KH001_SETTLEMENTS_REGRESSION', context));
  const rows = Object.entries(exp.settlements).map(([n, v]) => ({ source_settlement_number: Number(n), ...v }));
  const totals = { ...exp.totals };
  assert.equal(H.evaluateKh001SettlementsRegression_(rows, totals).pass, true);
  rows[1].provider_fee_amount = 354.3793;
  const r = js(H.evaluateKh001SettlementsRegression_(rows, totals));
  assert.deepEqual(r.failed, ['#2.provider_fee_amount']);
  const b = build();
  assert.equal(H.evaluateKh001SettlementsRegression_(b.rows, H.summarizeSettlements_(b.rows)).pass, false);
});
