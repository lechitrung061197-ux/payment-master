/**
 * Kh001Settlements.gs
 * KH001 normalizer: settlement history + reconciliation -> canonical Settlements headers
 * (KH001 partition). Provider economics only.
 *
 * - Settlement history comes ONLY from section "D. LỊCH SỬ CHỐT & THANH TOÁN — CÔNG NỢ" of
 *   "Raw KH001 Settlements" (PhieuDoiSoat). The section and its header row are discovered by
 *   normalized text, never by row number; unlabeled trailing columns are ignored.
 * - Transaction economics are actual sums of "Raw KH001 Reconciled" (DoiSoat_GD) rows with
 *   Có trên PP = 1, grouped by `Lần chốt (ngày)` == history `Đến ngày` compared as
 *   provider-timezone (Settings source.KH001.timezone) YYYY-MM-DD keys. Provider fee/hold are
 *   never recalculated from rates and never rounded per row.
 * - Provider hold history values are preserved as reported; an independent roll-forward
 *   (expected_provider_hold_balance) and the difference are reported, never "fixed".
 * - Every included transaction must resolve to a KH001 Provider Transaction, and the KH001
 *   Provider Transactions partition must be current (dependency gate) before write/NO_CHANGE.
 * - No settlement items, seller allocation, balances, payouts or receipt confirmation.
 *
 * IMMUTABILITY BOUNDARY: Settlements are a REBUILDABLE observed provider settlement layer.
 * Every run rebuilds the KH001 partition from the current raw tabs, so a later provider edit
 * to section D or DoiSoat_GD changes the affected settlement. Before Settlement Items are
 * created/frozen (Phase 2E) a commit/lock boundary must be added so a committed settlement
 * cannot silently mutate. Each row's source_fingerprint (settlement-specific, see
 * computeKh001SettlementFingerprint_) is the revision identity for that boundary.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const KH001_SETTLEMENTS = Object.freeze({
  providerId: 'KH001',
  paymentSource: 'PAYPAL',
  currency: 'USD',
  normalizerVersion: 'KH001_SETTLEMENT_HEADERS_V1',
  idPrefix: 'ST-KH001-PAYPAL-',
  timezoneSetting: 'source.KH001.timezone',
  sectionPrefix: 'd.',
  sectionText: 'lịch sử chốt',
  headerSearchRows: 10,
  historyHeaders: [
    'Lần', 'Từ ngày', 'Đến ngày', 'Ngày thanh toán', 'Phát sinh phải trả', 'Còn nợ lần trước', 'Tổng phải trả',
    'Đã thanh toán (USD)', 'Còn nợ', 'Hold giữ lần này', 'Hold được hoàn lần này', 'Số dư hold',
    'Hold lần này hoàn từ ngày', '… đến ngày', 'Hình thức / chứng từ', 'Tỷ giá lần này (VND/USD)', 'Đã thanh toán (VND)',
  ],
  reconciledHeaderRow: 6,
  reconciledHeaders: [
    'Transaction ID', 'Có trên PP', 'Lần chốt (ngày)', 'Doanh thu (Gross)', 'Phí PayPal', 'Net', 'Phí thuê OP', 'Hold',
    'Thực nhận (chưa gồm hoàn hold)',
  ],
  tolerance: 0.005,
  vndTolerance: 1,
  payoutCurrencyWhenVnd: 'VND',
  dateColumns: ['period_start_date', 'period_end_date', 'source_payment_date', 'hold_release_due_from_date',
    'hold_release_due_to_date'],
  maxReportedErrors: 20,
});

/** Current-snapshot regression expectations (October 2026). Report only. */
const KH001_SETTLEMENTS_REGRESSION = Object.freeze({
  snapshot: 'KH001 2026-10 production snapshot',
  settlements: {
    1: { period_start_date: '2026-10-01', period_end_date: '2026-10-04', source_payment_date: '2026-10-06',
      transaction_count: 94, gross_amount: 5357.86, processing_fee_amount: 213.04, net_amount: 5144.82,
      provider_fee_amount: 360.1374, provider_hold_created_amount: 514.4820, transaction_payout_amount: 4270.2006,
      provider_hold_released_amount: 0, period_due_amount: 4270.2006, carry_in_amount: 0, total_due_amount: 4270.2006,
      source_paid_amount: 4270.2006, outstanding_amount: 0, fx_rate: 25300, source_paid_payout_amount: 108036075.18 },
    2: { period_start_date: '2026-10-05', period_end_date: '2026-10-09', source_payment_date: '2026-10-10',
      transaction_count: 74, gross_amount: 5269.76, processing_fee_amount: 207.20, net_amount: 5062.56,
      provider_fee_amount: 354.3792, provider_hold_created_amount: 506.2560, transaction_payout_amount: 4201.9248,
      provider_hold_released_amount: 0, period_due_amount: 4201.9248, carry_in_amount: 0, total_due_amount: 4201.9248,
      source_paid_amount: 4201.9248, outstanding_amount: 0, fx_rate: 25300, source_paid_payout_amount: 106308697.44 },
  },
  totals: { settlement_count: 2, transaction_count: 168, gross_amount: 10627.62, processing_fee_amount: 420.24,
    net_amount: 10207.38, provider_fee_amount: 714.5166, provider_hold_created_amount: 1020.738,
    transaction_payout_amount: 8472.1254 },
});

/* ----------------------------- Pure helpers ----------------------------- */

/** Loose header/section key: NFC, "…" -> "...", collapsed whitespace, trimmed, lower case. */
function normalizeSourceKey_(value) {
  return normalizeLabel_(value).replace(/…/g, '...').replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Provider-timezone YYYY-MM-DD key of a raw date value (Date instant or an ISO date string).
 * Returns '' for blank; throws for anything else.
 */
function providerDateKey_(value, timeZone) {
  if (isBlankCell_(value)) return '';
  if (isDateValue_(value)) {
    if (isNaN(value.getTime())) throw new Error('invalid date');
    return Utilities.formatDate(value, timeZone, 'yyyy-MM-dd');
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  throw new Error('not a date: "' + value + '"');
}

function kh001SettlementId_(settlementNumber) {
  const n = String(settlementNumber);
  return KH001_SETTLEMENTS.idPrefix + ('000000' + n).slice(-Math.max(6, n.length));
}

/** Section-D fields of one settlement, in canonical fingerprint order. */
const KH001_SETTLEMENT_FINGERPRINT_HISTORY_FIELDS = Object.freeze([
  'source_settlement_number', 'period_start_date', 'period_end_date', 'source_payment_date', 'period_due_amount',
  'carry_in_amount', 'total_due_amount', 'source_paid_amount', 'outstanding_amount', 'source_hold_created_amount',
  'provider_hold_released_amount', 'provider_hold_balance', 'hold_release_due_from_date', 'hold_release_due_to_date',
  'source_payment_reference', 'fx_rate', 'source_paid_payout_amount',
]);
/** DoiSoat_GD inputs of one included transaction, in canonical fingerprint order. */
const KH001_SETTLEMENT_FINGERPRINT_TX_FIELDS = Object.freeze([
  'transaction_id', 'settlement_date', 'gross', 'processing_fee', 'net', 'provider_fee', 'hold', 'payout',
]);

/**
 * Settlement-specific source fingerprint (revision identity of one settlement):
 * SHA-256 over the normalizer version, that settlement's section-D history fields and the
 * DoiSoat_GD inputs of the transactions assigned to it (sorted by Transaction ID). Values
 * use the canonical cell serialization (dates as provider YYYY-MM-DD keys). Sections A/B,
 * other settlements, unrelated DoiSoat rows, sheet row numbers and timestamps are excluded.
 * @param {Object} history values keyed by KH001_SETTLEMENT_FINGERPRINT_HISTORY_FIELDS
 * @param {Array<Object>} transactions values keyed by KH001_SETTLEMENT_FINGERPRINT_TX_FIELDS
 */
function computeKh001SettlementFingerprint_(history, transactions, digestHex) {
  const digest = digestHex || sha256Hex_;
  const line = function (obj, fields) {
    return fields.map(function (f) { return serializeCell_(obj[f]); }).join('\u001f');
  };
  const txLines = transactions.slice()
    .sort(function (a, b) { return a.transaction_id < b.transaction_id ? -1 : a.transaction_id > b.transaction_id ? 1 : 0; })
    .map(function (t) { return line(t, KH001_SETTLEMENT_FINGERPRINT_TX_FIELDS); });
  return digest([KH001_SETTLEMENTS.normalizerVersion, 'H', line(history, KH001_SETTLEMENT_FINGERPRINT_HISTORY_FIELDS),
    'T', String(txLines.length)].concat(txLines).join('\u001e'));
}

/** Row index (0-based) of the section D title, or throws. */
function findSettlementHistorySection_(values) {
  const cfg = KH001_SETTLEMENTS;
  const found = [];
  values.forEach(function (row, r) {
    row.forEach(function (cell) {
      const key = normalizeSourceKey_(cell);
      if (key.indexOf(cfg.sectionPrefix) === 0 && key.indexOf(cfg.sectionText) >= 0) found.push(r);
    });
  });
  if (found.length === 0) throw new Error('Section "D. LỊCH SỬ CHỐT & THANH TOÁN — CÔNG NỢ" not found in Raw KH001 Settlements.');
  if (found.length > 1) throw new Error('Section D found more than once in Raw KH001 Settlements (rows ' +
    found.map(function (r) { return r + 1; }).join(', ') + ').');
  return found[0];
}

/**
 * Finds the history header row below the section title and maps required headers to column
 * indexes. Unlabeled or unknown columns are ignored.
 * @return {{headerRow: number, map: Object}} headerRow 0-based; map normalized key -> index
 */
function findSettlementHistoryHeader_(values, sectionRow) {
  const cfg = KH001_SETTLEMENTS;
  const required = cfg.historyHeaders.map(normalizeSourceKey_);
  const last = Math.min(values.length - 1, sectionRow + cfg.headerSearchRows);
  for (let r = sectionRow + 1; r <= last; r++) {
    const keys = values[r].map(normalizeSourceKey_);
    if (keys.indexOf(normalizeSourceKey_('Lần')) < 0 || keys.indexOf(normalizeSourceKey_('Đến ngày')) < 0) continue;
    const map = {};
    const duplicates = [];
    keys.forEach(function (k, c) {
      if (k === '' || required.indexOf(k) < 0) return;
      if (Object.prototype.hasOwnProperty.call(map, k)) duplicates.push(k);
      else map[k] = c;
    });
    const missing = required.filter(function (k) { return !Object.prototype.hasOwnProperty.call(map, k); });
    if (missing.length > 0 || duplicates.length > 0) {
      throw new Error('Settlement history header (row ' + (r + 1) + ') ' +
        (missing.length ? 'is missing: ' + missing.join(', ') : '') +
        (duplicates.length ? (missing.length ? '; ' : '') + 'has duplicates: ' + duplicates.join(', ') : '') + '.');
    }
    return { headerRow: r, map: map };
  }
  throw new Error('Settlement history header row not found within ' + cfg.headerSearchRows + ' rows below section D.');
}

function parseSettlementNumber_(value) {
  if (typeof value === 'number' && isFinite(value) && value >= 1 && Math.floor(value) === value) return value;
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value) && Number(value) >= 1) return Number(value);
  return null;
}

/** Optional numeric field: '' for blank, the number, or null when non-numeric. */
function optionalNumber_(value) {
  if (isBlankCell_(value)) return '';
  return isFiniteNumber_(value) ? value : null;
}

/** Display-only rounding for messages (stored values are never rounded). */
function fmt4_(value) {
  return isFiniteNumber_(value) ? String(Math.round(value * 10000) / 10000) : String(value);
}

function n0_(value) {
  return value === '' ? 0 : value;
}

function near_(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance + 1e-9;
}

function emptySettlementErrors_() {
  return { duplicate: [], relationship: [], cross_check: [], amount_invariant: [], history_equation: [], data: [] };
}

function flattenSettlementErrors_(errors) {
  return [].concat(errors.duplicate, errors.relationship, errors.cross_check, errors.amount_invariant,
    errors.history_equation, errors.data);
}

/**
 * Builds KH001 settlement header objects (date fields as provider YYYY-MM-DD keys,
 * normalized_at blank). Structural problems throw; row problems are collected.
 * @param {Array<Array<*>>} settlementsValues full "Raw KH001 Settlements" grid
 * @param {Array<Array<*>>} reconciledValues full "Raw KH001 Reconciled" grid
 * @param {Object} ptIndex provider_transaction_id -> Provider Transaction object
 * @param {{timeZone: string}} opts
 * @return {{rows: Array<Object>, errors: Object, warnings: Array<string>,
 *           holdReconciliation: Array<Object>, includedTransactions: number,
 *           sourceRows: Array<{settlement_number: number, source_row: number}>}}  sourceRows is diagnostic only
 */
function buildKh001Settlements_(settlementsValues, reconciledValues, ptIndex, opts) {
  const cfg = KH001_SETTLEMENTS;
  const errors = emptySettlementErrors_();
  const warnings = [];
  const tol = cfg.tolerance;

  // --- Settlement history (section D) ---
  const sectionRow = findSettlementHistorySection_(settlementsValues);
  const header = findSettlementHistoryHeader_(settlementsValues, sectionRow);
  const h = function (row, name) { return row[header.map[normalizeSourceKey_(name)]]; };
  const historyCols = cfg.historyHeaders.map(function (name) { return header.map[normalizeSourceKey_(name)]; });

  const history = [];
  const byNumber = {};
  const byEndKey = {};
  for (let r = header.headerRow + 1; r < settlementsValues.length; r++) {
    const row = settlementsValues[r];
    const number = parseSettlementNumber_(h(row, 'Lần'));
    if (number === null) {
      const rest = historyCols.some(function (c) { return !isBlankCell_(row[c]); });
      if (rest) warnings.push('Settlement history ends at row ' + (r + 1) + ' (Lần "' + h(row, 'Lần') + '" is not a settlement number).');
      break;
    }
    const sheetRow = r + 1;
    const otherBlank = historyCols.slice(1).every(function (c) { return isBlankCell_(row[c]); });
    if (otherBlank) { warnings.push('Settlement #' + number + ' (row ' + sheetRow + ') is an empty placeholder; skipped.'); continue; }
    if (byNumber[number]) { errors.duplicate.push('Duplicate settlement number ' + number + ' (rows ' + byNumber[number].row + ', ' + sheetRow + ')'); continue; }

    const label = 'Settlement #' + number + ' (row ' + sheetRow + ')';
    const dates = {};
    let dateError = false;
    [['period_start_date', 'Từ ngày', true], ['period_end_date', 'Đến ngày', true], ['source_payment_date', 'Ngày thanh toán', false],
      ['hold_release_due_from_date', 'Hold lần này hoàn từ ngày', false], ['hold_release_due_to_date', '… đến ngày', false]]
      .forEach(function (d) {
        try {
          dates[d[0]] = providerDateKey_(h(row, d[1]), opts.timeZone);
          if (d[2] && dates[d[0]] === '') throw new Error('blank');
        } catch (e) {
          errors.data.push(label + ': ' + d[1] + ' ' + e.message);
          dateError = true;
        }
      });
    const nums = {};
    let numError = false;
    // [field, source header, required]: required fields must be numeric (blank is not 0).
    [['period_due_amount', 'Phát sinh phải trả', true], ['carry_in_amount', 'Còn nợ lần trước', true],
      ['total_due_amount', 'Tổng phải trả', true], ['source_paid_amount', 'Đã thanh toán (USD)', false],
      ['outstanding_amount', 'Còn nợ', true], ['source_hold_created', 'Hold giữ lần này', true],
      ['provider_hold_released_amount', 'Hold được hoàn lần này', true], ['provider_hold_balance', 'Số dư hold', true],
      ['fx_rate', 'Tỷ giá lần này (VND/USD)', false], ['source_paid_payout_amount', 'Đã thanh toán (VND)', false]]
      .forEach(function (f) {
        const v = optionalNumber_(h(row, f[1]));
        if (v === null) { errors.data.push(label + ': non-numeric ' + f[1] + ' "' + h(row, f[1]) + '"'); numError = true; }
        else if (v === '' && f[2]) { errors.data.push(label + ': required ' + f[1] + ' is blank'); numError = true; }
        nums[f[0]] = v;
      });
    if (dateError || numError) continue;
    // Payment consistency: a paid amount needs a payment date; a VND payout needs USD paid > 0,
    // a positive FX rate and a payment date. Unpaid (closed, not yet paid) rows stay valid.
    const paidUsd = n0_(nums.source_paid_amount);
    if (paidUsd > 0 && dates.source_payment_date === '') {
      errors.data.push(label + ': Đã thanh toán (USD) ' + paidUsd + ' without Ngày thanh toán');
      continue;
    }
    if (nums.source_paid_payout_amount !== '') {
      const vndProblems = [];
      if (!(paidUsd > 0)) vndProblems.push('Đã thanh toán (USD) must be > 0');
      if (!(isFiniteNumber_(nums.fx_rate) && nums.fx_rate > 0)) vndProblems.push('Tỷ giá must be > 0');
      if (dates.source_payment_date === '') vndProblems.push('Ngày thanh toán is required');
      if (vndProblems.length > 0) {
        errors.data.push(label + ': Đã thanh toán (VND) populated but ' + vndProblems.join(', '));
        continue;
      }
    }
    if (byEndKey[dates.period_end_date]) {
      errors.duplicate.push('Settlements #' + byEndKey[dates.period_end_date].number + ' and #' + number +
        ' share Đến ngày ' + dates.period_end_date);
      continue;
    }
    const entry = { number: number, row: sheetRow, dates: dates, nums: nums,
      reference: canonicalText_(h(row, 'Hình thức / chứng từ')),
      tx: { count: 0, gross: 0, fee: 0, net: 0, providerFee: 0, hold: 0, payout: 0 }, inputs: [] };
    history.push(entry);
    byNumber[number] = entry;
    byEndKey[dates.period_end_date] = entry;
  }

  // --- Transaction aggregation (DoiSoat_GD) ---
  if (reconciledValues.length < cfg.reconciledHeaderRow) throw new Error('Raw KH001 Reconciled has no header row ' + cfg.reconciledHeaderRow + '.');
  const rc = buildHeaderMap_(reconciledValues[cfg.reconciledHeaderRow - 1], cfg.reconciledHeaders, 'Raw KH001 Reconciled');
  const c = function (row, name) { return row[rc[normalizeLabel_(name)]]; };
  const seenTx = {};
  let included = 0;
  for (let r = cfg.reconciledHeaderRow; r < reconciledValues.length; r++) {
    const row = reconciledValues[r];
    const onPayPal = c(row, 'Có trên PP');
    if (!(onPayPal === 1 || (typeof onPayPal === 'string' && onPayPal.trim() === '1'))) continue;
    const rawDate = c(row, 'Lần chốt (ngày)');
    if (isBlankCell_(rawDate)) continue;
    const sheetRow = r + 1;
    const id = canonicalText_(c(row, 'Transaction ID'));
    const label = 'Reconciled row ' + sheetRow + (id ? ' (' + id + ')' : '');
    let key;
    try { key = providerDateKey_(rawDate, opts.timeZone); } catch (e) { errors.data.push(label + ': Lần chốt (ngày) ' + e.message); continue; }
    if (id === '') { errors.data.push(label + ': blank Transaction ID'); continue; }
    if (seenTx[id]) { errors.duplicate.push('Transaction ID ' + id + ' settled twice (rows ' + seenTx[id] + ', ' + sheetRow + ')'); continue; }
    seenTx[id] = sheetRow;

    const v = {};
    let bad = false;
    [['gross', 'Doanh thu (Gross)'], ['fee', 'Phí PayPal'], ['net', 'Net'], ['providerFee', 'Phí thuê OP'], ['hold', 'Hold'],
      ['payout', 'Thực nhận (chưa gồm hoàn hold)']].forEach(function (f) {
      const x = c(row, f[1]);
      if (!isFiniteNumber_(x)) { errors.amount_invariant.push(label + ': non-numeric ' + f[1]); bad = true; }
      v[f[0]] = x;
    });
    if (bad) continue;
    if (!near_(v.gross - v.fee, v.net, tol)) { errors.amount_invariant.push(label + ': gross - processing fee != net (' + v.gross + ' - ' + v.fee + ' != ' + v.net + ')'); continue; }
    if (!near_(v.net - v.providerFee - v.hold, v.payout, tol)) {
      errors.amount_invariant.push(label + ': net - provider fee - hold != payout (' + v.net + ' - ' + v.providerFee + ' - ' + v.hold + ' != ' + v.payout + ')');
      continue;
    }

    const settlement = byEndKey[key];
    if (!settlement) { errors.relationship.push(label + ': Lần chốt ' + key + ' matches no settlement history Đến ngày'); continue; }
    const pt = ptIndex[kh001ProviderTransactionId_(id)];
    if (!pt || pt.provider_id !== cfg.providerId || pt.payment_source !== cfg.paymentSource || String(pt.external_transaction_id) !== id) {
      errors.relationship.push(label + ': no KH001/PAYPAL Provider Transaction ' + kh001ProviderTransactionId_(id));
      continue;
    }
    // Cross-check PayPal economics with the canonical Provider Transaction (provider fee/hold
    // are DoiSoat-only and are not compared).
    const mismatches = [];
    if (pt.external_status !== 'Completed') mismatches.push('status "' + pt.external_status + '" is not Completed');
    if (pt.currency !== cfg.currency) mismatches.push('currency "' + pt.currency + '" != ' + cfg.currency);
    [['gross', 'gross_amount', 'Doanh thu (Gross)'], ['fee', 'processing_fee', 'Phí PayPal'], ['net', 'net_amount', 'Net']]
      .forEach(function (f) {
        if (!isFiniteNumber_(pt[f[1]]) || !near_(v[f[0]], pt[f[1]], tol)) {
          mismatches.push(f[2] + ' ' + v[f[0]] + ' != Provider Transaction ' + f[1] + ' ' + pt[f[1]]);
        }
      });
    if (mismatches.length > 0) {
      errors.cross_check.push(label + ': ' + mismatches.join('; '));
      continue;
    }
    included++;
    const t = settlement.tx;
    t.count++;
    t.gross += v.gross; t.fee += v.fee; t.net += v.net; t.providerFee += v.providerFee; t.hold += v.hold; t.payout += v.payout;
    settlement.inputs.push({ transaction_id: id, settlement_date: key, gross: v.gross, processing_fee: v.fee, net: v.net,
      provider_fee: v.providerFee, hold: v.hold, payout: v.payout });
  }

  // --- Settlement headers, equations, hold roll-forward ---
  history.sort(function (a, b) { return a.number - b.number; });
  const rows = [];
  const holdReconciliation = [];
  let expectedHold = 0;
  let previousOutstanding = null;
  history.forEach(function (s) {
    const label = 'Settlement #' + s.number;
    const n = s.nums;
    const t = s.tx;
    const released = n0_(n.provider_hold_released_amount);
    const adjustments = n0_(n.period_due_amount) - t.payout - released;
    expectedHold = expectedHold + t.hold - released;
    const holdDifference = n.provider_hold_balance === '' ? '' : n.provider_hold_balance - expectedHold;

    const eq = function (ok, text) { if (!ok) errors.history_equation.push(label + ': ' + text); };
    eq(near_(t.gross - t.fee, t.net, tol), 'gross - processing fee != net');
    eq(near_(t.net - t.providerFee - t.hold, t.payout, tol), 'net - provider fee - hold created != transaction payout');
    eq(near_(n0_(n.period_due_amount), t.payout + released + adjustments, tol), 'period due != payout + hold released + adjustments');
    eq(near_(n0_(n.total_due_amount), n0_(n.period_due_amount) + n0_(n.carry_in_amount), tol), 'total due != period due + carry in');
    eq(near_(n0_(n.outstanding_amount), n0_(n.total_due_amount) - n0_(n.source_paid_amount), tol), 'outstanding != total due - paid');
    if (n.source_paid_payout_amount !== '') {
      eq(n.fx_rate !== '' && near_(n.source_paid_payout_amount, n0_(n.source_paid_amount) * n.fx_rate, cfg.vndTolerance),
        'paid (VND) != paid (USD) x fx rate');
    }

    if (t.count === 0) warnings.push(label + ': no reconciled transactions');
    if (!near_(adjustments, 0, tol)) warnings.push(label + ': unclassified provider adjustment ' + fmt4_(adjustments));
    eq(near_(n.source_hold_created, t.hold, tol), 'history "Hold giữ lần này" ' + fmt4_(n.source_hold_created) +
      ' != SUM(DoiSoat Hold) ' + fmt4_(t.hold));
    if (previousOutstanding !== null && !near_(n0_(n.carry_in_amount), previousOutstanding, tol)) {
      warnings.push(label + ': carry in ' + fmt4_(n0_(n.carry_in_amount)) + ' != previous outstanding ' + fmt4_(previousOutstanding));
    }
    previousOutstanding = n0_(n.outstanding_amount);
    const holdMatches = holdDifference !== '' && near_(holdDifference, 0, tol);
    if (!holdMatches) {
      warnings.push(label + ': provider hold balance ' + (n.provider_hold_balance === '' ? '(blank)' : fmt4_(n.provider_hold_balance)) +
        ' vs expected roll-forward ' + fmt4_(expectedHold) + (holdDifference === '' ? '' : ' (difference ' + fmt4_(holdDifference) + ')'));
    }
    holdReconciliation.push({
      settlement_number: s.number,
      provider_hold_created_amount: t.hold,
      provider_hold_released_amount: released,
      provider_hold_balance: n.provider_hold_balance,
      expected_provider_hold_balance: expectedHold,
      hold_balance_difference: holdDifference,
      matches: holdMatches,
    });

    rows.push({
      settlement_id: kh001SettlementId_(s.number),
      provider_id: cfg.providerId,
      payment_source: cfg.paymentSource,
      source_settlement_number: s.number,
      period_start_date: s.dates.period_start_date,
      period_end_date: s.dates.period_end_date,
      source_payment_date: s.dates.source_payment_date,
      currency: cfg.currency,
      transaction_count: t.count,
      gross_amount: t.gross,
      processing_fee_amount: t.fee,
      net_amount: t.net,
      provider_fee_amount: t.providerFee,
      provider_hold_created_amount: t.hold,
      transaction_payout_amount: t.payout,
      provider_hold_released_amount: n.provider_hold_released_amount,
      provider_hold_balance: n.provider_hold_balance,
      expected_provider_hold_balance: expectedHold,
      hold_balance_difference: holdDifference,
      hold_release_due_from_date: s.dates.hold_release_due_from_date,
      hold_release_due_to_date: s.dates.hold_release_due_to_date,
      period_due_amount: n.period_due_amount,
      carry_in_amount: n.carry_in_amount,
      total_due_amount: n.total_due_amount,
      source_paid_amount: n.source_paid_amount,
      outstanding_amount: n.outstanding_amount,
      provider_adjustments: adjustments,
      source_payment_reference: s.reference,
      fx_rate: n.fx_rate,
      payout_currency: n.source_paid_payout_amount === '' ? '' : cfg.payoutCurrencyWhenVnd,
      source_paid_payout_amount: n.source_paid_payout_amount,
      source_fingerprint: computeKh001SettlementFingerprint_({
        source_settlement_number: s.number,
        period_start_date: s.dates.period_start_date,
        period_end_date: s.dates.period_end_date,
        source_payment_date: s.dates.source_payment_date,
        period_due_amount: n.period_due_amount,
        carry_in_amount: n.carry_in_amount,
        total_due_amount: n.total_due_amount,
        source_paid_amount: n.source_paid_amount,
        outstanding_amount: n.outstanding_amount,
        source_hold_created_amount: n.source_hold_created,
        provider_hold_released_amount: n.provider_hold_released_amount,
        provider_hold_balance: n.provider_hold_balance,
        hold_release_due_from_date: s.dates.hold_release_due_from_date,
        hold_release_due_to_date: s.dates.hold_release_due_to_date,
        source_payment_reference: s.reference,
        fx_rate: n.fx_rate,
        source_paid_payout_amount: n.source_paid_payout_amount,
      }, s.inputs),
      normalizer_version: cfg.normalizerVersion,
      normalized_at: '',
    });
  });

  // Current section-D row of each settlement: diagnostic only (never stored or fingerprinted).
  const sourceRows = history.map(function (s) { return { settlement_number: s.number, source_row: s.row }; });
  return { rows: rows, errors: errors, warnings: warnings, holdReconciliation: holdReconciliation,
    includedTransactions: included, sourceRows: sourceRows };
}

function assertNoSettlementErrors_(errors) {
  const all = flattenSettlementErrors_(errors);
  if (all.length === 0) return;
  const shown = all.slice(0, KH001_SETTLEMENTS.maxReportedErrors);
  const more = all.length > shown.length ? ' | ... ' + (all.length - shown.length) + ' more' : '';
  throw new Error('KH001 settlements normalization failed (' + all.length + ' error(s)): ' + shown.join(' | ') + more);
}

/**
 * Converts a settlement object to a sheet row; provider date keys become Master date values
 * via dateFromKey (deterministic: same key -> same Date).
 */
function settlementObjectToRow_(obj, columns, dateFromKey) {
  const copy = Object.assign({}, obj);
  KH001_SETTLEMENTS.dateColumns.forEach(function (c) {
    copy[c] = copy[c] === '' ? '' : dateFromKey(copy[c]);
  });
  return objectToRow_(copy, columns);
}

/** Generic totals across settlement objects (sums of stored values). */
function summarizeSettlements_(rows) {
  const sum = function (field) {
    return rows.reduce(function (acc, r) { return acc + (isFiniteNumber_(r[field]) ? r[field] : 0); }, 0);
  };
  const numbers = {};
  rows.forEach(function (r) { numbers[String(r.source_settlement_number)] = (numbers[String(r.source_settlement_number)] || 0) + 1; });
  return {
    settlement_count: rows.length,
    unique_settlements: Object.keys(numbers).length,
    transaction_count: sum('transaction_count'),
    gross_amount: sum('gross_amount'),
    processing_fee_amount: sum('processing_fee_amount'),
    net_amount: sum('net_amount'),
    provider_fee_amount: sum('provider_fee_amount'),
    provider_hold_created_amount: sum('provider_hold_created_amount'),
    transaction_payout_amount: sum('transaction_payout_amount'),
    provider_hold_released_amount: sum('provider_hold_released_amount'),
    provider_adjustments: sum('provider_adjustments'),
    source_paid_amount: sum('source_paid_amount'),
    outstanding_amount: sum('outstanding_amount'),
  };
}

/**
 * Regression report (October 2026 snapshot). rowsWithKeys must carry date fields as
 * provider date keys. Report only.
 */
function evaluateKh001SettlementsRegression_(rowsWithKeys, totals) {
  const exp = KH001_SETTLEMENTS_REGRESSION;
  const checks = [];
  const tolFor = function (field) {
    if (/_date$/.test(field)) return null;
    if (field === 'transaction_count') return 0;
    return /^(provider_|transaction_payout|period_due|carry_in|total_due|source_paid_amount|outstanding)/.test(field) ? 0.00005 : 0.005;
  };
  const check = function (name, e, a, tol) {
    const pass = tol === null ? e === a : isFiniteNumber_(a) && Math.abs(a - e) <= tol + 1e-9;
    checks.push({ name: name, expected: e, actual: a, pass: pass });
  };
  const byNumber = {};
  rowsWithKeys.forEach(function (r) { byNumber[r.source_settlement_number] = r; });
  Object.keys(exp.settlements).forEach(function (num) {
    const e = exp.settlements[num];
    const a = byNumber[num] || {};
    Object.keys(e).forEach(function (f) {
      // A blank numeric source cell is compared as 0 here only; stored values keep the blank.
      const actual = a[f] === undefined ? null : (a[f] === '' && tolFor(f) !== null ? 0 : a[f]);
      check('#' + num + '.' + f, e[f], actual, tolFor(f));
    });
  });
  Object.keys(exp.totals).forEach(function (f) {
    check('totals.' + f, exp.totals[f], totals[f], f === 'settlement_count' || f === 'transaction_count' ? 0 : tolFor(f));
  });
  return {
    snapshot: exp.snapshot,
    pass: checks.every(function (x) { return x.pass; }),
    failed: checks.filter(function (x) { return !x.pass; }).map(function (x) { return x.name; }),
    checks: checks,
  };
}

/* ---------------------------------- I/O --------------------------------- */

const SETTLEMENT_KEY_COLUMNS = ['provider_id', 'payment_source', 'source_settlement_number'];
const SETTLEMENT_SORT_COLUMNS = ['provider_id', 'payment_source', 'source_settlement_number'];

function settlementsTab_() {
  return { targetSheet: SHEETS.SETTLEMENTS, stagingSheet: '__STAGE_SETTLEMENTS' };
}

/** Provider date key -> Master date value (midnight in the Master timezone). */
function masterDateFromKey_(key) {
  return Utilities.parseDate(key, APP.TIMEZONE, 'yyyy-MM-dd');
}

/** Reads every input needed for KH001 settlements, including the PT dependency. Read-only. */
function readKh001SettlementsInputs_(ss) {
  const read = function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) throw new Error('Raw tab "' + name + '" not found. Run syncKh001Raw first.');
    return readSheetGrid_(sheet);
  };
  const settlements = read(SHEETS.RAW_KH001_SETTLEMENTS);
  const reconciled = read(SHEETS.RAW_KH001_RECONCILED);
  const paypal = read(SHEETS.RAW_KH001_PAYPAL);
  const timeZone = String(getRequiredSetting_(readSettingsMap_(), KH001_SETTLEMENTS.timezoneSetting));
  const dep = readProviderTransactionsDependency_(ss, paypal);
  return {
    settlements: settlements,
    reconciled: reconciled,
    timeZone: timeZone,
    dependency: dep,
  };
}

/** Normalizes KH001 settlement headers under the script lock. Never throws. */
function runKh001SettlementsNormalizer_() {
  const cfg = KH001_SETTLEMENTS;
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  const details = { normalizer_version: cfg.normalizerVersion };
  let status = 'FAILED';
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms.');
    const ss = getSpreadsheet_();
    const table = getTableSchema_(SHEETS.SETTLEMENTS);
    const columns = table.columns.map(function (c) { return c.name; });

    const input = readKh001SettlementsInputs_(ss);
    details.settlements_checksum = input.settlements.checksum;
    details.reconciled_checksum = input.reconciled.checksum;
    details.provider_timezone = input.timeZone;
    details.provider_transactions_checksum = input.dependency.dependency.stored_checksum;
    // Dependency freshness gate: before any write or NO_CHANGE.
    if (!input.dependency.dependency.provider_transactions_current) throw new Error(input.dependency.dependency.reason);

    const built = buildKh001Settlements_(input.settlements.values, input.reconciled.values, input.dependency.index,
      { timeZone: input.timeZone });
    details.included_transactions = built.includedTransactions;
    assertNoSettlementErrors_(built.errors);

    const partition = built.rows.map(function (o) { return settlementObjectToRow_(o, columns, masterDateFromKey_); });
    details.output_rows = partition.length;
    details.output_checksum = partitionChecksum_(partition, columns, SETTLEMENT_SORT_COLUMNS, 'normalized_at');
    details.settlement_fingerprints = built.rows.map(function (r) {
      return { settlement_id: r.settlement_id, source_fingerprint: r.source_fingerprint };
    });
    details.hold_reconciliation = built.holdReconciliation;
    details.settlement_source_rows = built.sourceRows;
    details.warnings = built.warnings;

    const result = replaceCanonicalPartition_(ss, {
      table: table,
      tab: settlementsTab_(),
      providerId: cfg.providerId,
      partitionRows: partition,
      keyColumns: SETTLEMENT_KEY_COLUMNS,
      sortColumns: SETTLEMENT_SORT_COLUMNS,
      stampColumn: 'normalized_at',
    });
    details.swap_state = result.swapState;
    details.swap_actions = result.swapActions;
    details.table_rows = result.tableRows;
    status = result.status;
  } catch (err) {
    details.error = err && err.message ? err.message : String(err);
    status = 'FAILED';
  } finally {
    try {
      appendAuditLog_({
        action: cfg.providerId + '_SETTLEMENTS_NORMALIZE_' + status,
        entityType: 'SETTLEMENTS',
        entityId: cfg.providerId,
        newStatus: status,
        details: details,
      });
    } catch (auditErr) {
      Logger.log('Failed to write audit entry: %s', auditErr);
    }
    if (locked) lock.releaseLock();
  }
  return Object.assign({ provider: cfg.providerId, status: status }, details);
}

/** Read-only verification of the KH001 Settlements partition. */
function buildKh001SettlementsReport_() {
  const cfg = KH001_SETTLEMENTS;
  const report = {
    provider: cfg.providerId,
    normalizer_version: cfg.normalizerVersion,
    source: {},
    dependency: null,
    output: {},
    hold_balance_reconciliation: [],
    provider_adjustments: [],
    warnings: [],
    totals: {},
    target_match: false,
    swap_state: null,
    pass: false,
    errors: [],
    regression: null,
  };
  try {
    const ss = getSpreadsheet_();
    const columns = getColumnNames_(SHEETS.SETTLEMENTS);
    const input = readKh001SettlementsInputs_(ss);
    report.source = {
      settlements_rows: input.settlements.rows,
      settlements_columns: input.settlements.columns,
      settlements_checksum: input.settlements.checksum,
      reconciled_rows: input.reconciled.rows,
      reconciled_checksum: input.reconciled.checksum,
      provider_timezone: input.timeZone,
    };
    report.dependency = input.dependency.dependency;
    if (!report.dependency.provider_transactions_current) report.errors.push(report.dependency.reason);

    const built = buildKh001Settlements_(input.settlements.values, input.reconciled.values, input.dependency.index,
      { timeZone: input.timeZone });
    const buildErrors = flattenSettlementErrors_(built.errors);
    let expectedChecksum = null;
    if (buildErrors.length === 0) {
      expectedChecksum = partitionChecksum_(built.rows.map(function (o) { return settlementObjectToRow_(o, columns, masterDateFromKey_); }),
        columns, SETTLEMENT_SORT_COLUMNS, 'normalized_at');
    } else {
      report.errors.push('Normalizer validation failed with ' + buildErrors.length + ' error(s).');
    }
    report.hold_balance_reconciliation = built.holdReconciliation;
    report.provider_adjustments = built.rows.map(function (r) {
      return { settlement_number: r.source_settlement_number, provider_adjustments: r.provider_adjustments };
    });
    report.settlement_fingerprints = built.rows.map(function (r) {
      return { settlement_id: r.settlement_id, source_fingerprint: r.source_fingerprint };
    });
    report.settlement_source_rows = built.sourceRows; // diagnostic only, not stored
    report.warnings = built.warnings;

    report.swap_state = detectSwapState_(ss, settlementsTab_()).state;
    if (report.swap_state !== 'NORMAL') report.errors.push('Swap state is ' + report.swap_state + '.');

    const target = ss.getSheetByName(SHEETS.SETTLEMENTS);
    if (!target) throw new Error('Settlements tab not found.');
    const allRows = tableRowsFromGrid_(readSheetGrid_(target).values, columns, SHEETS.SETTLEMENTS);
    const providerIdx = columns.indexOf('provider_id');
    const kh001Rows = allRows.filter(function (r) { return r[providerIdx] === cfg.providerId; });
    const stored = kh001Rows.map(function (r) { return rowToObject_(r, columns); });
    const summary = summarizeSettlements_(stored);
    const keyIdx = SETTLEMENT_KEY_COLUMNS.map(function (c) { return columns.indexOf(c); });

    report.output = {
      row_count: summary.settlement_count,
      unique_settlements: summary.unique_settlements,
      output_checksum: partitionChecksum_(kh001Rows, columns, SETTLEMENT_SORT_COLUMNS, 'normalized_at'),
      expected_checksum: expectedChecksum,
      duplicate_keys: findDuplicateKeys_(allRows, keyIdx),
      relationship_errors: built.errors.relationship,
      cross_check_errors: built.errors.cross_check,
      amount_invariant_errors: built.errors.amount_invariant,
      history_equation_errors: built.errors.history_equation,
      duplicate_errors: built.errors.duplicate,
      data_errors: built.errors.data,
      included_transactions: built.includedTransactions,
      table_rows_all_providers: allRows.length,
    };
    report.totals = summary;

    const storedChecksum = tableChecksumExcluding_(buildTableValues_(columns, kh001Rows), [columns.indexOf('normalized_at')]);
    report.target_match = expectedChecksum !== null && storedChecksum === expectedChecksum;
    if (!report.target_match) report.errors.push('Settlements KH001 partition does not match raw snapshot.');
    ['duplicate_keys', 'relationship_errors', 'cross_check_errors', 'amount_invariant_errors', 'history_equation_errors',
      'duplicate_errors', 'data_errors']
      .forEach(function (k) { if (report.output[k].length > 0) report.errors.push(k + ': ' + report.output[k].length); });

    report.regression = evaluateKh001SettlementsRegression_(built.rows, summarizeSettlements_(built.rows));
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0 && report.target_match && report.swap_state === 'NORMAL';
  return report;
}
