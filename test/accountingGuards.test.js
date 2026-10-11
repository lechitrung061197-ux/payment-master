// Gate tests for the Phase 2I/2J review fixes: missing Seller Terms block downstream writers, and frozen
// Settlement Items need a valid snapshot_at. Runs the real normalizers/verifiers against an in-memory
// spreadsheet; only lock, swap-state, audit and unrelated upstream freshness are stubbed. Fake data.
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

// ---- in-memory spreadsheet -------------------------------------------------------------------------
function fakeSheet(name, values) {
  const width = Math.max(...values.map((r) => r.length));
  const grid = values.map((r) => [...r, ...Array(width - r.length).fill('')]);
  return {
    getName: () => name,
    getMaxRows: () => grid.length,
    getMaxColumns: () => width,
    getRange: (r, c, nr, nc) => ({ getValues: () => grid.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)) }),
  };
}
function fakeSpreadsheet(tables) {
  const sheets = Object.entries(tables).map(([name, rows]) => {
    const columns = js(H.getColumnNames_(name));
    return fakeSheet(name, [columns, ...rows.map((o) => columns.map((c) => (o[c] === undefined ? '' : o[c])))]);
  });
  return { getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null, getSheets: () => sheets };
}

// ---- stubs (set per test) ----------------------------------------------------------------------------
let calls;
function install(ss) {
  calls = { audit: [], writes: [], legInputs: 0 };
  Object.assign(context, {
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    getSpreadsheet_: () => ss,
    recoverSwapState_: () => ({ state: 'NORMAL', actions: [] }),
    detectSwapState_: () => ({ state: 'NORMAL' }),
    appendAuditLog_: (e) => calls.audit.push(e.action),
    writeCanonicalTable_: (_ss, schema) => calls.writes.push(schema.name),
    readInternalTransactionsFreshness_: () => ({ current: true, reason: null }),
    readProviderTransactionsFreshness_: () => ({ current: true, reason: null }),
    readPaymentMatchesFreshness_: () => ({ current: true, reason: null }),
    readKh001SettlementsFreshness_: () => ({ current: true, reason: null }),
  });
}

const SELLERS = [{ seller_id: 'CUS001', seller_name: 'Seller 1', status: 'ACTIVE', effective_from: D('2026-10-01T04:00:00Z') },
  { seller_id: 'CUS002', seller_name: 'Seller 2', status: 'ACTIVE', effective_from: D('2026-10-01T04:00:00Z') }];
const term = (id, n) => ({ seller_id: id, payment_source: 'PAYPAL', seller_name_snapshot: 'Seller ' + n, seller_fee_rate: 0.08, effective_from: D('2026-10-01T04:00:00Z') });

// ---- 1. Missing Seller Terms are blocking --------------------------------------------------------------
test('a seller without Seller Terms: validity not current, verifySellerTerms fails, Payment Legs fails before any read/write', () => {
  const ss = fakeSpreadsheet({ Sellers: SELLERS, 'Seller Terms': [term('CUS001', 1)] });
  install(ss);
  const validity = js(H.readSellerTermsValidity_(ss));
  assert.equal(validity.current, false);
  assert.deepEqual(validity.missing_sellers, ['CUS002']);
  assert.match(validity.reason, /Seller Terms is invalid \(1 error\(s\); sellers without terms: CUS002\)/);

  const report = js(H.buildSellerTermsReport_());
  assert.equal(report.pass, false);
  assert.deepEqual(report.missing_sellers, ['CUS002']);
  assert.match(report.errors.join(), /Sellers without Seller Terms: CUS002/);

  context.readPaymentLegsInputs_ = () => { calls.legInputs++; throw new Error('inputs must not be read'); };
  const r = js(H.runPaymentLegsNormalizer_());
  assert.equal(r.status, 'FAILED');
  assert.equal(r.seller_terms_valid, false);
  assert.match(r.error, /Seller Terms is invalid .*CUS002/);
  assert.equal(calls.legInputs, 0, 'gate fails before inputs are built');
  assert.deepEqual(calls.writes, [], 'nothing written');
  assert.deepEqual(calls.audit, ['PAYMENT_LEGS_NORMALIZE_FAILED']);
});

test('complete seller coverage: Seller Terms valid and the Payment Legs seller_terms gate passes', () => {
  const ss = fakeSpreadsheet({ Sellers: SELLERS, 'Seller Terms': [term('CUS001', 1), term('CUS002', 2)] });
  install(ss);
  const validity = js(H.readSellerTermsValidity_(ss));
  assert.equal(validity.current, true);
  assert.deepEqual(validity.missing_sellers, []);
  assert.equal(js(H.buildSellerTermsReport_()).pass, true);
  context.readPaymentLegsInputs_ = () => { calls.legInputs++; throw new Error('reached inputs'); };
  const r = js(H.runPaymentLegsNormalizer_());
  assert.equal(r.seller_terms_valid, true);
  assert.equal(r.error, 'reached inputs', 'all gates passed');
  assert.equal(calls.legInputs, 1);
});

test('setup never auto-seeds a missing seller once Seller Terms has data', () => {
  const ss = fakeSpreadsheet({ Sellers: SELLERS, 'Seller Terms': [term('CUS001', 1)] });
  assert.equal(H.seedSellerTermsIfEmpty_(ss, []), 0);
});

// ---- 2. Frozen Settlement Items need a valid snapshot_at -------------------------------------------------
const leg = (id, net) => ({ payment_leg_id: 'PL-' + id, settlement_id: 'ST-1', settlement_status: 'AVAILABLE', payment_source: 'PAYPAL',
  internal_transaction_id: id, external_transaction_id: id, currency: 'USD', gross_amount: net + 4, processing_fee: 4, net_amount: net,
  provider_fee_rate: 0.07, provider_fee: net * 0.07, provider_hold_rate: 0.1, provider_hold_amount: net * 0.1, seller_fee_rate: 0.08,
  seller_fee: net * 0.08, seller_hold_rate: 0.1, seller_hold_amount: net * 0.1, seller_available_amount: net - net * 0.08 - net * 0.1 });
const LEGS = [leg('TX1', 100), leg('TX2', 50)];
const TXS = LEGS.map((l) => ({ internal_transaction_id: l.internal_transaction_id, payment_source: 'PAYPAL', ownership_status: 'MAPPED', seller_id: 'CUS001' }));
const SI_COLUMNS = js(H.getColumnNames_('Settlement Items'));
const T1 = D('2026-01-05T08:00:00Z');
const frozen = () => H.buildSettlementItems_({ legs: LEGS, transactions: TXS, existingItems: [], now: T1, columns: SI_COLUMNS }).items;

function itemsSpreadsheet(existing) {
  const ss = fakeSpreadsheet({ 'Payment Legs': LEGS, Transactions: TXS, 'Settlement Items': existing });
  install(ss);
  const upstream = {};
  ['transactions', 'provider_transactions', 'payment_matches', 'settlements', 'seller_terms', 'payment_legs']
    .forEach((k) => { upstream[k] = { current: true, reason: null }; });
  context.readSettlementItemsUpstream_ = () => upstream;
  return ss;
}

for (const [label, value, pattern] of [['blank', '', /snapshot_at is blank/], ['text', 'yesterday', /snapshot_at "yesterday" is not a valid datetime/],
  ['invalid date', 'INVALID', /is not a valid datetime/]]) {
  test(`frozen item with ${label} snapshot_at: normalizeSettlementItems fails before write, verifySettlementItems fails`, () => {
    const items = frozen().map((x, i) => (i === 0 ? { ...x, snapshot_at: value === 'INVALID' ? D('nope') : value } : x));
    itemsSpreadsheet(items);
    const r = js(H.runSettlementItemsNormalizer_());
    assert.equal(r.status, 'FAILED');
    assert.match(r.error, pattern);
    assert.deepEqual(calls.writes, [], 'not repaired or rewritten');
    const v = js(H.buildSettlementItemsReport_());
    assert.equal(v.pass, false);
    assert.equal(v.invalid_snapshot_at.length, 1);
    assert.match(v.invalid_snapshot_at[0], pattern);
  });
}

test('frozen items with valid snapshot_at: NO_CHANGE, verify passes, snapshot_at preserved', () => {
  itemsSpreadsheet(frozen());
  const r = js(H.runSettlementItemsNormalizer_());
  assert.equal(r.status, 'NO_CHANGE', r.error);
  assert.deepEqual(calls.writes, []);
  const v = js(H.buildSettlementItemsReport_());
  assert.deepEqual(v.invalid_snapshot_at, []);
  assert.equal(v.pass, true, v.errors.join());
});

test('a new AVAILABLE leg is written with snapshot_at = now; existing snapshot_at untouched', () => {
  itemsSpreadsheet(frozen().slice(0, 1));
  let written;
  context.writeCanonicalTable_ = (_ss, schema, _tab, rows) => { written = rows; calls.writes.push(schema.name); };
  const r = js(H.runSettlementItemsNormalizer_());
  assert.equal(r.status, 'SUCCESS', r.error);
  assert.equal(r.new_items, 1);
  const at = SI_COLUMNS.indexOf('snapshot_at');
  const snaps = written.map((row) => row[at].getTime());
  assert.ok(snaps.includes(T1.getTime()), 'existing item keeps T1');
  assert.ok(snaps.some((t) => t !== T1.getTime() && Math.abs(t - Date.now()) < 60000), 'new item stamped at creation');
});

// ---- 3. Seller Balances read-only freshness (Phase 2K gate) ------------------------------------------------
test('readSellerBalancesFreshness_: current only when the stored table equals the rebuild (ignoring updated_at)', () => {
  const items = frozen().map((i) => ({ ...i, seller_id: 'CUS001' }));
  const built = H.buildSellerBalances_({ items, adjustments: [], payouts: [], sellerIds: ['CUS001', 'CUS002'], existing: [], now: T1,
    columns: js(H.getColumnNames_('Seller Balances')) }).rows;
  const fresh = { current: true, reason: null };
  const run = (balances, extra) => {
    const ss = fakeSpreadsheet({ Sellers: SELLERS, 'Settlement Items': items, 'Seller Balances': balances, Adjustments: [], 'Seller Payouts': [], ...extra });
    install(ss);
    return js(H.readSellerBalancesFreshness_(ss, fresh));
  };
  assert.equal(run(built).current, true);
  assert.equal(run(built.map((b) => ({ ...b, updated_at: D('2027-01-01T00:00:00Z') }))).current, true, 'updated_at ignored');
  const stale = run(built.map((b) => ({ ...b, current_balance: b.current_balance + 1 })));
  assert.equal(stale.current, false);
  assert.match(stale.reason, /Seller Balances is stale; run normalizeSellerBalances first/);
  const payout = run(built, { 'Seller Payouts': [{ seller_payout_id: 'SP-1', seller_id: 'CUS001', currency: 'USD', amount: 10, status: 'SENT' }] });
  assert.equal(payout.current, false, 'a new SENT payout makes stored balances stale');
  const invalid = run(built, { Adjustments: [{ adjustment_id: 'A1', adjustment_type: 'HOLD_RELEASE', seller_id: 'CUS001', currency: 'USD', amount: -1, status: 'APPLIED' }] });
  assert.match(invalid.reason, /Seller Balances is invalid \(1 error/);
  install(fakeSpreadsheet({ Sellers: SELLERS }));
  assert.match(js(H.readSellerBalancesFreshness_(fakeSpreadsheet({ Sellers: SELLERS }), { current: false, reason: 'Settlement Items is stale' })).reason,
    /Seller Balances upstream is stale \(Settlement Items is stale\)/);
});
