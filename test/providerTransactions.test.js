// Unit tests for the KH001 Provider Transactions normalizer and the canonical table
// helpers (pure parts of src/Kh001ProviderTransactions.gs and src/CanonicalTable.gs).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Apps Script globals used by default digests; Node SHA-256 stands in for Utilities.
const Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  computeDigest: (_alg, text) => [...crypto.createHash('sha256').update(text, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
};
const context = vm.createContext({ Utilities });
for (const f of ['Config', 'Utils', 'RawSnapshot', 'CanonicalTable', 'Kh001ProviderTransactions']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.gs'), 'utf8'), context, { filename: f + '.gs' });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const D = (iso) => vm.runInContext(`new Date(${JSON.stringify(iso)})`, context);
const COLUMNS = js(H.getColumnNames_('Provider Transactions'));
const FP = 'f'.repeat(64);

// ---- Fixtures ---------------------------------------------------------------
const PP_HEADER = ['Thời gian', 'Name', 'Type', 'Status', 'Currency', 'Gross', 'Fee', 'Net', 'From Email Address',
  'To Email Address', 'Transaction ID', 'Invoice Number', 'Balance Impact', 'Mã cổng', 'Nhóm GD'];
function ppRow(o) {
  const r = {
    'Thời gian': D('2026-10-02T15:00:00Z'), Name: 'Buyer', Type: 'Express Checkout Payment', Status: 'Completed',
    Currency: 'USD', Gross: 91.98, Fee: -3.24, Net: 88.74, 'From Email Address': 'buyer@example.com',
    'To Email Address': 'shop@example.com', 'Transaction ID': 'TXA', 'Invoice Number': 'INV-1',
    'Balance Impact': 'Credit', 'Mã cổng': 'G01', 'Nhóm GD': 'Thanh toán', ...o,
  };
  return PP_HEADER.map((h) => r[h]);
}
const RC_HEADER = ['Transaction ID', 'Có trên KH', 'Có trên PP', 'Trạng thái', 'Mã cổng', 'Sub account', 'Thời gian GD',
  'Số tiền KH', 'Gross PayPal', 'Chênh lệch', 'Phí PayPal', 'Net', 'Phí thuê OP', 'Hold'];
function rcRow(o) {
  const r = {
    'Transaction ID': 'TXA', 'Có trên KH': 'x', 'Có trên PP': 'x', 'Trạng thái': 'Khớp', 'Mã cổng': 'G01',
    'Sub account': 'SUB-1', 'Thời gian GD': D('2026-10-02T15:00:00Z'), 'Số tiền KH': 91.98, 'Gross PayPal': 91.98,
    'Chênh lệch': 0, 'Phí PayPal': 3.24, Net: 88.74, 'Phí thuê OP': 6.21, Hold: 8.87, ...o,
  };
  return RC_HEADER.map((h) => r[h]);
}
function reconciledGrid(rows) {
  const blank = RC_HEADER.map(() => '');
  return [['DOI SOAT', ...blank.slice(1)], blank, blank, blank, blank, RC_HEADER, ...rows];
}
function baseInputs() {
  const paypal = [
    PP_HEADER,
    ppRow({}),
    ppRow({ 'Transaction ID': '80B6789902665252D', Status: 'Pending', Gross: 78.73, Fee: 0, Net: 78.73,
      'Thời gian': D('2026-10-03T01:00:00Z') }),
    ppRow({ 'Transaction ID': 'TXR', Type: 'Payment Refund', 'Nhóm GD': 'Hoàn tiền', Gross: -10, Fee: 0.3, Net: -9.7 }),
    ppRow({ 'Transaction ID': 'TXS', Type: 'Payment Received', 'Nhóm GD': 'Khác' }),
    ppRow({ 'Transaction ID': 'TXB', Gross: 50, Fee: -2, Net: 48, 'Thời gian': D('2026-10-01T12:00:00Z') }),
  ];
  const reconciled = reconciledGrid([
    rcRow({}),
    rcRow({ 'Transaction ID': 'TXB', 'Trạng thái': 'Lệch số tiền', 'Chênh lệch': -0.5, 'Sub account': 'SUB-2' }),
    rcRow({ 'Transaction ID': 'TX-KH-ONLY', 'Trạng thái': 'Thiếu trên PayPal', 'Có trên PP': '' }),
    RC_HEADER.map(() => ''),
  ]);
  return { paypal, reconciled };
}
const build = (inp) => H.buildKh001ProviderTransactions_(inp.paypal, inp.reconciled, FP);
const byId = (rows) => Object.fromEntries(js(rows).map((r) => [r.external_transaction_id, r]));

// ---- Selection ----------------------------------------------------------------
test('selects rows with Nhóm GD exactly "Thanh toán", not by Type substring', () => {
  const out = build(baseInputs());
  assert.equal(out.paymentRows, 3);
  assert.deepEqual(Object.keys(byId(out.rows)).sort(), ['80B6789902665252D', 'TXA', 'TXB']);
  // TXS has a "Payment" Type but another group: excluded.
  assert.equal(byId(out.rows).TXS, undefined);
});

test('Pending payment is included; non-payment event is excluded', () => {
  const rows = byId(build(baseInputs()).rows);
  assert.equal(rows['80B6789902665252D'].external_status, 'Pending');
  assert.equal(rows.TXR, undefined, 'refund group excluded');
});

test('decomposed (NFD) Vietnamese text still matches "Thanh toán"', () => {
  const inp = baseInputs();
  inp.paypal[1][PP_HEADER.indexOf('Nhóm GD')] = 'Thanh toán'.normalize('NFD');
  assert.equal(build(inp).paymentRows, 3);
});

test('internal-only reconciled rows (Thiếu trên PayPal) create no provider transaction', () => {
  assert.equal(byId(build(baseInputs()).rows)['TX-KH-ONLY'], undefined);
  assert.equal(build(baseInputs()).rows.length, 3);
});

// ---- Amounts ------------------------------------------------------------------
test('negative raw PayPal fee becomes positive processing_fee; gross - fee = net', () => {
  const a = byId(build(baseInputs()).rows).TXA;
  assert.equal(a.gross_amount, 91.98);
  assert.equal(a.processing_fee, 3.24);
  assert.equal(a.net_amount, 88.74);
  assert.equal(byId(build(baseInputs()).rows)['80B6789902665252D'].processing_fee, 0);
});

test('amount invariant uses 0.005 tolerance and reports the Transaction ID', () => {
  const ok = baseInputs();
  ok.paypal[1][PP_HEADER.indexOf('Net')] = 88.744;
  assert.doesNotThrow(() => build(ok));
  const bad = baseInputs();
  bad.paypal[1][PP_HEADER.indexOf('Net')] = 88.76;
  assert.throws(() => build(bad), /Amount invariant failed for Transaction ID TXA/);
});

test('non-numeric amounts and non-date Thời gian are rejected', () => {
  const a = baseInputs();
  a.paypal[1][PP_HEADER.indexOf('Gross')] = '91,98';
  assert.throws(() => build(a), /Non-numeric Gross\/Fee\/Net for Transaction ID TXA/);
  const b = baseInputs();
  b.paypal[1][PP_HEADER.indexOf('Thời gian')] = '02/10/2026';
  assert.throws(() => build(b), /Thời gian is not a date-time for Transaction ID TXA/);
});

// ---- Keys / duplicates ----------------------------------------------------------
test('duplicate payment Transaction ID is rejected', () => {
  const inp = baseInputs();
  inp.paypal.push(ppRow({}));
  assert.throws(() => build(inp), /Duplicate payment Transaction ID TXA \(rows 2, 7\)/);
});

test('a payment matching two reconciled rows is rejected', () => {
  const inp = baseInputs();
  inp.reconciled.push(rcRow({}));
  assert.throws(() => build(inp), /Transaction ID TXA appears in Raw KH001 Reconciled rows 7, 11/);
});

test('missing required header fails with a descriptive error', () => {
  const inp = baseInputs();
  inp.paypal[0] = inp.paypal[0].map((h) => (h === 'Balance Impact' ? 'Impact' : h));
  assert.throws(() => build(inp), /Missing required header\(s\) in Raw KH001 PayPal: Balance Impact/);
  const inp2 = baseInputs();
  inp2.reconciled[5] = inp2.reconciled[5].map((h) => (h === 'Trạng thái' ? 'Status' : h));
  assert.throws(() => build(inp2), /Missing required header\(s\) in Raw KH001 Reconciled: Trạng thái/);
});

// ---- Reconciliation -----------------------------------------------------------
test('Khớp -> RECONCILED, Lệch số tiền -> AMOUNT_MISMATCH, no row -> PROVIDER_ONLY', () => {
  const rows = byId(build(baseInputs()).rows);
  assert.equal(rows.TXA.provider_reconciliation_status, 'RECONCILED');
  assert.equal(rows.TXA.provider_reconciliation_raw_status, 'Khớp');
  assert.equal(rows.TXA.provider_sub_account, 'SUB-1');
  assert.equal(rows.TXA.source_reconciled_row, 7);
  assert.equal(rows.TXB.provider_reconciliation_status, 'AMOUNT_MISMATCH');
  assert.equal(rows.TXB.reconciliation_difference, -0.5);
  const po = rows['80B6789902665252D'];
  assert.equal(po.provider_reconciliation_status, 'PROVIDER_ONLY');
  assert.equal(po.provider_reconciliation_raw_status, '');
  assert.equal(po.provider_sub_account, '');
  assert.equal(po.reconciliation_difference, '');
  assert.equal(po.source_reconciled_row, '');
  assert.equal(po.source_paypal_row, 3);
});

test('unmapped DoiSoat status for an existing payment is rejected', () => {
  const inp = baseInputs();
  inp.reconciled[6] = rcRow({ 'Trạng thái': 'Thiếu trên PayPal' });
  assert.throws(() => build(inp), /Unmapped KH001 reconciliation status: "Thiếu trên PayPal" \(Transaction ID TXA\)/);
});

// ---- Determinism ----------------------------------------------------------------
test('provider_transaction_id is deterministic', () => {
  assert.equal(H.kh001ProviderTransactionId_('80B6789902665252D'), 'PT-KH001-PAYPAL-80B6789902665252D');
  assert.equal(byId(build(baseInputs()).rows).TXA.provider_transaction_id, 'PT-KH001-PAYPAL-TXA');
});

test('source_fingerprint is deterministic and depends on both raw checksums', () => {
  const a = H.computeKh001SourceFingerprint_('p1', 'r1');
  assert.equal(a, H.computeKh001SourceFingerprint_('p1', 'r1'));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, H.computeKh001SourceFingerprint_('p2', 'r1'));
  assert.notEqual(a, H.computeKh001SourceFingerprint_('p1', 'r2'));
  const expected = crypto.createHash('sha256').update('p1|r1|KH001_PROVIDER_TX_V1').digest('hex');
  assert.equal(a, expected);
});

test('canonical output checksum is deterministic and ignores normalized_at', () => {
  const rows = () => build(baseInputs()).rows.map((o) => H.objectToRow_(o, COLUMNS));
  const c1 = H.kh001PartitionChecksum_(rows(), COLUMNS);
  assert.equal(c1, H.kh001PartitionChecksum_(rows(), COLUMNS));
  const stamped = rows().map((r) => { const x = r.slice(); x[COLUMNS.indexOf('normalized_at')] = D('2026-10-10T00:00:00Z'); return x; });
  assert.equal(c1, H.kh001PartitionChecksum_(stamped, COLUMNS));
  assert.equal(c1, H.kh001PartitionChecksum_(rows().reverse(), COLUMNS), 'order-independent (sorted)');
});

test('output rows follow the schema column order', () => {
  const row = H.objectToRow_(byId(build(baseInputs()).rows).TXA, COLUMNS);
  assert.equal(row.length, 24);
  assert.equal(row[COLUMNS.indexOf('provider_id')], 'KH001');
  assert.equal(row[COLUMNS.indexOf('payment_source')], 'PAYPAL');
  assert.equal(row[COLUMNS.indexOf('normalizer_version')], 'KH001_PROVIDER_TX_V1');
  assert.equal(row[COLUMNS.indexOf('source_fingerprint')], FP);
  assert.equal(row[COLUMNS.indexOf('normalized_at')], '');
});

// ---- Canonical table: NO_CHANGE / rebuild / partitions ----------------------------
function table(rowsAsArrays) {
  const sortIdx = ['provider_id', 'payment_source', 'transaction_at', 'external_transaction_id'].map((c) => COLUMNS.indexOf(c));
  return H.buildTableValues_(COLUMNS, H.sortCanonicalRows_(rowsAsArrays, sortIdx));
}
const stampIdx = COLUMNS.indexOf('normalized_at');

test('NO_CHANGE when the target equals the expected table (excluding normalized_at)', () => {
  const rows = build(baseInputs()).rows.map((o) => H.objectToRow_(o, COLUMNS));
  const expected = H.tableChecksumExcluding_(table(rows), [stampIdx]);
  const writtenEarlier = table(rows).map((r, i) => (i === 0 ? r : r.map((v, c) => (c === stampIdx ? D('2026-10-09T00:00:00Z') : v))));
  assert.equal(H.decideCanonicalWrite_(expected, H.tableChecksumExcluding_(writtenEarlier, [stampIdx])), 'NO_CHANGE');
  assert.equal(H.decideCanonicalWrite_(expected, null), 'WRITE', 'no target yet');
});

test('manual target modification is detected and triggers a rebuild', () => {
  const rows = build(baseInputs()).rows.map((o) => H.objectToRow_(o, COLUMNS));
  const expected = H.tableChecksumExcluding_(table(rows), [stampIdx]);
  const edited = table(rows);
  edited[1][COLUMNS.indexOf('gross_amount')] = 1;
  assert.equal(H.decideCanonicalWrite_(expected, H.tableChecksumExcluding_(edited, [stampIdx])), 'WRITE');
  const extraRow = table(rows).concat([COLUMNS.map(() => '')]);
  assert.equal(H.decideCanonicalWrite_(expected, H.tableChecksumExcluding_(extraRow, [stampIdx])), 'WRITE');
});

test('refreshing the KH001 partition preserves other providers and sorts deterministically', () => {
  const pid = COLUMNS.indexOf('provider_id');
  const kh = build(baseInputs()).rows.map((o) => H.objectToRow_(o, COLUMNS));
  const other = H.objectToRow_({ provider_transaction_id: 'PT-KH002-STRIPE-pi_1', provider_id: 'KH002',
    payment_source: 'STRIPE', external_transaction_id: 'pi_1', transaction_at: D('2026-10-01T00:00:00Z'),
    gross_amount: 10, processing_fee: 1, net_amount: 9, normalized_at: D('2026-10-05T00:00:00Z') }, COLUMNS);
  const staleKh = H.objectToRow_({ provider_id: 'KH001', payment_source: 'PAYPAL', external_transaction_id: 'OLD' }, COLUMNS);
  const merged = H.mergeProviderPartition_([staleKh, other], kh, pid, 'KH001');
  assert.equal(merged.length, 4);
  assert.ok(merged.includes(other), 'other provider row kept untouched');
  assert.ok(!merged.some((r) => r[COLUMNS.indexOf('external_transaction_id')] === 'OLD'), 'old KH001 row replaced');
  const sorted = js(table(merged).slice(1).map((r) => r[pid] + ':' + r[COLUMNS.indexOf('external_transaction_id')]));
  assert.deepEqual(sorted, ['KH001:TXB', 'KH001:TXA', 'KH001:80B6789902665252D', 'KH002:pi_1']);
});

test('duplicate canonical keys across the table are found', () => {
  const keyIdx = ['provider_id', 'payment_source', 'external_transaction_id'].map((c) => COLUMNS.indexOf(c));
  const kh = build(baseInputs()).rows.map((o) => H.objectToRow_(o, COLUMNS));
  assert.deepEqual(js(H.findDuplicateKeys_(kh, keyIdx)), []);
  assert.deepEqual(js(H.findDuplicateKeys_(kh.concat([kh[0]]), keyIdx)), ['KH001|PAYPAL|TXA']);
});

test('tableRowsFromGrid_: header must match, blank rows skipped; header-only table is padded', () => {
  const grid = [COLUMNS, COLUMNS.map(() => ''), COLUMNS.map((c) => (c === 'provider_id' ? 'KH001' : '')), COLUMNS.map(() => '')];
  assert.equal(H.tableRowsFromGrid_(grid, COLUMNS, 'PT').length, 1);
  const bad = [COLUMNS.map((c, i) => (i === 3 ? 'gateway' : c))];
  assert.throws(() => H.tableRowsFromGrid_(bad, COLUMNS, 'PT'), /PT header does not match the schema at column 4/);
  const empty = H.buildTableValues_(COLUMNS, []);
  assert.equal(empty.length, 2, 'header + one blank row');
  assert.ok(empty[1].every((v) => v === ''));
});

test('compareCanonicalValues_ is a total order across types', () => {
  const c = H.compareCanonicalValues_;
  assert.ok(c('', 1) < 0 && c(1, D('2026-01-01T00:00:00Z')) < 0 && c(D('2026-01-01T00:00:00Z'), 'a') < 0);
  assert.ok(c(D('2026-01-01T00:00:00Z'), D('2026-01-02T00:00:00Z')) < 0);
  assert.ok(c('B', 'a') < 0, 'code-unit order, locale independent');
  assert.equal(c('x', 'x'), 0);
});

// ---- Summary / regression -------------------------------------------------------
test('summary counts, provider-only ids and cent-exact totals', () => {
  const s = js(H.summarizeProviderTransactions_(build(baseInputs()).rows));
  assert.equal(s.row_count, 3);
  assert.equal(s.unique_transaction_count, 3);
  assert.deepEqual(s.status_counts, { Completed: 2, Pending: 1 });
  assert.deepEqual(s.reconciliation_counts, { RECONCILED: 1, PROVIDER_ONLY: 1, AMOUNT_MISMATCH: 1 });
  assert.deepEqual(s.provider_only_transaction_ids, ['80B6789902665252D']);
  assert.deepEqual(s.totals, { gross: 220.71, processing_fee: 5.24, net: 215.47 });
  assert.deepEqual(s.completed_totals, { gross: 141.98, processing_fee: 5.24, net: 136.74 });
  assert.deepEqual(s.amount_invariant_errors, []);
});

test('regression report passes only for the expected snapshot summary', () => {
  const exp = js(vm.runInContext('KH001_PROVIDER_TX_REGRESSION', context));
  const good = { ...exp, duplicate_ids: [], amount_invariant_errors: [] };
  assert.equal(H.evaluateKh001ProviderTxRegression_(good).pass, true);
  const bad = { ...good, totals: { ...exp.totals, net: 10286.12 } };
  const r = js(H.evaluateKh001ProviderTxRegression_(bad));
  assert.equal(r.pass, false);
  assert.deepEqual(r.failed, ['totals.net']);
  assert.equal(H.evaluateKh001ProviderTxRegression_(js(H.summarizeProviderTransactions_(build(baseInputs()).rows))).pass, false);
});
