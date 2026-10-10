/**
 * Main.gs
 * Public entry points. Run these from the Apps Script editor.
 * Functions ending with "_" are private helpers and are hidden from the Run menu.
 */

/** Creates/updates all Master tabs, headers, formats and default Settings. Safe to re-run. */
function setupMaster() {
  const result = runSetup_();
  Logger.log('Setup complete for spreadsheet %s', result.spreadsheetId);
  Logger.log('Migrated tabs: %s', JSON.stringify(result.migratedTabs));
  Logger.log('Renamed Settings keys: %s', JSON.stringify(result.renamedSettingKeys));
  if (result.warnings.length > 0) {
    Logger.log('WARNINGS:\n%s', result.warnings.join('\n'));
  }
}

/** Logs a read-only verification report of the Master spreadsheet. */
function verifyMaster() {
  const ss = getSpreadsheet_();
  const expected = Object.keys(SHEETS).map(function (k) { return SHEETS[k]; });
  const actual = ss.getSheets().map(function (s) { return s.getName(); });

  const headerIssues = SCHEMA
    .filter(function (t) {
      const sheet = ss.getSheetByName(t.sheet);
      return !sheet || !arraysEqual_(readHeaderRow_(sheet), getColumnNames_(t.sheet));
    })
    .map(function (t) { return t.sheet; });

  const dataRowCounts = {};
  SCHEMA.forEach(function (t) {
    const sheet = ss.getSheetByName(t.sheet);
    dataRowCounts[t.sheet] = sheet ? Math.max(sheet.getLastRow() - 1, 0) : null;
  });

  const settingsSheet = ss.getSheetByName(SHEETS.SETTINGS);
  const settingKeys = settingsSheet ? readSettingKeys_(settingsSheet) : [];
  const schemaVersion = settingsSheet ? readSettingValue_(ss, 'schema_version') : null;

  const report = {
    name: ss.getName(),
    id: ss.getId(),
    url: ss.getUrl(),
    locale: ss.getSpreadsheetLocale(),
    spreadsheetTimeZone: ss.getSpreadsheetTimeZone(),
    scriptTimeZone: Session.getScriptTimeZone(),
    tabs: actual,
    missingTabs: expected.filter(function (n) { return actual.indexOf(n) < 0; }),
    extraTabs: actual.filter(function (n) { return expected.indexOf(n) < 0; }),
    headerIssues: headerIssues,
    schemaVersion: { expected: APP.SCHEMA_VERSION, actual: schemaVersion },
    missingSettings: DEFAULT_SETTINGS
      .map(function (d) { return d[0]; })
      .filter(function (k) { return settingKeys.indexOf(k) < 0; }),
    legacySettings: SETTING_KEY_RENAMES
      .map(function (r) { return r[0]; })
      .filter(function (k) { return settingKeys.indexOf(k) >= 0; }),
    dataRowCounts: dataRowCounts,
  };

  Logger.log(JSON.stringify(report, null, 2));
  return report;
}
