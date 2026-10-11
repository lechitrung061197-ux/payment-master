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
    // Hidden staging tabs are expected; a leftover __SWAP_ tab is reported here.
    extraTabs: actual.filter(function (n) {
      return expected.indexOf(n) < 0 && n.indexOf(STAGING_SHEET_PREFIX) !== 0;
    }),
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

/* ---------------------------------------------------------------------------
 * KH001 raw sync (RAW INGESTION ONLY: no normalization, matching or accounting)
 * ------------------------------------------------------------------------- */

/** Syncs all KH001 raw tabs. One tab failing does not stop the others. */
function syncKh001Raw() {
  const summary = syncRawSource_(RAW_SOURCES.KH001);
  Logger.log(JSON.stringify(summary, null, 2));
  return summary;
}

function syncKh001RawPayPal() {
  return runSingleRawTab_(RAW_SOURCES.KH001, SHEETS.RAW_KH001_PAYPAL);
}

function syncKh001RawReconciled() {
  return runSingleRawTab_(RAW_SOURCES.KH001, SHEETS.RAW_KH001_RECONCILED);
}

function syncKh001RawSettlements() {
  return runSingleRawTab_(RAW_SOURCES.KH001, SHEETS.RAW_KH001_SETTLEMENTS);
}

function syncKh001RawDisputes() {
  return runSingleRawTab_(RAW_SOURCES.KH001, SHEETS.RAW_KH001_DISPUTES);
}

/** Read-only: compares each KH001 source tab with its raw target tab. */
function verifyKh001RawSync() {
  const report = verifyRawSource_(RAW_SOURCES.KH001);
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

function runSingleRawTab_(source, targetSheet) {
  const tab = source.tabs.find(function (t) { return t.targetSheet === targetSheet; });
  if (!tab) throw new Error('No raw tab configured for target ' + targetSheet);
  const result = syncRawTab_(source, tab);
  const summary = { provider: source.providerId };
  summary[result.sourceSheet || targetSheet] = result.status;
  if (result.error) summary.error = result.error;
  Logger.log(JSON.stringify(summary, null, 2));
  return summary;
}

/* ---------------------------------------------------------------------------
 * KH001 Provider Transactions (canonical PAYMENT rows; no fees, holds or matching)
 * ------------------------------------------------------------------------- */

/** Rebuilds the KH001 partition of Provider Transactions from Master raw tabs. */
function normalizeKh001ProviderTransactions() {
  const result = runKh001ProviderTransactionsNormalizer_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Read-only: checks Provider Transactions (KH001) against the current raw snapshot. */
function verifyKh001ProviderTransactions() {
  const report = buildKh001ProviderTransactionsReport_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/* ---------------------------------------------------------------------------
 * KH001 Provider Events (signed PayPal ledger events; no settlements or holds)
 * ------------------------------------------------------------------------- */

/** Rebuilds the KH001 partition of Provider Events from Raw KH001 PayPal. */
function normalizeKh001ProviderEvents() {
  const result = runKh001ProviderEventsNormalizer_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Read-only: checks Provider Events (KH001) against the current raw snapshot. */
function verifyKh001ProviderEvents() {
  const report = buildKh001ProviderEventsReport_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/* ---------------------------------------------------------------------------
 * KH001 Settlements (provider settlement headers only; no items or seller effects)
 * ------------------------------------------------------------------------- */

/** Rebuilds the KH001 partition of Settlements from Master raw tabs. */
function normalizeKh001Settlements() {
  const result = runKh001SettlementsNormalizer_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Read-only: checks Settlements (KH001) against the current raw snapshot. */
function verifyKh001Settlements() {
  const report = buildKh001SettlementsReport_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/* ---------------------------------------------------------------------------
 * Seller / endpoint mapping (ownership history; no seller economics)
 * ------------------------------------------------------------------------- */

/** Publishes the Sellers draft into effective-dated Endpoint Mapping history. */
function publishSellerMapping() {
  const result = runPublishSellerMapping_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Read-only: validates the Sellers draft and Endpoint Mapping history. */
function verifySellerMapping() {
  const report = buildSellerMappingReport_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/* ---------------------------------------------------------------------------
 * One-time endpoint key correction (Phase 2E.1): full credentials -> endpoint tokens
 * ------------------------------------------------------------------------- */

/** Guarded one-time migration of Sellers / Endpoint Mapping keys to endpoint tokens. */
function migrateSellerEndpointKeysToTokens() {
  const result = runEndpointKeyMigration_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Read-only: endpoint key token state, legacy key counts and migration safety. */
function verifySellerEndpointKeys() {
  const report = verifyEndpointKeyState_(getSpreadsheet_());
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/** Security exception: redacts endpoint credentials in existing Audit Log cells (logs SECURITY_REDACTION). */
function redactAuditLogCredentials() {
  const result = runAuditLogCredentialRedaction_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Read-only: counts rows still holding credential-like values in Audit Log, Sellers, Endpoint Mapping. */
function verifyCredentialExposure() {
  const report = buildCredentialExposureReport_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/* ---------------------------------------------------------------------------
 * Internal transactions (raw CSV evidence -> Source System -> Transactions)
 * ------------------------------------------------------------------------- */

/** Rebuilds Source System and Transactions from Raw Internal Transactions. */
function normalizeInternalTransactions() {
  const result = runInternalNormalizer_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Read-only: checks raw contract, snapshot selection, ownership and both canonical tables. */
function verifyInternalTransactions() {
  const report = buildInternalTransactionsReport_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}
