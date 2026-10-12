// End-to-end Payment Master simulation for integration tests (fake data shaped like current production):
// an in-memory Master spreadsheet + KH001 provider source + seller child spreadsheets (template fakes), the whole src/
// loaded in one Apps Script-like realm, and the real setup / normalizers / pipeline run on it.
//   168 KH001 PAYPAL transactions over 4 sellers and 2 provider settlements -> 168 Settlement Items, balances
//   CUS001 1919.3986 / CUS002 3037.444 / CUS003 256.7666 / CUS004 3156.4424 (holds 234.073 / 370.42 / 31.313 / 384.932),
//   7 seller settlement obligations, no payouts. CUS001 and CUS004 have ACTIVE seller sheets.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FK = require('./sellerFakes');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');
const MASTER_ID = '1MasterPaymentSpreadsheetId_000000000000AA';
const PROVIDER_ID = '1gDg2NrxIkXNSnFSOgH-jCUH4GZOpSyrm2Zf8oEuiBzM';
const TEMPLATE_ID = '1SellerTemplateSpreadsheet_0000000000000TT';
const FOLDER_ID = '1SellerOutputFolder_00000000000000000FF';

/** Midnight of a YYYY-MM-DD day in a time zone (Utilities.parseDate 'yyyy-MM-dd'). */
function zonedMidnight(key, tz) {
  const [y, m, d] = key.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess)).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(guess - (asUtc - guess));
}

function makeMock() {
  let seq = 0;
  let uuid = 0;
  const locks = { script: false, document: false, documentBusy: false };
  function makeSheet(name, ss) {
    const sh = { id: ++seq, name, cells: {}, fmts: {}, maxRows: 1000, maxCols: 26, hidden: false, prots: [], filter: null };
    const k = (r, c) => r + ',' + c;
    const nonEmpty = (v) => v !== '' && v != null;
    const lastRow = () => { let m = 0; for (const x in sh.cells) if (nonEmpty(sh.cells[x])) m = Math.max(m, +x.split(',')[0]); return m; };
    const lastCol = () => { let m = 0; for (const x in sh.cells) if (nonEmpty(sh.cells[x])) m = Math.max(m, +x.split(',')[1]); return m; };
    const range = (r, c, nr, nc) => {
      nr = nr || 1; nc = nc || 1;
      if (r < 1 || c < 1 || r + nr - 1 > sh.maxRows || c + nc - 1 > sh.maxCols) throw new Error(`range out of bounds ${sh.name} ${r},${c},${nr},${nc}`);
      const rg = {
        getRow: () => r, getColumn: () => c, getNumRows: () => nr, getNumColumns: () => nc, getSheet: () => sh.api, getA1Notation: () => String.fromCharCode(64 + c) + r,
        getValues: () => { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = sh.cells[k(r + i, c + j)]; row.push(v == null ? '' : (v instanceof Date ? new Date(v.getTime()) : v)); } o.push(row); } return o; },
        getDisplayValues: () => rg.getValues().map((x) => x.map(String)),
        getFormulas: () => rg.getValues().map((x) => x.map((v) => (typeof v === 'string' && v.startsWith('=') ? v : ''))),
        getFormula: () => rg.getFormulas()[0][0],
        getNumberFormats: () => { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(sh.fmts[k(r + i, c + j)] || 'General'); o.push(row); } return o; },
        getValue: () => rg.getValues()[0][0],
        setValues: (v) => {
          if (v.length !== nr || v.some((row) => row.length !== nc)) throw new Error(`setValues dimension mismatch on ${sh.name}`);
          v.forEach((row, i) => row.forEach((x, j) => {
            let val = x;
            const f = sh.fmts[k(r + i, c + j)];
            if (typeof x === 'string' && f !== '@' && /^\d+$/.test(x)) val = Number(x); // Sheets parses digits unless plain text
            sh.cells[k(r + i, c + j)] = val;
          }));
          return rg;
        },
        setNumberFormats: (f) => { f.forEach((row, i) => row.forEach((x, j) => { sh.fmts[k(r + i, c + j)] = x; })); return rg; },
        setValue: (v) => rg.setValues([[v]]),
        setFormula: (f) => { sh.cells[k(r, c)] = f; return rg; },
        clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) delete sh.cells[k(r + i, c + j)]; return rg; },
        createFilter: () => { sh.filter = { getRange: () => ({ getNumColumns: () => nc }), remove: () => { sh.filter = null; } }; return sh.filter; },
        protect: () => prot('RANGE', nc),
      };
      rg.setNumberFormat = (f) => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh.fmts[k(r + i, c + j)] = f; return rg; };
      rg.setDataValidation = (dv) => { sh.validation = sh.validation || {}; sh.validation[k(r, c)] = dv; return rg; };
      ['setFontWeight', 'setBackground', 'setVerticalAlignment', 'setBorder', 'setNote', 'clearNote', 'clearDataValidations', 'setFontSize',
        'setFontColor'].forEach((f) => { rg[f] = () => rg; });
      return rg;
    };
    const prot = (type, nc) => { const p = { type, desc: '', setDescription: (d) => { p.desc = d; return p; }, setWarningOnly: () => p, getDescription: () => p.desc,
      getRange: () => ({ getNumColumns: () => nc }), remove: () => { sh.prots = sh.prots.filter((x) => x !== p); } }; sh.prots.push(p); return p; };
    sh.api = {
      getName: () => sh.name, getSheetId: () => sh.id,
      setName: (n) => { if (ss.sheets.some((x) => x !== sh && x.name === n)) throw new Error('name exists ' + n); sh.name = n; return sh.api; },
      getMaxRows: () => sh.maxRows, getMaxColumns: () => sh.maxCols, getLastRow: lastRow, getLastColumn: lastCol,
      insertColumnsAfter: (a, n) => { sh.maxCols += n; const shift = (o) => { const x = {}; for (const key in o) { const [rr, cc] = key.split(',').map(Number); x[rr + ',' + (cc > a ? cc + n : cc)] = o[key]; } return x; }; sh.cells = shift(sh.cells); sh.fmts = shift(sh.fmts); },
      insertRowsAfter: (a, n) => { sh.maxRows += n; },
      deleteColumns: (s, n) => { sh.maxCols -= n; for (const x in sh.cells) if (+x.split(',')[1] >= s) delete sh.cells[x]; },
      deleteRows: (s, n) => { sh.maxRows -= n; for (const x in sh.cells) if (+x.split(',')[0] >= s) delete sh.cells[x]; },
      clear: () => { sh.cells = {}; sh.fmts = {}; return sh.api; }, clearNotes: () => sh.api,
      hideSheet: () => {
        if (!sh.hidden && ss.sheets.filter((x) => !x.hidden).length === 1) throw new Error('You can\'t hide all the sheets in a document.');
        sh.hidden = true; return sh.api;
      },
      showSheet: () => { sh.hidden = false; return sh.api; }, isSheetHidden: () => sh.hidden,
      getIndex: () => ss.sheets.indexOf(sh) + 1,
      setFrozenRows: () => {}, setFrozenColumns: () => {}, setColumnWidth: () => {}, getFilter: () => sh.filter,
      getProtections: (t) => sh.prots.filter((p) => p.type === t), protect: () => prot('SHEET', 0),
      getDataRange: () => range(1, 1, Math.max(lastRow(), 1), Math.max(lastCol(), 1)),
      getRange: (r, c, nr, nc) => { if (typeof r === 'string') { const m = r.match(/([A-Z]+)(\d+)/); return range(+m[2], m[1].charCodeAt(0) - 64, 1, 1); } return range(r, c, nr, nc); },
    };
    return sh;
  }
  function makeSS(id, first) {
    const ss = { id, sheets: [], locale: '', tz: '', active: null, activeRange: null };
    ss.sheets.push(makeSheet(first || 'Sheet1', ss));
    ss.api = {
      getId: () => id, getName: () => id, getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id + '/edit',
      setSpreadsheetLocale: (l) => { ss.locale = l; }, setSpreadsheetTimeZone: (t) => { ss.tz = t; },
      getSpreadsheetLocale: () => ss.locale, getSpreadsheetTimeZone: () => ss.tz,
      getSheets: () => ss.sheets.map((s) => s.api), getNumSheets: () => ss.sheets.length,
      getSheetByName: (n) => { const s = ss.sheets.find((x) => x.name === n); return s ? s.api : null; },
      insertSheet: (n, idx) => { const s = makeSheet(n, ss); if (idx == null) ss.sheets.push(s); else ss.sheets.splice(idx, 0, s); return s.api; },
      deleteSheet: (a) => { ss.sheets = ss.sheets.filter((x) => x.api !== a); },
      getNamedRanges: () => [],
      createTextFinder: () => { const tf = { matchFormulaText: () => tf, findAll: () => [] }; return tf; },
      setActiveSheet: (a) => { ss.active = a; ss.activeRange = null; return a; },
      getActiveSheet: () => ss.active || ss.sheets[0].api,
      getActiveRange: () => ss.activeRange,
      moveActiveSheet: (i) => { const s = ss.sheets.find((x) => x.api === ss.active); ss.sheets = ss.sheets.filter((x) => x !== s); ss.sheets.splice(i - 1, 0, s); },
    };
    return ss;
  }
  const MASTER = makeSS(MASTER_ID);
  const SRC = makeSS(PROVIDER_ID, 'RAW_KH');
  ['RAW_PP', 'DoiSoat_GD', 'PhieuDoiSoat', 'Dispute'].forEach((n) => SRC.sheets.push(makeSheet(n, SRC)));
  const dv = { requireValueInList: (list) => { dv.list = list; return dv; }, setAllowInvalid: () => dv, setHelpText: () => dv, build: () => ({ list: dv.list }) };
  const children = {};
  const opened = [];
  const state = { providerDown: false, now: null };
  const globals = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => MASTER.api,
      openById: (id) => {
        opened.push(id);
        if (id === SRC.id) { if (state.providerDown) throw new Error('Service unavailable (simulated provider outage)'); return SRC.api; }
        if (id === MASTER_ID) return MASTER.api;
        if (children[id]) return children[id].api;
        throw new Error('Requested entity was not found.');
      },
      flush: () => {}, newDataValidation: () => dv, ProtectionType: { RANGE: 'RANGE', SHEET: 'SHEET' },
      CopyPasteType: { PASTE_FORMAT: 'PASTE_FORMAT', PASTE_FORMULA: 'PASTE_FORMULA' },
    },
    LockService: {
      getScriptLock: () => { let mine = false; return { tryLock: () => { if (locks.script) return false; locks.script = true; mine = true; return true; }, releaseLock: () => { if (mine) { locks.script = false; mine = false; } } }; },
      getDocumentLock: () => { let mine = false; return { tryLock: () => { if (locks.document || locks.documentBusy) return false; locks.document = true; mine = true; return true; }, releaseLock: () => { if (mine) { locks.document = false; mine = false; } } }; },
    },
    Utilities: {
      computeDigest: (a, t) => [...crypto.createHash('sha256').update(t, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
      formatDate: (d, tz, p) => (p === 'yyyy-MM-dd' ? new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) : d.toISOString()),
      parseDate: (s, tz, p) => (p === 'yyyy-MM-dd' ? zonedMidnight(s, tz) : new Date(s.replace(' ', 'T') + 'Z')),
      getUuid: () => 'uuid-' + String(++uuid).padStart(6, '0'),
    },
    Logger: { log: () => {} },
    Session: { getScriptTimeZone: () => 'America/New_York' },
    console,
  };
  return { MASTER, SRC, makeSheet, makeSS, globals, children, opened, locks, state };
}

/**
 * Builds the production-shaped Master, runs every normalizer, provisions CUS001 + CUS004 seller sheets and one full pipeline.
 * @return {Object} sim handle (see bottom)
 */
function buildMasterSim() {
  const M = makeMock();
  const ctx = vm.createContext({ ...M.globals });
  for (const f of fs.readdirSync(SRC_DIR).filter((x) => x.endsWith('.gs')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'), ctx, { filename: f });
  }
  const call = (expr) => vm.runInContext(expr, ctx);
  const mS = (n) => M.MASTER.sheets.find((s) => s.name === n);
  const src = (n) => M.SRC.sheets.find((s) => s.name === n);
  const D = (iso) => new Date(iso);
  const LA = (day) => D(day + 'T07:00:00Z');
  const makeDate = (ms) => vm.runInContext(`new Date(${ms})`, ctx);

  call('setupMaster()');
  // ---- provider source (KH001): 168 PayPal payments, 2 provider settlements
  const SELLERS = [['CUS001', 'DITECH', 43, 234073, 45], ['CUS002', 'HUI', 74, 370420, 69], ['CUS003', 'DINO', 4, 31313, 22], ['CUS004', 'VNS_1', 47, 384932, 52]];
  const TX = [];
  SELLERS.forEach(([sid, , n, cents]) => { const base = Math.floor(cents / n); for (let i = 0; i < n; i++) TX.push({ seller: sid, netC: i < n - 1 ? base : cents - base * (n - 1) }); });
  TX.sort((a, b) => ((TX.indexOf(a) * 7919) % 168) - ((TX.indexOf(b) * 7919) % 168));
  TX.forEach((t, i) => { t.id = '9X' + String(i).padStart(4, '0') + 'PP'; t.feeC = i < 167 ? 250 : 274; t.st = i < 94 ? 1 : 2; t.day = t.st === 1 ? '2026-10-02' : '2026-10-07'; });
  const c2 = (c) => c / 100;
  const PPH = ['Thời gian', 'Type', 'Status', 'Currency', 'Gross', 'Fee', 'Net', 'From Email Address', 'To Email Address', 'Transaction ID', 'Reference Txn ID',
    'Invoice Number', 'Balance Impact', 'Mã cổng', 'Nhóm GD', 'Txn gốc', 'Name'];
  const RCH = ['Transaction ID', 'Có trên KH', 'Có trên PP', 'Trạng thái', 'Mã cổng', 'Sub account', 'Thời gian GD', 'Số tiền KH', 'Gross PayPal', 'Chênh lệch',
    'Phí PayPal', 'Net', 'Lần chốt (ngày)', 'Doanh thu (Gross)', 'Phí thuê OP', 'Hold', 'Thực nhận (chưa gồm hoàn hold)'];
  const ppRows = [PPH];
  const rcRows = [...Array(5).fill(RCH.map(() => '')), RCH];
  const sums = { 1: { payout: 0, hold: 0 }, 2: { payout: 0, hold: 0 } };
  TX.forEach((t) => {
    const g = c2(t.netC + t.feeC); const f = c2(t.feeC); const n = c2(t.netC); const pf = n * 0.07; const h = n * 0.1; const pay = n - pf - h;
    const end = t.st === 1 ? LA('2026-10-04') : LA('2026-10-09');
    ppRows.push([LA(t.day), 'Express Checkout Payment', 'Completed', 'USD', g, -f, n, 'buyer@example.com', 's', t.id, '', 'INV', 'Credit', 'G', 'Thanh toán', t.id, 'Buyer Name']);
    rcRows.push([t.id, 1, 1, 'Khớp', 'G', 'S', LA(t.day), g, g, 0, f, n, end, g, pf, h, pay]);
    sums[t.st].payout += pay; sums[t.st].hold += h;
  });
  const HIST = ['Lần', 'Từ ngày', 'Đến ngày', 'Ngày thanh toán', 'Phát sinh phải trả', 'Còn nợ lần trước', 'Tổng phải trả', 'Đã thanh toán (USD)', 'Còn nợ',
    'Hold giữ lần này', 'Hold được hoàn lần này', 'Số dư hold', 'Hold lần này hoàn từ ngày', '… đến ngày', 'Hình thức / chứng từ', 'Tỷ giá lần này (VND/USD)', 'Đã thanh toán (VND)'];
  const W = HIST.length;
  const title = (x) => { const r = Array(W).fill(''); r[0] = x; return r; };
  const hrow = (no, from, to, pay, s, bal, paid) => {
    const r = { 'Lần': no, 'Từ ngày': LA(from), 'Đến ngày': LA(to), 'Ngày thanh toán': pay ? LA(pay) : '', 'Phát sinh phải trả': s.payout, 'Còn nợ lần trước': 0,
      'Tổng phải trả': s.payout, 'Đã thanh toán (USD)': paid, 'Còn nợ': s.payout - paid, 'Hold giữ lần này': s.hold, 'Hold được hoàn lần này': 0, 'Số dư hold': bal,
      'Hold lần này hoàn từ ngày': '', '… đến ngày': '', 'Hình thức / chứng từ': 'CK ' + no, 'Tỷ giá lần này (VND/USD)': 25300, 'Đã thanh toán (VND)': paid * 25300 };
    return HIST.map((x) => r[x]);
  };
  const pds = [title('PHIẾU'), title('D. LỊCH SỬ CHỐT & THANH TOÁN — CÔNG NỢ'), HIST, hrow(1, '2026-10-01', '2026-10-04', '2026-10-06', sums[1], sums[1].hold, sums[1].payout),
    hrow(2, '2026-10-05', '2026-10-09', '2026-10-10', sums[2], sums[1].hold + sums[2].hold, sums[2].payout)];
  src('RAW_PP').api.getRange(1, 1, ppRows.length, PPH.length).setValues(ppRows);
  src('DoiSoat_GD').api.getRange(1, 1, rcRows.length, RCH.length).setValues(rcRows);
  src('PhieuDoiSoat').api.getRange(1, 1, pds.length, W).setValues(pds);
  src('Dispute').api.getRange(1, 1, 1, 1).setValues([['C']]);
  // ---- Sellers + internal CSV evidence (168 matched + 188 internal-only orders)
  const scols = call('getColumnNames_("Sellers")');
  mS('Sellers').api.getRange(2, 1, 4, scols.length).setValues(SELLERS.map(([sid, name], i) => scols.map((c) => ({ seller_id: sid, seller_name: name, status: 'ACTIVE',
    effective_from: D('2026-10-01T04:00:00Z'), endpoint_1_name: 'Shop ' + (i + 1), endpoint_1_key: 'glk_cus' + (i + 1) })[c] ?? '')));
  const rcols = call('getColumnNames_("Raw Internal Transactions")');
  let rawN = 0;
  const mk = (o) => {
    const x = { order_id: '1', payment_method: 'pp', transaction_id: 'X', gateway: 'paypal', status: 'captured', total: '1.00', currency: 'USD', sub_account: 's',
      store_domain: 'd', shield_domain: 'sd', endpoint_token: '', created_at: '', refunded_at: '', customer: 'cust@example.com', settled_at: '', note: 'internal note',
      import_batch_id: 'IB-1', source_file_name: 'export.csv', source_row_number: 2 + rawN, imported_at: '2026-10-10T08:00:00Z', ...o };
    x.row_fingerprint = ctx.computeInternalRowFingerprint_(x);
    rawN++;
    return rcols.map((key) => x[key]);
  };
  const internal = TX.map((t, i) => mk({ order_id: String(100000 + i), transaction_id: t.id, total: c2(t.netC + t.feeC).toFixed(2), endpoint_token: 'glk_cus' + t.seller.slice(-1),
    store_domain: 'shop' + t.seller.slice(-1) + '.com', created_at: t.day + 'T15:00:00Z' }));
  let miss = 0;
  SELLERS.forEach(([sid, , , , m]) => { for (let i = 0; i < m; i++) { miss++; internal.push(mk({ order_id: String(200000 + miss), transaction_id: 'MP' + String(miss).padStart(4, '0'),
    total: (20 + i).toFixed(2), endpoint_token: 'glk_cus' + sid.slice(-1), store_domain: 'shop' + sid.slice(-1) + '.com', created_at: '2026-10-08T15:00:00Z' })); } });
  mS('Raw Internal Transactions').api.getRange(2, 1, internal.length, rcols.length).setValues(internal);
  const steps = ['syncKh001Raw()', 'normalizeKh001ProviderTransactions()', 'normalizeKh001Settlements()', 'publishSellerMapping()', 'setupMaster()',
    'normalizeInternalTransactions()', 'reconcilePayments()', 'normalizePaymentLegs()', 'normalizeSettlementItems()', 'normalizeSellerBalances()'];
  steps.forEach((s) => { const r = call(s); if (r && r.status && !['SUCCESS', 'NO_CHANGE'].includes(r.status)) throw new Error(s + ' ' + r.status + ' ' + (r.error || '')); });

  // ---- seller sheets for CUS001 + CUS004 (template fakes)
  const tpl = FK.makeSpreadsheet({ id: TEMPLATE_ID, makeDate });
  M.children[TEMPLATE_ID] = tpl;
  let copies = 0;
  ctx.DriveApp = {
    getFileById: () => ({ getName: () => 'T', getMimeType: () => 'application/vnd.google-apps.spreadsheet',
      makeCopy: () => { const nid = '1Copy' + String(++copies).padStart(35, '0'); M.children[nid] = FK.cloneSpreadsheet(tpl, nid, makeDate); return { getId: () => nid }; } }),
    getFolderById: (id) => ({ getId: () => id, getName: () => 'F' }),
  };
  const setSetting = (key, val) => { const a = mS('Settings').api; const keys = a.getRange(2, 1, a.getLastRow() - 1, 1).getValues().map((x) => x[0]); a.getRange(2 + keys.indexOf(key), 2).setValue(val); };
  setSetting('seller_template_spreadsheet_id', TEMPLATE_ID);
  setSetting('seller_output_folder_id', FOLDER_ID);
  const childOf = {};
  ['CUS001', 'CUS004'].forEach((id) => {
    const r = call(`createSellerSheet("${id}")`);
    if (r.status !== 'SUCCESS') throw new Error('createSellerSheet ' + id + ' ' + r.status + ' ' + r.error);
    childOf[id] = r.spreadsheet_id;
  });
  const first = call('runScheduledPaymentPipeline()');
  if (first.status !== 'SUCCESS') throw new Error('initial pipeline ' + first.status + ' ' + first.error);

  // ---- snapshot / restore (each test starts from the same production-shaped state)
  const cloneCells = (o) => Object.fromEntries(Object.entries(o).map(([key, v]) => [key, v instanceof Date ? new Date(v.getTime()) : v]));
  const snapSS = (ss) => ss.sheets.map((s) => ({ id: s.id, name: s.name, cells: cloneCells(s.cells), fmts: { ...s.fmts }, maxRows: s.maxRows, maxCols: s.maxCols,
    hidden: s.hidden, prots: s.prots.slice(), validation: s.validation ? { ...s.validation } : undefined }));
  const restoreSS = (ss, snap) => {
    ss.sheets = snap.map((x) => { const s = M.makeSheet(x.name, ss); Object.assign(s, { id: x.id, cells: cloneCells(x.cells), fmts: { ...x.fmts }, maxRows: x.maxRows,
      maxCols: x.maxCols, hidden: x.hidden, prots: x.prots.slice(), validation: x.validation ? { ...x.validation } : undefined }); return s; });
    ss.active = null; ss.activeRange = null;
  };
  const snapChildren = () => Object.fromEntries(Object.entries(M.children).map(([id, c]) => [id, c]));
  const saved = { master: snapSS(M.MASTER), src: snapSS(M.SRC), children: snapChildren() };
  const childSpec = Object.fromEntries(Object.entries(M.children).map(([id, c]) => [id, c]));

  const sim = {
    M, ctx, call, mS, makeDate, childOf, TEMPLATE_ID, MASTER_ID,
    restore() {
      restoreSS(M.MASTER, saved.master);
      restoreSS(M.SRC, saved.src);
      Object.keys(M.children).forEach((id) => { if (!childSpec[id]) delete M.children[id]; });
      Object.entries(childSpec).forEach(([id, c]) => { M.children[id] = FK.cloneSpreadsheet(saved.childSnaps[id], id, makeDate); });
      M.opened.length = 0;
      M.locks.script = false; M.locks.document = false; M.locks.documentBusy = false;
      M.state.providerDown = false;
    },
    child: (sellerId) => M.children[childOf[sellerId]],
    /** Table rows of a Master tab as objects. */
    rows(sheetName) {
      const s = mS(sheetName).api;
      const cols = call(`getColumnNames_(${JSON.stringify(sheetName)})`);
      const last = s.getLastRow();
      if (last < 2) return [];
      return s.getRange(2, 1, last - 1, cols.length).getValues().filter((r) => r.some((v) => v !== '')).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
    },
    audit() { return sim.rows('Audit Log'); },
    /** Sets one Operations form field (column B) by key. */
    setForm(values) {
      const s = mS('Operations').api;
      const fields = call('OPERATIONS.formFields.map(function (f) { return f[0]; })');
      Object.entries(values).forEach(([key, v]) => { s.getRange(call('OPERATIONS.formStartRow') + fields.indexOf(key), 2).setValue(v); });
    },
    formValue(key) {
      const fields = call('OPERATIONS.formFields.map(function (f) { return f[0]; })');
      return mS('Operations').api.getRange(call('OPERATIONS.formStartRow') + fields.indexOf(key), 2).getValue();
    },
    token: () => mS('Operations').api.getRange(call('OPERATIONS.tokenRow'), 2).getValue(),
    /** Selects the Operations payouts-table row of a payout id (or an arbitrary row). */
    selectPayout(payoutId, rowOverride) {
      const s = mS('Operations');
      const last = s.api.getLastRow();
      const colA = s.api.getRange(1, 1, last, 1).getValues().map((r) => r[0]);
      const row = rowOverride || colA.indexOf(payoutId) + 1;
      if (row < 1) throw new Error('payout ' + payoutId + ' not in Operations');
      M.MASTER.active = s.api;
      M.MASTER.activeRange = s.api.getRange(row, 1, 1, 12);
      return row;
    },
    balances() { return Object.fromEntries(sim.rows('Seller Balances').map((b) => [b.seller_id, b])); },
    states() { return call('verifySellerPayoutAllocations()').obligation_states; },
  };
  // child snapshots (template fakes: cell objects)
  saved.childSnaps = Object.fromEntries(Object.entries(M.children).map(([id, c]) => [id, { tz: c.tz, locale: c.locale,
    sheets: c.sheets.map((s) => ({ name: s.name, hidden: s.hidden, maxRows: s.maxRows, maxCols: s.maxCols, cells: Object.fromEntries(Object.entries(s.cells).map(([key, x]) => [key, { ...x }])) })) }]));
  sim.restore();
  return sim;
}

module.exports = { buildMasterSim, zonedMidnight };
