/**
 * Utils.gs
 * Small, generic helpers shared by all modules.
 */

function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/** Returns the schema entry for a tab name, or null. */
function getTableSchema_(sheetName) {
  return SCHEMA.find(function (t) { return t.sheet === sheetName; }) || null;
}

/** Returns the column names for a tab, in order. */
function getColumnNames_(sheetName) {
  const table = getTableSchema_(sheetName);
  if (!table) throw new Error('Unknown table: ' + sheetName);
  return table.columns.map(function (c) { return c.name; });
}

/** Returns the 1-based column index of a column in a schema tab. */
function getColumnIndex_(sheetName, columnName) {
  const index = getColumnNames_(sheetName).indexOf(columnName);
  if (index < 0) throw new Error('Unknown column "' + columnName + '" in table ' + sheetName);
  return index + 1;
}

/** Converts a 1-based column index to an A1 column letter (1 -> A, 27 -> AA). */
function columnLetter_(index) {
  let letter = '';
  let n = index;
  while (n > 0) {
    const mod = (n - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

/** Returns an A1 reference to an open-ended data column, e.g. 'Transactions'!J2:J. */
function dataColumnRef_(sheetName, columnName) {
  const letter = columnLetter_(getColumnIndex_(sheetName, columnName));
  return "'" + sheetName.replace(/'/g, "''") + "'!" + letter + '2:' + letter;
}

/** Reads row 1 of a sheet and strips trailing blank cells. */
function readHeaderRow_(sheet) {
  const lastColumn = sheet.getLastColumn();
  if (lastColumn === 0) return [];
  const row = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  while (row.length > 0 && String(row[row.length - 1]).trim() === '') row.pop();
  return row.map(function (v) { return String(v).trim(); });
}

function arraysEqual_(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
