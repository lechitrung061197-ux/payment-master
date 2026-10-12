// Unit tests for the Phase 2N schema cleanup (schema v17): Source Payments leaves the schema and setup
// deletes the legacy tab only when it is provably empty and unreferenced. Fake data.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
const context = vm.createContext({ Logger: { log: () => {} } });
for (const f of fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort()) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), context, { filename: f });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const ev = (expr) => js(vm.runInContext(expr, context)); // top-level const is not a context property
const LEGACY = 'Source Payments';
const LEGACY_HEADER = ['payment_source', 'external_event_id', 'external_transaction_id', 'related_external_transaction_id',
  'provider', 'event_type', 'event_date', 'gross_amount', 'processing_fee', 'net_amount', 'currency',
  'external_status', 'order_reference', 'payer_reference', 'import_batch_id', 'imported_at'];

/** In-memory spreadsheet: each sheet is a grid of values; a value starting with "=" is a formula. */
function fakeSpreadsheet(tabs, namedRanges) {
  let nextId = 1;
  const sheets = Object.entries(tabs).map(([name, grid]) => {
    const sheet = { id: nextId++, name, grid };
    sheet.api = {
      getName: () => sheet.name,
      getSheetId: () => sheet.id,
      getLastRow: () => { for (let r = grid.length; r > 0; r--) if (grid[r - 1].some((v) => v !== '')) return r; return 0; },
      getLastColumn: () => Math.max(0, ...grid.map((r) => { let n = r.length; while (n > 0 && r[n - 1] === '') n--; return n; })),
      getRange: (r, c, nr, nc) => ({
        getDisplayValues: () => grid.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc).map(String)),
      }),
    };
    return sheet;
  });
  const deleted = [];
  const ss = {
    getSheetByName: (n) => (sheets.find((s) => s.name === n) || {}).api || null,
    deleteSheet: (api) => { const i = sheets.findIndex((s) => s.api === api); deleted.push(sheets[i].name); sheets.splice(i, 1); },
    getNamedRanges: () => (namedRanges || []).map(([name, tab]) => ({
      getName: () => name, getRange: () => ({ getSheet: () => ss.getSheetByName(tab) }) })),
    createTextFinder: (text) => {
      let formulas = false;
      const finder = {
        matchFormulaText: (b) => { formulas = b; return finder; },
        findAll: () => {
          assert.equal(formulas, true, 'the reference check must search formula text');
          const hits = [];
          sheets.forEach((s) => s.grid.forEach((row, i) => row.forEach((v, j) => {
            if (String(v).indexOf(text) >= 0) {
              hits.push({ getSheet: () => s.api, getA1Notation: () => String.fromCharCode(65 + j) + (i + 1),
                getFormula: () => (String(v).charAt(0) === '=' ? String(v) : '') });
            }
          })));
          return hits;
        },
      };
      return finder;
    },
  };
  return { ss, deleted, names: () => sheets.map((s) => s.name) };
}

const legacyTab = (...rows) => [LEGACY_HEADER.slice(), ...rows];
const run = (f) => { const warnings = []; const result = js(H.removeLegacyTabs_(f.ss, warnings)); return { result, warnings: js(warnings) }; };

test('schema v17: Source Payments and its enum are gone; every required tab and the Dashboard stay', () => {
  assert.equal(ev('APP.SCHEMA_VERSION'), 17);
  const names = Object.values(ev('SHEETS'));
  assert.ok(!names.includes(LEGACY), 'not in SHEETS');
  assert.ok(!ev('SCHEMA').some((t) => t.sheet === LEGACY), 'not in SCHEMA');
  assert.equal(ev('ENUMS').SOURCE_EVENT_TYPE, undefined, 'its only enum is removed');
  ['Settings', 'Sellers', 'Seller Terms', 'Seller Destinations', 'Endpoint Mapping', 'Raw Internal Transactions', 'Source System',
    'Transactions', 'Payment Matches', 'Payment Legs', 'Settlements', 'Settlement Items', 'Seller Balances', 'Seller Payouts',
    'Seller Payout Allocations', 'Adjustments', 'Disputes', 'Audit Log', 'Import Batches', 'Raw KH001 PayPal', 'Raw KH001 Reconciled',
    'Raw KH001 Settlements', 'Raw KH001 Disputes', 'Provider Transactions', 'Provider Events', 'Dashboard',
  ].forEach((n) => assert.ok(names.includes(n), n + ' must stay in SHEETS'));
  const legacy = ev('LEGACY_TABS');
  assert.deepEqual(legacy.map((t) => [t.sheet, t.removedInSchema]), [[LEGACY, 17]]);
  assert.deepEqual(legacy[0].legacyHeader, LEGACY_HEADER, 'exactly the v16 header');
});

test('empty legacy tab (exact v16 header, no rows) is deleted; a second run is a no-op', () => {
  const f = fakeSpreadsheet({ Settings: [['key']], [LEGACY]: legacyTab(), 'Audit Log': [['x']] });
  assert.deepEqual(run(f), { result: { removed: [LEGACY], kept: [] }, warnings: [] });
  assert.deepEqual(f.names(), ['Settings', 'Audit Log']);
  assert.deepEqual(run(f), { result: { removed: [], kept: [] }, warnings: [] });
  assert.deepEqual(f.deleted, [LEGACY], 'only the legacy tab was ever deleted');
});

test('fully blank legacy tab is deleted', () => {
  const f = fakeSpreadsheet({ [LEGACY]: [[]] });
  assert.deepEqual(run(f).result.removed, [LEGACY]);
});

test('legacy tab with a data row is kept untouched and reported', () => {
  const row = ['PAYPAL', 'EV-1', 'TX-1', '', 'KH001', 'PAYMENT', '2026-10-01', 10, -1, 9, 'USD', 'Completed', '', '', '', ''];
  const f = fakeSpreadsheet({ [LEGACY]: legacyTab(row) });
  const before = JSON.stringify(f.ss.getSheetByName(LEGACY).getRange(1, 1, 2, 16).getDisplayValues());
  const out = run(f);
  assert.deepEqual(out.result, { removed: [], kept: [LEGACY] });
  assert.match(out.warnings[0], /Legacy tab "Source Payments" \(removed from schema v17\) kept: 1 row\(s\) below the header/);
  assert.deepEqual(f.deleted, []);
  assert.equal(JSON.stringify(f.ss.getSheetByName(LEGACY).getRange(1, 1, 2, 16).getDisplayValues()), before, 'no cell changed');
});

test('a value in any data row (even far below) keeps the tab', () => {
  const grid = legacyTab([], [], []);
  grid[3] = Array(16).fill(''); grid[3][15] = 'note';
  const out = run(fakeSpreadsheet({ [LEGACY]: grid }));
  assert.match(out.warnings[0], /3 row\(s\) below the header/);
});

test('unexpected header or content beyond the header columns keeps the tab', () => {
  const renamed = legacyTab(); renamed[0][5] = 'kind';
  assert.match(run(fakeSpreadsheet({ [LEGACY]: renamed })).warnings[0], /header row differs from the legacy header/);
  const wider = legacyTab(); wider[0].push('my_column');
  assert.match(run(fakeSpreadsheet({ [LEGACY]: wider })).warnings[0], /content beyond the 16 legacy header columns/);
  const custom = [['my own notes']];
  assert.match(run(fakeSpreadsheet({ [LEGACY]: custom })).warnings[0], /header row differs/);
});

test('a formula elsewhere that references the tab keeps it; plain text mentions (Audit Log) do not', () => {
  const ref = fakeSpreadsheet({ [LEGACY]: legacyTab(), Report: [['', "=COUNTA('Source Payments'!A2:A)"]] });
  const out = run(ref);
  assert.deepEqual(out.result.kept, [LEGACY]);
  assert.match(out.warnings[0], /referenced by formula\(s\) 'Report'!B1/);
  const text = fakeSpreadsheet({ [LEGACY]: legacyTab(), 'Audit Log': [['SCHEMA_SETUP', '{"migratedTabs":["Source Payments"]}']] });
  assert.deepEqual(run(text).result.removed, [LEGACY]);
});

test('a named range on the tab keeps it', () => {
  const out = run(fakeSpreadsheet({ [LEGACY]: legacyTab(), Other: [['x']] }, [['sp_events', LEGACY], ['other', 'Other']]));
  assert.deepEqual(out.result.kept, [LEGACY]);
  assert.match(out.warnings[0], /named range\(s\) sp_events/);
});

test('Settings: only the canonical schedule keys are seeded; legacy automation / seller_output keys never are', () => {
  const keys = ev('DEFAULT_SETTINGS').map((d) => d[0]);
  ['scheduled_sync_morning_hour', 'scheduled_sync_afternoon_hour', 'scheduled_sync_timezone'].forEach((k) => assert.ok(keys.includes(k), k));
  const legacyKeys = ['automation.sync.enabled', 'automation.sync.timezone', 'automation.sync.morning_hour', 'automation.sync.afternoon_hour',
    'seller_output.status_authority', 'seller_output.paid_source', 'seller_output.direction'];
  const renameTargets = ev('SETTING_KEY_RENAMES').map((r) => r[1]);
  legacyKeys.forEach((k) => {
    assert.ok(!keys.includes(k), k + ' is not a default setting');
    assert.ok(!renameTargets.includes(k), k + ' is not a rename target');
  });
  const code = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
  legacyKeys.forEach((k) => assert.ok(code.indexOf(k) < 0, k + ' is not referenced anywhere in src'));
  assert.ok(code.indexOf('Source Payments') === code.lastIndexOf('Source Payments'), 'the tab name appears only in LEGACY_TABS');
});
