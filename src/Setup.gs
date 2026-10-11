/**
 * Setup.gs
 * Builds and formats the Master spreadsheet from SCHEMA.
 *
 * Setup is idempotent and non-destructive:
 * - Missing tabs are created; existing tabs are never deleted.
 * - A header row that differs from the schema is migrated only when the tab has no
 *   data rows. A tab with data rows and a different header is reported as a warning
 *   and left untouched.
 * - Renamed Settings keys are migrated in place (value kept); other Settings rows are
 *   added only for keys that do not exist yet.
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
  AMOUNT4: 130,
  RATE: 100,
  FX_RATE: 100,
  INTEGER: 90,
});

/** Runs the full Master setup. Returns a summary object. */
function runSetup_() {
  const ss = getSpreadsheet_();
  const warnings = [];
  const migratedTabs = [];

  ss.setSpreadsheetLocale(APP.LOCALE);
  ss.setSpreadsheetTimeZone(APP.TIMEZONE);

  adoptDefaultSheet_(ss);
  SCHEMA.forEach(function (table) { ensureTable_(ss, table, warnings, migratedTabs); });
  ensureRawTargetTabs_(ss);
  ensureDashboard_(ss);
  orderSheets_(ss);
  const oldSchemaVersion = readSettingValue_(ss, 'schema_version');
  const renamedKeys = migrateSettingKeys_(ss, warnings);
  seedSettings_(ss);
  SpreadsheetApp.flush();

  appendAuditLog_({
    action: 'SCHEMA_SETUP',
    entityType: 'SPREADSHEET',
    entityId: ss.getId(),
    oldStatus: oldSchemaVersion === null ? '' : 'SCHEMA_V' + oldSchemaVersion,
    newStatus: 'SCHEMA_V' + APP.SCHEMA_VERSION,
    details: { migratedTabs: migratedTabs, renamedSettingKeys: renamedKeys, warnings: warnings },
  });

  return {
    spreadsheetId: ss.getId(),
    migratedTabs: migratedTabs,
    renamedSettingKeys: renamedKeys,
    warnings: warnings,
  };
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

function ensureTable_(ss, table, warnings, migratedTabs) {
  const sheet = ss.getSheetByName(table.sheet) || ss.insertSheet(table.sheet);
  const headers = table.columns.map(function (c) { return c.name; });
  const existing = readHeaderRow_(sheet);
  const headerMatches = arraysEqual_(existing, headers);

  if (existing.length > 0 && !headerMatches) {
    if (sheet.getLastRow() > 1) {
      warnings.push('Header mismatch on "' + table.sheet + '" with data rows; tab left unchanged.');
      return;
    }
    resetEmptyTable_(sheet);
    migratedTabs.push(table.sheet);
  }

  fitColumnCount_(sheet, headers.length);
  if (!headerMatches) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  formatHeader_(sheet, headers.length);
  if (table.frozenColumns) sheet.setFrozenColumns(table.frozenColumns);
  formatColumns_(sheet, table.columns);
  ensureFilter_(sheet, headers.length);
  protectHeader_(sheet, headers.length);
  sheet.getRange(1, 1).setNote(table.description);
}

/**
 * Clears the header row, filter, managed header protection and all data validation
 * of a tab that has no data rows, so a new header layout can be applied cleanly.
 */
function resetEmptyTable_(sheet) {
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  getHeaderProtections_(sheet).forEach(function (p) { p.remove(); });
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearDataValidations();
  sheet.getRange(1, 1, 1, sheet.getMaxColumns()).clearContent().clearNote();
}

/** Adds missing columns, and removes empty columns to the right of the table. */
function fitColumnCount_(sheet, columnCount) {
  const maxColumns = sheet.getMaxColumns();
  if (maxColumns < columnCount) {
    sheet.insertColumnsAfter(maxColumns, columnCount - maxColumns);
  } else if (maxColumns > columnCount && sheet.getLastColumn() <= columnCount) {
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
    } else {
      range.clearDataValidations();
    }

    sheet.setColumnWidth(i + 1, COLUMN_WIDTHS[column.type] || 140);
  });
}

function ensureFilter_(sheet, columnCount) {
  const filter = sheet.getFilter();
  if (filter && filter.getRange().getNumColumns() === columnCount) return;
  if (filter) filter.remove();
  sheet.getRange(1, 1, sheet.getMaxRows(), columnCount).createFilter();
}

function getHeaderProtections_(sheet) {
  return sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).filter(function (p) {
    return p.getDescription() === HEADER_PROTECTION_DESCRIPTION;
  });
}

/** Warning-only protection: editors can still edit, but get a confirmation prompt. */
function protectHeader_(sheet, columnCount) {
  const existing = getHeaderProtections_(sheet);
  if (existing.length === 1 && existing[0].getRange().getNumColumns() === columnCount) return;
  existing.forEach(function (p) { p.remove(); });
  sheet.getRange(1, 1, 1, columnCount).protect()
    .setDescription(HEADER_PROTECTION_DESCRIPTION)
    .setWarningOnly(true);
}

/**
 * Creates empty raw target tabs that do not exist yet. Their content is managed
 * only by raw sync (RawSync.gs); setup never writes or clears them.
 */
function ensureRawTargetTabs_(ss) {
  Object.keys(RAW_SOURCES).forEach(function (k) {
    RAW_SOURCES[k].tabs.forEach(function (tab) {
      if (!ss.getSheetByName(tab.targetSheet)) ss.insertSheet(tab.targetSheet);
    });
  });
}

/**
 * Dashboard metric rows: [label, formula builder or null, definition].
 * Formulas reference tabs by NAME through INDIRECT, so they keep working when a tab is
 * replaced by a crash-safe swap (a direct reference would follow the old sheet object).
 */
function dashboardMetrics_() {
  const col = function (sheetName, columnName) {
    return 'INDIRECT("' + dataColumnRef_(sheetName, columnName).replace(/"/g, '""') + '")';
  };
  const txStatus = col(SHEETS.TRANSACTIONS, 'status');
  const disputeStatus = col(SHEETS.DISPUTES, 'dispute_status');
  const notYet = 'Not implemented yet (later phase)';
  return [
    ['Total transactions', '=COUNTA(' + col(SHEETS.TRANSACTIONS, 'internal_transaction_id') + ')', 'Count of Transactions rows'],
    ['Matched', '=COUNTIF(' + col(SHEETS.PAYMENT_MATCHES, 'reconciliation_status') + ',"MATCHED")',
      'Payment Matches.reconciliation_status = MATCHED'],
    ['Waiting settlement', '=COUNTIF(' + txStatus + ',"WAITING_SETTLEMENT")', 'Transactions.status = WAITING_SETTLEMENT'],
    ['Available (USD)', null, notYet],
    ['Seller balances (USD)', null, notYet],
    ['Provider settlements (USD)', null, notYet],
    ['System margin (USD)', null, notYet],
    ['Holds (USD)', null, notYet],
    ['Open disputes', '=COUNTIF(' + disputeStatus + ',"OPEN")+COUNTIF(' + disputeStatus + ',"UNDER_REVIEW")',
      'Disputes.dispute_status in OPEN, UNDER_REVIEW'],
  ];
}

/**
 * Dashboard skeleton. The layout is written only when the tab is empty; the formulas of the
 * known metric rows (matched by label in column A) are refreshed on every setup so they track
 * schema changes.
 */
function ensureDashboard_(ss) {
  const sheet = ss.getSheetByName(SHEETS.DASHBOARD) || ss.insertSheet(SHEETS.DASHBOARD);
  const metrics = dashboardMetrics_();

  if (sheet.getLastRow() === 0) {
    sheet.getRange('A1').setValue(APP.NAME + ' Dashboard').setFontWeight('bold').setFontSize(14);
    sheet.getRange('A2').setValue('Skeleton only. Financial metrics are added in a later phase.')
      .setFontColor('#666666');
    sheet.getRange(4, 1, 1, 3).setValues([['Metric', 'Value', 'Definition']])
      .setFontWeight('bold')
      .setBackground(HEADER_BACKGROUND)
      .setBorder(null, null, true, null, null, null);
    sheet.getRange(5, 1, metrics.length, 3).setValues(metrics.map(function (m) { return [m[0], '', m[2]]; }));
    sheet.getRange(5, 3, metrics.length, 1).setFontColor('#666666');
    sheet.setColumnWidth(1, 220);
    sheet.setColumnWidth(2, 140);
    sheet.setColumnWidth(3, 320);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 5) return;
  const labels = sheet.getRange(5, 1, lastRow - 4, 1).getValues().map(function (r) { return String(r[0]); });
  metrics.forEach(function (m) {
    const i = labels.indexOf(m[0]);
    if (i < 0 || !m[1]) return;
    sheet.getRange(5 + i, 2).setFormula(m[1]).setNumberFormat(FORMATS.INTEGER);
  });
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

/** Returns Settings keys in sheet order (index 0 = row 2). */
function readSettingKeys_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const keyCol = getColumnIndex_(SHEETS.SETTINGS, 'key');
  return sheet.getRange(2, keyCol, lastRow - 1, 1).getValues().map(function (r) { return String(r[0]); });
}

/** Returns a Settings value by key, or null when the key does not exist. */
function readSettingValue_(ss, key) {
  const sheet = ss.getSheetByName(SHEETS.SETTINGS);
  const index = readSettingKeys_(sheet).indexOf(key);
  if (index < 0) return null;
  return sheet.getRange(2 + index, getColumnIndex_(SHEETS.SETTINGS, 'value')).getValue();
}

function findDefaultSetting_(key) {
  return DEFAULT_SETTINGS.find(function (s) { return s[0] === key; }) || null;
}

/**
 * Renames Settings keys listed in SETTING_KEY_RENAMES. The existing value is kept;
 * the description is replaced with the new default description.
 * Returns the list of applied renames.
 */
function migrateSettingKeys_(ss, warnings) {
  const sheet = ss.getSheetByName(SHEETS.SETTINGS);
  const keys = readSettingKeys_(sheet);
  const applied = [];

  SETTING_KEY_RENAMES.forEach(function (rename) {
    const oldIndex = keys.indexOf(rename[0]);
    if (oldIndex < 0) return;
    if (keys.indexOf(rename[1]) >= 0) {
      warnings.push('Settings has both "' + rename[0] + '" and "' + rename[1] + '"; not renamed.');
      return;
    }
    const row = 2 + oldIndex;
    const defaults = findDefaultSetting_(rename[1]);
    sheet.getRange(row, getColumnIndex_(SHEETS.SETTINGS, 'key')).setValue(rename[1]);
    if (defaults) sheet.getRange(row, getColumnIndex_(SHEETS.SETTINGS, 'description')).setValue(defaults[3]);
    sheet.getRange(row, getColumnIndex_(SHEETS.SETTINGS, 'updated_at')).setValue(new Date());
    keys[oldIndex] = rename[1];
    applied.push(rename[0] + ' -> ' + rename[1]);
  });

  return applied;
}

/**
 * Appends default Settings rows whose key is not present yet, and syncs the values of
 * MANAGED_SETTING_KEYS with code.
 */
function seedSettings_(ss) {
  const sheet = ss.getSheetByName(SHEETS.SETTINGS);
  const typeCol = getColumnIndex_(SHEETS.SETTINGS, 'value_type');
  const valueCol = getColumnIndex_(SHEETS.SETTINGS, 'value');
  const updatedCol = getColumnIndex_(SHEETS.SETTINGS, 'updated_at');

  const lastRow = sheet.getLastRow();
  const existingKeys = readSettingKeys_(sheet);
  const now = new Date();

  MANAGED_SETTING_KEYS.forEach(function (key) {
    const index = existingKeys.indexOf(key);
    const defaults = findDefaultSetting_(key);
    if (index < 0 || !defaults) return;
    const valueCell = sheet.getRange(2 + index, valueCol);
    if (String(valueCell.getValue()) !== String(defaults[1])) {
      valueCell.setValue(defaults[1]);
      sheet.getRange(2 + index, updatedCol).setValue(now);
    }
  });

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
