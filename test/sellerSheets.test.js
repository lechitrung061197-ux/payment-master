// Unit tests for Phase 2K seller child sheets: destination validation, seller snapshots (isolation, unknown
// economics, summary equations) and the sync/verify flow against in-memory child spreadsheets. Fake data.
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
const near = (a, b) => Math.abs(a - b) < 1e-9;
const MASTER_ID = 'MASTER_SPREADSHEET_ID_0000000001';
const CHILD_A = 'CHILD_SPREADSHEET_A_000000000001';
const CHILD_B = 'CHILD_SPREADSHEET_B_000000000002';

// ---- Destinations ------------------------------------------------------------------------------------
const SELLERS = [{ seller_id: 'CUS001', seller_name: 'DITECH' }, { seller_id: 'CUS002', seller_name: 'HUI' }, { seller_id: 'CUS003', seller_name: 'DINO' }];
const dest = (o) => ({ seller_id: 'CUS001', seller_name_snapshot: 'DITECH', spreadsheet_id: CHILD_A, status: 'ACTIVE', notes: '', ...o });
const parseDest = (rows, guard) => H.parseSellerDestinations_(rows, SELLERS, guard || { masterId: MASTER_ID, protectedIds: [] });
const derrs = (p) => js(H.flattenDestinationErrors_(p.errors)).join(' | ');

test('seed plan: one INACTIVE row per seller with a blank spreadsheet_id, sorted', () => {
  const plan = js(H.planSellerDestinationsSeed_([SELLERS[1], SELLERS[0], { seller_id: '', seller_name: 'draft' }]));
  assert.deepEqual(plan.map((d) => [d.seller_id, d.seller_name_snapshot, d.spreadsheet_id, d.status]),
    [['CUS001', 'DITECH', '', 'INACTIVE'], ['CUS002', 'HUI', '', 'INACTIVE']]);
});

test('valid destinations: ACTIVE needs an ID, INACTIVE may be blank; missing sellers and name changes are warnings', () => {
  const p = parseDest([dest({}), dest({ seller_id: 'CUS002', seller_name_snapshot: 'Old HUI', spreadsheet_id: '', status: 'INACTIVE' })]);
  assert.equal(derrs(p), '');
  assert.deepEqual(js(p.active).map((d) => d.seller_id), ['CUS001']);
  assert.deepEqual(js(p.missing_sellers), ['CUS003']);
  assert.equal(js(p.snapshot_name_mismatches).length, 1);
  assert.match(js(p.warnings).join(), /without a Seller Destinations row \(not synced\): CUS003/);
});

test('leak-risk / ambiguity errors: duplicate ACTIVE spreadsheet, Master id, unknown or duplicate seller, ACTIVE without id, URL', () => {
  assert.match(derrs(parseDest([dest({}), dest({ seller_id: 'CUS002', seller_name_snapshot: 'HUI' })])), /is ACTIVE for several rows: CUS001.*CUS002/);
  assert.match(derrs(parseDest([dest({ spreadsheet_id: MASTER_ID, status: 'INACTIVE' })])), /is the Payment Master spreadsheet/);
  assert.match(derrs(parseDest([dest({ spreadsheet_id: 'PROVIDER_SOURCE_ID_00000000001' })],
    { masterId: MASTER_ID, protectedIds: [{ id: 'PROVIDER_SOURCE_ID_00000000001', label: 'the KH001 provider source spreadsheet' }] })),
  /KH001 provider source spreadsheet/);
  assert.match(derrs(parseDest([dest({ seller_id: 'CUS999' })])), /unknown seller CUS999/);
  assert.match(derrs(parseDest([dest({}), dest({ spreadsheet_id: CHILD_B, status: 'INACTIVE' })])), /CUS001: 2 rows/);
  assert.match(derrs(parseDest([dest({ spreadsheet_id: '' })])), /ACTIVE destination for CUS001 has no spreadsheet_id/);
  assert.match(derrs(parseDest([dest({ spreadsheet_id: 'https://docs.google.com/spreadsheets/d/' + CHILD_A })])), /not a URL/);
  assert.match(derrs(parseDest([dest({ status: 'LIVE' })])), /status must be ACTIVE or INACTIVE/);
  const shared = parseDest([dest({}), dest({ seller_id: 'CUS002', seller_name_snapshot: 'HUI', status: 'INACTIVE' })]);
  assert.equal(derrs(shared), '', 'an INACTIVE row sharing the id is only a warning');
  assert.match(js(shared.warnings).join(), /appears on several rows/);
  assert.equal(js(parseDest([dest({}), dest({ seller_id: 'CUS999' })]).active).length, 0, 'any error -> nothing is active');
});

// ---- Master fixture ------------------------------------------------------------------------------------
const ST1 = 'ST-KH001-PAYPAL-000001';
const ST2 = 'ST-KH001-PAYPAL-000002';
let seq = 0;
function txn(seller, o) {
  seq++;
  const id = o.id || 'T' + String(seq).padStart(4, '0');
  return { internal_transaction_id: id, created_at: D('2026-10-0' + (1 + (seq % 8)) + 'T15:00:00Z'), payment_source: 'PAYPAL',
    endpoint_token: 'glk_secretToken' + seller, seller_id: seller, seller_name_snapshot: 'x', store_domain: 'shop-' + seller + '.com',
    order_id: 'ORD-' + id, order_amount: o.gross || 100, currency: 'USD', customer: 'buyer@example.com', ownership_status: 'MAPPED',
    status: 'UNMATCHED', ...o.tx };
}
function leg(t, status, o) {
  const net = (t.order_amount || 100) - 4;
  const hold = net * 0.1;
  const base = { payment_leg_id: 'PL-' + t.internal_transaction_id, match_id: 'PM-' + t.internal_transaction_id,
    internal_transaction_id: t.internal_transaction_id, payment_source: 'PAYPAL', provider: 'KH001', external_transaction_id: t.internal_transaction_id,
    currency: 'USD', gross_amount: t.order_amount, processing_fee: 4, net_amount: net, provider_fee_rate: 0.07, provider_fee: net * 0.07,
    provider_hold_rate: 0.1, provider_hold_amount: hold, seller_fee_rate: 0.08, seller_fee: net * 0.08, seller_hold_rate: 0.1,
    seller_hold_amount: hold, seller_available_amount: net - net * 0.08 - hold, settlement_id: status === 'WAITING_SETTLEMENT' ? '' : ST1,
    settlement_status: status };
  return { ...base, ...o };
}
const match = (t, status) => ({ match_id: 'PM-' + t.internal_transaction_id, payment_source: 'PAYPAL', internal_transaction_id: t.internal_transaction_id,
  external_transaction_id: status === 'MISSING_PROVIDER' ? '' : t.internal_transaction_id, provider_transaction_id: 'PT-x', provider_id: status === 'MISSING_PROVIDER' ? '' : 'KH001',
  reconciliation_status: status, match_status: status === 'MATCHED' ? 'CONFIRMED' : '' });

function fixture() {
  seq = 0;
  const a1 = txn('CUS001', { id: 'A-AVAIL', gross: 100 });
  const a2 = txn('CUS001', { id: 'A-SETTLED', gross: 200 });
  const a3 = txn('CUS001', { id: 'A-WAIT-KNOWN', gross: 50 });
  const a4 = txn('CUS001', { id: 'A-WAIT-UNKNOWN', gross: 60 });
  const a5 = txn('CUS001', { id: 'A-MISSING', gross: 70 });
  const b1 = txn('CUS002', { id: 'B-AVAIL', gross: 300 });
  const b2 = txn('CUS002', { id: 'B-MISSING', gross: 30 });
  const u1 = txn('', { id: 'U-UNASSIGNED', tx: { seller_id: '', ownership_status: 'UNASSIGNED_ENDPOINT' } });
  const transactions = [a1, a2, a3, a4, a5, b1, b2, u1];
  const matches = [match(a1, 'MATCHED'), match(a2, 'MATCHED'), match(a3, 'MATCHED'), match(a4, 'MATCHED'), match(a5, 'MISSING_PROVIDER'),
    match(b1, 'MATCHED'), match(b2, 'MISSING_PROVIDER'), match(u1, 'MATCHED')];
  const legs = [leg(a1, 'AVAILABLE'), leg(a2, 'SETTLED', { settlement_id: ST2 }), leg(a3, 'WAITING_SETTLEMENT'),
    leg(a4, 'WAITING_SETTLEMENT', { provider_fee_rate: '', provider_fee: '', provider_hold_rate: '', provider_hold_amount: '', seller_hold_rate: '',
      seller_hold_amount: '', seller_available_amount: '' }),
    leg(b1, 'AVAILABLE'), leg(u1, 'AVAILABLE')];
  const settlements = [{ settlement_id: ST1, period_end_date: D('2026-10-04T04:00:00Z'), source_payment_date: D('2026-10-06T04:00:00Z'), provider_fee_amount: 999 },
    { settlement_id: ST2, period_end_date: D('2026-10-09T04:00:00Z'), source_payment_date: '', provider_fee_amount: 999 }];
  const availA = legs[0].seller_available_amount;
  const availB = legs[4].seller_available_amount;
  const balances = [{ seller_id: 'CUS001', currency: 'USD', settled_amount: availA, available_amount: availA, paid_amount: 0,
    seller_hold_balance: legs[0].seller_hold_amount, adjustments: 0, current_balance: availA },
  { seller_id: 'CUS002', currency: 'USD', settled_amount: availB, available_amount: availB - 50, paid_amount: 50,
    seller_hold_balance: legs[4].seller_hold_amount, adjustments: 0, current_balance: availB - 50 }];
  const payout = (id, status, amount) => ({ seller_payout_id: id, seller_id: 'CUS002', payout_date: D('2026-10-08T04:00:00Z'), currency: 'USD', amount,
    fx_rate: '', payout_currency: '', payout_amount: '', payment_method: 'Bank', reference: 'REF-' + id, status, notes: 'internal note' });
  const payouts = [payout('SP-B1', 'SENT', 30), payout('SP-B2', 'DRAFT', 999), payout('SP-B3', 'VOID', 888), payout('SP-B4', 'CONFIRMED', 20)];
  const adjustment = (id, status) => ({ adjustment_id: id, adjustment_type: 'MANUAL_ADJUSTMENT', seller_id: 'CUS001', provider: 'KH001', payment_source: 'PAYPAL',
    external_event_id: 'EVT-' + id, internal_transaction_id: 'A-AVAIL', payment_leg_id: 'PL-A-AVAIL', settlement_id: ST1, dispute_id: '',
    currency: 'USD', amount: 0, effective_date: D('2026-10-07T04:00:00Z'), status, reason: 'review', created_at: '', created_by: 'ops' });
  const adjustments = [adjustment('ADJ-A1', 'APPLIED'), adjustment('ADJ-A2', 'PENDING'), adjustment('ADJ-A3', 'VOID')];
  return { transactions, matches, legs, settlements, balances, payouts, adjustments, masterSchemaVersion: 13 };
}
const SNAP_SELLERS = [{ seller_id: 'CUS001', seller_name: 'DITECH' }, { seller_id: 'CUS002', seller_name: 'HUI' }];
const snaps = (f) => {
  const b = H.buildSellerSnapshots_({ ...(f || fixture()), sellers: SNAP_SELLERS });
  assert.deepEqual(js(b.errors), []);
  return b.snapshots;
};
const rowsOf = (snap, tab) => {
  const cols = js(H.sellerOutputColumns_(tab));
  return js(snap.values[tab].map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]]))));
};

// ---- Snapshot content ------------------------------------------------------------------------------------
test('seller isolation: each seller sees only its own transactions, settlements, payouts and adjustments', () => {
  const s = snaps();
  const a = rowsOf(s.CUS001, 'Transactions').map((r) => r.internal_transaction_id).sort();
  const b = rowsOf(s.CUS002, 'Transactions').map((r) => r.internal_transaction_id).sort();
  assert.deepEqual(a, ['A-AVAIL', 'A-MISSING', 'A-SETTLED', 'A-WAIT-KNOWN', 'A-WAIT-UNKNOWN']);
  assert.deepEqual(b, ['B-AVAIL', 'B-MISSING']);
  assert.ok(!a.some((id) => b.includes(id)) && !a.includes('U-UNASSIGNED') && !b.includes('U-UNASSIGNED'));
  assert.deepEqual(rowsOf(s.CUS001, 'Payouts'), []);
  assert.deepEqual(rowsOf(s.CUS002, 'Payouts').map((p) => p.seller_payout_id), ['SP-B1', 'SP-B4']);
  assert.deepEqual(rowsOf(s.CUS002, 'Adjustments'), []);
  assert.deepEqual(rowsOf(s.CUS001, 'Adjustments').map((x) => x.adjustment_id), ['ADJ-A1']);
  const st = rowsOf(s.CUS002, 'Settlements');
  assert.equal(st.length, 1);
  assert.equal(st[0].transaction_count, 1, 'only CUS002 legs, not the provider-wide settlement');
  assert.ok(near(st[0].seller_amount_after_fee_hold, fixture().legs[4].seller_available_amount));
  rowsOf(s.CUS001, 'Summary').forEach((r) => assert.equal(r.seller_id, 'CUS001'));
});

test('MISSING_PROVIDER rows appear with every financial / settlement field blank', () => {
  const r = rowsOf(snaps().CUS001, 'Transactions').find((x) => x.internal_transaction_id === 'A-MISSING');
  assert.equal(r.reconciliation_status, 'MISSING_PROVIDER');
  assert.equal(r.accounting_state, 'MISSING_PROVIDER');
  assert.equal(r.order_amount, 70, 'internal order data is shown');
  ['external_transaction_id', 'provider', 'gross_amount', 'processing_fee', 'net_amount', 'seller_fee_rate', 'seller_fee', 'seller_hold_amount',
    'seller_amount_after_fee_hold', 'available_to_payout', 'settlement_id', 'settlement_status', 'provider_payment_date']
    .forEach((f) => assert.equal(r[f], '', f));
});

test('AVAILABLE has available_to_payout; SETTLED has the seller amount but no available_to_payout', () => {
  const t = rowsOf(snaps().CUS001, 'Transactions');
  const avail = t.find((x) => x.internal_transaction_id === 'A-AVAIL');
  const settled = t.find((x) => x.internal_transaction_id === 'A-SETTLED');
  assert.equal(avail.accounting_state, 'AVAILABLE');
  assert.ok(avail.available_to_payout > 0 && near(avail.available_to_payout, avail.seller_amount_after_fee_hold));
  assert.equal(new Date(avail.provider_payment_date).toISOString(), '2026-10-06T04:00:00.000Z');
  assert.equal(settled.accounting_state, 'SETTLED');
  assert.ok(settled.seller_amount_after_fee_hold > 0);
  assert.equal(settled.available_to_payout, '');
  const st = rowsOf(snaps().CUS001, 'Settlements');
  assert.deepEqual(st.map((x) => [x.settlement_id, x.settlement_status]), [[ST1, 'AVAILABLE'], [ST2, 'SETTLED']]);
  assert.equal(st[1].available_to_payout, 0);
});

test('summary: pending includes known non-AVAILABLE amounts/holds; unknown economics never estimated; equations hold', () => {
  const f = fixture();
  const [l1, l2, l3] = f.legs;
  const s = rowsOf(snaps(f).CUS001, 'Summary');
  assert.equal(s.length, 1);
  const r = s[0];
  assert.ok(near(r.current_balance, l1.seller_available_amount));
  assert.ok(near(r.settled_hold_remaining, l1.seller_hold_amount));
  assert.ok(near(r.pending_settlement_amount, l2.seller_available_amount + l3.seller_available_amount), 'SETTLED + WAITING with known economics');
  assert.ok(near(r.pending_hold_amount, l2.seller_hold_amount + l3.seller_hold_amount), 'no hold for the unknown-economics leg');
  assert.ok(near(r.total_known_hold, r.settled_hold_remaining + r.pending_hold_amount));
  assert.ok(near(r.total_known_obligation, r.current_balance + r.pending_settlement_amount + r.total_known_hold));
  assert.deepEqual([r.total_transactions, r.matched_transactions, r.missing_provider_transactions, r.waiting_settlement_transactions,
    r.settled_not_paid_transactions, r.available_transactions, r.unknown_economics_transactions], [5, 4, 1, 2, 1, 1, 2]);
  const unknown = rowsOf(snaps(f).CUS001, 'Transactions').find((x) => x.internal_transaction_id === 'A-WAIT-UNKNOWN');
  assert.equal(unknown.seller_hold_amount, '');
  assert.equal(unknown.seller_amount_after_fee_hold, '');
  assert.ok(unknown.seller_fee > 0, 'seller fee on the known net is shown');
  const b = rowsOf(snaps(f).CUS002, 'Summary')[0];
  assert.equal(b.paid_amount, 50);
  assert.ok(near(b.current_balance, f.balances[1].current_balance));
});

test('privacy: no forbidden column in any output tab; endpoint tokens, customers and provider fees never output', () => {
  assert.deepEqual(js(H.forbiddenSellerOutputColumns_()), []);
  const s = snaps();
  for (const snap of Object.values(s)) {
    const text = JSON.stringify(snap.values);
    assert.ok(!/glk_/.test(text) && !/buyer@example.com/.test(text) && !/internal note/.test(text) && !/EVT-/.test(text) && !/"ops"/.test(text));
    assert.ok(!text.includes(String(fixture().legs[0].provider_fee)), 'provider fee value absent');
    assert.deepEqual(js(H.findCredentialsInSnapshot_(snap)), []);
  }
  const leaky = fixture();
  leaky.transactions[0].store_domain = 'glk_abc.secret';
  const snap = H.buildSellerSnapshots_({ ...leaky, sellers: SNAP_SELLERS }).snapshots.CUS001;
  assert.equal(js(H.findCredentialsInSnapshot_(snap)).length, 1);
});

test('ledger filter: only SENT/CONFIRMED payouts and APPLIED adjustments are published; others never affect output', () => {
  const base = snaps();
  assert.deepEqual(rowsOf(base.CUS002, 'Payouts').map((p) => [p.seller_payout_id, p.status]), [['SP-B1', 'SENT'], ['SP-B4', 'CONFIRMED']]);
  assert.deepEqual(rowsOf(base.CUS001, 'Adjustments').map((a) => [a.adjustment_id, a.status]), [['ADJ-A1', 'APPLIED']]);
  const text = JSON.stringify([base.CUS001.values, base.CUS002.values]);
  assert.ok(!/SP-B2|SP-B3|ADJ-A2|ADJ-A3|DRAFT|PENDING|VOID/.test(text));
  // Adding / editing non-effective rows changes nothing seller-visible.
  const f = fixture();
  f.payouts.push({ seller_payout_id: 'SP-A9', seller_id: 'CUS001', payout_date: D('2026-10-09T04:00:00Z'), currency: 'USD', amount: 1, status: 'DRAFT' });
  f.payouts.find((p) => p.seller_payout_id === 'SP-B3').amount = 1;
  f.adjustments.push({ adjustment_id: 'ADJ-A9', adjustment_type: 'HOLD_RELEASE', seller_id: 'CUS001', currency: 'USD', amount: 5, status: 'PENDING' });
  const same = snaps(f);
  assert.deepEqual(js(same.CUS001.checksums), js(base.CUS001.checksums));
  assert.deepEqual(js(same.CUS002.checksums), js(base.CUS002.checksums));
  // ...until they become financially effective.
  f.payouts.find((p) => p.seller_payout_id === 'SP-A9').status = 'SENT';
  f.adjustments.find((a) => a.adjustment_id === 'ADJ-A9').status = 'APPLIED';
  const eff = snaps(f).CUS001;
  assert.notEqual(eff.checksums.payouts_checksum, base.CUS001.checksums.payouts_checksum);
  assert.notEqual(eff.checksums.adjustments_checksum, base.CUS001.checksums.adjustments_checksum);
  assert.deepEqual(rowsOf(eff, 'Payouts').map((p) => p.seller_payout_id), ['SP-A9']);
  assert.deepEqual(rowsOf(eff, 'Adjustments').map((a) => a.adjustment_id).sort(), ['ADJ-A1', 'ADJ-A9']);
});

test('integrity errors: transaction without a Payment Matches row or leg pointing to an unknown settlement', () => {
  const f = fixture();
  f.matches = f.matches.filter((m) => m.internal_transaction_id !== 'A-MISSING');
  assert.match(js(H.buildSellerSnapshots_({ ...f, sellers: SNAP_SELLERS }).errors).join(), /A-MISSING: no Payment Matches row/);
  const g = fixture();
  g.settlements = g.settlements.slice(0, 1);
  assert.match(js(H.buildSellerSnapshots_({ ...g, sellers: SNAP_SELLERS }).errors).join(), /settlement ST-KH001-PAYPAL-000002 not found/);
});

test('checksums are deterministic and the combined checksum covers the five content tabs', () => {
  const a = snaps().CUS001.checksums;
  const b = snaps().CUS001.checksums;
  assert.deepEqual(js(a), js(b));
  assert.equal(a.combined_checksum, H.sellerCombinedChecksum_(a));
  const f = fixture();
  f.payouts.push({ seller_payout_id: 'SP-A1', seller_id: 'CUS001', payout_date: D('2026-10-09T04:00:00Z'), currency: 'USD', amount: 1, status: 'SENT' });
  const c = snaps(f).CUS001.checksums;
  assert.notEqual(c.payouts_checksum, a.payouts_checksum);
  assert.notEqual(c.combined_checksum, a.combined_checksum);
  assert.equal(c.transactions_checksum, a.transactions_checksum);
});

test('overall status: PARTIAL when one fails and another succeeds; FAILED when none succeed', () => {
  const st = (...s) => H.decideSellerSyncStatus_(s.map((x) => ({ status: x })));
  assert.equal(st('SUCCESS', 'FAILED'), 'PARTIAL');
  assert.equal(st('NO_CHANGE', 'FAILED'), 'PARTIAL');
  assert.equal(st('FAILED', 'FAILED'), 'FAILED');
  assert.equal(st('SUCCESS', 'NO_CHANGE'), 'SUCCESS');
  assert.equal(st('NO_CHANGE', 'NO_CHANGE'), 'NO_CHANGE');
});

// ---- Sync / verify against in-memory child spreadsheets ---------------------------------------------------
function fakeChild(id, opts) {
  const log = [];
  const sheets = [];
  const mkSheet = (name) => {
    let cells = {};
    let rows = 1000;
    let cols = 26;
    const fmts = {};
    const sh = {
      name, failOnWrite: false,
      getName: () => name, getMaxRows: () => rows, getMaxColumns: () => cols,
      insertRowsAfter: (_a, n) => { rows += n; }, insertColumnsAfter: (_a, n) => { cols += n; },
      deleteRows: (s, n) => { rows -= n; Object.keys(cells).forEach((k) => { if (+k.split(',')[0] >= s) delete cells[k]; }); },
      deleteColumns: (s, n) => { cols -= n; Object.keys(cells).forEach((k) => { if (+k.split(',')[1] >= s) delete cells[k]; }); },
      clear: () => { cells = {}; }, getFilter: () => null, setFrozenRows: () => {}, setColumnWidth: () => {},
      cells: () => cells,
      getRange: (r, c, nr, nc) => {
        nr = nr || 1; nc = nc || 1;
        const rg = {
          getValues: () => Array.from({ length: nr }, (_x, i) => Array.from({ length: nc }, (_y, j) => {
            const v = cells[(r + i) + ',' + (c + j)];
            return v === undefined ? '' : (v instanceof Object && v.getTime ? D(new Date(v.getTime()).toISOString()) : v);
          })),
          getFormulas: () => Array.from({ length: nr }, (_x, i) => Array.from({ length: nc }, (_y, j) => {
            const v = cells[(r + i) + ',' + (c + j)];
            return typeof v === 'string' && v.startsWith('=') ? v : '';
          })),
          setValues: (v) => {
            if (sh.failOnWrite) throw new Error('simulated write failure on ' + name);
            log.push(name);
            v.forEach((row, i) => row.forEach((x, j) => { cells[(r + i) + ',' + (c + j)] = x; }));
            return rg;
          },
          setNumberFormat: (f) => { fmts[c] = f; return rg; }, setFontWeight: () => rg, setBackground: () => rg, setBorder: () => rg,
          clearDataValidations: () => rg, createFilter: () => ({}),
        };
        return rg;
      },
    };
    return sh;
  };
  const child = {
    tz: (opts && opts.tz) || 'America/New_York', sheets, log,
    getId: () => id, getSpreadsheetTimeZone: () => child.tz, setSpreadsheetTimeZone: (t) => { child.tz = t; },
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    insertSheet: (n) => { const s = mkSheet(n); sheets.push(s); return s; },
  };
  child.insertSheet('Seller Notes').getRange(1, 1, 1, 2).setValues([['my own', 'tab']]);
  log.length = 0;
  return child;
}

let env;
function installSync(o) {
  const f = o.fixture || fixture();
  env = { opened: [], audit: [], children: o.children || {}, gateCalls: 0 };
  const destRows = o.destinations || [dest({}), dest({ seller_id: 'CUS002', seller_name_snapshot: 'HUI', spreadsheet_id: CHILD_B })];
  Object.assign(context, {
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    getSpreadsheet_: () => ({ getId: () => MASTER_ID }),
    SpreadsheetApp: {
      flush: () => {},
      openById: (id) => {
        env.opened.push(id);
        if (!env.children[id]) throw new Error('You do not have permission to access the requested document.');
        return env.children[id];
      },
    },
    appendAuditLog_: (e) => env.audit.push(e),
    readSellerDestinations_: () => ({ rows: destRows, sellers: SELLERS, parsed: H.parseSellerDestinations_(destRows, SELLERS, { masterId: MASTER_ID, protectedIds: [] }) }),
    readSellerSheetsGates_: () => { env.gateCalls++; return o.gates || { current: true, gates: {}, reasons: [] }; },
    buildSellerSnapshotsFromMaster_: (_ss, sellers) => H.buildSellerSnapshots_({ ...f, sellers }),
  });
}
const tabValue = (child, tab, col, row) => {
  const cols = js(H.sellerOutputColumns_(tab));
  return child.getSheetByName(tab).getRange(row || 2, cols.indexOf(col) + 1, 1, 1).getValues()[0][0];
};

test('first sync writes both sellers (SUCCESS); custom tabs untouched; Sync Info written last', () => {
  const a = fakeChild(CHILD_A);
  const b = fakeChild(CHILD_B);
  installSync({ children: { [CHILD_A]: a, [CHILD_B]: b } });
  const r = js(H.runSellerSheetsSync_());
  assert.equal(r.status, 'SUCCESS', r.error);
  assert.deepEqual(r.sellers.map((s) => [s.seller_id, s.status]), [['CUS001', 'SUCCESS'], ['CUS002', 'SUCCESS']]);
  assert.equal(a.log[a.log.length - 1], 'Sync Info', 'Sync Info is the last write');
  assert.ok(a.log.indexOf('Summary') > a.log.lastIndexOf('Transactions'));
  assert.deepEqual(a.getSheetByName('Seller Notes').getRange(1, 1, 1, 2).getValues()[0], ['my own', 'tab'], 'custom tab untouched');
  assert.deepEqual(a.sheets.map((s) => s.name).sort(), ['Adjustments', 'Payouts', 'Seller Notes', 'Settlements', 'Summary', 'Sync Info', 'Transactions']);
  assert.equal(env.audit[0].action, 'SELLER_SHEETS_SYNC_SUCCESS');
  assert.equal(JSON.parse(JSON.stringify(env.audit[0].details)).sellers.length, 2, 'per-seller details audited');
  const ids = (child) => child.getSheetByName('Transactions').getRange(2, 1, 10, 1).getValues().map((x) => x[0]).filter(Boolean).sort();
  assert.deepEqual(ids(a), ['A-AVAIL', 'A-MISSING', 'A-SETTLED', 'A-WAIT-KNOWN', 'A-WAIT-UNKNOWN']);
  assert.deepEqual(ids(b), ['B-AVAIL', 'B-MISSING']);
});

test('verifySellerSheets is read-only: passes after sync, fails on tampering / incomplete sync, never writes', () => {
  const a = fakeChild(CHILD_A);
  const b = fakeChild(CHILD_B);
  installSync({ children: { [CHILD_A]: a, [CHILD_B]: b } });
  H.runSellerSheetsSync_();
  a.log.length = 0;
  b.log.length = 0;
  let v = js(H.buildSellerSheetsReport_());
  assert.equal(v.pass, true, v.errors.join());
  assert.equal(v.master_fresh, true);
  assert.deepEqual([v.active_destinations, v.passed_destinations, v.failed_destinations], [2, 2, 0]);
  const s = v.sellers[0];
  assert.deepEqual([s.seller_id, s.accessible, s.summary_match, s.transactions_match, s.settlements_match, s.payouts_match, s.adjustments_match,
    s.sync_info_match, s.combined_match, s.transaction_rows, s.settlement_rows, s.payout_rows, s.adjustment_rows, s.pass],
  ['CUS001', true, true, true, true, true, true, true, true, 5, 2, 0, 1, true]);
  assert.ok(v.regression && v.regression.pass === false, 'regression is report-only');
  a.getSheetByName('Transactions').getRange(2, 6, 1, 1).setValues([[12345]]);
  a.log.length = 0;
  v = js(H.buildSellerSheetsReport_());
  assert.equal(v.pass, false);
  assert.deepEqual([v.passed_destinations, v.failed_destinations], [1, 1]);
  assert.equal(v.sellers[0].transactions_match, false);
  assert.equal(v.sellers[0].combined_match, false);
  assert.deepEqual(a.log, [], 'verify never writes');
  assert.deepEqual(b.log, []);
  installSync({ children: { [CHILD_A]: a, [CHILD_B]: b }, gates: { current: false, gates: { payment_legs: false }, reasons: ['Payment Legs is stale'] } });
  v = js(H.buildSellerSheetsReport_());
  assert.equal(v.master_fresh, false);
  assert.equal(v.pass, false);
  assert.equal(v.sellers[1].pass, false, 'no seller passes against a stale Master');
});

test('unchanged sync is NO_CHANGE: nothing written, last_content_sync_at preserved; a change updates it', async () => {
  const a = fakeChild(CHILD_A);
  const b = fakeChild(CHILD_B);
  installSync({ children: { [CHILD_A]: a, [CHILD_B]: b } });
  H.runSellerSheetsSync_();
  const stamp1 = tabValue(a, 'Sync Info', 'last_content_sync_at').getTime();
  a.log.length = 0;
  const r2 = js(H.runSellerSheetsSync_());
  assert.equal(r2.status, 'NO_CHANGE');
  assert.deepEqual(a.log, [], 'no write at all');
  assert.equal(tabValue(a, 'Sync Info', 'last_content_sync_at').getTime(), stamp1);
  assert.equal(tabValue(a, 'Summary', 'last_content_sync_at').getTime(), stamp1);
  await new Promise((res) => setTimeout(res, 1100));
  const f = fixture();
  f.payouts.push({ seller_payout_id: 'SP-A1', seller_id: 'CUS001', payout_date: D('2026-10-09T04:00:00Z'), currency: 'USD', amount: 5, status: 'CONFIRMED' });
  installSync({ children: { [CHILD_A]: a, [CHILD_B]: b }, fixture: f });
  const r3 = js(H.runSellerSheetsSync_());
  assert.equal(r3.status, 'SUCCESS');
  assert.deepEqual(r3.sellers.map((s) => s.status), ['SUCCESS', 'NO_CHANGE']);
  assert.deepEqual(r3.sellers[0].written_tabs, ['Payouts', 'Summary', 'Sync Info'], 'only changed data tab + Summary + Sync Info');
  assert.ok(tabValue(a, 'Sync Info', 'last_content_sync_at').getTime() > stamp1);
});

for (const failTab of ['Summary', 'Sync Info']) {
  test(`a write failure on ${failTab} keeps the old Sync Info commit marker and is detected as stale/incomplete`, () => {
    const a = fakeChild(CHILD_A);
    const b = fakeChild(CHILD_B);
    installSync({ children: { [CHILD_A]: a, [CHILD_B]: b } });
    H.runSellerSheetsSync_();
    const infoBefore = JSON.stringify(a.getSheetByName('Sync Info').cells());
    const f = fixture();
    f.payouts.push({ seller_payout_id: 'SP-A1', seller_id: 'CUS001', payout_date: D('2026-10-09T04:00:00Z'), currency: 'USD', amount: 5, status: 'SENT' });
    installSync({ children: { [CHILD_A]: a, [CHILD_B]: b }, fixture: f });
    a.getSheetByName(failTab).failOnWrite = true;
    const r = js(H.runSellerSheetsSync_());
    assert.equal(r.sellers[0].status, 'FAILED');
    assert.match(r.sellers[0].error, new RegExp('simulated write failure on ' + failTab));
    assert.equal(r.status, 'PARTIAL');
    assert.equal(JSON.stringify(a.getSheetByName('Sync Info').cells()), infoBefore, 'old Sync Info remains');
    a.getSheetByName(failTab).failOnWrite = false;
    const snap = H.buildSellerSnapshots_({ ...f, sellers: SNAP_SELLERS }).snapshots.CUS001;
    const c = js(H.compareChildToSnapshot_(snap, H.readChildState_(a)));
    assert.equal(c.payouts_match, true, 'the data tab was already written');
    assert.equal(c.sync_info_match, false);
    assert.equal(c.combined_match, false);
    const v = js(H.buildSellerSheetsReport_());
    assert.equal(v.sellers[0].pass, false);
    assert.equal(v.sellers[1].pass, true);
    const again = js(H.runSellerSheetsSync_());
    assert.equal(again.sellers[0].status, 'SUCCESS', 'next sync repairs it');
    assert.equal(js(H.buildSellerSheetsReport_()).pass, true);
  });
}

test('inaccessible destination: that seller FAILED, the other seller still syncs -> PARTIAL', () => {
  const b = fakeChild(CHILD_B);
  installSync({ children: { [CHILD_B]: b } });
  const r = js(H.runSellerSheetsSync_());
  assert.equal(r.status, 'PARTIAL');
  assert.equal(r.sellers[0].status, 'FAILED');
  assert.match(r.sellers[0].error, /permission/);
  assert.equal(r.sellers[1].status, 'SUCCESS');
  assert.equal(env.audit[0].action, 'SELLER_SHEETS_SYNC_PARTIAL');
  installSync({ children: {} });
  assert.equal(js(H.runSellerSheetsSync_()).status, 'FAILED', 'no ACTIVE seller succeeded');
});

test('global leak-risk config errors and stale Master write nothing anywhere (no child opened)', () => {
  for (const destinations of [
    [dest({}), dest({ seller_id: 'CUS002', seller_name_snapshot: 'HUI' })], // same ACTIVE spreadsheet for two sellers
    [dest({ spreadsheet_id: MASTER_ID })],
    [dest({}), dest({ seller_id: 'CUS999', spreadsheet_id: CHILD_B })],
  ]) {
    const a = fakeChild(CHILD_A);
    installSync({ children: { [CHILD_A]: a }, destinations });
    const r = js(H.runSellerSheetsSync_());
    assert.equal(r.status, 'FAILED');
    assert.match(r.error, /Seller Destinations is invalid; no seller sheet written/);
    assert.deepEqual(env.opened, []);
    assert.equal(env.gateCalls, 0);
    assert.deepEqual(a.log, []);
  }
  const a = fakeChild(CHILD_A);
  installSync({ children: { [CHILD_A]: a }, gates: { current: false, gates: { seller_balances: false }, reasons: ['Seller Balances is stale'] } });
  const r = js(H.runSellerSheetsSync_());
  assert.equal(r.status, 'FAILED');
  assert.match(r.error, /Payment Master is not current; no seller sheet written: Seller Balances is stale/);
  assert.deepEqual(env.opened, []);
  const leaky = fixture();
  leaky.transactions[5].store_domain = 'glk_tok.secretvalue';
  installSync({ children: { [CHILD_A]: a }, fixture: leaky });
  const r2 = js(H.runSellerSheetsSync_());
  assert.match(r2.error, /endpoint tokens\/credentials; no seller sheet written/);
  assert.ok(!JSON.stringify(r2).includes('secretvalue'));
  assert.deepEqual(env.opened, []);
});

test('INACTIVE destinations are never opened; no ACTIVE destination -> NO_CHANGE', () => {
  const a = fakeChild(CHILD_A);
  const b = fakeChild(CHILD_B);
  installSync({ children: { [CHILD_A]: a, [CHILD_B]: b },
    destinations: [dest({}), dest({ seller_id: 'CUS002', seller_name_snapshot: 'HUI', spreadsheet_id: CHILD_B, status: 'INACTIVE' })] });
  const r = js(H.runSellerSheetsSync_());
  assert.equal(r.status, 'SUCCESS');
  assert.deepEqual(env.opened, [CHILD_A]);
  assert.deepEqual(b.log, []);
  installSync({ children: { [CHILD_A]: a }, destinations: [dest({ status: 'INACTIVE', spreadsheet_id: '' })] });
  const r2 = js(H.runSellerSheetsSync_());
  assert.equal(r2.status, 'NO_CHANGE');
  assert.deepEqual(env.opened, []);
  assert.equal(env.gateCalls, 0);
});

test('child checks: forbidden columns, formulas, foreign rows and wrong time zone are detected', () => {
  const a = fakeChild(CHILD_A);
  installSync({ children: { [CHILD_A]: a }, destinations: [dest({})] });
  H.runSellerSheetsSync_();
  const snap = H.buildSellerSnapshots_({ ...fixture(), sellers: SNAP_SELLERS }).snapshots.CUS001;
  assert.deepEqual(js(H.compareChildToSnapshot_(snap, H.readChildState_(a))).errors, []);
  const tx = a.getSheetByName('Transactions');
  tx.getRange(3, 1, 1, 1).setValues([['B-AVAIL']]);
  tx.getRange(4, 6, 1, 1).setValues([['=1+1']]);
  a.getSheetByName('Payouts').getRange(1, 1, 1, 1).setValues([['provider_fee']]);
  a.tz = 'America/Los_Angeles';
  const e = js(H.compareChildToSnapshot_(snap, H.readChildState_(a))).errors.join(' | ');
  assert.match(e, /isolation: Transactions shows internal_transaction_id B-AVAIL that is not owned by CUS001/);
  assert.match(e, /Transactions: 1 formula cell/);
  assert.match(e, /forbidden output column Payouts.provider_fee/);
  assert.match(e, /child time zone is America\/Los_Angeles/);
  installSync({ children: { [CHILD_A]: a }, destinations: [dest({})] });
  const r = js(H.runSellerSheetsSync_());
  assert.equal(r.status, 'SUCCESS', 'resync repairs the child');
  assert.equal(a.tz, 'America/New_York');
  assert.deepEqual(js(H.compareChildToSnapshot_(snap, H.readChildState_(a))).errors, []);
});

test('production regression report (report only)', () => {
  const exp = js(vm.runInContext('SELLER_SHEETS_REGRESSION', context));
  const fakeSnaps = {};
  for (const [id, e] of Object.entries(exp.sellers)) fakeSnaps[id] = { summary: [{ currency: 'USD', ...e }] };
  assert.equal(H.evaluateSellerSheetsRegression_(fakeSnaps).pass, true);
  for (const e of Object.values(exp.sellers)) {
    assert.ok(Math.abs(e.total_known_obligation - (e.current_balance + e.pending_settlement_amount + e.total_known_hold)) < 1e-9);
    assert.equal(e.total_transactions, e.matched_transactions + e.missing_provider_transactions);
  }
  assert.equal(H.evaluateSellerSheetsRegression_(snaps()).pass, false);
});
