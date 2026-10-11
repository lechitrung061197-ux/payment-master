// In-memory Google Sheets fakes for seller-output tests: a replica of VNS_SELLER_PAYMENT_TEMPLATE
// (test/fixtures/sellerTemplate.json: labels, approved formulas, per-cell style ids) with the Sheets
// behaviours the renderer relies on - row insertion that extends formula ranges, copyTo of formats /
// formulas, quote-prefixed text - and a log of every write so tests can prove what was (not) touched.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sellerTemplate.json'), 'utf8'));
const colNum = (c) => c.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/** Sheets-style reference adjustment after inserting n rows before row `at`. */
function shiftFormulaRows(formula, at, n) {
  return formula.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(])/g, (m, ca, col, ra, row) => (Number(row) >= at ? ca + col + ra + (Number(row) + n) : m));
}

/** Relative-reference shift used by copyTo(PASTE_FORMULA). */
function moveFormula(formula, dr) {
  return formula.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(])/g, (m, ca, col, ra, row) => ca + col + ra + (ra ? row : Number(row) + dr));
}

/**
 * @param {{id: string, makeDate: function(number): Date, tz?: string, locale?: string, sheets?: Array}} o
 */
function makeSpreadsheet(o) {
  const log = [];
  const ss = { id: o.id, tz: o.tz || 'America/Los_Angeles', locale: o.locale || 'vi_VN', log, sheets: [], failOn: null, forbidden: [] };
  const mkSheet = (spec) => {
    const sh = { name: spec.name, hidden: !!spec.hidden, maxRows: spec.maxRows || 1000, maxCols: spec.maxCols || 26, cells: {} };
    Object.entries(spec.cells || {}).forEach(([k, c]) => { sh.cells[k] = { ...c }; });
    const cell = (r, c) => sh.cells[r + ',' + c];
    const api = {
      getName: () => sh.name, setName: (n) => { sh.name = n; return api; },
      getMaxRows: () => sh.maxRows, getMaxColumns: () => sh.maxCols,
      isSheetHidden: () => sh.hidden, hideSheet: () => { sh.hidden = true; log.push({ op: 'hideSheet', sheet: sh.name }); return api; },
      showSheet: () => { sh.hidden = false; return api; },
      clear: () => { ss.forbidden.push('clear:' + sh.name); sh.cells = {}; return api; },
      clearFormats: () => { ss.forbidden.push('clearFormats:' + sh.name); return api; },
      insertRowsBefore: (at, n) => {
        log.push({ op: 'insertRowsBefore', sheet: sh.name, at, n });
        const next = {};
        Object.entries(sh.cells).forEach(([k, c]) => {
          const [r, col] = k.split(',').map(Number);
          const nc = { ...c };
          if (nc.f) nc.f = shiftFormulaRows(nc.f, at, n);
          next[(r >= at ? r + n : r) + ',' + col] = nc;
        });
        sh.cells = next;
        sh.maxRows += n;
        return api;
      },
      getRange: (r, c, nr, nc) => {
        nr = nr || 1; nc = nc || 1;
        if (r < 1 || c < 1 || r + nr - 1 > sh.maxRows || c + nc - 1 > sh.maxCols) throw new Error(`range out of bounds ${sh.name} R${r}C${c} ${nr}x${nc}`);
        const each = (fn) => Array.from({ length: nr }, (_x, i) => Array.from({ length: nc }, (_y, j) => fn(r + i, c + j)));
        const fmtCall = (name) => () => { log.push({ op: name, sheet: sh.name, r, c, nr, nc }); return rg; };
        const rg = {
          getValues: () => each((rr, cc) => { const x = cell(rr, cc); if (!x || x.v === undefined || x.v === null) return ''; return typeof x.v === 'object' && typeof x.v.getTime === 'function' ? o.makeDate(x.v.getTime()) : x.v; }),
          getFormulas: () => each((rr, cc) => { const x = cell(rr, cc); return x && x.f ? x.f : ''; }),
          getValue: () => rg.getValues()[0][0],
          setValues: (vals) => {
            if (ss.failOn && ss.failOn(sh.name, r, c)) throw new Error('Service Spreadsheets failed (simulated on ' + sh.name + ')');
            if (ss.beforeWrite) { const hook = ss.beforeWrite; ss.beforeWrite = null; hook(); }
            log.push({ op: 'setValues', sheet: sh.name, r, c, nr, nc });
            vals.forEach((row, i) => row.forEach((v, j) => {
              const k = (r + i) + ',' + (c + j);
              const prev = sh.cells[k] || {};
              let val = v;
              if (typeof v === 'string' && v.startsWith("'")) val = v.slice(1);
              else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) val = Number(v);
              else if (typeof v === 'string' && v.startsWith('=')) { sh.cells[k] = { ...prev, f: v, v: '' }; return; }
              const next = { ...prev, v: val };
              delete next.f;
              sh.cells[k] = next;
            }));
            return rg;
          },
          setValue: (v) => rg.setValues([[v]]),
          setFormula: (f) => { log.push({ op: 'setFormula', sheet: sh.name, r, c }); sh.cells[r + ',' + c] = { ...(cell(r, c) || {}), f, v: '' }; return rg; },
          clearContent: () => { log.push({ op: 'clearContent', sheet: sh.name, r, c, nr, nc }); each((rr, cc) => { const x = cell(rr, cc); if (x) { delete x.v; delete x.f; } }); return rg; },
          copyTo: (dest, type) => {
            log.push({ op: 'copyTo', sheet: sh.name, type, from: [r, c, nr, nc], to: [dest.__r, dest.__c, dest.__nr, dest.__nc] });
            for (let i = 0; i < dest.__nr; i++) {
              for (let j = 0; j < dest.__nc; j++) {
                const src = cell(r + (i % nr), c + (j % nc)) || {};
                const k = (dest.__r + i) + ',' + (dest.__c + j);
                const tgt = dest.__sheet.cells[k] || {};
                if (type === 'PASTE_FORMAT') dest.__sheet.cells[k] = { ...tgt, s: src.s };
                if (type === 'PASTE_FORMULA' && src.f) dest.__sheet.cells[k] = { ...tgt, f: moveFormula(src.f, dest.__r + i - (r + (i % nr))), v: '' };
              }
            }
          },
          __r: r, __c: c, __nr: nr, __nc: nc, __sheet: sh,
        };
        ['setNumberFormat', 'setNumberFormats', 'setBackground', 'setFontWeight', 'setFontColor', 'setFontSize', 'setBorder', 'merge', 'breakApart',
          'setDataValidation', 'clearDataValidations', 'createFilter', 'setHorizontalAlignment', 'setWrap'].forEach((m) => { rg[m] = fmtCall(m); });
        return rg;
      },
      setFrozenRows: () => { log.push({ op: 'setFrozenRows', sheet: sh.name }); }, setColumnWidth: () => { log.push({ op: 'setColumnWidth', sheet: sh.name }); },
      getFilter: () => null,
      __sh: sh,
    };
    sh.api = api;
    return sh;
  };
  (o.sheets || TEMPLATE.sheets).forEach((spec) => ss.sheets.push(mkSheet(spec)));
  ss.api = {
    getId: () => ss.id, getName: () => ss.id,
    getSpreadsheetTimeZone: () => ss.tz, setSpreadsheetTimeZone: (t) => { ss.forbidden.push('setSpreadsheetTimeZone'); ss.tz = t; },
    getSpreadsheetLocale: () => ss.locale, setSpreadsheetLocale: (l) => { ss.forbidden.push('setSpreadsheetLocale'); ss.locale = l; },
    getSheets: () => ss.sheets.map((s) => s.api),
    getSheetByName: (n) => { const s = ss.sheets.find((x) => x.name === n); return s ? s.api : null; },
    insertSheet: (n, idx) => {
      log.push({ op: 'insertSheet', sheet: n });
      const s = mkSheet({ name: n, maxRows: 1000, maxCols: 26, cells: {} });
      if (idx === undefined) ss.sheets.push(s); else ss.sheets.splice(idx, 0, s);
      return s.api;
    },
    deleteSheet: () => { ss.forbidden.push('deleteSheet'); },
  };
  return ss;
}

/** A clone (Drive makeCopy) of a fake spreadsheet. */
function cloneSpreadsheet(src, id, makeDate) {
  return makeSpreadsheet({ id, makeDate, tz: src.tz, locale: src.locale,
    sheets: src.sheets.map((s) => ({ name: s.name, hidden: s.hidden, maxRows: s.maxRows, maxCols: s.maxCols, cells: Object.fromEntries(Object.entries(s.cells).map(([k, c]) => [k, { ...c }])) })) });
}

const writesTo = (ss, sheet) => ss.log.filter((e) => e.sheet === sheet && e.op === 'setValues');
const formatOps = (ss) => ss.log.filter((e) => !['setValues', 'insertSheet', 'hideSheet', 'insertRowsBefore', 'copyTo'].includes(e.op));

module.exports = { TEMPLATE, makeSpreadsheet, cloneSpreadsheet, writesTo, formatOps, colNum, shiftFormulaRows };
