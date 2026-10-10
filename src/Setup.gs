/**
 * Setup.gs
 * Builds and formats the Master spreadsheet from SCHEMA.
 *
 * Setup is idempotent and non-destructive:
 * - Missing tabs are created; existing tabs are never deleted.
 * - Headers are written only on an empty header row. A header row that differs from
 *   the schema is reported as a warning and that tab is left untouched.
 * - Settings rows are added only for keys that do not exist yet.
 */

const HEADER_BACKGROUND = '#f3f3f3';
const HEADER_PROTECTION_DESCRIPTION = 'Schema header row (managed by Setup.gs)';

const COLUMN_WIDTHS = Object.freeze({
  ID: 170,
  TEXT: 200,
  GENERAL: 160,
  ENUM: 150,
  DATE: 110,
  DATETIME: 150,
  USD: 120,
  AMOUNT: 120,
  RATE: 100,
  FX_RATE: 100,
  INTEGER: 90,
});

/** Runs the full Master setup. Returns a summary object. */
function runSetup_() {
  const ss = getSpreadsheet_();
  const warnings = [];

  ss.setSpreadsheetLocale(APP.LOCALE);
  ss.setSpreadsheetTimeZone(APP.TIMEZONE);

  adoptDefaultSheet_(ss);
  SCHEMA.forEach(function (table) { ensureTable_(ss, table, warnings); });
  ensureDashboard_(ss);
  orderSheets_(ss);
  seedSettings_(ss);
  SpreadsheetApp.flush();

  appendAuditLog_({
    action: 'SCHEMA_SETUP',
    entityType: 'SPREADSHEET',
    entityId: ss.getId(),
    newStatus: 'SCHEMA_V' + APP.SCHEMA_VERSION,
    details: { warnings: warnings },
  });

  return { spreadsheetId: ss.getId(), warnings: warnings };
}

/**
 * A brand-new spreadsheet has one empty default tab ("Sheet1" or a localized name).
 * Rename it to the first schema tab instead of deleting anything.
 */
function adoptDefaultSheet_(ss) {
  const sheets = ss.getSheets();
  if (sheets.length !== 1) return;
  const sheet = sheets[0];
  const schemaNames = Object.keys(SHEETS).map(function (k) { return SHEETS[k]; });
  if (schemaNames.indexOf(sheet.getName()) >= 0) return;
  if (sheet.getLastRow() !== 0 || sheet.getLastColumn() !== 0) return;
  sheet.setName(SHEETS.SETTINGS);
}

function ensureTable_(ss, table, warnings) {
  const sheet = ss.getSheetByName(table.sheet) || ss.insertSheet(table.sheet);
  const headers = table.columns.map(function (c) { return c.name; });
  const existing = readHeaderRow_(sheet);

  if (existing.length === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else if (!arraysEqual_(existing, headers)) {
    warnings.push('Header mismatch on "' + table.sheet + '"; tab left unchanged.');
    return;
  }

  trimEmptyColumns_(sheet, headers.length);
  formatHeader_(sheet, headers.length);
  formatColumns_(sheet, table.columns);
  ensureFilter_(sheet, headers.length);
  protectHeader_(sheet, headers.length);
  sheet.getRange(1, 1).setNote(table.description);
}

/** Removes empty columns to the right of the table so tabs stay compact. */
function trimEmptyColumns_(sheet, columnCount) {
  const maxColumns = sheet.getMaxColumns();
  if (maxColumns > columnCount && sheet.getLastColumn() <= columnCount) {
    sheet.deleteColumns(columnCount + 1, maxColumns - columnCount);
  }
}

function formatHeader_(sheet, columnCount) {
  sheet.getRange(1, 1, 1, columnCount)
    .setNumberFormat('@')
    .setFontWeight('bold')
    .setBackground(HEADER_BACKGROUND)
    .setVerticalAlignment('middle')
    .setBorder(null, null, true, null, null, null);
  sheet.setFrozenRows(1);
}

function formatColumns_(sheet, columns) {
  const dataRows = sheet.getMaxRows() - 1;
  if (dataRows < 1) return;

  columns.forEach(function (column, i) {
    const range = sheet.getRange(2, i + 1, dataRows, 1);
    const format = FORMATS[column.type];
    if (format) range.setNumberFormat(format);

    if (column.type === COL_TYPE.ENUM && column.values) {
      range.setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(column.values, true)
        .setAllowInvalid(false)
        .setHelpText('Allowed: ' + column.values.join(', '))
        .build());
    }

    sheet.setColumnWidth(i + 1, COLUMN_WIDTHS[column.type] || 140);
  });
}

function ensureFilter_(sheet, columnCount) {
  if (sheet.getFilter()) return;
  sheet.getRange(1, 1, sheet.getMaxRows(), columnCount).createFilter();
}

/** Warning-only protection: editors can still edit, but get a confirmation prompt. */
function protectHeader_(sheet, columnCount) {
  const exists = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).some(function (p) {
    return p.getDescription() === HEADER_PROTECTION_DESCRIPTION;
  });
  if (exists) return;
  sheet.getRange(1, 1, 1, columnCount).protect()
    .setDescription(HEADER_PROTECTION_DESCRIPTION)
    .setWarningOnly(true);
}

/**
 * Dashboard skeleton. Written only when the tab is empty so later manual or
 * scripted changes are never overwritten.
 */
function ensureDashboard_(ss) {
  const sheet = ss.getSheetByName(SHEETS.DASHBOARD) || ss.insertSheet(SHEETS.DASHBOARD);
  if (sheet.getLastRow() > 0) return;

  const txStatus = dataColumnRef_(SHEETS.TRANSACTIONS, 'status');
  const txId = dataColumnRef_(SHEETS.TRANSACTIONS, 'internal_transaction_id');
  const disputeStatus = dataColumnRef_(SHEETS.DISPUTES, 'dispute_status');
  const notYet = 'Not implemented yet (later phase)';

  const rows = [
    ['Total transactions', '=COUNTA(' + txId + ')', 'Count of Transactions rows'],
    ['Matched', '=COUNTIF(' + txStatus + ',"MATCHED")', 'Transactions.status = MATCHED'],
    ['Waiting settlement', '=COUNTIF(' + txStatus + ',"WAITING_SETTLEMENT")', 'Transactions.status = WAITING_SETTLEMENT'],
    ['Available (USD)', '', notYet],
    ['Seller balances (USD)', '', notYet],
    ['Provider settlements (USD)', '', notYet],
    ['System margin (USD)', '', notYet],
    ['Holds (USD)', '', notYet],
    ['Open disputes', '=COUNTIF(' + disputeStatus + ',"OPEN")+COUNTIF(' + disputeStatus + ',"UNDER_REVIEW")',
      'Disputes.dispute_status in OPEN, UNDER_REVIEW'],
  ];

  sheet.getRange('A1').setValue(APP.NAME + ' Dashboard').setFontWeight('bold').setFontSize(14);
  sheet.getRange('A2').setValue('Skeleton only. Financial metrics are added in a later phase.')
    .setFontColor('#666666');

  sheet.getRange(4, 1, 1, 3).setValues([['Metric', 'Value', 'Definition']])
    .setFontWeight('bold')
    .setBackground(HEADER_BACKGROUND)
    .setBorder(null, null, true, null, null, null);

  const body = sheet.getRange(5, 1, rows.length, 3);
  body.setValues(rows.map(function (r) { return [r[0], '', r[2]]; }));
  rows.forEach(function (r, i) {
    if (r[1]) sheet.getRange(5 + i, 2).setFormula(r[1]).setNumberFormat(FORMATS.INTEGER);
  });
  sheet.getRange(5, 3, rows.length, 1).setFontColor('#666666');

  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 140);
  sheet.setColumnWidth(3, 320);
}

function orderSheets_(ss) {
  const order = Object.keys(SHEETS).map(function (k) { return SHEETS[k]; });
  order.forEach(function (name, i) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(i + 1);
  });
  ss.setActiveSheet(ss.getSheets()[0]);
}

/** Appends default Settings rows whose key is not present yet. */
function seedSettings_(ss) {
  const sheet = ss.getSheetByName(SHEETS.SETTINGS);
  const keyCol = getColumnIndex_(SHEETS.SETTINGS, 'key');
  const typeCol = getColumnIndex_(SHEETS.SETTINGS, 'value_type');
  const valueCol = getColumnIndex_(SHEETS.SETTINGS, 'value');

  const lastRow = sheet.getLastRow();
  const existingKeys = lastRow > 1
    ? sheet.getRange(2, keyCol, lastRow - 1, 1).getValues().map(function (r) { return String(r[0]); })
    : [];

  const now = new Date();
  const newRows = DEFAULT_SETTINGS
    .filter(function (s) { return existingKeys.indexOf(s[0]) < 0; })
    .map(function (s) { return [s[0], s[1], s[2], s[3], now]; });

  if (newRows.length > 0) {
    sheet.getRange(lastRow + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
  }

  // Show RATE values as percentages; leave other values unformatted.
  const total = sheet.getLastRow() - 1;
  if (total < 1) return;
  const types = sheet.getRange(2, typeCol, total, 1).getValues();
  types.forEach(function (r, i) {
    if (r[0] === 'RATE') sheet.getRange(2 + i, valueCol).setNumberFormat(FORMATS.RATE);
  });
}
