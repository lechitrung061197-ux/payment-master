/**
 * SellerDestinations.gs
 * Seller Destinations: user-managed mapping seller_id -> seller child spreadsheet (output only).
 *
 * - Hard errors (config ambiguity / data-leak risk; syncSellerSheets writes nothing anywhere):
 *   blank or unknown seller_id, duplicate seller_id rows, invalid status, malformed spreadsheet_id,
 *   ACTIVE without spreadsheet_id, the same spreadsheet_id ACTIVE for more than one seller, and a
 *   spreadsheet_id equal to the Payment Master (or a configured provider source spreadsheet).
 * - Warnings only (never block accounting or other sellers): sellers without a destination row,
 *   seller_name_snapshot differing from the current name, a spreadsheet_id shared with an INACTIVE row.
 * - Seed: only while the tab has no data rows, one INACTIVE row per seller with a blank spreadsheet_id.
 *   Never reseeds; sellers added later get their row manually.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const SELLER_DESTINATIONS = Object.freeze({
  activeStatus: 'ACTIVE',
  inactiveStatus: 'INACTIVE',
  // Drive file IDs: URL-safe base64 characters; a pasted URL or name is rejected.
  spreadsheetIdPattern: /^[A-Za-z0-9_-]{20,}$/,
  seedNote: 'Initial seed: paste the seller child spreadsheet ID, then set status ACTIVE.',
  maxReportedErrors: 30,
});

/* ----------------------------- Pure helpers ----------------------------- */

function emptyDestinationErrors_() {
  return { invalid_rows: [], unknown_sellers: [], duplicate_seller_ids: [], duplicate_spreadsheet_ids: [], master_id_conflicts: [],
    active_missing_spreadsheet_id: [] };
}

function flattenDestinationErrors_(errors) {
  return Object.keys(errors).reduce(function (acc, k) { return acc.concat(errors[k]); }, []);
}

/**
 * Validates Seller Destinations rows.
 * @param {Array<Object>} rows destination rows as objects (+ optional _row)
 * @param {Array<Object>} sellers parsed Sellers (seller_id, seller_name)
 * @param {{masterId: string, protectedIds: Array<{id: string, label: string}>}} guard spreadsheets that may never be a destination
 * @return {{destinations: Array<Object>, active: Array<Object>, errors: Object, warnings: Array<string>,
 *           missing_sellers: Array<string>, snapshot_name_mismatches: Array<string>}}
 */
function parseSellerDestinations_(rows, sellers, guard) {
  const errors = emptyDestinationErrors_();
  const warnings = [];
  const nameById = {};
  sellers.forEach(function (s) { if (s.seller_id) nameById[s.seller_id] = s.seller_name; });
  const protectedIds = [{ id: guard.masterId, label: 'the Payment Master spreadsheet' }].concat(guard.protectedIds || [])
    .filter(function (p) { return trimmedText_(p.id) !== ''; });
  const destinations = [];
  const mismatches = [];
  const rowsBySeller = {};

  rows.forEach(function (r, i) {
    const label = 'Seller Destinations row ' + (r._row || i + 2);
    const sellerId = trimmedText_(r.seller_id);
    const snapshot = trimmedText_(r.seller_name_snapshot);
    const spreadsheetId = trimmedText_(r.spreadsheet_id);
    const status = trimmedText_(r.status).toUpperCase();
    let bad = false;
    if (sellerId === '') { errors.invalid_rows.push(label + ': seller_id is blank'); bad = true; }
    else if (!Object.prototype.hasOwnProperty.call(nameById, sellerId)) { errors.unknown_sellers.push(label + ': unknown seller ' + sellerId); bad = true; }
    if (ENUMS.SELLER_DESTINATION_STATUS.indexOf(status) < 0) {
      errors.invalid_rows.push(label + ': status must be ' + ENUMS.SELLER_DESTINATION_STATUS.join(' or ') + ' (found "' + r.status + '")');
      bad = true;
    }
    if (spreadsheetId !== '' && !SELLER_DESTINATIONS.spreadsheetIdPattern.test(spreadsheetId)) {
      errors.invalid_rows.push(label + ': spreadsheet_id must be a spreadsheet ID (not a URL or name)');
      bad = true;
    }
    protectedIds.forEach(function (p) {
      if (spreadsheetId !== '' && spreadsheetId === trimmedText_(p.id)) {
        errors.master_id_conflicts.push(label + ': spreadsheet_id is ' + p.label + ' and can never be a seller destination');
        bad = true;
      }
    });
    if (status === SELLER_DESTINATIONS.activeStatus && spreadsheetId === '') {
      errors.active_missing_spreadsheet_id.push(label + ': ACTIVE destination for ' + (sellerId || '(blank seller)') + ' has no spreadsheet_id');
      bad = true;
    }
    if (sellerId !== '') (rowsBySeller[sellerId] = rowsBySeller[sellerId] || []).push(r._row || i + 2);
    if (bad) return;
    if (snapshot !== nameById[sellerId]) {
      mismatches.push(label + ': seller_name_snapshot "' + snapshot + '" differs from current name "' + nameById[sellerId] + '"');
    }
    destinations.push({ seller_id: sellerId, seller_name: nameById[sellerId], seller_name_snapshot: snapshot, spreadsheet_id: spreadsheetId,
      status: status, row: r._row || i + 2 });
  });

  Object.keys(rowsBySeller).sort().forEach(function (id) {
    if (rowsBySeller[id].length > 1) errors.duplicate_seller_ids.push(id + ': ' + rowsBySeller[id].length + ' rows (' + rowsBySeller[id].join(', ') + ')');
  });
  const bySheet = {};
  rows.forEach(function (r, i) {
    const id = trimmedText_(r.spreadsheet_id);
    if (id === '') return;
    (bySheet[id] = bySheet[id] || []).push({ seller_id: trimmedText_(r.seller_id), status: trimmedText_(r.status).toUpperCase(), row: r._row || i + 2 });
  });
  Object.keys(bySheet).sort().forEach(function (id) {
    const list = bySheet[id];
    if (list.length < 2) return;
    const active = list.filter(function (x) { return x.status === SELLER_DESTINATIONS.activeStatus; });
    const where = list.map(function (x) { return x.seller_id + ' (row ' + x.row + ', ' + x.status + ')'; }).join(', ');
    // The ID is never echoed in full: only a short prefix to locate it.
    const shortId = id.slice(0, 6) + '...';
    if (active.length > 1) errors.duplicate_spreadsheet_ids.push('spreadsheet_id ' + shortId + ' is ACTIVE for several rows: ' + where);
    else warnings.push('spreadsheet_id ' + shortId + ' appears on several rows (at most one ACTIVE): ' + where);
  });

  const missing = Object.keys(nameById).filter(function (id) { return !rowsBySeller[id]; }).sort();
  if (missing.length > 0) warnings.push('Sellers without a Seller Destinations row (not synced): ' + missing.join(', '));
  if (mismatches.length > 0) warnings.push(mismatches.length + ' seller_name_snapshot value(s) differ from the current seller name.');
  const hasErrors = flattenDestinationErrors_(errors).length > 0;
  return {
    destinations: destinations,
    active: hasErrors ? [] : destinations.filter(function (d) { return d.status === SELLER_DESTINATIONS.activeStatus; }),
    errors: errors, warnings: warnings, missing_sellers: missing, snapshot_name_mismatches: mismatches,
  };
}

/** Initial seed rows (one INACTIVE row per seller with an ID, blank spreadsheet_id) for an EMPTY tab. */
function planSellerDestinationsSeed_(sellers) {
  return sellers.filter(function (s) { return s.seller_id !== ''; })
    .slice().sort(function (a, b) { return a.seller_id < b.seller_id ? -1 : a.seller_id > b.seller_id ? 1 : 0; })
    .map(function (s) {
      return { seller_id: s.seller_id, seller_name_snapshot: s.seller_name, spreadsheet_id: '', status: SELLER_DESTINATIONS.inactiveStatus,
        notes: SELLER_DESTINATIONS.seedNote };
    });
}

/* ---------------------------------- I/O --------------------------------- */

/** Spreadsheets that may never receive seller output: the Master and configured provider sources. */
function sellerDestinationGuard_(ss) {
  const settings = readSettingsMap_();
  const protectedIds = Object.keys(RAW_SOURCES).map(function (k) {
    return { id: String(settings[RAW_SOURCES[k].spreadsheetIdSetting] || ''), label: 'the ' + k + ' provider source spreadsheet' };
  });
  return { masterId: ss.getId(), protectedIds: protectedIds };
}

function readSellerDestinations_(ss) {
  const sheet = ss.getSheetByName(SHEETS.SELLER_DESTINATIONS);
  if (!sheet) throw new Error('Seller Destinations tab not found. Run setupMaster first.');
  const columns = getColumnNames_(SHEETS.SELLER_DESTINATIONS);
  const grid = readSheetGrid_(sheet);
  tableRowsFromGrid_(grid.values, columns, SHEETS.SELLER_DESTINATIONS); // header contract check
  const rows = [];
  grid.values.slice(1).forEach(function (row, i) {
    if (row.every(isBlankCell_)) return;
    const obj = rowToObject_(row.slice(0, columns.length), columns);
    obj._row = i + 2;
    rows.push(obj);
  });
  const sellers = readSellersDraft_(ss).parsed.sellers;
  return { rows: rows, sellers: sellers, parsed: parseSellerDestinations_(rows, sellers, sellerDestinationGuard_(ss)) };
}

/**
 * Setup-only: seeds Seller Destinations when (and only when) it has no data rows.
 * @return {number} rows seeded
 */
function seedSellerDestinationsIfEmpty_(ss, warnings) {
  const sheet = ss.getSheetByName(SHEETS.SELLER_DESTINATIONS);
  if (!sheet) return 0;
  const columns = getColumnNames_(SHEETS.SELLER_DESTINATIONS);
  const grid = readSheetGrid_(sheet);
  if (grid.values.slice(1).some(function (row) { return !row.every(isBlankCell_); })) return 0;
  let plan;
  try {
    plan = planSellerDestinationsSeed_(readSellersDraft_(ss).parsed.sellers);
  } catch (err) {
    warnings.push('Seller Destinations not seeded: ' + (err && err.message ? err.message : String(err)));
    return 0;
  }
  if (plan.length === 0) return 0;
  const rows = plan.map(function (d) { return objectToRow_(d, columns); });
  if (sheet.getMaxRows() < rows.length + 1) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
  sheet.getRange(2, 1, rows.length, columns.length).setValues(rows);
  return rows.length;
}

/** Read-only Seller Destinations report. */
function buildSellerDestinationsReport_() {
  const report = { seller_count: 0, destination_rows: 0, active_destinations: 0, inactive_destinations: 0, missing_sellers: [],
    unknown_sellers: [], duplicate_seller_ids: [], duplicate_spreadsheet_ids: [], master_id_conflicts: [], active_missing_spreadsheet_id: [],
    invalid_rows: [], snapshot_name_mismatches: [], pass: false, errors: [], warnings: [] };
  try {
    const d = readSellerDestinations_(getSpreadsheet_());
    const p = d.parsed;
    report.seller_count = d.sellers.filter(function (s) { return s.seller_id !== ''; }).length;
    report.destination_rows = d.rows.length;
    report.active_destinations = p.destinations.filter(function (x) { return x.status === SELLER_DESTINATIONS.activeStatus; }).length;
    report.inactive_destinations = p.destinations.filter(function (x) { return x.status === SELLER_DESTINATIONS.inactiveStatus; }).length;
    report.missing_sellers = p.missing_sellers;
    report.snapshot_name_mismatches = p.snapshot_name_mismatches;
    Object.keys(p.errors).forEach(function (k) { report[k] = p.errors[k]; });
    const errors = flattenDestinationErrors_(p.errors);
    if (errors.length > 0) report.errors.push('Seller Destinations has ' + errors.length + ' error(s); syncSellerSheets will not write anything.');
    report.warnings = p.warnings;
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0;
  return redactDeep_(report);
}
