/**
 * SellerOutput.gs
 * Seller output contract v3 (v2 + allocation-aware PhieuDoiSoat section D): the seller child spreadsheet is a clone of the seller template
 * (VNS_SELLER_PAYMENT_TEMPLATE, the UI authority) with exactly four visible tabs - DoiSoat_GD,
 * TongHop_Thang, PhieuDoiSoat, Dispute - plus one hidden system tab, _Sync.
 *
 * - Payment Master computes every amount; the child only receives values in explicit OWNED ranges.
 *   Static titles, labels, headers and formatting belong to the template and are never rewritten.
 * - Layouts are discovered from the template's own labels / headers (anchors) and validated strictly;
 *   formulas are allowed only at the approved presentation locations (DoiSoat_GD summary COUNTIF row and
 *   SUBTOTAL row, Dispute summary row and "Số ngày còn lại" column). Anything else fails closed.
 * - Provider-agnostic: one seller reconciliation across payment sources; seller fee rates come from the
 *   frozen Payment Leg snapshots (Seller Terms by seller + payment_source + effective date).
 * - No provider trace = no provider economics; MATCHED != AVAILABLE; unknown economics are never estimated.
 * - PhieuDoiSoat section D is allocation-aware: settlement rows (due = frozen Settlement Items of the seller) and
 *   positive APPLIED adjustment rows (due = amount) show effective allocations as paid, the remaining amount and a
 *   label "<source> #<n> · UNPAID|PARTIAL|PAID" / "<adjustment_type> · ...". Negative adjustments stay plain debit
 *   rows. Payout rows still show the actual money movement; allocations never move the running balance.
 *
 * Everything in this file is pure (unit-tested in Node); I/O lives in SellerSheets.gs.
 */

const SELLER_OUTPUT = Object.freeze({
  schemaVersion: 3,
  checksumVersion: 'seller-output-v3',
  syncTab: '_Sync',
  visibleTabs: Object.freeze(['DoiSoat_GD', 'TongHop_Thang', 'PhieuDoiSoat', 'Dispute']),
  legacyTabs: Object.freeze(['Summary', 'Transactions', 'Settlements', 'Payouts', 'Adjustments', 'Sync Info']),
  rawTabs: Object.freeze(['RAW_KH', 'RAW_PP']),
  forbiddenFormulaPattern: /RAW_KH|RAW_PP|IMPORTRANGE|IMPORTDATA|IMPORTXML|IMPORTHTML|IMPORTFEED|!/i,
  credentialPattern: /glk_[A-Za-z0-9_-]+/,
  emailPattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  // Internal / provider-economics names that must never appear as seller-visible text.
  forbiddenTerms: Object.freeze(['provider_fee', 'provider_hold', 'system_margin', 'endpoint_token', 'endpoint_key', 'payer_reference']),
  currency: 'USD',
  statusLabels: Object.freeze({ MATCHED: 'Khớp', AMOUNT_MISMATCH: 'Lệch số tiền', MISSING_PROVIDER: 'Thiếu trên cổng',
    MISSING_INTERNAL: 'Thiếu trên hệ thống' }),
  syncKeys: Object.freeze(['output_schema_version', 'seller_id', 'seller_name', 'master_schema_version', 'synced_at', 'DoiSoat_GD_checksum',
    'TongHop_Thang_checksum', 'PhieuDoiSoat_checksum', 'Dispute_checksum', 'combined_checksum']),
  maxReportedErrors: 30,
});

/** Template anchors (exact text from VNS_SELLER_PAYMENT_TEMPLATE). */
const SELLER_TEMPLATE = Object.freeze({
  doiSoatHeaders: ['Transaction ID', 'Có trên hệ thống', 'Có trên cổng', 'Trạng thái', 'Cổng thanh toán', 'Sub account', 'Thời gian GD', 'Số tiền đơn', 'Gross cổng', 'Chênh lệch', 'Refund / Dispute', 'Tỷ lệ VNS', 'Doanh thu (Gross)', 'Phí cổng', 'Net', 'Phí VNS', 'Hold', 'Lần chốt (ngày)', 'Ngày VNS nhận tiền', 'Trạng thái chốt', 'Thực nhận'],
  doiSoatSummaryLabels: ['Khớp', 'Lệch số tiền', 'Thiếu trên cổng', 'Thiếu trên hệ thống'],
  doiSoatSubtotalColumns: ['H', 'I', 'J', 'K', 'M', 'N', 'O', 'P', 'Q', 'U'],
  tongHopHeaders: ['Tháng', 'Tháng hợp tác thứ', 'Số cổng đã dùng', 'Số GD', 'Doanh thu (Gross)', 'Phí cổng', 'Net', 'Phí VNS', 'Hold phát sinh', 'Hold đã hoàn', 'Số dư hold cuối tháng', 'Available seller', 'Số dispute', 'Tỷ lệ dispute', 'Đã payout seller', 'Điều chỉnh', 'Balance còn lại', 'Tổng nghĩa vụ', 'Ghi nhận vào lần chốt', 'Ghi chú'],
  tongHopFooterPrefix: 'Logic:',
  phieuInfoLabels: ['Seller', 'Từ ngày', 'Đến hết ngày', 'Chưa đối soát / chưa tính'],
  phieuHoldLabel: 'Hold đang giữ',
  phieuTitleA: 'A. DOANH THU THEO CỔNG',
  phieuHeadersA: ['Cổng thanh toán', 'Số GD', 'Doanh thu (Gross)', 'Phí cổng', 'Net', 'Tỷ lệ VNS', 'Phí VNS', 'Hold', 'Thực nhận'],
  phieuTotalLabel: 'Cộng',
  phieuTitleB: 'B. CHỐT CÔNG NỢ',
  phieuLabelsB: ['Doanh thu (Gross)', '(−) Phí cổng', '(−) Phí VNS', '(−) Hold giữ lại (actual)', '(+) Hold đã hoàn', '(−) Refund / Dispute đã áp dụng', '(±) Điều chỉnh', '(+) Còn nợ lần trước chuyển sang', 'TỔNG PHẢI TRẢ (USD)', '(−) Đã payout seller', 'CÒN NỢ SAU THANH TOÁN (USD)', 'Tỷ giá payout', 'Quy đổi payout', 'Số dư hold VNS đang giữ'],
  phieuTitleC: 'C. TÌNH TRẠNG ĐỐI SOÁT',
  phieuHeadersC: ['Trạng thái', 'Số GD', 'Số tiền theo hệ thống'],
  phieuLabelsC: ['Khớp — Đã tính', 'Lệch số tiền', 'Thiếu trên cổng — Chưa tính — chờ xác minh', 'Thiếu trên hệ thống'],
  phieuCheckPrefix: 'Kiểm tra',
  phieuTitleD: 'D. LỊCH SỬ CHỐT',
  phieuHeadersD: ['Lần', 'Từ ngày', 'Đến ngày', 'Ngày VNS nhận tiền', 'Phát sinh phải trả', 'Còn nợ lần trước', 'Tổng phải trả', 'Đã payout seller (USD)', 'Còn nợ', 'Hold giữ lần này', 'Hold được hoàn lần này', 'Số dư hold', 'Hold dự kiến release từ', '… đến ngày', 'Hình thức / chứng từ', 'Tỷ giá', 'Đã payout quy đổi'],
  phieuPendingPrefix: 'Phát sinh sau lần chốt cuối',
  phieuStartLabel: 'Ngày bắt đầu hợp tác',
  disputeHeaders: ['Case type', 'Case ID', 'Transaction ID', 'Cổng thanh toán', 'Order ID', 'Case reason', 'Ngày mở case', 'Case status', 'Hạn phản hồi', 'Số tiền dispute', 'Currency', 'Dispute fee', 'Ảnh hưởng balance', 'Số ngày còn lại', 'Chứng từ yêu cầu', 'Link docs kháng', 'Trạng thái hồ sơ', 'Ghi chú'],
  disputeDocsDone: 'Đã nộp docs',
  disputeDocsAppeal: 'Đang kháng',
  disputeDocsWaiting: 'Chờ seller nộp docs',
});

/** Current production regression (report only): seller summaries after Phase 2J; CUS002 / HUI in detail. */
const SELLER_SHEETS_REGRESSION = Object.freeze({
  snapshot: 'Production after Phase 2J (356 Transactions, 168 AVAILABLE PAYPAL legs, no payouts/adjustments)',
  sellers: {
    CUS001: { total_transactions: 88, matched_transactions: 43, missing_provider_transactions: 45, current_balance: 1919.3986,
      seller_hold: 234.073, known_obligation: 2153.4716 },
    CUS002: { total_transactions: 143, matched_transactions: 74, missing_provider_transactions: 69, total_order_amount: 7362.27,
      matched_gross: 3860.51, processing_fee: 156.31, net: 3704.2, seller_fee: 296.336, seller_hold: 370.42, current_balance: 3037.444,
      known_obligation: 3407.864, missing_provider_order_amount: 3501.76 },
    CUS003: { total_transactions: 26, matched_transactions: 4, missing_provider_transactions: 22, current_balance: 256.7666,
      seller_hold: 31.313, known_obligation: 288.0796 },
    CUS004: { total_transactions: 99, matched_transactions: 47, missing_provider_transactions: 52, current_balance: 3156.4424,
      seller_hold: 384.932, known_obligation: 3541.3744 },
  },
  seller_fee_rates: { CUS002: { PAYPAL: [0.08] } },
});

/* ------------------------------ Grid helpers ------------------------------ */

function sellerText_(v) {
  return isBlankCell_(v) ? '' : String(v).normalize('NFC').trim();
}

function gridCell_(grid, r, c) {
  const row = grid[r - 1];
  return row && row[c - 1] !== undefined && row[c - 1] !== null ? row[c - 1] : '';
}

function columnIndex_(letter) {
  return letter.split('').reduce(function (n, ch) { return n * 26 + ch.charCodeAt(0) - 64; }, 0);
}

/** Formula text normalized for comparison (spaces removed, locale ';' separators as ',', upper case, NFC). */
function normalizeFormula_(f) {
  return String(f).normalize('NFC').replace(/\s+/g, '').replace(/;/g, ',').toUpperCase();
}

function findRows_(grid, col, predicate, from) {
  const rows = [];
  for (let r = from || 1; r <= grid.length; r++) if (predicate(sellerText_(gridCell_(grid, r, col)))) rows.push(r);
  return rows;
}

function rowMatches_(grid, r, startCol, labels) {
  return labels.every(function (l, i) { return sellerText_(gridCell_(grid, r, startCol + i)) === l.normalize('NFC'); });
}

/**
 * Date-only value anchored at 12:00 UTC of the Master calendar day, to avoid date drift in the supported
 * seller-template time zones (not a general time zone conversion).
 */
function sellerDateOnly_(value, dateKeyOf) {
  if (isBlankCell_(value)) return '';
  const key = dateKeyOf(value);
  return key ? new Date(key + 'T12:00:00Z') : '';
}

/**
 * Provider-aware settlement label for PhieuDoiSoat section D, e.g. "PAYPAL #1 · PAID" (sources can share numbers;
 * the status is the derived allocation state of this seller's share).
 */
function sellerSettlementLabel_(settlement, status) {
  return trimmedText_(settlement.payment_source) + ' #' + trimmedText_(settlement.source_settlement_number) + (status ? ' · ' + status : '');
}

function micro_(v) {
  return isFiniteNumber_(v) ? Math.round(v * 1e6) : 0;
}

/* ------------------------- Template layout discovery ------------------------- */

/**
 * Locates the owned ranges and approved formulas of one visible tab from its anchors.
 * @param {string} tab
 * @param {Array<Array<*>>} values
 * @param {Array<Array<string>>} formulas
 * @return {{layout: ?Object, errors: Array<string>}} layout.approved maps 'r,c' -> normalized formula
 */
function locateSellerTabLayout_(tab, values, formulas) {
  const T_ = SELLER_TEMPLATE;
  const errors = [];
  const fail = function (msg) { errors.push(tab + ': ' + msg); return { layout: null, errors: errors }; };
  const one = function (rows, what) {
    if (rows.length !== 1) { errors.push(tab + ': expected exactly one ' + what + ', found ' + rows.length); return 0; }
    return rows[0];
  };
  const approved = {};
  if (tab === 'DoiSoat_GD') {
    const h = one(findRows_(values, 1, function (t) { return t === T_.doiSoatHeaders[0]; }), 'header row "' + T_.doiSoatHeaders[0] + '"');
    if (!h) return { layout: null, errors: errors };
    if (!rowMatches_(values, h, 1, T_.doiSoatHeaders)) return fail('header row ' + h + ' does not match the template contract');
    const ds = h + 1;
    const summary = h - 3;
    const subtotal = h - 2;
    if (summary < 1) return fail('summary rows above the header are missing');
    const m = /^=SUBTOTAL\(9,H(\d+):H(\d+)\)$/.exec(normalizeFormula_(gridCell_(formulas, subtotal, 8)));
    if (!m || Number(m[1]) !== ds) return fail('SUBTOTAL anchor in H' + subtotal + ' is missing');
    const end = Number(m[2]);
    if (end < ds) return fail('data capacity is empty');
    T_.doiSoatSummaryLabels.forEach(function (label, i) {
      const col = 2 + 2 * i;
      if (sellerText_(gridCell_(values, summary, col)) !== label.normalize('NFC')) errors.push(tab + ': summary label missing at row ' + summary);
      approved[summary + ',' + (col + 1)] = normalizeFormula_('=COUNTIF($D$' + ds + ':$D$' + end + ',"' + label + '")');
    });
    T_.doiSoatSubtotalColumns.forEach(function (L) {
      approved[subtotal + ',' + columnIndex_(L)] = normalizeFormula_('=SUBTOTAL(9,' + L + ds + ':' + L + end + ')');
    });
    return { layout: { tab: tab, headerRow: h, dataStart: ds, dataEnd: end, width: T_.doiSoatHeaders.length, approved: approved },
      errors: errors };
  }
  if (tab === 'TongHop_Thang') {
    const h = one(findRows_(values, 1, function (t) { return t === T_.tongHopHeaders[0]; }), 'header row "' + T_.tongHopHeaders[0] + '"');
    if (!h) return { layout: null, errors: errors };
    if (!rowMatches_(values, h, 1, T_.tongHopHeaders)) return fail('header row ' + h + ' does not match the template contract');
    const footer = findRows_(values, 1, function (t) { return t.indexOf(T_.tongHopFooterPrefix) === 0; }, h + 1)[0];
    if (!footer || footer < h + 2) return fail('footer note "' + T_.tongHopFooterPrefix + '" below the data rows is missing');
    return { layout: { tab: tab, headerRow: h, dataStart: h + 1, dataEnd: footer - 1, footerRow: footer, width: T_.tongHopHeaders.length,
      approved: approved }, errors: errors };
  }
  if (tab === 'PhieuDoiSoat') {
    const at = function (label, from) { return findRows_(values, 1, function (t) { return t === label.normalize('NFC'); }, from); };
    const prefixed = function (prefix, from) { return findRows_(values, 1, function (t) { return t.indexOf(prefix.normalize('NFC')) === 0; }, from); };
    const L = {};
    ['seller', 'from', 'to', 'pending'].forEach(function (k, i) { L[k] = one(at(T_.phieuInfoLabels[i]), 'label "' + T_.phieuInfoLabels[i] + '"'); });
    L.titleA = one(prefixed(T_.phieuTitleA), 'section "' + T_.phieuTitleA + '"');
    L.titleB = one(prefixed(T_.phieuTitleB), 'section "' + T_.phieuTitleB + '"');
    L.titleC = one(prefixed(T_.phieuTitleC), 'section "' + T_.phieuTitleC + '"');
    L.titleD = one(prefixed(T_.phieuTitleD), 'section "' + T_.phieuTitleD + '"');
    if (errors.length > 0) return { layout: null, errors: errors };
    if (!(L.seller < L.from && L.from < L.to && L.to < L.pending && L.pending < L.titleA && L.titleA < L.titleB && L.titleB < L.titleC &&
      L.titleC < L.titleD)) return fail('sections are not in the template order');
    if (sellerText_(gridCell_(values, L.pending, 4)) !== T_.phieuHoldLabel.normalize('NFC')) return fail('"' + T_.phieuHoldLabel + '" label missing');
    L.headerA = L.titleA + 1;
    if (!rowMatches_(values, L.headerA, 1, T_.phieuHeadersA)) return fail('section A header does not match');
    L.totalRow = at(T_.phieuTotalLabel, L.headerA + 1).filter(function (r) { return r < L.titleB; })[0];
    if (!L.totalRow || L.totalRow < L.headerA + 2) return fail('section A "' + T_.phieuTotalLabel + '" row is missing');
    L.srcStart = L.headerA + 1;
    L.srcEnd = L.totalRow - 1;
    L.bRows = T_.phieuLabelsB.map(function (label, i) { return L.titleB + 1 + i; });
    if (!T_.phieuLabelsB.every(function (label, i) { return sellerText_(gridCell_(values, L.bRows[i], 1)) === label.normalize('NFC'); })) {
      return fail('section B labels do not match');
    }
    if (L.bRows[L.bRows.length - 1] >= L.titleC) return fail('section B overlaps section C');
    L.headerC = L.titleC + 1;
    if (!rowMatches_(values, L.headerC, 1, T_.phieuHeadersC)) return fail('section C header does not match');
    L.cRows = T_.phieuLabelsC.map(function (label, i) { return L.headerC + 1 + i; });
    if (!T_.phieuLabelsC.every(function (label, i) { return sellerText_(gridCell_(values, L.cRows[i], 1)) === label.normalize('NFC'); })) {
      return fail('section C labels do not match');
    }
    L.checkRow = L.cRows[L.cRows.length - 1] + 1;
    if (sellerText_(gridCell_(values, L.checkRow, 1)).indexOf(T_.phieuCheckPrefix.normalize('NFC')) !== 0) return fail('section C check row is missing');
    L.headerD = findRows_(values, 1, function (t) { return t === T_.phieuHeadersD[0]; }, L.titleD + 1)[0];
    if (!L.headerD || !rowMatches_(values, L.headerD, 1, T_.phieuHeadersD)) return fail('section D header does not match');
    L.pendRow = one(prefixed(T_.phieuPendingPrefix, L.headerD + 1), 'row "' + T_.phieuPendingPrefix + '"');
    L.startRow = one(at(T_.phieuStartLabel, L.titleD), 'label "' + T_.phieuStartLabel + '"');
    if (!L.pendRow || !L.startRow) return { layout: null, errors: errors };
    if (L.pendRow < L.headerD + 2 || L.startRow < L.pendRow) return fail('section D rows are not in the template order');
    L.histStart = L.headerD + 1;
    L.histEnd = L.pendRow - 1;
    L.tab = tab;
    L.approved = approved;
    return { layout: L, errors: errors };
  }
  if (tab === 'Dispute') {
    const h = one(findRows_(values, 1, function (t) { return t === T_.disputeHeaders[0]; }), 'header row "' + T_.disputeHeaders[0] + '"');
    if (!h) return { layout: null, errors: errors };
    if (!rowMatches_(values, h, 1, T_.disputeHeaders)) return fail('header row ' + h + ' does not match the template contract');
    const ds = h + 1;
    const summary = h - 4;
    if (summary < 1) return fail('summary row above the header is missing');
    const m = /^=COUNTA\(B(\d+):B(\d+)\)$/.exec(normalizeFormula_(gridCell_(formulas, summary, 2)));
    if (!m || Number(m[1]) !== ds) return fail('COUNTA anchor in B' + summary + ' is missing');
    const end = Number(m[2]);
    const r = function (L) { return L + ds + ':' + L + end; };
    approved[summary + ',2'] = normalizeFormula_('=COUNTA(' + r('B') + ')');
    approved[summary + ',4'] = normalizeFormula_('=SUM(' + r('J') + ')');
    approved[summary + ',6'] = normalizeFormula_('=COUNTIF(' + r('Q') + ',"' + T_.disputeDocsDone + '")+COUNTIF(' + r('Q') + ',"' + T_.disputeDocsAppeal + '")');
    approved[summary + ',8'] = normalizeFormula_('=COUNTIF(' + r('Q') + ',"' + T_.disputeDocsWaiting + '")');
    approved[summary + ',10'] = normalizeFormula_('=COUNTIFS(' + r('N') + ',"<=4",' + r('B') + ',"<>")');
    for (let row = ds; row <= end; row++) {
      approved[row + ',14'] = normalizeFormula_('=IF(OR(B' + row + '="",I' + row + '=""),"",MAX(0,INT(I' + row + '-TODAY())))');
    }
    return { layout: { tab: tab, headerRow: h, dataStart: ds, dataEnd: end, width: T_.disputeHeaders.length, dayColumn: 14, approved: approved },
      errors: errors };
  }
  return fail('not a seller output tab');
}

/**
 * Validates a seller template (mode 'template') or a generated child (mode 'child').
 * @param {{sheets: Array<{name: string, hidden: boolean, values: Array<Array<*>>, formulas: Array<Array<string>>}>}} wb
 * @param {{mode: string, requireSync?: boolean, hiddenIds?: Array<string>}} opts
 * @return {{layouts: Object<string, Object>, errors: Array<string>}}
 */
function validateSellerWorkbook_(wb, opts) {
  const errors = [];
  const layouts = {};
  const hiddenIds = (opts.hiddenIds || []).map(function (x) { return String(x).trim(); }).filter(function (x) { return x !== ''; });
  const byName = {};
  wb.sheets.forEach(function (s) { byName[s.name] = s; });
  SELLER_OUTPUT.visibleTabs.forEach(function (t) {
    if (!byName[t]) errors.push('required tab "' + t + '" is missing');
    else if (byName[t].hidden) errors.push('tab "' + t + '" must be visible');
  });
  wb.sheets.forEach(function (s) {
    if (SELLER_OUTPUT.visibleTabs.indexOf(s.name) >= 0) return;
    if (s.name === SELLER_OUTPUT.syncTab && opts.mode === 'child') {
      if (!s.hidden) errors.push('system tab "' + SELLER_OUTPUT.syncTab + '" must be hidden');
      return;
    }
    const why = SELLER_OUTPUT.legacyTabs.indexOf(s.name) >= 0 ? ' (old Phase 2K tab)' : SELLER_OUTPUT.rawTabs.indexOf(s.name) >= 0 ? ' (provider raw tab)' : '';
    errors.push('unexpected ' + (s.hidden ? 'hidden' : 'visible') + ' tab "' + s.name + '"' + why + '; it is never deleted automatically');
  });
  if (opts.requireSync && !byName[SELLER_OUTPUT.syncTab]) errors.push('system tab "' + SELLER_OUTPUT.syncTab + '" is missing');
  wb.sheets.forEach(function (s) {
    const isOutput = SELLER_OUTPUT.visibleTabs.indexOf(s.name) >= 0;
    if (!isOutput && s.name !== SELLER_OUTPUT.syncTab) return;
    let located = { layout: null, errors: [] };
    if (isOutput) {
      located = locateSellerTabLayout_(s.name, s.values, s.formulas || []);
      located.errors.forEach(function (e) { errors.push(e); });
      if (located.layout) layouts[s.name] = located.layout;
    }
    const approved = located.layout ? located.layout.approved : {};
    const seen = {};
    (s.formulas || []).forEach(function (row, r) {
      row.forEach(function (f, c) {
        if (isBlankCell_(f) || f === '') return;
        const key = (r + 1) + ',' + (c + 1);
        const nf = normalizeFormula_(f);
        if (SELLER_OUTPUT.forbiddenFormulaPattern.test(f) || SELLER_OUTPUT.credentialPattern.test(f) ||
            hiddenIds.some(function (id) { return f.indexOf(id) >= 0; })) {
          errors.push(s.name + ': forbidden reference in formula at R' + (r + 1) + 'C' + (c + 1));
        } else if (approved[key] !== nf) {
          errors.push(s.name + ': unexpected formula at R' + (r + 1) + 'C' + (c + 1) + ' (only approved presentation formulas are allowed)');
        }
        seen[key] = true;
      });
    });
    Object.keys(approved).forEach(function (key) {
      if (!seen[key]) errors.push(s.name + ': approved presentation formula missing at R' + key.replace(',', 'C'));
    });
    s.values.forEach(function (row, r) {
      row.forEach(function (v, c) {
        if (typeof v !== 'string' || v === '') return;
        const where = s.name + ' R' + (r + 1) + 'C' + (c + 1);
        if (SELLER_OUTPUT.credentialPattern.test(v)) errors.push(where + ': endpoint token or credential');
        if (hiddenIds.some(function (id) { return v.indexOf(id) >= 0; })) errors.push(where + ': protected spreadsheet ID');
        if (SELLER_OUTPUT.emailPattern.test(v)) errors.push(where + ': e-mail address (customer data is never published)');
        if (SELLER_OUTPUT.forbiddenTerms.some(function (t) { return v.toLowerCase().indexOf(t) >= 0; })) errors.push(where + ': internal field name');
      });
    });
  });
  return { layouts: layouts, errors: errors.slice(0, 200) };
}

/* ------------------------------ Seller model ------------------------------ */

const SELLER_PHIEU_BLOCKS = Object.freeze(['info', 'sources', 'total', 'b', 'c', 'check', 'history', 'pending', 'start']);

/**
 * Builds the seller output (all four tabs as owned-range blocks) for every requested seller.
 * @param {{sellers: Array<{seller_id: string, seller_name: string}>, transactions: Array<Object>, matches: Array<Object>,
 *          legs: Array<Object>, settlements: Array<Object>, balances: Array<Object>, payouts: Array<Object>,
 *          adjustments: Array<Object>, disputes: Array<Object>, sellerTerms: Array<Object>, settlementItems: Array<Object>,
 *          allocations: Array<Object>, masterSchemaVersion: number, dateKeyOf: function(*): string, digestHex?: Function}} input
 * @return {{snapshots: Object<string, Object>, errors: Array<string>}}
 */
function buildSellerOutputs_(input) {
  const errors = [];
  const keyOf = function (source, id) { return String(source) + '|' + String(id); };
  const dk = input.dateKeyOf;
  const dateOnly = function (v) { return sellerDateOnly_(v, dk); };
  const matchByTx = {};
  input.matches.forEach(function (m) {
    if (trimmedText_(m.internal_transaction_id) === '') return;
    const k = keyOf(m.payment_source, m.internal_transaction_id);
    if (matchByTx[k]) errors.push('Payment Matches has internal transaction ' + k + ' twice');
    matchByTx[k] = m;
  });
  const legByMatch = {};
  input.legs.forEach(function (l) {
    if (legByMatch[String(l.match_id)]) errors.push('Payment Legs has match_id ' + l.match_id + ' twice');
    legByMatch[String(l.match_id)] = l;
  });
  const settlementById = {};
  input.settlements.forEach(function (s) { settlementById[String(s.settlement_id)] = s; });
  const counted = SELLER_BALANCES.countedPayoutStatuses;
  const applied = SELLER_BALANCES.countedAdjustmentStatus;
  const snapshots = {};
  // Settlement obligations / payment states: frozen Settlement Items + effective allocations (fail closed on any error).
  const allocation = validateSellerPayoutAllocations_({ allocations: input.allocations || [], payouts: input.payouts, items: input.settlementItems || [],
    settlements: input.settlements, adjustments: input.adjustments, digestHex: input.digestHex });
  flattenAllocationErrors_(allocation.errors).forEach(function (e) { errors.push('Seller Payout Allocations: ' + e); });

  input.sellers.forEach(function (seller) {
    const sellerId = seller.seller_id;
    const own = function (row) { return trimmedText_(row.seller_id) === sellerId; };
    const label = function (msg) { errors.push(sellerId + ': ' + msg); };
    const txs = [];
    input.transactions.filter(own).forEach(function (t) {
      const m = matchByTx[keyOf(t.payment_source, t.internal_transaction_id)];
      if (!m) { label('Transaction ' + t.internal_transaction_id + ' has no Payment Matches row'); return; }
      const status = trimmedText_(m.reconciliation_status);
      const leg = status === 'MATCHED' ? legByMatch[String(m.match_id)] || null : null;
      if (leg && (String(leg.internal_transaction_id) !== String(t.internal_transaction_id) || String(leg.payment_source) !== String(t.payment_source))) {
        label('Payment Leg ' + leg.payment_leg_id + ' belongs to another transaction');
        return;
      }
      const settlement = leg && trimmedText_(leg.settlement_id) !== '' ? settlementById[String(leg.settlement_id)] : null;
      if (leg && trimmedText_(leg.settlement_id) !== '' && !settlement) { label('settlement ' + leg.settlement_id + ' not found'); return; }
      if (trimmedText_(t.currency) !== SELLER_OUTPUT.currency || (leg && trimmedText_(leg.currency) !== SELLER_OUTPUT.currency)) {
        label('Transaction ' + t.internal_transaction_id + ' is not ' + SELLER_OUTPUT.currency + ' (seller output supports ' + SELLER_OUTPUT.currency + ' only)');
        return;
      }
      if (!SELLER_OUTPUT.statusLabels[status] || status === 'MISSING_INTERNAL') { label('Transaction ' + t.internal_transaction_id + ' has status ' + status); return; }
      txs.push({ t: t, m: m, status: status, leg: leg, settlement: settlement, dateKey: dk(t.created_at),
        known: !!leg && isFiniteNumber_(leg.seller_available_amount) });
    });
    txs.sort(function (a, b) {
      return compareCanonicalValues_(a.t.created_at, b.t.created_at) ||
        compareCanonicalValues_(String(a.t.internal_transaction_id), String(b.t.internal_transaction_id));
    });
    const legs = txs.filter(function (x) { return x.leg; });
    const available = legs.filter(function (x) { return trimmedText_(x.leg.settlement_status) === 'AVAILABLE'; });
    const pendingKnown = legs.filter(function (x) { return trimmedText_(x.leg.settlement_status) !== 'AVAILABLE'; });
    const sumLegs = function (list, f) { return list.reduce(function (a, x) { return a + micro_(x.leg[f]); }, 0); };
    const txIds = {};
    txs.forEach(function (x) { txIds[String(x.t.internal_transaction_id)] = x; });

    const adjustments = input.adjustments.filter(own).filter(function (a) { return trimmedText_(a.status) === applied; });
    const payouts = input.payouts.filter(own).filter(function (p) { return counted.indexOf(trimmedText_(p.status)) >= 0; });
    adjustments.concat(payouts).forEach(function (x) {
      if (trimmedText_(x.currency) !== SELLER_OUTPUT.currency) label('Adjustment/Payout ' + (x.adjustment_id || x.seller_payout_id) + ' is not ' + SELLER_OUTPUT.currency);
    });
    adjustments.forEach(function (a) { if (isBlankCell_(a.effective_date)) label('APPLIED adjustment ' + a.adjustment_id + ' has no effective_date'); });
    payouts.forEach(function (p) { if (isBlankCell_(p.payout_date)) label('Seller Payout ' + p.seller_payout_id + ' has no payout_date'); });
    const balances = input.balances.filter(own);
    balances.forEach(function (b) { if (trimmedText_(b.currency) !== SELLER_OUTPUT.currency) label('Seller Balances currency ' + b.currency + ' is not supported'); });
    const bal = balances.filter(function (b) { return trimmedText_(b.currency) === SELLER_OUTPUT.currency; })[0] || {};
    const currentBalance = micro_(bal.current_balance);
    const holdBalance = micro_(bal.seller_hold_balance);
    const adjOfType = function (types) { return adjustments.filter(function (a) { return types.indexOf(trimmedText_(a.adjustment_type)) >= 0; }); };
    const sumOf = function (list, f) { return list.reduce(function (a, x) { return a + micro_(x[f]); }, 0); };
    const holdReleases = adjOfType(['HOLD_RELEASE']);
    const refundDispute = adjOfType(['REFUND', 'DISPUTE', 'DISPUTE_FEE']);
    const manual = adjOfType(['MANUAL_ADJUSTMENT']);
    const disputes = input.disputes.filter(own).filter(function (d) {
      return trimmedText_(d.internal_transaction_id) === '' || !!txIds[String(d.internal_transaction_id)];
    });
    const terms = (input.sellerTerms || []).filter(function (t) { return t.seller_id === sellerId; });
    const startKey = terms.map(function (t) { return t.effective_from; }).sort()[0] || '';

    // ---- DoiSoat_GD
    const refundByTx = {};
    refundDispute.forEach(function (a) {
      const k = String(a.internal_transaction_id);
      if (txIds[k]) refundByTx[k] = (refundByTx[k] || 0) + micro_(a.amount);
    });
    const doiSoat = txs.map(function (x) {
      const t = x.t;
      const m = x.m;
      const l = x.leg;
      const s = x.settlement;
      const provider = x.status === 'MATCHED' || x.status === 'AMOUNT_MISMATCH';
      const providerGross = l ? l.gross_amount : (provider && isFiniteNumber_(m.provider_gross_amount) ? m.provider_gross_amount : '');
      return [t.internal_transaction_id, 1, provider ? 1 : 0, SELLER_OUTPUT.statusLabels[x.status], t.payment_source, t.sub_account, t.created_at,
        t.order_amount, providerGross, provider && isFiniteNumber_(m.amount_difference) ? m.amount_difference : '',
        refundByTx[String(t.internal_transaction_id)] !== undefined ? refundByTx[String(t.internal_transaction_id)] / 1e6 : '',
        l ? l.seller_fee_rate : '', l ? l.gross_amount : '', l ? l.processing_fee : '', l ? l.net_amount : '', l ? l.seller_fee : '',
        l ? l.seller_hold_amount : '', s ? dateOnly(s.period_end_date) : '', s ? dateOnly(s.source_payment_date) : '', l ? l.settlement_status : '',
        l ? l.seller_available_amount : ''].map(function (v) { return v === null || v === undefined ? '' : v; });
    });

    // ---- TongHop_Thang (months: transactions by created date; availability / holds by provider payment date)
    const monthOf = function (key) { return key ? key.slice(0, 7) : ''; };
    const payKey = function (x) { return x.settlement ? dk(x.settlement.source_payment_date) : ''; };
    const months = {};
    const touch = function (k) { if (k) months[k] = true; };
    txs.forEach(function (x) { touch(monthOf(x.dateKey)); });
    available.forEach(function (x) { touch(monthOf(payKey(x))); });
    adjustments.forEach(function (a) { touch(monthOf(dk(a.effective_date))); });
    payouts.forEach(function (p) { touch(monthOf(dk(p.payout_date))); });
    disputes.forEach(function (d) { touch(monthOf(dk(d.opened_at))); });
    const monthList = Object.keys(months).sort();
    const monthIndex = function (m) {
      if (!startKey || m < monthOf(startKey)) return '';
      return (Number(m.slice(0, 4)) - Number(startKey.slice(0, 4))) * 12 + Number(m.slice(5, 7)) - Number(startKey.slice(5, 7)) + 1;
    };
    let cumBalance = 0;
    let cumHold = 0;
    const tongHop = monthList.map(function (m) {
      const inMonth = txs.filter(function (x) { return monthOf(x.dateKey) === m; });
      const legsM = inMonth.filter(function (x) { return x.leg; });
      const availM = available.filter(function (x) { return monthOf(payKey(x)) === m; });
      const relM = holdReleases.filter(function (a) { return monthOf(dk(a.effective_date)) === m; });
      const adjM = adjustments.filter(function (a) { return monthOf(dk(a.effective_date)) === m && trimmedText_(a.adjustment_type) !== 'HOLD_RELEASE'; });
      const payM = payouts.filter(function (p) { return monthOf(dk(p.payout_date)) === m; });
      const dispM = disputes.filter(function (d) { return monthOf(dk(d.opened_at)) === m; }).length;
      const availableM = sumLegs(availM, 'seller_available_amount');
      const released = sumOf(relM, 'amount');
      cumHold += sumLegs(availM, 'seller_hold_amount') - released;
      cumBalance += availableM + released + sumOf(adjM, 'amount') - sumOf(payM, 'amount');
      const pendingToDate = pendingKnown.filter(function (x) { return monthOf(x.dateKey) <= m; });
      const obligation = cumBalance + cumHold + sumLegs(pendingToDate, 'seller_available_amount') + sumLegs(pendingToDate, 'seller_hold_amount');
      const settledDates = legsM.filter(function (x) { return x.settlement; }).map(function (x) { return dk(x.settlement.period_end_date); }).sort();
      const sources = {};
      inMonth.forEach(function (x) { sources[String(x.t.payment_source)] = true; });
      const unknown = inMonth.filter(function (x) { return !x.known; }).length;
      return [new Date(m + '-01T12:00:00Z'), monthIndex(m), Object.keys(sources).length, inMonth.length, sumLegs(legsM, 'gross_amount') / 1e6,
        sumLegs(legsM, 'processing_fee') / 1e6, sumLegs(legsM, 'net_amount') / 1e6, sumLegs(legsM, 'seller_fee') / 1e6,
        sumLegs(availM, 'seller_hold_amount') / 1e6, released / 1e6, cumHold / 1e6, availableM / 1e6, dispM, inMonth.length > 0 ? dispM / inMonth.length : '',
        sumOf(payM, 'amount') / 1e6, sumOf(adjM, 'amount') / 1e6, cumBalance / 1e6, obligation / 1e6,
        settledDates.length > 0 ? new Date(settledDates[settledDates.length - 1] + 'T12:00:00Z') : '',
        unknown > 0 ? unknown + ' GD chưa có provider economics (không ước tính)' : ''];
    });
    if (monthList.length > 0 && (cumBalance !== currentBalance || cumHold !== holdBalance)) {
      label('TongHop_Thang does not reconcile to Seller Balances (balance ' + cumBalance / 1e6 + ' vs ' + currentBalance / 1e6 +
        ', hold ' + cumHold / 1e6 + ' vs ' + holdBalance / 1e6 + '); run normalizeSellerBalances');
    }

    // ---- PhieuDoiSoat
    const unknownTx = txs.filter(function (x) { return !x.known; });
    const keys = txs.map(function (x) { return x.dateKey; }).filter(Boolean).sort();
    const info = [seller.seller_name + ' (' + sellerId + ')', keys.length ? new Date(keys[0] + 'T12:00:00Z') : '',
      keys.length ? new Date(keys[keys.length - 1] + 'T12:00:00Z') : '', sumOf(unknownTx.map(function (x) { return x.t; }), 'order_amount') / 1e6,
      unknownTx.length + ' GD', holdBalance / 1e6];
    const bySource = {};
    legs.forEach(function (x) { (bySource[String(x.leg.payment_source)] = bySource[String(x.leg.payment_source)] || []).push(x); });
    const sourceRows = Object.keys(bySource).sort().map(function (src) {
      const list = bySource[src];
      const rates = {};
      list.forEach(function (x) { rates[serializeCell_(x.leg.seller_fee_rate)] = x.leg.seller_fee_rate; });
      const rateKeys = Object.keys(rates);
      return [src, list.length, sumLegs(list, 'gross_amount') / 1e6, sumLegs(list, 'processing_fee') / 1e6, sumLegs(list, 'net_amount') / 1e6,
        rateKeys.length === 1 ? rates[rateKeys[0]] : '', sumLegs(list, 'seller_fee') / 1e6, sumLegs(list, 'seller_hold_amount') / 1e6,
        sumLegs(list, 'seller_available_amount') / 1e6];
    });
    const total = [legs.length, sumLegs(legs, 'gross_amount') / 1e6, sumLegs(legs, 'processing_fee') / 1e6, sumLegs(legs, 'net_amount') / 1e6, '',
      sumLegs(legs, 'seller_fee') / 1e6, sumLegs(legs, 'seller_hold_amount') / 1e6, sumLegs(legs, 'seller_available_amount') / 1e6];
    const aGross = sumLegs(available, 'gross_amount');
    const aFee = sumLegs(available, 'processing_fee');
    const aSellerFee = sumLegs(available, 'seller_fee');
    const aHold = sumLegs(available, 'seller_hold_amount');
    const released = sumOf(holdReleases, 'amount');
    const refunds = -sumOf(refundDispute, 'amount');
    const manualAdj = sumOf(manual, 'amount');
    const payable = aGross - aFee - aSellerFee - aHold + released - refunds + manualAdj;
    const paid = sumOf(payouts, 'amount');
    const fx = {};
    const payoutCurrencies = {};
    payouts.forEach(function (p) { if (isFiniteNumber_(p.fx_rate)) fx[serializeCell_(p.fx_rate)] = p.fx_rate; payoutCurrencies[trimmedText_(p.payout_currency)] = true; });
    const fxKeys = Object.keys(fx);
    const payoutCurrencyKeys = Object.keys(payoutCurrencies).filter(Boolean);
    const sectionB = [aGross / 1e6, aFee / 1e6, aSellerFee / 1e6, aHold / 1e6, released / 1e6, refunds / 1e6, manualAdj / 1e6, 0, payable / 1e6,
      paid / 1e6, (payable - paid) / 1e6, fxKeys.length === 1 ? fx[fxKeys[0]] : '',
      payoutCurrencyKeys.length === 1 && Object.keys(payoutCurrencies).length === 1 ? sumOf(payouts, 'payout_amount') / 1e6 : '', holdBalance / 1e6];
    if (payable - paid !== currentBalance) label('PhieuDoiSoat section B does not reconcile to Seller Balances.current_balance; run normalizeSellerBalances');
    if (aHold - released !== holdBalance) label('PhieuDoiSoat hold does not reconcile to Seller Balances.seller_hold_balance');
    const byStatus = function (s) {
      const list = txs.filter(function (x) { return x.status === s; });
      return [list.length, sumOf(list.map(function (x) { return x.t; }), 'order_amount') / 1e6];
    };
    const sectionC = [byStatus('MATCHED'), byStatus('AMOUNT_MISMATCH'), byStatus('MISSING_PROVIDER'), [0, 0]];
    const matched = txs.filter(function (x) { return x.status === 'MATCHED'; }).length;
    const check = [available.length === matched ? 'OK — ' + available.length + '/' + matched + ' matched đã vào Seller Balance'
      : 'Chưa — ' + available.length + '/' + matched + ' matched đã vào Seller Balance (còn lại chờ provider thanh toán)'];
    // Section D: chronological seller-only ledger (paid settlements, applied adjustments, effective payouts).
    // Settlement rows: due = this seller's frozen Settlement Items, paid = effective allocations (allocation model).
    const events = [];
    allocation.states.filter(function (st) { return st.seller_id === sellerId && st.target_type === SELLER_ALLOCATIONS.settlementTarget; }).forEach(function (st) {
      if (st.currency !== SELLER_OUTPUT.currency) { label('settlement obligation ' + st.settlement_id + ' is not ' + SELLER_OUTPUT.currency); return; }
      const s = st.settlement;
      events.push({ key: dk(s.source_payment_date), rank: 0, order: Number(s.source_settlement_number) || 0, kind: 'S', s: s, st: st,
        amount: micro_(st.due_amount), hold: micro_(st.hold_amount), paid: micro_(st.paid_amount), remaining: micro_(st.remaining_amount) });
    });
    const creditState = {};
    allocation.states.filter(function (st) { return st.seller_id === sellerId && st.target_type === SELLER_ALLOCATIONS.adjustmentTarget; })
      .forEach(function (st) { creditState[st.target_id] = st; });
    adjustments.forEach(function (a) {
      events.push({ key: dk(a.effective_date), rank: 1, order: String(a.adjustment_id), kind: 'A', a: a, amount: micro_(a.amount),
        release: trimmedText_(a.adjustment_type) === 'HOLD_RELEASE' ? micro_(a.amount) : 0, st: creditState[trimmedText_(a.adjustment_id)] || null });
    });
    payouts.forEach(function (p) { events.push({ key: dk(p.payout_date), rank: 2, order: String(p.seller_payout_id), kind: 'P', p: p, paid: micro_(p.amount) }); });
    events.sort(function (x, y) { return x.key < y.key ? -1 : x.key > y.key ? 1 : x.rank - y.rank || (x.order < y.order ? -1 : x.order > y.order ? 1 : 0); });
    let runBalance = 0;
    let runHold = 0;
    const history = events.map(function (e) {
      const before = runBalance;
      if (e.kind === 'S') {
        // Running balance: + due (allocations have no balance effect). H / I = this period's allocated paid / remaining.
        runBalance += e.amount;
        runHold += e.hold;
        return [sellerSettlementLabel_(e.s, e.st.payment_status), dateOnly(e.s.period_start_date), dateOnly(e.s.period_end_date),
          dateOnly(e.s.source_payment_date), e.amount / 1e6, before / 1e6, (before + e.amount) / 1e6, e.paid / 1e6, e.remaining / 1e6, e.hold / 1e6, 0,
          runHold / 1e6,
          dateOnly(e.s.hold_release_due_from_date), dateOnly(e.s.hold_release_due_to_date), '', '', ''];
      }
      if (e.kind === 'A') {
        runBalance += e.amount;
        runHold -= e.release;
        const type = trimmedText_(e.a.adjustment_type);
        if (e.st) {
          // Positive APPLIED credit = payout obligation: H / I = effective allocations to it / its remaining.
          return [type + ' · ' + e.st.payment_status, dateOnly(e.a.effective_date), '', '', e.amount / 1e6, before / 1e6, runBalance / 1e6,
            micro_(e.st.paid_amount) / 1e6, micro_(e.st.remaining_amount) / 1e6, 0, e.release / 1e6, runHold / 1e6, '', '', type, '', ''];
        }
        // Negative APPLIED adjustment: ordinary ledger debit, no payout status.
        return [type, dateOnly(e.a.effective_date), '', '', e.amount / 1e6, before / 1e6, runBalance / 1e6, 0, runBalance / 1e6, 0, e.release / 1e6,
          runHold / 1e6, '', '', type, '', ''];
      }
      runBalance -= e.paid;
      const ref = [trimmedText_(e.p.payment_method), trimmedText_(e.p.reference)].filter(Boolean).join(' / ');
      return ['Payout', dateOnly(e.p.payout_date), '', '', 0, before / 1e6, before / 1e6, e.paid / 1e6, runBalance / 1e6, 0, 0, runHold / 1e6, '', '',
        ref, isFiniteNumber_(e.p.fx_rate) ? e.p.fx_rate : '', isFiniteNumber_(e.p.payout_amount) ? e.p.payout_amount : ''];
    });
    if (runBalance !== currentBalance || runHold !== holdBalance) label('PhieuDoiSoat section D does not reconcile to Seller Balances');
    const phieu = { info: info, sources: sourceRows, total: total, b: sectionB, c: sectionC, check: check, history: history,
      pending: [sumLegs(pendingKnown, 'seller_available_amount') / 1e6], start: [startKey ? new Date(startKey + 'T12:00:00Z') : ''] };

    // ---- Dispute (existing canonical Master disputes only; no customer data)
    const disputeRows = disputes.slice().sort(function (a, b) {
      return compareCanonicalValues_(a.opened_at, b.opened_at) || compareCanonicalValues_(String(a.dispute_id), String(b.dispute_id));
    }).map(function (d) {
      const tx = txIds[String(d.internal_transaction_id)];
      const effect = adjustments.filter(function (a) { return trimmedText_(a.dispute_id) !== '' && String(a.dispute_id) === String(d.dispute_id); });
      return ['', trimmedText_(d.external_dispute_id) || d.dispute_id, d.internal_transaction_id, d.payment_source, tx ? tx.t.order_id : '', d.reason,
        dateOnly(d.opened_at), d.dispute_status, dateOnly(d.due_at), d.dispute_amount, d.currency, d.dispute_fee,
        effect.length > 0 ? sumOf(effect, 'amount') / 1e6 : '', '', '', '', ''].map(function (v) { return v === null || v === undefined ? '' : v; });
    });

    const blocks = { 'DoiSoat_GD': { rows: doiSoat }, 'TongHop_Thang': { rows: tongHop }, 'PhieuDoiSoat': phieu, 'Dispute': { rows: disputeRows } };
    const checksums = {};
    SELLER_OUTPUT.visibleTabs.forEach(function (tab) { checksums[tab] = sellerTabChecksum_(tab, blocks[tab], input.digestHex); });
    checksums.combined = sellerCombinedChecksum_(checksums, input.digestHex);
    const owned = { transactions: {}, disputes: {} };
    txs.forEach(function (x) { owned.transactions[String(x.t.internal_transaction_id)] = true; });
    disputeRows.forEach(function (r) { owned.disputes[String(r[1])] = true; });
    const missing = txs.filter(function (x) { return x.status === 'MISSING_PROVIDER'; });
    snapshots[sellerId] = {
      seller_id: sellerId, seller_name: seller.seller_name, seller_label: info[0], blocks: blocks, checksums: checksums, owned: owned,
      sync: { output_schema_version: SELLER_OUTPUT.schemaVersion, seller_id: sellerId, seller_name: seller.seller_name,
        master_schema_version: input.masterSchemaVersion, synced_at: '', DoiSoat_GD_checksum: checksums.DoiSoat_GD,
        TongHop_Thang_checksum: checksums.TongHop_Thang, PhieuDoiSoat_checksum: checksums.PhieuDoiSoat, Dispute_checksum: checksums.Dispute,
        combined_checksum: checksums.combined },
      totals: { total_transactions: txs.length, matched_transactions: matched, missing_provider_transactions: missing.length,
        total_order_amount: sumOf(txs.map(function (x) { return x.t; }), 'order_amount') / 1e6, matched_gross: sumLegs(legs, 'gross_amount') / 1e6,
        processing_fee: sumLegs(legs, 'processing_fee') / 1e6, net: sumLegs(legs, 'net_amount') / 1e6, seller_fee: sumLegs(legs, 'seller_fee') / 1e6,
        seller_hold: holdBalance / 1e6, current_balance: currentBalance / 1e6,
        known_obligation: (currentBalance + holdBalance + sumLegs(pendingKnown, 'seller_available_amount') + sumLegs(pendingKnown, 'seller_hold_amount')) / 1e6,
        missing_provider_order_amount: sumOf(missing.map(function (x) { return x.t; }), 'order_amount') / 1e6,
        seller_fee_rates: sourceRows.reduce(function (acc, r) {
          acc[r[0]] = Object.keys(bySource[r[0]].reduce(function (o, x) { o[x.leg.seller_fee_rate] = true; return o; }, {})).map(Number).sort();
          return acc;
        }, {}),
        counts: { transaction_rows: doiSoat.length, month_rows: tongHop.length, settlement_rows: history.length, dispute_rows: disputeRows.length } },
    };
  });
  return { snapshots: snapshots, errors: errors };
}

/* --------------------------- Canonical content --------------------------- */

/** Canonical 2D content of one tab (tagged rows) - the checksum input; independent of formatting. */
function sellerTabCanonical_(tab, blocks) {
  if (tab !== 'PhieuDoiSoat') return blocks.rows.map(function (r) { return ['row'].concat(r); });
  const out = [];
  out.push(['info'].concat(blocks.info));
  blocks.sources.forEach(function (r) { out.push(['source'].concat(r)); });
  out.push(['total'].concat(blocks.total));
  out.push(['b'].concat(blocks.b));
  blocks.c.forEach(function (r) { out.push(['c'].concat(r)); });
  out.push(['check'].concat(blocks.check));
  blocks.history.forEach(function (r) { out.push(['history'].concat(r)); });
  out.push(['pending'].concat(blocks.pending));
  out.push(['start'].concat(blocks.start));
  return out;
}

function sellerTabChecksum_(tab, blocks, digestHex) {
  const rows = sellerTabCanonical_(tab, blocks);
  const width = rows.reduce(function (w, r) { return Math.max(w, r.length); }, 1);
  return computeRawChecksum_([[SELLER_OUTPUT.checksumVersion, tab]].concat(rows).map(function (r) {
    return r.concat(Array(Math.max(0, width - r.length)).fill(''));
  }), digestHex);
}

function sellerCombinedChecksum_(checksums, digestHex) {
  const digest = digestHex || sha256Hex_;
  return digest(SELLER_OUTPUT.checksumVersion + '|' + SELLER_OUTPUT.visibleTabs.map(function (t) { return t + '=' + checksums[t]; }).join('|'));
}

/** Rows start..end (1-based) of columns cols (1-based list), trailing fully blank rows removed. */
function sellerReadRows_(values, start, end, cols) {
  const rows = [];
  for (let r = start; r <= end; r++) rows.push(cols.map(function (c) { const v = gridCell_(values, r, c); return v === null ? '' : v; }));
  while (rows.length > 0 && rows[rows.length - 1].every(isBlankCell_)) rows.pop();
  return rows;
}

function sellerRange_(from, to) {
  const out = [];
  for (let c = from; c <= to; c++) out.push(c);
  return out;
}

/** Dispute owned columns: A..M and O..R ("Số ngày còn lại" in N is a presentation formula). */
function sellerDisputeColumns_() {
  return sellerRange_(1, 13).concat(sellerRange_(15, 18));
}

/** Reads the owned content of a tab back into the block structure used for the checksum. */
function extractSellerTabBlocks_(tab, layout, values) {
  const cell = function (r, c) { const v = gridCell_(values, r, c); return v === null ? '' : v; };
  if (tab === 'DoiSoat_GD' || tab === 'TongHop_Thang') return { rows: sellerReadRows_(values, layout.dataStart, layout.dataEnd, sellerRange_(1, layout.width)) };
  if (tab === 'Dispute') return { rows: sellerReadRows_(values, layout.dataStart, layout.dataEnd, sellerDisputeColumns_()) };
  const L = layout;
  return {
    info: [cell(L.seller, 2), cell(L.from, 2), cell(L.to, 2), cell(L.pending, 2), cell(L.pending, 3), cell(L.pending, 5)],
    sources: sellerReadRows_(values, L.srcStart, L.srcEnd, sellerRange_(1, 9)),
    total: sellerRange_(2, 9).map(function (c) { return cell(L.totalRow, c); }),
    b: L.bRows.map(function (r) { return cell(r, 2); }),
    c: L.cRows.map(function (r) { return [cell(r, 2), cell(r, 3)]; }),
    check: [cell(L.checkRow, 2)],
    history: sellerReadRows_(values, L.histStart, L.histEnd, sellerRange_(1, 17)),
    pending: [cell(L.pendRow, 5)],
    start: [cell(L.startRow, 2)],
  };
}

/** Rows needed per dynamic block vs the template capacity: {tab: [{block, need, capacity}]}. */
function sellerCapacityNeeds_(snapshot, layouts) {
  const needs = [];
  const add = function (tab, block, need, start, end) { if (need > end - start + 1) needs.push({ tab: tab, block: block, extra: need - (end - start + 1) }); };
  add('DoiSoat_GD', 'rows', snapshot.blocks.DoiSoat_GD.rows.length, layouts.DoiSoat_GD.dataStart, layouts.DoiSoat_GD.dataEnd);
  add('TongHop_Thang', 'rows', snapshot.blocks.TongHop_Thang.rows.length, layouts.TongHop_Thang.dataStart, layouts.TongHop_Thang.dataEnd);
  add('PhieuDoiSoat', 'sources', snapshot.blocks.PhieuDoiSoat.sources.length, layouts.PhieuDoiSoat.srcStart, layouts.PhieuDoiSoat.srcEnd);
  add('PhieuDoiSoat', 'history', snapshot.blocks.PhieuDoiSoat.history.length, layouts.PhieuDoiSoat.histStart, layouts.PhieuDoiSoat.histEnd);
  add('Dispute', 'rows', snapshot.blocks.Dispute.rows.length, layouts.Dispute.dataStart, layouts.Dispute.dataEnd);
  return needs;
}

/** _Sync rows (header + key/value) for a snapshot at a sync time. */
function sellerSyncRows_(snapshot, at) {
  const info = Object.assign({}, snapshot.sync, { synced_at: at });
  return [['key', 'value']].concat(SELLER_OUTPUT.syncKeys.map(function (k) { return [k, info[k]]; }));
}

/**
 * Compares a child workbook with the desired seller output (used for the NO_CHANGE decision, the post-write
 * verification and verifySellerSheets). Includes the leak / isolation checks.
 * @return {{errors: Array<string>, changedTabs: Array<string>, matches: Object<string, boolean>, sync_match: boolean,
 *           combined_match: boolean, synced_at: ?Date, layouts: Object, counts: Object}}
 */
function compareSellerWorkbook_(snapshot, wb, opts) {
  const v = validateSellerWorkbook_(wb, { mode: 'child', requireSync: !!opts.requireSync, hiddenIds: opts.hiddenIds });
  const out = { errors: v.errors.slice(), changedTabs: [], matches: {}, sync_match: false, combined_match: false, synced_at: null, layouts: v.layouts,
    actual: {}, counts: {} };
  const byName = {};
  wb.sheets.forEach(function (s) { byName[s.name] = s; });
  SELLER_OUTPUT.visibleTabs.forEach(function (tab) {
    const layout = v.layouts[tab];
    if (!layout) { out.matches[tab] = false; out.changedTabs.push(tab); return; }
    const blocks = extractSellerTabBlocks_(tab, layout, byName[tab].values);
    out.actual[tab] = sellerTabChecksum_(tab, blocks);
    out.matches[tab] = out.actual[tab] === snapshot.checksums[tab];
    if (!out.matches[tab]) out.changedTabs.push(tab);
    if (tab === 'DoiSoat_GD') {
      out.counts.transaction_rows = blocks.rows.length;
      blocks.rows.forEach(function (r) {
        if (!snapshot.owned.transactions[String(r[0])]) out.errors.push('isolation: DoiSoat_GD shows transaction ' + r[0] + ' not owned by ' + snapshot.seller_id);
      });
    }
    if (tab === 'Dispute') {
      out.counts.dispute_rows = blocks.rows.length;
      blocks.rows.forEach(function (r) {
        if (!snapshot.owned.disputes[String(r[1])] || (r[2] !== '' && !snapshot.owned.transactions[String(r[2])])) {
          out.errors.push('isolation: Dispute shows case ' + r[1] + ' not owned by ' + snapshot.seller_id);
        }
      });
    }
    if (tab === 'TongHop_Thang') out.counts.month_rows = blocks.rows.length;
    if (tab === 'PhieuDoiSoat') {
      out.counts.settlement_rows = blocks.history.length;
      if (blocks.info[0] !== '' && blocks.info[0] !== snapshot.seller_label) out.errors.push('isolation: PhieuDoiSoat shows seller "' + blocks.info[0] + '"');
    }
  });
  const sync = byName[SELLER_OUTPUT.syncTab];
  if (sync) {
    const rows = sellerReadRows_(sync.values, 1, sync.values.length, [1, 2]);
    const map = {};
    rows.slice(1).forEach(function (r) { map[sellerText_(r[0])] = r[1]; });
    const differing = SELLER_OUTPUT.syncKeys.filter(function (k) { return k !== 'synced_at' && serializeCell_(map[k]) !== serializeCell_(snapshot.sync[k]); });
    out.sync_match = rows.length === SELLER_OUTPUT.syncKeys.length + 1 && differing.length === 0;
    const stamp = map.synced_at;
    out.synced_at = isDateValue_(stamp) && isFinite(stamp.getTime()) ? stamp : null;
    if (map.seller_id !== undefined && String(map.seller_id) !== snapshot.seller_id) out.errors.push('isolation: _Sync belongs to seller ' + map.seller_id);
    const actualCombined = SELLER_OUTPUT.visibleTabs.every(function (t) { return out.actual[t]; }) ? sellerCombinedChecksum_(out.actual) : null;
    out.combined_match = map.combined_checksum === snapshot.checksums.combined && actualCombined === map.combined_checksum;
    if (opts.requireSync) {
      if (!out.sync_match) out.errors.push('_Sync differs from Payment Master in ' + (differing.join(', ') || 'shape'));
      if (!out.synced_at) out.errors.push('_Sync synced_at is not a valid datetime');
      if (!out.combined_match) out.errors.push('combined checksum mismatch (visible content does not match _Sync / Payment Master)');
    }
  }
  if (opts.requireSync) out.changedTabs.forEach(function (t) { out.errors.push(t + ': content differs from Payment Master'); });
  return out;
}

/** Report-only regression of expected seller totals. */
function evaluateSellerSheetsRegression_(snapshots) {
  const exp = SELLER_SHEETS_REGRESSION;
  const checks = [];
  const add = function (n, e, a, pass) { checks.push({ name: n, expected: e, actual: a, pass: pass }); };
  Object.keys(exp.sellers).forEach(function (id) {
    const t = snapshots[id] ? snapshots[id].totals : null;
    Object.keys(exp.sellers[id]).forEach(function (f) {
      const e = exp.sellers[id][f];
      const a = t ? t[f] : null;
      add(id + '.' + f, e, a, isFiniteNumber_(a) && Math.abs(a - e) < 0.00005);
    });
  });
  Object.keys(exp.seller_fee_rates).forEach(function (id) {
    const t = snapshots[id] ? snapshots[id].totals.seller_fee_rates : null;
    add(id + '.seller_fee_rates', exp.seller_fee_rates[id], t, JSON.stringify(t) === JSON.stringify(exp.seller_fee_rates[id]));
  });
  const hui = snapshots.CUS002 ? snapshots.CUS002.totals : null;
  if (hui) {
    const lhs = Math.round((hui.current_balance + hui.seller_hold + hui.seller_fee + hui.processing_fee + hui.missing_provider_order_amount) * 1e6);
    add('CUS002.identity', 'balance + hold + seller fee + processing fee + missing order amount = total order amount', lhs / 1e6,
      Math.abs(lhs - Math.round(hui.total_order_amount * 1e6)) <= 50);
  }
  return { snapshot: exp.snapshot, pass: checks.every(function (c) { return c.pass; }),
    failed: checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }), checks: checks };
}
