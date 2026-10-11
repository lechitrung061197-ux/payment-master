// Regression test for Dashboard refresh in setup (src/Setup.gs ensureDashboard_).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({});
for (const f of ['Config', 'Utils', 'Setup']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.gs'), 'utf8'), context, { filename: f + '.gs' });
}
const H = context;

/** Minimal in-memory sheet: cells keyed "row,col"; formulas stored as strings. */
function fakeDashboard(rows) {
  const cells = {};
  rows.forEach((r, i) => r.forEach((v, j) => { if (v !== '') cells[(i + 1) + ',' + (j + 1)] = v; }));
  const lastRow = () => Math.max(0, ...Object.keys(cells).map((k) => Number(k.split(',')[0])));
  const range = (r, c, nr, nc) => {
    const rg = {
      getValues: () => Array.from({ length: nr || 1 }, (_, i) => Array.from({ length: nc || 1 }, (_, j) => cells[(r + i) + ',' + (c + j)] ?? '')),
      setValue: (v) => { cells[r + ',' + c] = v; return rg; },
      setFormula: (f) => { cells[r + ',' + c] = f; return rg; },
      setValues: (vals) => { vals.forEach((row, i) => row.forEach((v, j) => { cells[(r + i) + ',' + (c + j)] = v; })); return rg; },
    };
    ['setNumberFormat', 'setFontWeight', 'setFontSize', 'setFontColor', 'setBackground', 'setBorder'].forEach((f) => { rg[f] = () => rg; });
    return rg;
  };
  const sheet = { getLastRow: lastRow, getRange: (r, c, nr, nc) => (typeof r === 'string' ? range(1, 1) : range(r, c, nr, nc)), setColumnWidth: () => {} };
  return { cells, ss: { getSheetByName: () => sheet, insertSheet: () => sheet } };
}

test('existing Dashboard: known rows get refreshed formula + definition; null-formula values and custom rows untouched', () => {
  const d = fakeDashboard([
    ['Payment Master Dashboard'], [''], [''],
    ['Metric', 'Value', 'Definition'],
    ['Total transactions', "=COUNTA('Transactions'!A2:A)", 'Count of Transactions rows'],
    ['Matched', "=COUNTIF('Transactions'!J2:J,\"MATCHED\")", 'Transactions.status = MATCHED'],
    ['Available (USD)', 123.45, 'old definition'],
    ['My custom metric', '=1+1', 'custom definition'],
  ]);
  H.ensureDashboard_(d.ss);
  assert.equal(d.cells['6,2'], '=COUNTIF(INDIRECT("\'Payment Matches\'!G2:G"),"MATCHED")');
  assert.equal(d.cells['6,3'], 'Payment Matches.reconciliation_status = MATCHED');
  assert.equal(d.cells['5,2'], '=COUNTA(INDIRECT("\'Transactions\'!A2:A"))');
  assert.equal(d.cells['7,2'], '=SUMIFS(INDIRECT("\'Seller Balances\'!D2:D"),INDIRECT("\'Seller Balances\'!B2:B"),"USD")',
    'Available (USD) now has a canonical formula');
  assert.equal(d.cells['7,3'], 'SUM Seller Balances.available_amount WHERE currency = USD', 'definition refreshed');
  assert.equal(d.cells['8,2'], '=1+1', 'custom row formula untouched');
  assert.equal(d.cells['8,3'], 'custom definition', 'custom row definition untouched');
});

test('empty Dashboard: layout written once with current definitions', () => {
  const d = fakeDashboard([]);
  H.ensureDashboard_(d.ss);
  assert.equal(d.cells['4,1'], 'Metric');
  assert.equal(d.cells['6,1'], 'Matched');
  assert.equal(d.cells['6,3'], 'Payment Matches.reconciliation_status = MATCHED');
});

test('all five financial metrics point to canonical sources with matching definitions', () => {
  const metrics = Object.fromEntries(H.dashboardMetrics_().map((m) => [m[0], m]));
  const expect = {
    'Available (USD)': ["'Seller Balances'!D2:D", 'SUM Seller Balances.available_amount WHERE currency = USD'],
    'Seller balances (USD)': ["'Seller Balances'!H2:H", 'SUM Seller Balances.current_balance WHERE currency = USD'],
    'Provider settlements (USD)': ["'Settlements'!Y2:Y", 'SUM Settlements.source_paid_amount WHERE currency = USD'],
    'Holds (USD)': ["'Seller Balances'!F2:F", 'SUM Seller Balances.seller_hold_balance WHERE currency = USD'],
  };
  Object.entries(expect).forEach(([label, [ref, def]]) => {
    assert.ok(metrics[label][1].includes(ref), label + ' formula uses ' + ref + ': ' + metrics[label][1]);
    assert.ok(metrics[label][1].includes('"USD"'), label + ' filters USD');
    assert.equal(metrics[label][2], def);
  });
  const margin = metrics['System margin (USD)'];
  assert.equal(margin[1], '=SUMIFS(INDIRECT("\'Settlement Items\'!Q2:Q"),INDIRECT("\'Settlement Items\'!H2:H"),"USD")-' +
    'SUMIFS(INDIRECT("\'Settlement Items\'!M2:M"),INDIRECT("\'Settlement Items\'!H2:H"),"USD")');
  assert.equal(margin[2], 'SUM Settlement Items (seller_fee - provider_fee) WHERE currency = USD');
  assert.equal(metrics['Waiting settlement'][2], 'Payment Legs.settlement_status = WAITING_SETTLEMENT');
});
