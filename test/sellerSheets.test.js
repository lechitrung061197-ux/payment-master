// Unit tests for seller child sheets: destination validation and the template-driven sync / verify flow
// (output contract v2) against in-memory replicas of the seller template. Fake data.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeSpreadsheet, cloneSpreadsheet, writesTo, formatOps, TEMPLATE } = require('./helpers/sellerFakes');
const { makeMaster } = require('./helpers/sellerMaster');

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
const near = (a, b) => Math.abs(a - b) < 1e-6;
const makeDate = (ms) => vm.runInContext(`new Date(${ms})`, context);
const NY = (v) => H.providerDateKey_(v, 'America/New_York');
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


// ---- Sync / verify against template replicas -------------------------------------------------------------
const KH001_SOURCE = 'KH001_SOURCE_SPREADSHEET_00000001';
const template = () => makeSpreadsheet({ id: 'TEMPLATE_SPREADSHEET_000000000001', makeDate });
const freshChild = (id) => cloneSpreadsheet(template(), id, makeDate);
function baseSpec() {
  return {
    sellers: [{ seller_id: 'CUS001', seller_name: 'DITECH' }, { seller_id: 'CUS002', seller_name: 'HUI' }],
    txs: [
      { id: '1001', seller: 'CUS001', order: 104, leg: { fee: 4, rate: 0.08, settlement: 'ST-1' } },
      { id: 'A-MISS', seller: 'CUS001', order: 70, status: 'MISSING_PROVIDER' },
      { id: 'B-1', seller: 'CUS002', order: 304, leg: { fee: 4, rate: 0.08, settlement: 'ST-1' } },
      { id: 'B-MISS', seller: 'CUS002', order: 30, status: 'MISSING_PROVIDER' },
    ],
  };
}
let env;
function installSync(o) {
  o = o || {};
  const master = o.master || makeMaster(D, o.spec || baseSpec());
  env = { opened: [], audit: [], children: o.children || {}, gateCalls: 0, master };
  const destRows = o.destinations || [dest({}), dest({ seller_id: 'CUS002', seller_name_snapshot: 'HUI', spreadsheet_id: CHILD_B })];
  Object.assign(context, {
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    getSpreadsheet_: () => ({ getId: () => MASTER_ID }),
    SpreadsheetApp: {
      flush: () => {},
      CopyPasteType: { PASTE_FORMAT: 'PASTE_FORMAT', PASTE_FORMULA: 'PASTE_FORMULA' },
      openById: (id) => {
        env.opened.push(id);
        if (!env.children[id]) throw new Error('You do not have permission to access the requested document.');
        return env.children[id].api;
      },
    },
    appendAuditLog_: (e) => env.audit.push(e),
    readSellerDestinations_: () => ({ rows: destRows, sellers: SELLERS, parsed: H.parseSellerDestinations_(destRows, SELLERS, { masterId: MASTER_ID, protectedIds: [] }) }),
    readSellerSheetsGates_: () => { env.gateCalls++; return o.gates || { current: true, gates: {}, reasons: [] }; },
    buildSellerSnapshotsFromMaster_: (_ss, sellers) => H.buildSellerOutputs_({ ...master, sellers, dateKeyOf: NY }),
    sellerHiddenIds_: () => [MASTER_ID, KH001_SOURCE],
  });
}
const cellOf = (ss, tab, r, c) => ss.sheets.find((s) => s.name === tab).cells[r + ',' + c] || {};
const syncValue = (ss, key) => { const s = ss.sheets.find((x) => x.name === '_Sync'); const row = Object.keys(s.cells).map((k) => k.split(',').map(Number)).filter(([, c]) => c === 1).map(([r]) => r).find((r) => s.cells[r + ',1'].v === key); return s.cells[row + ',2'].v; };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

test('first sync: four template tabs filled in owned ranges, statics / formulas / formats untouched, _Sync hidden and written last', () => {
  const a = freshChild(CHILD_A);
  const b = freshChild(CHILD_B);
  installSync({ children: { [CHILD_A]: a, [CHILD_B]: b } });
  const r = js(H.runSellerSheetsSync_());
  assert.equal(r.status, 'SUCCESS', r.error || JSON.stringify(r.sellers));
  assert.deepEqual(r.sellers.map((s) => [s.seller_id, s.status]), [['CUS001', 'SUCCESS'], ['CUS002', 'SUCCESS']]);
  const tpl = template();
  // Static cells, approved formulas and every format id of the template are unchanged.
  for (const sheet of tpl.sheets) {
    for (const [k, c] of Object.entries(sheet.cells)) {
      const got = cellOf(a, sheet.name, ...k.split(',').map(Number));
      assert.equal(got.s, c.s, 'format kept ' + sheet.name + ' ' + k);
      if (c.f) assert.equal(got.f, c.f, 'presentation formula kept ' + sheet.name + ' ' + k);
      if (c.v !== undefined) assert.equal(got.v, c.v, 'static text kept ' + sheet.name + ' ' + k);
    }
  }
  assert.deepEqual(a.forbidden, [], 'no clear(), no locale / time zone change');
  assert.deepEqual([a.locale, a.tz], ['vi_VN', 'America/Los_Angeles']);
  assert.deepEqual(formatOps(a), [], 'no formatting calls during an ordinary sync');
  assert.deepEqual(a.sheets.map((s) => [s.name, s.hidden]), [['DoiSoat_GD', false], ['TongHop_Thang', false], ['PhieuDoiSoat', false], ['Dispute', false], ['_Sync', true]]);
  const sets = a.log.filter((e) => e.op === 'setValues');
  assert.equal(sets[sets.length - 1].sheet, '_Sync', '_Sync is the last write');
  assert.equal(cellOf(a, 'DoiSoat_GD', 7, 1).v, '1001', 'numeric-looking IDs stay text');
  assert.equal(cellOf(a, 'DoiSoat_GD', 7, 4).v, 'Khớp');
  assert.ok([undefined, ''].includes(cellOf(a, 'DoiSoat_GD', 9, 1).v), 'no third CUS001 row');
  for (let r = 7; r <= 1006; r++) for (let c = 1; c <= 21; c++) assert.ok(!cellOf(a, 'DoiSoat_GD', r, c).f, 'values-only data rows');
  assert.equal(cellOf(a, 'PhieuDoiSoat', 4, 2).v, 'DITECH (CUS001)');
  assert.equal(syncValue(a, 'seller_id'), 'CUS001');
  assert.equal(syncValue(a, 'output_schema_version'), 4);
  const text = JSON.stringify(a.sheets.map((s) => s.cells));
  for (const re of [/"B-1"/, /B-MISS/, /HUI/, /glk_/, /buyer@example/, /MASTER_SPREADSHEET/]) assert.ok(!re.test(text), 'CUS001 sheet must not contain ' + re);
});

test('NO_CHANGE: zero writes and synced_at preserved; a change rewrites only the affected tabs and _Sync', async () => {
  const a = freshChild(CHILD_A);
  const b = freshChild(CHILD_B);
  installSync({ children: { [CHILD_A]: a, [CHILD_B]: b } });
  H.runSellerSheetsSync_();
  const stamp = syncValue(a, 'synced_at').getTime();
  a.log.length = 0;
  const r = js(H.runSellerSheetsSync_());
  assert.equal(r.status, 'NO_CHANGE');
  assert.deepEqual(a.log, [], 'no write of any kind');
  assert.equal(syncValue(a, 'synced_at').getTime(), stamp);
  await sleep(1100);
  const spec = baseSpec();
  spec.payouts = [{ seller_payout_id: 'SP1', seller_id: 'CUS001', payout_date: D('2026-10-09T04:00:00Z'), currency: 'USD', amount: 10, status: 'SENT' }];
  spec.allocations = [{ allocation_id: H.sellerAllocationId_('SP1', 'SETTLEMENT', 'ST-1'), seller_payout_id: 'SP1', seller_id: 'CUS001', target_type: 'SETTLEMENT', target_id: 'ST-1', payment_source: 'PAYPAL', currency: 'USD', allocated_amount: 10 }];
  installSync({ children: { [CHILD_A]: a, [CHILD_B]: b }, spec });
  const r2 = js(H.runSellerSheetsSync_());
  assert.deepEqual(r2.sellers.map((s) => s.status), ['SUCCESS', 'NO_CHANGE']);
  assert.deepEqual(r2.sellers[0].written_tabs, ['TongHop_Thang', 'PhieuDoiSoat', '_Sync']);
  assert.equal(writesTo(a, 'DoiSoat_GD').length, 0);
  assert.ok(syncValue(a, 'synced_at').getTime() > stamp);
});

test('capacity: >1000 transactions and >4 months insert rows inside the blocks, copy the template row format and extend formula ranges', () => {
  const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
  const txs = Array.from({ length: 1003 }, (_x, i) => ({ id: 'M' + String(i).padStart(4, '0'), seller: 'CUS001', order: 10 + (i % 7), status: 'MISSING_PROVIDER',
    created: months[i % 6] + '-15T15:00:00Z' }));
  const spec = { sellers: [{ seller_id: 'CUS001', seller_name: 'DITECH' }], txs, terms: [{ seller_id: 'CUS001', payment_source: 'PAYPAL', seller_fee_rate: 0.08, effective_from: '2026-01-01', effective_to: '' }] };
  const a = freshChild(CHILD_A);
  installSync({ children: { [CHILD_A]: a }, spec, destinations: [dest({})] });
  const r = js(H.runSellerSheetsSync_());
  assert.equal(r.status, 'SUCCESS', JSON.stringify(r.sellers));
  assert.deepEqual(r.sellers[0].expanded, ['DoiSoat_GD.rows+3', 'TongHop_Thang.rows+2']);
  const tpl = template();
  for (let row = 1006; row <= 1008; row++) {
    for (let c = 1; c <= 21; c++) assert.equal(cellOf(a, 'DoiSoat_GD', row, c).s, cellOf(tpl, 'DoiSoat_GD', 7, c).s, 'template data-row format copied');
  }
  assert.equal(cellOf(a, 'DoiSoat_GD', 4, 8).f, '=SUBTOTAL(9,H7:H1009)');
  assert.equal(cellOf(a, 'DoiSoat_GD', 3, 3).f, '=COUNTIF($D$7:$D$1009,"Khớp")');
  assert.equal(cellOf(a, 'DoiSoat_GD', 1009, 1).v, 'M1001', 'last row (latest date) written into the expanded capacity');
  assert.equal(cellOf(a, 'TongHop_Thang', 11, 1).v.startsWith('Logic:'), true, 'footer moved down, never overwritten');
  for (let row = 8; row <= 9; row++) assert.equal(cellOf(a, 'TongHop_Thang', row, 4).s, cellOf(tpl, 'TongHop_Thang', 5, 4).s, 'inserted rows get the template data-row format');
  assert.equal(new Date(cellOf(a, 'TongHop_Thang', 10, 1).v).toISOString(), '2026-06-01T12:00:00.000Z');
  assert.deepEqual(a.log.filter((e) => e.op === 'copyTo').map((e) => e.type), ['PASTE_FORMAT', 'PASTE_FORMAT']);
  const again = js(H.runSellerSheetsSync_());
  assert.equal(again.status, 'NO_CHANGE');
});

test('a failed write before the _Sync commit is detected by verify; the old _Sync remains; the next sync repairs it', async () => {
  const a = freshChild(CHILD_A);
  installSync({ children: { [CHILD_A]: a }, destinations: [dest({})] });
  H.runSellerSheetsSync_();
  const before = JSON.stringify(a.sheets.find((s) => s.name === '_Sync').cells);
  await sleep(1100);
  const spec = baseSpec();
  spec.payouts = [{ seller_payout_id: 'SP1', seller_id: 'CUS001', payout_date: D('2026-10-09T04:00:00Z'), currency: 'USD', amount: 10, status: 'CONFIRMED' }];
  spec.allocations = [{ allocation_id: H.sellerAllocationId_('SP1', 'SETTLEMENT', 'ST-1'), seller_payout_id: 'SP1', seller_id: 'CUS001', target_type: 'SETTLEMENT', target_id: 'ST-1', payment_source: 'PAYPAL', currency: 'USD', allocated_amount: 10 }];
  installSync({ children: { [CHILD_A]: a }, spec, destinations: [dest({})] });
  for (const failTab of ['PhieuDoiSoat', '_Sync']) {
    a.failOn = (sheet) => sheet === failTab;
    const r = js(H.runSellerSheetsSync_());
    assert.equal(r.status, 'FAILED');
    assert.match(r.sellers[0].error, new RegExp('simulated on ' + failTab));
    assert.equal(JSON.stringify(a.sheets.find((s) => s.name === '_Sync').cells), before, 'old _Sync remains');
    a.failOn = null;
    const v = js(H.buildSellerSheetsReport_());
    assert.equal(v.sellers[0].pass, false);
    assert.equal(v.sellers[0].combined_match, false);
  }
  const repaired = js(H.runSellerSheetsSync_());
  assert.equal(repaired.status, 'SUCCESS');
  assert.equal(js(H.buildSellerSheetsReport_()).pass, true);
});

test('verifySellerSheets is read-only: per-tab matches; tampering and foreign rows are detected; nothing is written', () => {
  const a = freshChild(CHILD_A);
  const b = freshChild(CHILD_B);
  installSync({ children: { [CHILD_A]: a, [CHILD_B]: b } });
  H.runSellerSheetsSync_();
  a.log.length = 0;
  let v = js(H.buildSellerSheetsReport_());
  assert.equal(v.pass, true, v.errors.join());
  const s = v.sellers[0];
  assert.deepEqual([s.accessible, s.doisoat_match, s.tonghop_match, s.phieu_match, s.dispute_match, s.sync_match, s.combined_match, s.transaction_rows],
    [true, true, true, true, true, true, true, 2]);
  a.api.getSheetByName('DoiSoat_GD').getRange(8, 1, 1, 1).setValues([["'B-1"]]);
  a.log.length = 0;
  v = js(H.buildSellerSheetsReport_());
  assert.equal(v.sellers[0].pass, false);
  assert.equal(v.sellers[0].doisoat_match, false);
  assert.match(v.sellers[0].errors.join(), /isolation: DoiSoat_GD shows transaction B-1 not owned by CUS001/);
  assert.deepEqual(a.log, [], 'verify never writes');
  installSync({ children: { [CHILD_A]: a, [CHILD_B]: b }, gates: { current: false, gates: {}, reasons: ['Payment Legs is stale'] } });
  assert.equal(js(H.buildSellerSheetsReport_()).master_fresh, false);
});

test('child contract violations fail closed without writing: unexpected tab, data-row formula, old Phase 2K tab', () => {
  for (const [label, mutate] of [['extra tab', (c) => c.api.insertSheet('Notes')], ['old tab', (c) => c.api.insertSheet('Summary')],
    ['formula', (c) => c.api.getSheetByName('DoiSoat_GD').getRange(7, 16).setFormula('=O7*0.08')],
    ['RAW tab', (c) => c.api.insertSheet('RAW_KH')]]) {
    const a = freshChild(CHILD_A);
    mutate(a);
    a.log.length = 0;
    installSync({ children: { [CHILD_A]: a }, destinations: [dest({})] });
    const r = js(H.runSellerSheetsSync_());
    assert.equal(r.status, 'FAILED', label);
    assert.match(r.sellers[0].error, /does not satisfy the template contract/);
    assert.deepEqual(a.log.filter((e) => e.op === 'setValues'), [], 'nothing written: ' + label);
  }
});

test('partial failure, global leak-risk config, stale Master and INACTIVE destinations', () => {
  const b = freshChild(CHILD_B);
  installSync({ children: { [CHILD_B]: b } });
  const partial = js(H.runSellerSheetsSync_());
  assert.equal(partial.status, 'PARTIAL');
  assert.deepEqual(partial.sellers.map((s) => s.status), ['FAILED', 'SUCCESS']);
  for (const destinations of [[dest({}), dest({ seller_id: 'CUS002', seller_name_snapshot: 'HUI' })], [dest({ spreadsheet_id: MASTER_ID })]]) {
    const a = freshChild(CHILD_A);
    installSync({ children: { [CHILD_A]: a }, destinations });
    const r = js(H.runSellerSheetsSync_());
    assert.match(r.error, /Seller Destinations is invalid; no seller sheet written/);
    assert.deepEqual(env.opened, []);
    assert.deepEqual(a.log, []);
  }
  installSync({ children: { [CHILD_B]: b }, gates: { current: false, gates: {}, reasons: ['Seller Balances is stale'] } });
  assert.match(js(H.runSellerSheetsSync_()).error, /Payment Master is not current/);
  assert.deepEqual(env.opened, []);
  const a = freshChild(CHILD_A);
  installSync({ children: { [CHILD_A]: a, [CHILD_B]: b }, destinations: [dest({}), dest({ seller_id: 'CUS002', seller_name_snapshot: 'HUI', spreadsheet_id: CHILD_B, status: 'INACTIVE' })] });
  H.runSellerSheetsSync_();
  assert.deepEqual(env.opened, [CHILD_A], 'INACTIVE never opened');
  installSync({ children: {}, destinations: [dest({ status: 'INACTIVE', spreadsheet_id: '' })] });
  assert.equal(js(H.runSellerSheetsSync_()).status, 'NO_CHANGE');
  assert.equal(env.gateCalls, 0);
});

test('a seller output value that looks like an endpoint token or e-mail fails the whole sync before any write', () => {
  const master = makeMaster(D, baseSpec());
  master.transactions[0].sub_account = 'glk_tok.secretvalue';
  const a = freshChild(CHILD_A);
  installSync({ children: { [CHILD_A]: a }, master, destinations: [dest({})] });
  const r = js(H.runSellerSheetsSync_());
  assert.match(r.error, /endpoint tokens \/ e-mail addresses; no seller sheet written/);
  assert.ok(!JSON.stringify(r).includes('secretvalue'));
  assert.deepEqual(env.opened, []);
});

test('overall status: PARTIAL when one fails and another succeeds; FAILED when none succeed', () => {
  const st = (...s) => H.decideSellerSyncStatus_(s.map((x) => ({ status: x })));
  assert.equal(st('SUCCESS', 'FAILED'), 'PARTIAL');
  assert.equal(st('NO_CHANGE', 'FAILED'), 'PARTIAL');
  assert.equal(st('FAILED', 'FAILED'), 'FAILED');
  assert.equal(st('SUCCESS', 'NO_CHANGE'), 'SUCCESS');
  assert.equal(st('NO_CHANGE', 'NO_CHANGE'), 'NO_CHANGE');
});

test('rates land in the template percentage cells (0.08 shown as 8.00%) with zero formatting writes', () => {
  const a = freshChild(CHILD_A);
  installSync({ children: { [CHILD_A]: a }, destinations: [dest({})] });
  assert.equal(js(H.runSellerSheetsSync_()).status, 'SUCCESS');
  const nf = TEMPLATE.numberFormats;
  assert.equal(cellOf(a, 'DoiSoat_GD', 7, 12).v, 0.08);
  assert.equal(nf[cellOf(a, 'DoiSoat_GD', 7, 12).s], '0.00%');
  assert.equal(cellOf(a, 'PhieuDoiSoat', 11, 6).v, 0.08);
  assert.equal(nf[cellOf(a, 'PhieuDoiSoat', 11, 6).s], '0.00%');
  assert.deepEqual(formatOps(a), []);
  assert.deepEqual(a.log.filter((e) => e.op === 'copyTo'), [], 'no format copy without capacity growth');
});

test('18: an existing older-schema child upgrades to the current output schema in place (no reclone, no format writes, statics kept)', () => {
  const a = freshChild(CHILD_A);
  installSync({ children: { [CHILD_A]: a }, destinations: [dest({})] });
  H.runSellerSheetsSync_();
  // Make it look exactly like an output-schema-2 child: v2 _Sync version / checksums and the v2 section D label.
  const sync = a.sheets.find((s) => s.name === '_Sync');
  Object.entries(sync.cells).forEach(([k, c]) => { if (c.v === 'output_schema_version') sync.cells[k.split(',')[0] + ',2'].v = 2; });
  a.sheets.find((s) => s.name === 'PhieuDoiSoat').cells['50,1'].v = 'PAYPAL #1';
  const sheetsBefore = a.sheets.map((s) => s.name);
  const formatsBefore = JSON.stringify(a.sheets.map((s) => Object.entries(s.cells).map(([k, c]) => [k, c.s])));
  a.log.length = 0;
  const r = js(H.runSellerSheetsSync_());
  assert.equal(r.status, 'SUCCESS', JSON.stringify(r.sellers));
  assert.deepEqual(r.sellers[0].written_tabs, ['PhieuDoiSoat', '_Sync'], 'only changed owned content + commit marker');
  assert.equal(syncValue(a, 'output_schema_version'), 4);
  assert.equal(cellOf(a, 'PhieuDoiSoat', 50, 1).v, 'PAYPAL #1 · UNPAID');
  assert.deepEqual(a.sheets.map((s) => s.name), sheetsBefore, 'same spreadsheet, no new / replaced tab');
  assert.equal(JSON.stringify(a.sheets.map((s) => Object.entries(s.cells).map(([k, c]) => [k, c.s]))), formatsBefore, 'no formatting change');
  assert.deepEqual(formatOps(a), []);
  assert.deepEqual(a.forbidden, []);
  assert.equal(js(H.buildSellerSheetsReport_()).pass, true);
});

test('Section D header: a child still showing "Còn nợ" is migrated to "Chưa payout" (one value cell, no formatting); a template must already have it', () => {
  const a = freshChild(CHILD_A);
  a.sheets.find((s) => s.name === 'PhieuDoiSoat').cells['49,9'].v = 'Còn nợ';
  const style = a.sheets.find((s) => s.name === 'PhieuDoiSoat').cells['49,9'].s;
  installSync({ children: { [CHILD_A]: a }, destinations: [dest({})] });
  const r = js(H.runSellerSheetsSync_());
  assert.equal(r.status, 'SUCCESS', JSON.stringify(r.sellers));
  assert.equal(cellOf(a, 'PhieuDoiSoat', 49, 9).v, 'Chưa payout');
  assert.equal(cellOf(a, 'PhieuDoiSoat', 49, 9).s, style);
  assert.deepEqual(formatOps(a), []);
  assert.equal(js(H.buildSellerSheetsReport_()).pass, true);
  assert.equal(js(H.runSellerSheetsSync_()).status, 'NO_CHANGE');
  const tpl = template();
  tpl.sheets.find((s) => s.name === 'PhieuDoiSoat').cells['49,9'].v = 'Còn nợ';
  const errors = js(H.validateSellerWorkbook_(H.readSellerWorkbook_(tpl.api), { mode: 'template', hiddenIds: [] })).errors.join();
  assert.match(errors, /section D column I header is still "Còn nợ"; it must be "Chưa payout" \(update the seller template\)/);
  assert.equal(TEMPLATE.sheets.find((s) => s.name === 'PhieuDoiSoat').cells['49,9'].v, 'Chưa payout', 'fixture reflects the new header');
});
