/**
 * SellerTerms.gs
 * Effective-dated seller FEE history ("Seller Terms") per seller + payment_source: validation,
 * historical resolution, the one-time initial seed and the v13 -> v14 payment_source migration.
 *
 * - User-edited input. A fee change = close the old row (effective_to) and add a new row, so past
 *   transactions keep their historical rate.
 * - Rules: seller_id exists in Sellers; payment_source required (PAYMENT_SOURCE enum); seller_name_snapshot
 *   nonblank; 0 <= seller_fee_rate < 1; effective_from required; effective_to blank (open) or >=
 *   effective_from; per seller + payment_source no overlapping periods, at most one open-ended row, no
 *   duplicate periods; every seller with a seller_id has at
 *   least one valid row (a missing seller is blocking, never auto-seeded once the tab has data).
 * - Resolution for (seller, payment_source, date): exactly one row of that exact source with
 *   effective_from <= date <= effective_to (blank = open); zero or several rows fail closed. There is
 *   never a fallback to another payment source (PAYPAL terms never apply to STRIPE).
 * - Seed: only while the tab has no data rows, one PAYPAL row per seller with the Settings seller_fee_rate,
 *   starting at the seller's earliest Endpoint Mapping effective_from (fallback: earliest mapping
 *   date, then today). Never overwrites or reseeds history.
 * - Seller hold is NOT configured here: KH001 seller hold mirrors the actual provider hold 1:1.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const SELLER_TERMS = Object.freeze({
  seedRateSetting: 'seller_fee_rate',
  // Current activity is PAYPAL only: the seed and the v13 -> v14 migration assign this source.
  seedPaymentSource: 'PAYPAL',
  legacyHeaderV13: ['seller_id', 'seller_name_snapshot', 'seller_fee_rate', 'effective_from', 'effective_to', 'notes'],
  maxReportedErrors: 30,
});

/* ----------------------------- Pure helpers ----------------------------- */

function emptySellerTermErrors_() {
  return { unknown_sellers: [], invalid_rates: [], invalid_dates: [], overlaps: [], duplicate_periods: [], invalid_rows: [],
    missing_sellers: [] };
}

/**
 * Validates Seller Terms rows.
 * @param {Array<Object>} rows Seller Terms rows as objects (+ optional _row)
 * @param {Array<Object>} sellers parsed Sellers (parseSellersDraft_().sellers)
 * @param {function(*): string} dateKeyOf value -> 'YYYY-MM-DD' | '' (throws when invalid)
 * @return {{terms: Array<Object>, errors: Object, warnings: Array<string>, missing_sellers: Array<string>,
 *           snapshot_name_mismatches: Array<string>}}
 */
function parseSellerTerms_(rows, sellers, dateKeyOf) {
  const errors = emptySellerTermErrors_();
  const warnings = [];
  const nameById = {};
  sellers.forEach(function (s) { if (s.seller_id) nameById[s.seller_id] = s.seller_name; });
  const terms = [];
  const mismatches = [];
  rows.forEach(function (r, i) {
    const label = 'Seller Terms row ' + (r._row || i + 2);
    const sellerId = trimmedText_(r.seller_id);
    const source = trimmedText_(r.payment_source).toUpperCase();
    const snapshot = trimmedText_(r.seller_name_snapshot);
    let bad = false;
    if (sellerId === '') { errors.invalid_rows.push(label + ': seller_id is blank'); bad = true; }
    else if (!Object.prototype.hasOwnProperty.call(nameById, sellerId)) { errors.unknown_sellers.push(label + ': unknown seller ' + sellerId); bad = true; }
    if (source === '') { errors.invalid_rows.push(label + ': payment_source is blank (required)'); bad = true; }
    else if (ENUMS.PAYMENT_SOURCE.indexOf(source) < 0) { errors.invalid_rows.push(label + ': unknown payment_source "' + r.payment_source + '"'); bad = true; }
    if (snapshot === '') { errors.invalid_rows.push(label + ': seller_name_snapshot is blank'); bad = true; }
    const rate = r.seller_fee_rate;
    if (!isFiniteNumber_(rate) || rate < 0 || rate >= 1) { errors.invalid_rates.push(label + ': seller_fee_rate must be a number with 0 <= rate < 1'); bad = true; }
    let from = '';
    let to = '';
    try { from = dateKeyOf(r.effective_from); } catch (e) { errors.invalid_dates.push(label + ': effective_from ' + e.message); bad = true; }
    try { to = dateKeyOf(r.effective_to); } catch (e) { errors.invalid_dates.push(label + ': effective_to ' + e.message); bad = true; }
    if (!bad && from === '') { errors.invalid_dates.push(label + ': effective_from is required'); bad = true; }
    if (!bad && to !== '' && to < from) { errors.invalid_dates.push(label + ': effective_to ' + to + ' is before effective_from ' + from); bad = true; }
    if (bad) return;
    if (snapshot !== nameById[sellerId]) {
      mismatches.push(label + ': seller_name_snapshot "' + snapshot + '" differs from current name "' + nameById[sellerId] + '"');
    }
    terms.push({ seller_id: sellerId, payment_source: source, seller_name_snapshot: snapshot, seller_fee_rate: rate, effective_from: from,
      effective_to: to, row: r._row || i + 2 });
  });

  const bySeller = {};
  const byKey = {};
  terms.forEach(function (t) {
    (bySeller[t.seller_id] = bySeller[t.seller_id] || []).push(t);
    (byKey[t.seller_id + '/' + t.payment_source] = byKey[t.seller_id + '/' + t.payment_source] || []).push(t);
  });
  Object.keys(byKey).sort().forEach(function (id) {
    const list = byKey[id].slice().sort(function (a, b) {
      return a.effective_from < b.effective_from ? -1 : a.effective_from > b.effective_from ? 1 : 0;
    });
    const periods = {};
    list.forEach(function (t) {
      const k = t.effective_from + '|' + t.effective_to;
      if (periods[k]) errors.duplicate_periods.push(id + ': duplicate period ' + t.effective_from + '..' + (t.effective_to || 'open') + ' (rows ' + periods[k] + ', ' + t.row + ')');
      periods[k] = t.row;
    });
    const open = list.filter(function (t) { return t.effective_to === ''; });
    if (open.length > 1) errors.overlaps.push(id + ': ' + open.length + ' open-ended rows');
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      if (prev.effective_to === '' || list[i].effective_from <= prev.effective_to) {
        errors.overlaps.push(id + ': rows ' + prev.row + ' and ' + list[i].row + ' overlap');
      }
    }
  });
  const missing = Object.keys(nameById).filter(function (id) { return !bySeller[id]; }).sort();
  missing.forEach(function (id) { errors.missing_sellers.push(id + ': seller has no valid Seller Terms row; add an effective-dated term'); });
  if (mismatches.length > 0) warnings.push(mismatches.length + ' seller_name_snapshot value(s) differ from the current seller name.');
  return { terms: terms, errors: errors, warnings: warnings, missing_sellers: missing, snapshot_name_mismatches: mismatches };
}

function flattenSellerTermErrors_(errors) {
  return Object.keys(errors).reduce(function (acc, k) { return acc.concat(errors[k]); }, []);
}

/**
 * The single Seller Terms row in effect for a seller + exact payment_source on a date key; throws on zero or
 * several (fail closed; never falls back to another payment source).
 */
function resolveSellerTerm_(terms, sellerId, paymentSource, dateKey) {
  const source = trimmedText_(paymentSource).toUpperCase();
  const matches = terms.filter(function (t) {
    return t.seller_id === sellerId && t.payment_source === source && t.effective_from <= dateKey &&
      (t.effective_to === '' || dateKey <= t.effective_to);
  });
  if (matches.length === 0) throw new Error('No Seller Terms row for ' + sellerId + ' / ' + (source || '(blank source)') + ' on ' + dateKey);
  if (matches.length > 1) throw new Error('Several Seller Terms rows for ' + sellerId + ' / ' + source + ' on ' + dateKey);
  return matches[0];
}

/**
 * Initial seed rows (one per seller with an ID) for an EMPTY Seller Terms tab.
 * @param {Array<Object>} sellers parsed Sellers
 * @param {number} rate Settings seller_fee_rate
 * @param {Array<Object>} mappingRecords Endpoint Mapping records (date keys)
 * @param {string} todayKey fallback start date
 */
function planSellerTermsSeed_(sellers, rate, mappingRecords, todayKey) {
  if (!isFiniteNumber_(rate) || rate < 0 || rate >= 1) throw new Error('Settings seller_fee_rate must be a number with 0 <= rate < 1 to seed Seller Terms.');
  const earliest = {};
  let globalEarliest = '';
  mappingRecords.forEach(function (r) {
    if (!r.effective_from) return;
    if (!earliest[r.seller_id] || r.effective_from < earliest[r.seller_id]) earliest[r.seller_id] = r.effective_from;
    if (!globalEarliest || r.effective_from < globalEarliest) globalEarliest = r.effective_from;
  });
  return sellers.filter(function (s) { return s.seller_id !== ''; })
    .slice().sort(function (a, b) { return a.seller_id < b.seller_id ? -1 : a.seller_id > b.seller_id ? 1 : 0; })
    .map(function (s) {
      return { seller_id: s.seller_id, payment_source: SELLER_TERMS.seedPaymentSource, seller_name_snapshot: s.seller_name, seller_fee_rate: rate,
        effective_from: earliest[s.seller_id] || globalEarliest || todayKey, effective_to: '', notes: 'Initial seed from Settings seller_fee_rate' };
    });
}

/* ---------------------------------- I/O --------------------------------- */

function readSellerTerms_(ss) {
  const sheet = ss.getSheetByName(SHEETS.SELLER_TERMS);
  if (!sheet) throw new Error('Seller Terms tab not found. Run setupMaster first.');
  const columns = getColumnNames_(SHEETS.SELLER_TERMS);
  const grid = readSheetGrid_(sheet);
  const rows = [];
  grid.values.slice(1).forEach(function (row, i) {
    if (row.every(isBlankCell_)) return;
    const obj = rowToObject_(row.slice(0, columns.length), columns);
    obj._row = i + 2;
    rows.push(obj);
  });
  tableRowsFromGrid_(grid.values, columns, SHEETS.SELLER_TERMS); // header contract check
  const sellers = readSellersDraft_(ss).parsed.sellers;
  return { sheet: sheet, rows: rows, sellers: sellers, parsed: parseSellerTerms_(rows, sellers, masterDateKey_) };
}

/** Read-only validity of Seller Terms for downstream writers. Never throws. */
function readSellerTermsValidity_(ss) {
  try {
    const st = readSellerTerms_(ss);
    const errors = flattenSellerTermErrors_(st.parsed.errors);
    const missing = st.parsed.missing_sellers;
    return { current: errors.length === 0, terms: st.parsed.terms, missing_sellers: missing,
      reason: errors.length === 0 ? null : 'Seller Terms is invalid (' + errors.length + ' error(s)' +
        (missing.length > 0 ? '; sellers without terms: ' + missing.join(', ') : '') + '); fix Seller Terms first.' };
  } catch (err) {
    return { current: false, terms: [], reason: 'Seller Terms is invalid (' + (err && err.message ? err.message : String(err)) + ').' };
  }
}

/**
 * Setup-only v13 -> v14 migration. When Seller Terms still has the exact v13 header, a payment_source column is
 * inserted after seller_id and every existing data row gets PAYPAL (all terms so far are PAYPAL activity).
 * Rates, dates, names and notes are preserved cell-for-cell; Payment Legs are not recalculated.
 * @return {number} migrated data rows (0 when the tab is already v14 or missing)
 */
function migrateSellerTermsPaymentSource_(ss) {
  const sheet = ss.getSheetByName(SHEETS.SELLER_TERMS);
  if (!sheet || !arraysEqual_(readHeaderRow_(sheet), SELLER_TERMS.legacyHeaderV13)) return 0;
  sheet.insertColumnsAfter(1, 1);
  sheet.getRange(1, 2).setValue('payment_source');
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  let migrated = 0;
  const values = sheet.getRange(2, 1, last - 1, SELLER_TERMS.legacyHeaderV13.length + 1).getValues();
  const column = values.map(function (row) {
    const hasData = row.some(function (v, i) { return i !== 1 && !isBlankCell_(v); });
    if (hasData) migrated++;
    return [hasData ? SELLER_TERMS.seedPaymentSource : ''];
  });
  sheet.getRange(2, 2, last - 1, 1).setNumberFormat('@').setValues(column);
  return migrated;
}

/**
 * Setup-only: seeds Seller Terms when (and only when) it has no data rows.
 * @return {number} rows seeded
 */
function seedSellerTermsIfEmpty_(ss, warnings) {
  const sheet = ss.getSheetByName(SHEETS.SELLER_TERMS);
  if (!sheet) return 0;
  const columns = getColumnNames_(SHEETS.SELLER_TERMS);
  const grid = readSheetGrid_(sheet);
  if (grid.values.slice(1).some(function (row) { return !row.every(isBlankCell_); })) return 0;
  const sellers = readSellersDraft_(ss).parsed.sellers;
  if (sellers.filter(function (s) { return s.seller_id !== ''; }).length === 0) return 0;
  let plan;
  try {
    const records = readEndpointMappingRecords_(ss).records;
    const today = Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyy-MM-dd');
    plan = planSellerTermsSeed_(sellers, readSettingsMap_()[SELLER_TERMS.seedRateSetting], records, today);
  } catch (err) {
    warnings.push('Seller Terms not seeded: ' + (err && err.message ? err.message : String(err)));
    return 0;
  }
  const rows = plan.map(function (t) {
    return columns.map(function (c) {
      if (c === 'effective_from') return masterDateFromKey_(t.effective_from);
      return t[c] === undefined ? '' : t[c];
    });
  });
  if (sheet.getMaxRows() < rows.length + 1) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
  sheet.getRange(2, 1, rows.length, columns.length).setValues(rows);
  return rows.length;
}

/** Read-only Seller Terms report. */
function buildSellerTermsReport_() {
  const report = { seller_count: 0, term_rows: 0, seller_term_counts: {}, payment_source_counts: {}, open_term_counts: {}, missing_sellers: [], unknown_sellers: [],
    invalid_rates: [], invalid_dates: [], overlaps: [], duplicate_periods: [], invalid_rows: [], snapshot_name_mismatches: [],
    pass: false, errors: [], warnings: [] };
  try {
    const st = readSellerTerms_(getSpreadsheet_());
    const p = st.parsed;
    report.seller_count = st.sellers.filter(function (s) { return s.seller_id !== ''; }).length;
    report.term_rows = st.rows.length;
    p.terms.forEach(function (t) {
      report.seller_term_counts[t.seller_id] = (report.seller_term_counts[t.seller_id] || 0) + 1;
      const key = t.seller_id + '/' + t.payment_source;
      report.payment_source_counts[key] = (report.payment_source_counts[key] || 0) + 1;
      if (t.effective_to === '') report.open_term_counts[t.seller_id] = (report.open_term_counts[t.seller_id] || 0) + 1;
    });
    report.missing_sellers = p.missing_sellers;
    report.snapshot_name_mismatches = p.snapshot_name_mismatches;
    ['unknown_sellers', 'invalid_rates', 'invalid_dates', 'overlaps', 'duplicate_periods', 'invalid_rows'].forEach(function (k) { report[k] = p.errors[k]; });
    if (p.missing_sellers.length > 0) report.errors.push('Sellers without Seller Terms: ' + p.missing_sellers.join(', ') + '.');
    const errors = flattenSellerTermErrors_(p.errors);
    if (errors.length > p.missing_sellers.length) report.errors.push('Seller Terms has ' + (errors.length - p.missing_sellers.length) + ' row error(s).');
    report.warnings = p.warnings;
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0;
  return redactDeep_(report);
}
