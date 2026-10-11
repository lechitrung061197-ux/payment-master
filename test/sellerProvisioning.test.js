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
const { makeSpreadsheet, cloneSpreadsheet, formatOps } = require('./helpers/sellerFakes');
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
  const terms = (o.terms || ['CUS001', 'CUS002']).map((id, i) => ({ seller_id: id, payment_source: 'PAYPAL', seller_name_snapshot: sellers[i].seller_name, seller_fee_rate: 0.08,
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

// ---- child spreadsheets and Drive (template replica from test/fixtures/sellerTemplate.json) -------------------
const makeDate = (ms) => vm.runInContext(`new Date(${ms})`, context);
const NY = (v) => H.providerDateKey_(v, 'America/New_York');
const templateSheet = () => makeSpreadsheet({ id: TEMPLATE_ID, makeDate });
const fakeChild = (id) => cloneSpreadsheet(templateSheet(), id, makeDate);

let env;
function install(o) {
  o = o || {};
  const m = o.master || master();
  const tpl = o.template || templateSheet();
  env = { master: m, copies: [], opened: [], audit: [], children: Object.assign({ [TEMPLATE_ID]: tpl }, o.children || {}), prompts: [], alerts: [], gateCalls: 0 };
  const spreadsheetMime = { mime: o.templateMime || 'application/vnd.google-apps.spreadsheet' };
  const files = { [TEMPLATE_ID]: spreadsheetMime, [DOC_ID]: { mime: 'application/vnd.google-apps.document' }, [MASTER_ID]: spreadsheetMime, [SOURCE_ID]: spreadsheetMime };
  const accounting = makeMaster(D, fixtureSpec());
  Object.assign(context, {
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    getSpreadsheet_: () => m,
    appendAuditLog_: (e) => env.audit.push(e),
    readSellerSheetsGates_: () => { env.gateCalls++; return o.gates || { current: true, gates: {}, reasons: [] }; },
    buildSellerSnapshotsFromMaster_: (_ss, sellers) => H.buildSellerOutputs_({ ...accounting, sellers, dateKeyOf: NY }),
    SpreadsheetApp: {
      flush: () => {},
      CopyPasteType: { PASTE_FORMAT: 'PASTE_FORMAT', PASTE_FORMULA: 'PASTE_FORMULA' },
      openById: (id) => { env.opened.push(id); if (!env.children[id]) throw new Error('Requested entity was not found.'); return env.children[id].api; },
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
            const c = cloneSpreadsheet(env.children[id], newId, makeDate);
            if (o.failCopies) c.failOn = () => true;
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

// Minimal Master accounting fixture: one AVAILABLE + one MISSING_PROVIDER per seller.
function fixtureSpec() {
  return {
    sellers: [{ seller_id: 'CUS001', seller_name: 'DITECH' }, { seller_id: 'CUS002', seller_name: 'HUI' }],
    txs: [{ id: 'A1', seller: 'CUS001', order: 104, leg: { fee: 4, rate: 0.08, settlement: 'ST-1' } },
      { id: 'A2', seller: 'CUS001', order: 104, status: 'MISSING_PROVIDER' },
      { id: 'B1', seller: 'CUS002', order: 104, leg: { fee: 4, rate: 0.08, settlement: 'ST-1' } },
      { id: 'B2', seller: 'CUS002', order: 104, status: 'MISSING_PROVIDER' }],
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
      env.children[r.getId()].beforeWrite = () => { duringSync = destRow(env.master, 'CUS001'); };
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
  assert.deepEqual(child.sheets.map((x) => [x.name, x.hidden]), [['DoiSoat_GD', false], ['TongHop_Thang', false], ['PhieuDoiSoat', false], ['Dispute', false],
    ['_Sync', true]], 'exactly the four template tabs + hidden _Sync');
  assert.deepEqual([child.locale, child.tz], ['vi_VN', 'America/Los_Angeles'], 'template locale / time zone preserved');
  assert.deepEqual(child.forbidden, []);
  assert.deepEqual(formatOps(child), [], 'template UI not rebuilt');
  assert.equal(child.sheets[2].cells['4,2'].v, 'DITECH (CUS001)');
  assert.deepEqual(env.children[TEMPLATE_ID].log.filter((e) => e.op !== 'getValues'), [], 'template never modified');
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
  env.children[r.spreadsheet_id].failOn = null;
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

// ---- Auto-created destination row ---------------------------------------------------------------------------
const rowsFor = (m, sellerId) => m.getSheetByName('Seller Destinations').grid.slice(1).filter((r) => r[0] === sellerId);
const onlyCus002 = () => master({ destinations: [{ seller_id: 'CUS002', seller_name_snapshot: 'HUI', spreadsheet_id: '', status: 'INACTIVE', notes: 'seed' }] });
function watchProvisioning(sellerId) {
  const seen = {};
  const getFile = context.DriveApp.getFileById;
  context.DriveApp.getFileById = (id) => {
    const f = getFile(id);
    const mc = f.makeCopy;
    f.makeCopy = (name, folder) => {
      seen.atClone = rowsFor(env.master, sellerId).map((r) => r.slice());
      const res = mc(name, folder);
      env.children[res.getId()].beforeWrite = () => { seen.atSync = rowsFor(env.master, sellerId).map((r) => r.slice()); };
      return res;
    };
    return f;
  };
  return seen;
}

test('seller with valid Seller Terms but no destination row: one INACTIVE row is created and provisioning succeeds in one call', () => {
  install({ master: onlyCus002() });
  const seen = watchProvisioning('CUS001');
  const r = js(H.runCreateSellerSheet_('CUS001'));
  assert.equal(r.status, 'SUCCESS', r.error);
  assert.equal(r.destination_row_created, true);
  assert.equal(env.copies.length, 1);
  assert.equal(seen.atClone.length, 1);
  assert.deepEqual(seen.atClone[0].slice(0, 5), ['CUS001', 'DITECH', '', 'INACTIVE', 'Auto-created by seller sheet provisioning'], 'INACTIVE + blank before clone');
  assert.deepEqual(seen.atSync[0].slice(2, 4), [r.spreadsheet_id, 'INACTIVE'], 'registered, still INACTIVE during sync');
  const rows = rowsFor(env.master, 'CUS001');
  assert.equal(rows.length, 1, 'exactly one row');
  assert.deepEqual(rows[0].slice(0, 5), ['CUS001', 'DITECH', r.spreadsheet_id, 'ACTIVE', 'Auto-created by seller sheet provisioning']);
  assert.equal(rowsFor(env.master, 'CUS002').length, 1, 'other rows untouched');
});

test('auto-created row stays INACTIVE and is reused when provisioning fails (before or after the clone)', () => {
  install({ master: onlyCus002(), folderInaccessible: true });
  const m = env.master;
  const early = js(H.runCreateSellerSheet_('CUS001'));
  assert.equal(early.status, 'FAILED');
  assert.match(early.error, /seller_output_folder_id is not accessible/);
  assert.deepEqual(rowsFor(m, 'CUS001').map((r) => r.slice(0, 4)), [['CUS001', 'DITECH', '', 'INACTIVE']]);
  assert.equal(env.copies.length, 0);
  install({ master: m, failCopies: true });
  const late = js(H.runCreateSellerSheet_('CUS001'));
  assert.equal(late.status, 'FAILED');
  assert.equal(late.destination_row_created, false, 'the existing row is reused, not duplicated');
  assert.deepEqual(rowsFor(m, 'CUS001').map((r) => r.slice(0, 4)), [['CUS001', 'DITECH', late.spreadsheet_id, 'INACTIVE']]);
  env.children[late.spreadsheet_id].failOn = null;
  const retry = js(H.runCreateSellerSheet_('CUS001'));
  assert.equal(retry.status, 'SUCCESS', retry.error);
  assert.equal(retry.reused_existing_copy, true);
  assert.equal(env.copies.length, 1);
  assert.deepEqual(rowsFor(m, 'CUS001').map((r) => r.slice(2, 4)), [[late.spreadsheet_id, 'ACTIVE']]);
});

test('no row is auto-created for duplicate rows, unknown sellers or an invalid Seller Destinations config', () => {
  install({ master: master({ destinations: [{ seller_id: 'CUS001', seller_name_snapshot: 'DITECH', spreadsheet_id: '', status: 'INACTIVE' },
    { seller_id: 'CUS001', seller_name_snapshot: 'DITECH', spreadsheet_id: '', status: 'INACTIVE' }] }) });
  const dup = js(H.runCreateSellerSheet_('CUS001'));
  assert.equal(dup.status, 'FAILED');
  assert.match(dup.error, /Seller Destinations is invalid.*CUS001: 2 rows/);
  assert.equal(rowsFor(env.master, 'CUS001').length, 2);
  assert.equal(env.copies.length, 0);
  install({ master: onlyCus002() });
  const unknown = js(H.runCreateSellerSheet_('CUS999'));
  assert.match(unknown.error, /Unknown seller CUS999/);
  assert.equal(env.master.getSheetByName('Seller Destinations').grid.slice(1).filter((r) => r[0] !== '').length, 1);
  install({ master: master({ destinations: [{ seller_id: 'CUS002', seller_name_snapshot: 'HUI', spreadsheet_id: MASTER_ID, status: 'INACTIVE' }] }) });
  const leak = js(H.runCreateSellerSheet_('CUS001'));
  assert.match(leak.error, /Seller Destinations is invalid; no seller sheet written/);
  assert.equal(rowsFor(env.master, 'CUS001').length, 0);
  assert.equal(env.copies.length, 0);
});

test('template contract is checked before any clone: unexpected / RAW / old tabs and data-row formulas block provisioning', () => {
  for (const [label, mutate, re] of [['RAW tab', (t) => t.api.insertSheet('RAW_PP'), /provider raw tab/],
    ['old Phase 2K tab', (t) => t.api.insertSheet('Summary'), /old Phase 2K tab/],
    ['custom tab', (t) => t.api.insertSheet('Brand'), /unexpected visible tab "Brand"/],
    ['data formula', (t) => t.api.getSheetByName('DoiSoat_GD').getRange(7, 16).setFormula('=O7*0.08'), /unexpected formula at R7C16/],
    ['protected id', (t) => t.api.getSheetByName('PhieuDoiSoat').getRange(2, 3).setValue(SOURCE_ID), /protected spreadsheet ID/]]) {
    const tpl = templateSheet();
    mutate(tpl);
    install({ template: tpl });
    const r = js(H.runCreateSellerSheet_('CUS001'));
    assert.equal(r.status, 'FAILED', label);
    assert.match(r.error, /Seller template does not satisfy the seller output contract/);
    assert.match(r.error, re);
    assert.equal(env.copies.length, 0, 'nothing cloned: ' + label);
    assert.ok(!r.error.includes(SOURCE_ID), 'protected IDs never echoed');
  }
});

test('a registered copy shared with another (INACTIVE) row is never reused', () => {
  const shared = 'SHARED_COPY_ID_000000000000000001';
  install({ master: master({ destinations: [
    { seller_id: 'CUS001', seller_name_snapshot: 'DITECH', spreadsheet_id: shared, status: 'INACTIVE' },
    { seller_id: 'CUS002', seller_name_snapshot: 'HUI', spreadsheet_id: shared, status: 'INACTIVE' }] }), children: { [shared]: fakeChild(shared) } });
  const r = js(H.runCreateSellerSheet_('CUS001'));
  assert.equal(r.status, 'FAILED');
  assert.match(r.error, /also registered for another seller; refusing to reuse it/);
  assert.deepEqual(env.opened, [TEMPLATE_ID], 'only the template is read; the shared copy is never opened');
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
  assert.deepEqual(b.log, []);
  assert.ok(a.log.some((e) => e.op === 'setValues' && e.sheet === '_Sync'));
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
