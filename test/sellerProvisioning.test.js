// Unit tests for template-based seller sheet provisioning (createSellerSheet), single-seller sync and the
// Master menu. Real provisioning / destination / Seller Terms code runs against an in-memory Master; Drive,
// child spreadsheets, lock and audit are fakes; Master freshness gates are stubbed. Fake data.
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

const MASTER_ID = 'MASTER_SPREADSHEET_ID_00000000001';
const SOURCE_ID = 'KH001_PROVIDER_SOURCE_ID_0000001';
const TEMPLATE_ID = 'TEMPLATE_SPREADSHEET_ID_00000001';
const FOLDER_ID = 'OUTPUT_FOLDER_ID_000000000000001';
const DOC_ID = 'NOT_A_SPREADSHEET_DOC_ID_000001';

// ---- in-memory Master (grid sheets) ----------------------------------------------------------------------
function gridSheet(name, values) {
  const g = values.map((r) => r.slice());
  let width = Math.max(...g.map((r) => r.length));
  const cell = (r, c) => { while (g.length < r) g.push(Array(width).fill('')); if (c > width) { width = c; g.forEach((row) => { while (row.length < width) row.push(''); }); } };
  g.forEach((row) => { while (row.length < width) row.push(''); });
  return {
    grid: g,
    getName: () => name, getMaxRows: () => g.length, getMaxColumns: () => width,
    getLastRow: () => { for (let r = g.length; r > 0; r--) if (g[r - 1].some((v) => v !== '' && v !== null)) return r; return 0; },
    insertRowsAfter: (_a, n) => { for (let i = 0; i < n; i++) g.push(Array(width).fill('')); },
    getRange: (r, c, nr, nc) => {
      nr = nr || 1; nc = nc || 1;
      return {
        getValues: () => Array.from({ length: nr }, (_x, i) => Array.from({ length: nc }, (_y, j) => (g[r - 1 + i] || [])[c - 1 + j] ?? '')),
        setValue: (v) => { cell(r, c); g[r - 1][c - 1] = v; },
        setValues: (vs) => vs.forEach((row, i) => row.forEach((v, j) => { cell(r + i, c + j); g[r - 1 + i][c - 1 + j] = v; })),
      };
    },
  };
}
const table = (name, rows) => {
  const cols = js(H.getColumnNames_(name));
  return gridSheet(name, [cols, ...rows.map((o) => cols.map((c) => (o[c] === undefined ? '' : o[c])))]);
};
function master(o) {
  o = o || {};
  const settings = [['schema_version', '13'], ['source.KH001.spreadsheet_id', SOURCE_ID],
    ['seller_template_spreadsheet_id', o.template === undefined ? TEMPLATE_ID : o.template],
    ['seller_output_folder_id', o.folder === undefined ? FOLDER_ID : o.folder]].map(([key, value]) => ({ key, value, value_type: 'STRING' }));
  const sellers = [{ seller_id: 'CUS001', seller_name: 'DITECH', status: 'ACTIVE', effective_from: D('2026-10-01T04:00:00Z') },
    { seller_id: 'CUS002', seller_name: 'HUI', status: 'ACTIVE', effective_from: D('2026-10-01T04:00:00Z') }];
  const terms = (o.terms || ['CUS001', 'CUS002']).map((id, i) => ({ seller_id: id, seller_name_snapshot: sellers[i].seller_name, seller_fee_rate: 0.08,
    effective_from: D('2026-10-01T04:00:00Z') }));
  const destinations = o.destinations || [
    { seller_id: 'CUS001', seller_name_snapshot: 'Old DITECH name', spreadsheet_id: '', status: 'INACTIVE', notes: 'seed' },
    { seller_id: 'CUS002', seller_name_snapshot: 'HUI', spreadsheet_id: '', status: 'INACTIVE', notes: 'seed' }];
  const sheets = [table('Settings', settings), table('Sellers', sellers), table('Seller Terms', terms), table('Seller Destinations', destinations)];
  return { getId: () => MASTER_ID, getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null };
}
const destRow = (m, sellerId) => {
  const cols = js(H.getColumnNames_('Seller Destinations'));
  const row = m.getSheetByName('Seller Destinations').grid.slice(1).find((r) => r[0] === sellerId);
  return Object.fromEntries(cols.map((c, i) => [c, row[i]]));
};

// ---- child spreadsheets and Drive ----------------------------------------------------------------------
function fakeChild(id, extraTabs) {
  const sheets = [];
  const child = { id, tz: 'America/Los_Angeles', sheets, writes: [], failWrites: false, onFirstWrite: null };
  const mkSheet = (name) => {
    let cells = {};
    let rows = 1000;
    let cols = 26;
    const sh = {
      name, cells: () => cells, getName: () => name, getMaxRows: () => rows, getMaxColumns: () => cols,
      insertRowsAfter: (_a, n) => { rows += n; }, insertColumnsAfter: (_a, n) => { cols += n; },
      deleteRows: (s, n) => { rows -= n; Object.keys(cells).forEach((k) => { if (+k.split(',')[0] >= s) delete cells[k]; }); },
      deleteColumns: (s, n) => { cols -= n; Object.keys(cells).forEach((k) => { if (+k.split(',')[1] >= s) delete cells[k]; }); },
      clear: () => { cells = {}; }, getFilter: () => null, setFrozenRows: () => {}, setColumnWidth: () => {},
      getRange: (r, c, nr, nc) => {
        nr = nr || 1; nc = nc || 1;
        const rg = {
          getValues: () => Array.from({ length: nr }, (_x, i) => Array.from({ length: nc }, (_y, j) => {
            const v = cells[(r + i) + ',' + (c + j)];
            return v === undefined ? '' : (v instanceof Object && v.getTime ? D(new Date(v.getTime()).toISOString()) : v);
          })),
          getFormulas: () => rg.getValues().map((row) => row.map((v) => (typeof v === 'string' && v.startsWith('=') ? v : ''))),
          setValues: (v) => {
            if (child.failWrites) throw new Error('Service Spreadsheets failed (simulated)');
            if (child.onFirstWrite) { const f = child.onFirstWrite; child.onFirstWrite = null; f(); }
            child.writes.push(name);
            v.forEach((row, i) => row.forEach((x, j) => { cells[(r + i) + ',' + (c + j)] = x; }));
            return rg;
          },
          setNumberFormat: () => rg, setFontWeight: () => rg, setBackground: () => rg, setBorder: () => rg, clearDataValidations: () => rg,
          createFilter: () => ({}),
        };
        return rg;
      },
    };
    return sh;
  };
  Object.assign(child, {
    getId: () => id, getSpreadsheetTimeZone: () => child.tz, setSpreadsheetTimeZone: (t) => { child.tz = t; },
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    insertSheet: (n) => { const s = mkSheet(n); sheets.push(s); return s; },
  });
  for (const [tab, cells] of Object.entries(extraTabs || {})) {
    const s = child.insertSheet(tab);
    Object.assign(s.cells(), cells);
  }
  child.writes.length = 0;
  return child;
}

let env;
function install(o) {
  o = o || {};
  const m = o.master || master();
  env = { master: m, copies: [], opened: [], audit: [], children: o.children || {}, prompts: [], alerts: [], gateCalls: 0 };
  const template = { mime: o.templateMime || 'application/vnd.google-apps.spreadsheet' };
  const files = { [TEMPLATE_ID]: template, [DOC_ID]: { mime: 'application/vnd.google-apps.document' }, [MASTER_ID]: template, [SOURCE_ID]: template };
  Object.assign(context, {
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    getSpreadsheet_: () => m,
    appendAuditLog_: (e) => env.audit.push(e),
    readSellerSheetsGates_: () => { env.gateCalls++; return o.gates || { current: true, gates: {}, reasons: [] }; },
    buildSellerSnapshotsFromMaster_: (_ss, sellers) => H.buildSellerSnapshots_({ ...fixture(), sellers }),
    SpreadsheetApp: {
      flush: () => {},
      openById: (id) => { env.opened.push(id); if (!env.children[id]) throw new Error('Requested entity was not found.'); return env.children[id]; },
    },
    DriveApp: {
      getFileById: (id) => {
        const f = files[id];
        if (!f || o.templateInaccessible) throw new Error('No item with the given ID could be found.');
        return {
          getName: () => 'Seller template', getMimeType: () => f.mime,
          makeCopy: (name, folder) => {
            const newId = 'COPY_' + String(env.copies.length + 1).padStart(27, '0');
            env.copies.push({ name, folderId: folder.getId(), id: newId });
            const c = fakeChild(newId, { Brand: { '1,1': 'Seller handbook' }, Summary: { '1,1': 'old', '2,1': '=SUM(A1:A9)' } });
            if (o.failCopies) c.failWrites = true;
            env.children[newId] = c;
            return { getId: () => newId };
          },
        };
      },
      getFolderById: (id) => {
        if (id !== FOLDER_ID || o.folderInaccessible) throw new Error('No item with the given ID could be found.');
        return { getId: () => id, getName: () => 'Seller sheets' };
      },
    },
  });
}

// Minimal Master accounting fixture (snapshot input): one AVAILABLE + one MISSING_PROVIDER per seller.
function fixture() {
  const tx = (id, seller) => ({ internal_transaction_id: id, created_at: D('2026-10-02T15:00:00Z'), payment_source: 'PAYPAL', seller_id: seller,
    store_domain: 'shop.com', order_id: 'O-' + id, order_amount: 104, currency: 'USD' });
  const match = (id, status) => ({ match_id: 'PM-' + id, payment_source: 'PAYPAL', internal_transaction_id: id, external_transaction_id: status === 'MATCHED' ? id : '',
    provider_id: status === 'MATCHED' ? 'KH001' : '', reconciliation_status: status, match_status: status === 'MATCHED' ? 'CONFIRMED' : '' });
  const leg = (id) => ({ payment_leg_id: 'PL-' + id, match_id: 'PM-' + id, internal_transaction_id: id, payment_source: 'PAYPAL', provider: 'KH001',
    external_transaction_id: id, currency: 'USD', gross_amount: 104, processing_fee: 4, net_amount: 100, seller_fee_rate: 0.08, seller_fee: 8,
    seller_hold_amount: 10, seller_available_amount: 82, settlement_id: 'ST-1', settlement_status: 'AVAILABLE' });
  return {
    transactions: [tx('A1', 'CUS001'), tx('A2', 'CUS001'), tx('B1', 'CUS002'), tx('B2', 'CUS002')],
    matches: [match('A1', 'MATCHED'), match('A2', 'MISSING_PROVIDER'), match('B1', 'MATCHED'), match('B2', 'MISSING_PROVIDER')],
    legs: [leg('A1'), leg('B1')],
    settlements: [{ settlement_id: 'ST-1', period_end_date: D('2026-10-04T04:00:00Z'), source_payment_date: D('2026-10-06T04:00:00Z') }],
    balances: [{ seller_id: 'CUS001', currency: 'USD', current_balance: 82, seller_hold_balance: 10, paid_amount: 0, adjustments: 0 },
      { seller_id: 'CUS002', currency: 'USD', current_balance: 82, seller_hold_balance: 10, paid_amount: 0, adjustments: 0 }],
    payouts: [], adjustments: [], masterSchemaVersion: 13,
  };
}

// ---- createSellerSheet ------------------------------------------------------------------------------------
test('provisioning success: one copy in the output folder, correct name, ID registered, ACTIVE only after sync + verify', () => {
  install();
  let duringSync = null;
  const origMakeCopy = context.DriveApp.getFileById;
  context.DriveApp.getFileById = (id) => {
    const f = origMakeCopy(id);
    const mc = f.makeCopy;
    f.makeCopy = (name, folder) => {
      const r = mc(name, folder);
      env.children[r.getId()].onFirstWrite = () => { duringSync = destRow(env.master, 'CUS001'); };
      return r;
    };
    return f;
  };
  const r = js(H.runCreateSellerSheet_(' CUS001 '));
  assert.equal(r.status, 'SUCCESS', r.error);
  assert.equal(env.copies.length, 1);
  assert.deepEqual(env.copies[0], { name: 'Seller - CUS001 - DITECH', folderId: FOLDER_ID, id: r.spreadsheet_id });
  assert.deepEqual([duringSync.spreadsheet_id, duringSync.status], [r.spreadsheet_id, 'INACTIVE'], 'registered and still INACTIVE while syncing');
  const row = destRow(env.master, 'CUS001');
  assert.deepEqual([row.spreadsheet_id, row.status, row.seller_name_snapshot, row.notes], [r.spreadsheet_id, 'ACTIVE', 'DITECH', 'seed']);
  assert.deepEqual([r.seller_id, r.seller_name, r.destination_status, r.sync_status, r.verified, r.reused_existing_copy],
    ['CUS001', 'DITECH', 'ACTIVE', 'SUCCESS', true, false]);
  const child = env.children[r.spreadsheet_id];
  assert.equal(child.getSheetByName('Brand').cells()['1,1'], 'Seller handbook', 'template custom tab untouched');
  assert.equal(child.getSheetByName('Summary').getRange(1, 1, 1, 1).getValues()[0][0], 'seller_id', 'Master owns the managed tabs');
  assert.deepEqual(child.getSheetByName('Summary').getRange(1, 1, 3, 26).getFormulas().flat().filter(Boolean), [], 'template formula replaced');
  assert.equal(destRow(env.master, 'CUS002').status, 'INACTIVE', 'other seller untouched');
  assert.equal(env.audit[env.audit.length - 1].action, 'SELLER_SHEET_CREATE_SUCCESS');
});

test('failed sync keeps the registered ID + INACTIVE; retry reuses the copy (no second clone) and activates', () => {
  install({ failCopies: true });
  const r = js(H.runCreateSellerSheet_('CUS001'));
  assert.equal(r.status, 'FAILED');
  assert.match(r.error, /Seller sheet sync failed: .*simulated/);
  assert.ok(r.spreadsheet_id.startsWith('COPY_'));
  assert.equal(r.verified, false);
  const row = destRow(env.master, 'CUS001');
  assert.deepEqual([row.spreadsheet_id, row.status], [r.spreadsheet_id, 'INACTIVE']);
  env.children[r.spreadsheet_id].failWrites = false;
  const retry = js(H.runCreateSellerSheet_('CUS001'));
  assert.equal(retry.status, 'SUCCESS', retry.error);
  assert.equal(retry.reused_existing_copy, true);
  assert.equal(retry.spreadsheet_id, r.spreadsheet_id);
  assert.equal(env.copies.length, 1, 'never cloned again');
  assert.equal(destRow(env.master, 'CUS001').status, 'ACTIVE');
});

test('an ACTIVE seller cannot be cloned twice', () => {
  install();
  assert.equal(js(H.runCreateSellerSheet_('CUS001')).status, 'SUCCESS');
  const again = js(H.runCreateSellerSheet_('CUS001'));
  assert.equal(again.status, 'FAILED');
  assert.match(again.error, /already ACTIVE; no new spreadsheet is created/);
  assert.equal(env.copies.length, 1);
});

const blocked = (label, opts, pattern, sellerId) => test('blocked before clone: ' + label, () => {
  install(opts);
  const before = JSON.stringify(env.master.getSheetByName('Seller Destinations').grid);
  const r = js(H.runCreateSellerSheet_(sellerId || 'CUS001'));
  assert.equal(r.status, 'FAILED');
  assert.match(r.error, pattern);
  assert.equal(env.copies.length, 0, 'nothing cloned');
  assert.equal(JSON.stringify(env.master.getSheetByName('Seller Destinations').grid), before, 'registry untouched');
  assert.ok(!r.error.includes(SOURCE_ID) && !r.error.includes(TEMPLATE_ID), 'IDs never echoed');
});
blocked('blank template setting', { master: master({ template: '' }) }, /seller_template_spreadsheet_id is blank/);
blocked('template given as URL', { master: master({ template: 'https://docs.google.com/spreadsheets/d/' + TEMPLATE_ID }) }, /not a Drive file ID/);
blocked('template is not a spreadsheet', { master: master({ template: DOC_ID }) }, /is not a Google Spreadsheet/);
blocked('template inaccessible', { templateInaccessible: true }, /seller_template_spreadsheet_id is not accessible/);
blocked('template is the Payment Master', { master: master({ template: MASTER_ID }) }, /is the Payment Master spreadsheet/);
blocked('template is the KH001 provider source', { master: master({ template: SOURCE_ID }) }, /is the KH001 provider source spreadsheet/);
blocked('template is a registered seller destination', { master: master({ template: TEMPLATE_ID, destinations: [
  { seller_id: 'CUS001', seller_name_snapshot: 'DITECH', spreadsheet_id: '', status: 'INACTIVE' },
  { seller_id: 'CUS002', seller_name_snapshot: 'HUI', spreadsheet_id: TEMPLATE_ID, status: 'ACTIVE' }] }) }, /is a registered seller destination/);
blocked('output folder inaccessible', { folderInaccessible: true }, /seller_output_folder_id is not accessible/);
blocked('blank output folder', { master: master({ folder: '' }) }, /seller_output_folder_id is blank/);
blocked('seller without valid Seller Terms', { master: master({ terms: ['CUS001'] }) }, /Seller Terms is invalid.*CUS002/, 'CUS002');
blocked('unknown seller', {}, /Unknown seller CUS999/, 'CUS999');
blocked('stale Master', { gates: { current: false, gates: { seller_balances: false }, reasons: ['Seller Balances is stale'] } },
  /Payment Master is not current/);
blocked('seller without a destination row', { master: master({ destinations: [{ seller_id: 'CUS002', seller_name_snapshot: 'HUI', spreadsheet_id: '', status: 'INACTIVE' }] }) },
  /Expected exactly one Seller Destinations row for CUS001, found 0/);

test('a registered copy shared with another (INACTIVE) row is never reused', () => {
  const shared = 'SHARED_COPY_ID_000000000000000001';
  install({ master: master({ destinations: [
    { seller_id: 'CUS001', seller_name_snapshot: 'DITECH', spreadsheet_id: shared, status: 'INACTIVE' },
    { seller_id: 'CUS002', seller_name_snapshot: 'HUI', spreadsheet_id: shared, status: 'INACTIVE' }] }), children: { [shared]: fakeChild(shared) } });
  const r = js(H.runCreateSellerSheet_('CUS001'));
  assert.equal(r.status, 'FAILED');
  assert.match(r.error, /also registered for another seller; refusing to reuse it/);
  assert.deepEqual(env.opened, []);
});

// ---- syncSellerSheet ------------------------------------------------------------------------------------
test('syncSellerSheet syncs exactly one ACTIVE seller and never touches another; INACTIVE fails', () => {
  const A = 'CHILD_A_ID_000000000000000000001';
  const B = 'CHILD_B_ID_000000000000000000002';
  const a = fakeChild(A);
  const b = fakeChild(B);
  install({ master: master({ destinations: [{ seller_id: 'CUS001', seller_name_snapshot: 'DITECH', spreadsheet_id: A, status: 'ACTIVE' },
    { seller_id: 'CUS002', seller_name_snapshot: 'HUI', spreadsheet_id: B, status: 'ACTIVE' }] }), children: { [A]: a, [B]: b } });
  const r = js(H.runSingleSellerSheetSync_('CUS001'));
  assert.equal(r.status, 'SUCCESS', r.error);
  assert.deepEqual(r.sellers.map((s) => s.seller_id), ['CUS001']);
  assert.deepEqual(env.opened.filter((x) => x === B), []);
  assert.deepEqual(b.writes, []);
  assert.ok(a.writes.includes('Sync Info'));
  assert.equal(env.audit[0].action, 'SELLER_SHEET_SYNC_SUCCESS');
  assert.equal(js(H.runSingleSellerSheetSync_('CUS001')).status, 'NO_CHANGE');
  install({ master: master(), children: {} });
  const inactive = js(H.runSingleSellerSheetSync_('CUS002'));
  assert.equal(inactive.status, 'FAILED');
  assert.match(inactive.error, /is INACTIVE; only ACTIVE destinations are synced/);
  assert.deepEqual(env.opened, []);
  install({ gates: { current: false, gates: {}, reasons: ['Payment Legs is stale'] }, master: master({ destinations: [
    { seller_id: 'CUS001', seller_name_snapshot: 'DITECH', spreadsheet_id: A, status: 'ACTIVE' }] }), children: { [A]: a } });
  assert.match(js(H.runSingleSellerSheetSync_('CUS001')).error, /Payment Master is not current/);
  assert.deepEqual(env.opened, []);
});

// ---- Menu ------------------------------------------------------------------------------------------------
function fakeUi(button, text) {
  const ui = {
    Button: { OK: 'OK', CANCEL: 'CANCEL' }, ButtonSet: { OK_CANCEL: 'OK_CANCEL', OK: 'OK' },
    prompt: (title, msg) => { env.prompts.push(msg); return { getSelectedButton: () => button, getResponseText: () => text }; },
    alert: (title, msg) => { env.alerts.push(msg); },
    createMenu: (name) => { const m = { name, items: [], addItem: (l, fn) => { m.items.push([l, fn]); return m; }, addToUi: () => { env.menu = m; } }; return m; },
  };
  context.SpreadsheetApp.getUi = () => ui;
}

test('menu: onOpen adds the Seller Sheets menu; Create Seller Sheet prompts, calls createSellerSheet and alerts the URL', () => {
  install();
  fakeUi('OK', '  CUS001 ');
  H.onOpen();
  assert.deepEqual(js(env.menu.items), [['Create Seller Sheet', 'menuCreateSellerSheet'], ['Sync All Seller Sheets', 'menuSyncSellerSheets'],
    ['Verify Seller Sheets', 'menuVerifySellerSheets']]);
  const r = js(H.menuCreateSellerSheet());
  assert.equal(r.status, 'SUCCESS');
  assert.match(env.prompts[0], /CUS001 - DITECH/);
  assert.match(env.alerts[0], /Seller sheet ready for CUS001 \(DITECH\)/);
  assert.match(env.alerts[0], new RegExp('https://docs.google.com/spreadsheets/d/' + r.spreadsheet_id + '/edit'));
  // The handler goes through the public createSellerSheet entry point.
  const calls = [];
  const original = context.createSellerSheet;
  context.createSellerSheet = (id) => { calls.push(id); return { status: 'FAILED', seller_id: id, seller_name: 'HUI', spreadsheet_id: '',
    error: 'template ' + TEMPLATE_ID + ' is ' + SOURCE_ID }; };
  fakeUi('OK', 'CUS002');
  H.menuCreateSellerSheet();
  assert.deepEqual(calls, ['CUS002']);
  assert.match(env.alerts[1], /NOT activated for CUS002 \(HUI\)/);
  assert.ok(!env.alerts[1].includes(SOURCE_ID) && !env.alerts[1].includes(TEMPLATE_ID), 'provider/source IDs hidden in alerts');
  fakeUi('CANCEL', 'CUS002');
  assert.equal(H.menuCreateSellerSheet(), null);
  assert.deepEqual(calls, ['CUS002'], 'cancel does nothing');
  context.createSellerSheet = original;
});

test('alert text: failure with a registered copy explains the retry; sync/verify summaries', () => {
  const t = H.formatCreateSellerSheetAlert_({ status: 'FAILED', seller_id: 'CUS001', seller_name: 'DITECH', spreadsheet_id: 'COPY_X', error: 'boom' }, []);
  assert.match(t, /Registered copy \(still INACTIVE\): https:\/\/docs.google.com\/spreadsheets\/d\/COPY_X\/edit/);
  assert.match(t, /reuses this copy/);
  assert.match(H.formatSellerSyncAlert_({ status: 'PARTIAL', sellers: [{ seller_id: 'CUS001', seller_name: 'DITECH', status: 'FAILED', error: 'x' }] }, []),
    /CUS001 \(DITECH\): FAILED - x/);
  assert.match(H.formatSellerVerifyAlert_({ pass: true, master_fresh: true, active_destinations: 1, passed_destinations: 1, failed_destinations: 0,
    sellers: [{ seller_id: 'CUS001', seller_name: 'DITECH', pass: true, errors: [] }], errors: [] }, []), /PASS[\s\S]*CUS001 \(DITECH\): PASS/);
});
