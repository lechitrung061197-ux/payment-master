/**
 * Settings.gs
 * Read-only access to the Settings tab (key/value).
 */

/** Reads all Settings into a plain object { key: value }. */
function readSettingsMap_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.SETTINGS);
  if (!sheet) throw new Error('Settings tab not found. Run setupMaster first.');
  const lastRow = sheet.getLastRow();
  const map = {};
  if (lastRow < 2) return map;

  const keyCol = getColumnIndex_(SHEETS.SETTINGS, 'key');
  const valueCol = getColumnIndex_(SHEETS.SETTINGS, 'value');
  const width = Math.max(keyCol, valueCol);
  sheet.getRange(2, 1, lastRow - 1, width).getValues().forEach(function (row) {
    const key = String(row[keyCol - 1]).trim();
    if (key) map[key] = typeof row[valueCol - 1] === 'string' ? row[valueCol - 1].trim() : row[valueCol - 1];
  });
  return map;
}

/** Returns a non-blank setting value or throws a descriptive error. */
function getRequiredSetting_(settings, key) {
  const value = settings[key];
  if (value === undefined || value === null || value === '') {
    throw new Error('Missing required setting "' + key + '" in Settings.');
  }
  return value;
}

function isSettingEnabled_(value) {
  return value === true || String(value).trim().toUpperCase() === 'TRUE';
}
