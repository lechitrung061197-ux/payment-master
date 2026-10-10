// Unit tests for the KH001 Provider Events normalizer (pure parts of src/Kh001ProviderEvents.gs).
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
for (const f of ['Config', 'Utils', 'RawSnapshot', 'CanonicalTable', 'Kh001ProviderTransactions', 'Kh001ProviderEvents']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.gs'), 'utf8'), context, { filename: f + '.gs' });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const D = (iso) => vm.runInContext(`new Date(${JSON.stringify(iso)})`, context);
const COLUMNS = js(H.getColumnNames_('Provider Events'));
const SORT = ['provider_id', 'payment_source', 'event_at', 'external_event_id'];
const FP = 'e'.repeat(64);

// ---- Fixtures ---------------------------------------------------------------
const HEADER = ['Thời gian', 'Name', 'Type', 'Status', 'Currency', 'Gross', 'Fee', 'Net', 'From Email Address',
  'To Email Address', 'Transaction ID', 'Reference Txn ID', 'Invoice Number', 'Balance Impact', 'Mã cổng', 'Nhóm GD', 'Txn gốc', 'Balance'];
function row(o) {
  const r = {
    'Thời gian': D('2026-10-02T15:00:00Z'), Name: 'Buyer', Type: 'Express Checkout Payment', Status: 'Completed',
    Currency: 'USD', Gross: 91.98, Fee: -3.24, Net: 88.74, 'From Email Address': 'b@x.com', 'To Email Address': 's@x.com',
    'Transaction ID': 'PAY1',
    'Reference Txn ID': '', 'Invoice Number': 'INV-1', 'Balance Impact': 'Credit', 'Mã cổng': 'G01',
    'Nhóm GD': 'Thanh toán', 'Txn gốc': 'PAY1', Balance: 0, ...o,
  };
  return HEADER.map((h) => r[h]);
}
const BLANK = HEADER.map(() => '');
function inputs() {
  return [
    HEADER,
    row({}),
    row({ 'Transaction ID': '80B6789902665252D', 'Txn gốc': '80B6789902665252D', Status: 'Pending', 'Balance Impact': 'Memo',
      Gross: 78.73, Fee: 0, Net: 78.73, 'Thời gian': D('2026-10-03T01:00:00Z') }),
    row({ 'Transaction ID': '03652371D0702611V', 'Reference Txn ID': 'PAY1', 'Txn gốc': 'PAY1', Type: 'Reserve Hold',
      'Nhóm GD': 'Reserve PP', 'Balance Impact': 'Debit', Gross: -4.44, Fee: 0, Net: -4.44, 'Thời gian': D('2026-10-02T15:00:01Z') }),
    row({ 'Transaction ID': 'WD1', 'Txn gốc': 'WD1', Type: 'General Withdrawal', 'Nhóm GD': 'Rút tiền',
      'Balance Impact': 'Debit', Gross: -657.61, Fee: 0, Net: -657.61, 'Thời gian': D('2026-10-04T00:00:00Z') }),
    BLANK.slice(),
    BLANK.slice(),
  ];
}
const PT = (id) => ({ provider_transaction_id: 'PT-KH001-PAYPAL-' + id, provider_id: 'KH001', payment_source: 'PAYPAL', external_transaction_id: id });
const ptIndex = () => H.indexProviderTransactions_([PT('PAY1'), PT('80B6789902665252D')]);
const build = (grid, idx) => H.buildKh001ProviderEvents_(grid || inputs(), idx || ptIndex(), FP);
const ok = (grid, idx) => { const b = build(grid, idx); H.assertNoEventErrors_(b.errors); return b; };
const byId = (b) => Object.fromEntries(js(b.rows).map((r) => [r.external_event_id, r]));
const errorsOf = (b) => js(H.flattenEventErrors_(b.errors)).join(' | ');
const set = (grid, rowIdx, header, value) => { grid[rowIdx][HEADER.indexOf(header)] = value; return grid; };

// ---- Mapping ------------------------------------------------------------------
test('Thanh toán -> PAYMENT, Reserve PP -> RESERVE_HOLD, Rút tiền -> WITHDRAWAL; blank rows skipped', () => {
  const b = ok();
  assert.equal(b.eventRows, 4);
  const e = byId(b);
  assert.equal(e.PAY1.event_type, 'PAYMENT');
  assert.equal(e['03652371D0702611V'].event_type, 'RESERVE_HOLD');
  assert.equal(e.WD1.event_type, 'WITHDRAWAL');
  assert.equal(e.PAY1.raw_group, 'Thanh toán');
  assert.equal(e.PAY1.raw_type, 'Express Checkout Payment');
});

test('unknown non-blank Nhóm GD is rejected (no silent OTHER)', () => {
  for (const g of ['Hoàn tiền', 'Dispute', 'Khác']) {
    const b = build(set(inputs(), 1, 'Nhóm GD', g));
    assert.match(errorsOf(b), new RegExp('unmapped Nhóm GD "' + g + '"'));
    assert.throws(() => H.assertNoEventErrors_(b.errors), /KH001 provider events normalization failed/);
  }
});

test('a Transaction ID with blank Nhóm GD is rejected rather than dropped', () => {
  const g = inputs();
  g[5] = row({ 'Transaction ID': 'ORPHAN', 'Nhóm GD': '' });
  assert.match(errorsOf(build(g)), /Transaction ID ORPHAN has blank Nhóm GD/);
});

test('unverified raw Type is rejected', () => {
  assert.match(errorsOf(build(set(inputs(), 1, 'Type', 'Website Payment'))), /unverified Type "Website Payment" for PAYMENT/);
  assert.match(errorsOf(build(set(inputs(), 4, 'Type', 'User Initiated Withdrawal'))), /unverified Type .* for WITHDRAWAL/);
});

test('unverified Status / Balance Impact combination is rejected', () => {
  assert.match(errorsOf(build(set(inputs(), 1, 'Balance Impact', 'Memo'))), /unverified Status\/Balance Impact "Completed\/Memo" for PAYMENT/);
  assert.match(errorsOf(build(set(inputs(), 3, 'Status', 'Pending'))), /"Pending\/Debit" for RESERVE_HOLD/);
});

// ---- Money ----------------------------------------------------------------------
test('Pending PAYMENT is included with Memo balance effect 0', () => {
  const p = byId(ok())['80B6789902665252D'];
  assert.equal(p.event_type, 'PAYMENT');
  assert.equal(p.external_status, 'Pending');
  assert.equal(p.net_amount, 78.73);
  assert.equal(p.balance_effect_amount, 0);
});

test('Credit balance effect = net; Debit balance effect = signed (negative) net', () => {
  const e = byId(ok());
  assert.equal(e.PAY1.balance_effect_amount, 88.74);
  assert.equal(e['03652371D0702611V'].balance_effect_amount, -4.44);
  assert.equal(e.WD1.balance_effect_amount, -657.61);
});

test('raw Fee stays signed negative (no ABS)', () => {
  const p = byId(ok()).PAY1;
  assert.equal(p.gross_amount, 91.98);
  assert.equal(p.fee_amount, -3.24);
  assert.equal(p.net_amount, 88.74);
});

test('gross + fee = net within 0.005', () => {
  assert.doesNotThrow(() => ok(set(inputs(), 1, 'Net', 88.744)));
  assert.match(errorsOf(build(set(inputs(), 1, 'Net', 88.76))), /Row 2 \(PAY1\): 91.98 \+ -3.24 != 88.76/);
  assert.match(errorsOf(build(set(inputs(), 1, 'Fee', 3.24))), /91.98 \+ 3.24 != 88.74/, 'positive fee breaks invariant');
});

test('non-numeric amounts are rejected', () => {
  assert.match(errorsOf(build(set(inputs(), 1, 'Gross', '91,98'))), /non-numeric Gross\/Fee\/Net/);
});

test('unverified Balance Impact sign is rejected (Debit with positive net)', () => {
  const g = inputs();
  set(g, 4, 'Gross', 657.61); set(g, 4, 'Net', 657.61);
  assert.match(errorsOf(build(g)), /Debit with positive net 657.61/);
});

// ---- Keys / relationships --------------------------------------------------------
test('duplicate external event ID is rejected', () => {
  const g = inputs();
  g[5] = row({});
  assert.match(errorsOf(build(g)), /Duplicate event Transaction ID PAY1 \(rows 2, 6\)/);
});

test('PAYMENT provider_event_id and provider_transaction_id are deterministic', () => {
  const p = byId(ok()).PAY1;
  assert.equal(p.provider_event_id, 'PE-KH001-PAYPAL-PAY1');
  assert.equal(p.provider_transaction_id, 'PT-KH001-PAYPAL-PAY1');
  assert.equal(p.related_external_transaction_id, '');
  assert.equal(H.kh001ProviderEventId_('X'), 'PE-KH001-PAYPAL-X');
});

test('RESERVE_HOLD relates via Reference Txn ID', () => {
  const r = byId(ok())['03652371D0702611V'];
  assert.equal(r.related_external_transaction_id, 'PAY1');
  assert.equal(r.provider_transaction_id, 'PT-KH001-PAYPAL-PAY1');
});

test('RESERVE_HOLD requires Reference Txn ID', () => {
  assert.match(errorsOf(build(set(inputs(), 3, 'Reference Txn ID', ''))), /RESERVE_HOLD requires Reference Txn ID/);
});

test('Txn gốc validation for reserve, payment and withdrawal', () => {
  assert.match(errorsOf(build(set(inputs(), 3, 'Txn gốc', 'OTHER'))), /Txn gốc "OTHER" != Reference Txn ID "PAY1"/);
  assert.match(errorsOf(build(set(inputs(), 1, 'Txn gốc', 'OTHER'))), /Txn gốc "OTHER" != Transaction ID "PAY1"/);
  assert.match(errorsOf(build(set(inputs(), 4, 'Txn gốc', ''))), /Txn gốc "" != Transaction ID "WD1"/);
});

test('missing Provider Transaction link is rejected (payment and reserve)', () => {
  const onlyPending = H.indexProviderTransactions_([PT('80B6789902665252D')]);
  const msg = errorsOf(build(inputs(), onlyPending));
  assert.match(msg, /PAYMENT PAY1 links to missing Provider Transaction PT-KH001-PAYPAL-PAY1/);
  assert.match(msg, /RESERVE_HOLD 03652371D0702611V links to missing Provider Transaction PT-KH001-PAYPAL-PAY1/);
  const wrong = H.indexProviderTransactions_([{ ...PT('PAY1'), payment_source: 'STRIPE' }, PT('80B6789902665252D')]);
  assert.match(errorsOf(build(inputs(), wrong)), /mismatching provider\/source\/external id/);
});

test('WITHDRAWAL does not link to a Provider Transaction', () => {
  const w = byId(ok()).WD1;
  assert.equal(w.provider_transaction_id, '');
  assert.equal(w.related_external_transaction_id, '');
  assert.match(js(H.checkEventRelationship_({ event_type: 'WITHDRAWAL', external_event_id: 'WD1',
    related_external_transaction_id: '', provider_transaction_id: 'PT-KH001-PAYPAL-PAY1' }, ptIndex())), /must not link/);
});

test('missing required header (Reference Txn ID / Txn gốc) fails', () => {
  const g = inputs();
  g[0] = g[0].map((h) => (h === 'Txn gốc' ? 'Root' : h));
  assert.throws(() => build(g), /Missing required header\(s\) in Raw KH001 PayPal: Txn gốc/);
});

// ---- Determinism / partition -----------------------------------------------------
test('source fingerprint is deterministic and depends only on raw checksum + version', () => {
  const a = H.computeKh001EventsFingerprint_('pp1');
  assert.equal(a, H.computeKh001EventsFingerprint_('pp1'));
  assert.notEqual(a, H.computeKh001EventsFingerprint_('pp2'));
  assert.equal(a, crypto.createHash('sha256').update('pp1|KH001_PROVIDER_EVENTS_V1').digest('hex'));
});

test('output checksum is deterministic, order-independent and ignores normalized_at', () => {
  const rows = () => ok().rows.map((o) => H.objectToRow_(o, COLUMNS));
  const c = H.partitionChecksum_(rows(), COLUMNS, SORT, 'normalized_at');
  assert.equal(c, H.partitionChecksum_(rows().reverse(), COLUMNS, SORT, 'normalized_at'));
  const stamped = rows().map((r) => { const x = r.slice(); x[COLUMNS.indexOf('normalized_at')] = D('2026-10-11T00:00:00Z'); return x; });
  assert.equal(c, H.partitionChecksum_(stamped, COLUMNS, SORT, 'normalized_at'));
});

test('NO_CHANGE for identical target; manual modification triggers rebuild', () => {
  const rows = ok().rows.map((o) => H.objectToRow_(o, COLUMNS));
  const sortIdx = SORT.map((c) => COLUMNS.indexOf(c));
  const stamp = [COLUMNS.indexOf('normalized_at')];
  const tableVals = () => H.buildTableValues_(COLUMNS, H.sortCanonicalRows_(rows, sortIdx));
  const expected = H.tableChecksumExcluding_(tableVals(), stamp);
  assert.equal(H.decideCanonicalWrite_(expected, H.tableChecksumExcluding_(tableVals(), stamp)), 'NO_CHANGE');
  const edited = tableVals();
  edited[1][COLUMNS.indexOf('balance_effect_amount')] = 1;
  assert.equal(H.decideCanonicalWrite_(expected, H.tableChecksumExcluding_(edited, stamp)), 'WRITE');
});

test('KH001 partition refresh preserves other providers', () => {
  const pid = COLUMNS.indexOf('provider_id');
  const kh = ok().rows.map((o) => H.objectToRow_(o, COLUMNS));
  const other = H.objectToRow_({ provider_event_id: 'PE-KH002-STRIPE-ev1', provider_id: 'KH002', payment_source: 'STRIPE',
    external_event_id: 'ev1', event_type: 'PAYMENT', event_at: D('2026-10-01T00:00:00Z') }, COLUMNS);
  const merged = H.mergeProviderPartition_([other, H.objectToRow_({ provider_id: 'KH001', external_event_id: 'OLD' }, COLUMNS)], kh, pid, 'KH001');
  assert.equal(merged.length, 5);
  assert.ok(merged.includes(other));
  const keyIdx = ['provider_id', 'payment_source', 'external_event_id'].map((c) => COLUMNS.indexOf(c));
  assert.deepEqual(js(H.findDuplicateKeys_(merged, keyIdx)), []);
});

// ---- Stored-row checks / summary / regression ------------------------------------
test('checkProviderEventRows_ finds invariant, balance-effect, relationship and duplicate problems', () => {
  const rows = js(ok().rows).map((r) => ({ ...r, event_at: D(r.event_at) }));
  assert.deepEqual(js(H.flattenEventErrors_(H.checkProviderEventRows_(rows, ptIndex()))), []);
  const bad = rows.map((r) => ({ ...r }));
  bad[0].net_amount = 1;                                   // PAY1 invariant + effect mismatch
  bad[1].balance_effect_amount = 78.73;                    // Memo must be 0
  bad[3].provider_transaction_id = 'PT-KH001-PAYPAL-PAY1'; // withdrawal linked
  bad.push({ ...rows[2] });                                // duplicate reserve
  const e = js(H.checkProviderEventRows_(bad, ptIndex()));
  assert.deepEqual(e.amount_invariant, ['PAY1']);
  assert.deepEqual(e.balance_impact, ['PAY1', '80B6789902665252D']);
  assert.equal(e.relationship.length, 1);
  assert.deepEqual(e.duplicate, ['03652371D0702611V']);
});

test('summary: counts, per-type totals (signed), balance effect vs net', () => {
  const s = js(H.summarizeProviderEvents_(ok().rows));
  assert.deepEqual(s.event_type_counts, { PAYMENT: 2, RESERVE_HOLD: 1, WITHDRAWAL: 1 });
  assert.deepEqual(s.balance_impact_counts, { Credit: 1, Memo: 1, Debit: 2 });
  assert.deepEqual(s.totals_by_event_type.PAYMENT, { gross: 170.71, fee: -3.24, net: 167.47, balance_effect: 88.74 });
  assert.deepEqual(s.linked_counts, { PAYMENT: 2, RESERVE_HOLD: 1, WITHDRAWAL: 0 });
  assert.equal(s.total_net, -494.58, 'cent-exact (no floating-point drift)');
  assert.equal(s.total_balance_effect, -573.31, 'Memo payment excluded');
});

test('regression report is separate and only passes for the expected snapshot', () => {
  const exp = js(vm.runInContext('KH001_PROVIDER_EVENTS_REGRESSION', context));
  const summary = {
    row_count: exp.row_count, unique_event_count: exp.unique_event_count, event_type_counts: exp.event_type_counts,
    status_counts: exp.status_counts, balance_impact_counts: exp.balance_impact_counts, currency_counts: exp.currency_counts,
    linked_counts: exp.linked_counts, total_net: exp.total_net, total_balance_effect: exp.total_balance_effect,
    totals_by_event_type: Object.fromEntries(Object.entries(exp.totals_by_event_type).map(([k, v]) => [k, { ...v, balance_effect: 0 }])),
  };
  const source = { paypal_rows: 3000, paypal_columns: 47 };
  assert.equal(H.evaluateKh001ProviderEventsRegression_(summary, source).pass, true);
  const r = js(H.evaluateKh001ProviderEventsRegression_({ ...summary, total_balance_effect: 119.31 }, source));
  assert.deepEqual(r.failed, ['total_balance_effect']);
  assert.equal(H.evaluateKh001ProviderEventsRegression_(js(H.summarizeProviderEvents_(ok().rows)), source).pass, false);
});

// ---- Dependency freshness: Provider Transactions must match CURRENT raw snapshots ----
const PT_COLUMNS = js(H.getColumnNames_('Provider Transactions'));
const RC_HEADER = ['Transaction ID', 'Có trên KH', 'Có trên PP', 'Trạng thái', 'Mã cổng', 'Sub account', 'Thời gian GD',
  'Số tiền KH', 'Gross PayPal', 'Chênh lệch', 'Phí PayPal', 'Net'];
function reconciled(overrides) {
  const r = { 'Transaction ID': 'PAY1', 'Có trên KH': 'x', 'Có trên PP': 'x', 'Trạng thái': 'Khớp', 'Mã cổng': 'G01',
    'Sub account': 'SUB-1', 'Thời gian GD': D('2026-10-02T15:00:00Z'), 'Số tiền KH': 91.98, 'Gross PayPal': 91.98,
    'Chênh lệch': 0, 'Phí PayPal': 3.24, Net: 88.74, ...overrides };
  const blank = RC_HEADER.map(() => '');
  return [blank, blank, blank, blank, blank, RC_HEADER, RC_HEADER.map((h) => r[h])];
}
const grid = (values) => ({ values, checksum: H.computeRawChecksum_(values) });
/** Simulates normalizeKh001ProviderTransactions output stored in the sheet (sorted, stamped). */
function storedPt(paypalValues, reconciledValues) {
  const p = grid(paypalValues);
  const r = grid(reconciledValues);
  const fp = H.computeKh001SourceFingerprint_(p.checksum, r.checksum);
  const rows = H.buildKh001ProviderTransactions_(paypalValues, reconciledValues, fp).rows.map((o) => H.objectToRow_(o, PT_COLUMNS));
  const sortIdx = ['provider_id', 'payment_source', 'transaction_at', 'external_transaction_id'].map((c) => PT_COLUMNS.indexOf(c));
  return H.sortCanonicalRows_(rows, sortIdx).map((row) => { const x = row.slice(); x[PT_COLUMNS.indexOf('normalized_at')] = D('2026-10-11T00:00:00Z'); return x; });
}
const fresh = (paypalValues, reconciledValues, stored) =>
  js(H.checkKh001ProviderTransactionsCurrent_(grid(paypalValues), grid(reconciledValues), stored, PT_COLUMNS));

test('dependency: Provider Transactions exactly matching current raw PayPal + Reconciled is current', () => {
  const c = fresh(inputs(), reconciled({}), storedPt(inputs(), reconciled({})));
  assert.equal(c.current, true);
  assert.equal(c.reason, null);
  assert.equal(c.stored_rows, 2);
  assert.equal(c.expected_checksum, c.stored_checksum);
});

test('dependency: stale Provider Transaction (raw status/amount changed, PT not rerun) fails', () => {
  // PT normalized while 80B... was Pending/Memo; raw later shows Completed/Credit with a fee.
  const before = inputs();
  const after = inputs();
  set(after, 2, 'Status', 'Completed'); set(after, 2, 'Balance Impact', 'Credit');
  set(after, 2, 'Fee', -2.5); set(after, 2, 'Net', 76.23);
  const c = fresh(after, reconciled({}), storedPt(before, reconciled({})));
  assert.equal(c.current, false);
  assert.match(c.reason, /Provider Transactions KH001 partition is stale or modified; run normalizeKh001ProviderTransactions first/);
  // The event links themselves would still resolve, which is why this gate is needed.
  const b = build(after, H.indexProviderTransactions_(storedPt(before, reconciled({})).map((r) => H.rowToObject_(r, PT_COLUMNS))));
  assert.deepEqual(js(H.flattenEventErrors_(b.errors)), []);
});

test('dependency: manually edited Provider Transaction with intact IDs and fingerprint fails', () => {
  const stored = storedPt(inputs(), reconciled({}));
  stored[0] = stored[0].slice();
  stored[0][PT_COLUMNS.indexOf('gross_amount')] = 1000;   // id + source_fingerprint unchanged
  const c = fresh(inputs(), reconciled({}), stored);
  assert.equal(c.current, false);
  assert.match(c.reason, /stale or modified/);
  const reordered = storedPt(inputs(), reconciled({})).reverse();
  assert.equal(fresh(inputs(), reconciled({}), reordered).current, false, 'non-canonical stored order is a modification');
});

test('dependency: Reconciled snapshot changed and PT not rerun fails until PT is refreshed', () => {
  const stored = storedPt(inputs(), reconciled({}));
  const changed = reconciled({ 'Sub account': 'SUB-9' });
  assert.equal(fresh(inputs(), changed, stored).current, false);
  assert.equal(fresh(inputs(), changed, storedPt(inputs(), changed)).current, true, 'after PT refresh');
});

test('dependency: missing KH001 rows, extra rows and other providers', () => {
  const stored = storedPt(inputs(), reconciled({}));
  assert.equal(fresh(inputs(), reconciled({}), stored.slice(1)).current, false, 'missing row');
  assert.equal(fresh(inputs(), reconciled({}), []).current, false, 'empty Provider Transactions');
  const other = H.objectToRow_({ provider_id: 'KH002', payment_source: 'STRIPE', external_transaction_id: 'pi_1' }, PT_COLUMNS);
  assert.equal(fresh(inputs(), reconciled({}), stored.concat([other])).current, true, 'other providers are ignored');
});

test('dependency: raw that the Provider Transactions normalizer rejects is reported, not thrown', () => {
  const bad = set(inputs(), 1, 'Net', 1);
  const c = fresh(bad, reconciled({}), storedPt(inputs(), reconciled({})));
  assert.equal(c.current, false);
  assert.match(c.reason, /cannot be rebuilt from the current raw snapshot: .*Amount invariant failed/);
});
