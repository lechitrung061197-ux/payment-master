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
  Logger.log('Legacy tabs removed: %s; kept: %s', JSON.stringify(result.removedLegacyTabs), JSON.stringify(result.keptLegacyTabs));
  if (result.warnings.length > 0) {
    Logger.log('WARNINGS:\n%s', result.warnings.join('\n'));
  }
}

/** Logs a read-only verification report of the Master spreadsheet. */
function verifyMaster() {
  const ss = getSpreadsheet_();
  const expected = Object.keys(SHEETS).map(function (k) { return SHEETS[k]; });
  const actual = ss.getSheets().map(function (s) { return s.getName(); });
  const legacy = LEGACY_TABS.map(function (t) { return t.sheet; });

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
      return expected.indexOf(n) < 0 && legacy.indexOf(n) < 0 && n.indexOf(STAGING_SHEET_PREFIX) !== 0;
    }),
    // Tabs removed from the schema but still present (setupMaster keeps one that is not provably unused).
    legacyTabs: actual.filter(function (n) { return legacy.indexOf(n) >= 0; }),
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

/* ---------------------------------------------------------------------------
 * Exact internal <-> provider reconciliation (Payment Matches only)
 * ------------------------------------------------------------------------- */

/** Rebuilds Payment Matches from Transactions + Provider Transactions (exact key + amount). */
function reconcilePayments() {
  const result = runPaymentReconciliation_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Read-only: compares Payment Matches with a fresh exact reconciliation. */
function verifyPaymentReconciliation() {
  const report = buildPaymentReconciliationReport_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/* ---------------------------------------------------------------------------
 * Payment Legs (KH001 actual provider economics, settlement availability, effective-dated seller
 * economics from Seller Terms with seller hold mirroring the provider hold; refunds/disputes out of scope)
 * ------------------------------------------------------------------------- */

/** Rebuilds Payment Legs from confirmed Payment Matches, Provider Transactions, DoiSoat and Settlements. */
function normalizePaymentLegs() {
  const result = runPaymentLegsNormalizer_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Read-only: checks Payment Legs against a fresh build and its upstream inputs. */
function verifyPaymentLegs() {
  const report = buildPaymentLegsReport_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/* ---------------------------------------------------------------------------
 * Seller Terms (effective-dated seller fee history)
 * ------------------------------------------------------------------------- */

/** Read-only: validates Seller Terms (rates, dates, overlaps, sellers). */
function verifySellerTerms() {
  const report = buildSellerTermsReport_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/* ---------------------------------------------------------------------------
 * Settlement Items (frozen accounting) and Seller Balances (derived)
 * ------------------------------------------------------------------------- */

/** Freezes Settlement Items for new AVAILABLE Payment Legs (existing items never change). */
function normalizeSettlementItems() {
  const result = runSettlementItemsNormalizer_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Read-only: checks Settlement Items against Payment Legs and its frozen-history rules. */
function verifySettlementItems() {
  const report = buildSettlementItemsReport_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/** Rebuilds Seller Balances from Settlement Items, APPLIED Adjustments and SENT/CONFIRMED payouts. */
function normalizeSellerBalances() {
  const result = runSellerBalancesNormalizer_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Read-only: checks Seller Balances against its sources. */
function verifySellerBalances() {
  const report = buildSellerBalancesReport_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/* ---------------------------------------------------------------------------
 * Seller child spreadsheets (output-only projections of Payment Master)
 * ------------------------------------------------------------------------- */

/** Read-only: validates Seller Destinations (sellers, ACTIVE spreadsheet IDs, leak-risk conflicts). */
function verifySellerDestinations() {
  const report = buildSellerDestinationsReport_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/** Publishes the current Master projection to every ACTIVE seller child spreadsheet. */
function syncSellerSheets() {
  const result = runSellerSheetsSync_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Read-only: checks every ACTIVE seller child spreadsheet against the current Master projection. */
function verifySellerSheets() {
  const report = buildSellerSheetsReport_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/** Provisions one seller child sheet from the template (clone or reuse -> register -> sync -> verify -> ACTIVE). */
function createSellerSheet(sellerId) {
  const result = runCreateSellerSheet_(sellerId);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Syncs exactly one ACTIVE seller child sheet (same guards as syncSellerSheets; never touches another seller). */
function syncSellerSheet(sellerId) {
  const result = runSingleSellerSheetSync_(sellerId);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/* ---------------------------------------------------------------------------
 * Master menu
 * ------------------------------------------------------------------------- */

/** Simple trigger: the "Payment Master" menu (sync, payouts, seller sheets, views). */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Payment Master')
    .addSubMenu(ui.createMenu('Sync')
      .addItem('Run Full Sync', 'menuRunFullSync')
      .addItem('Verify Health', 'menuVerifyHealth')
      .addItem('Sync Seller Sheets', 'menuSyncSellerSheets'))
    .addSubMenu(ui.createMenu('Payouts')
      .addItem('New Payout', 'menuOpenPayoutModal')
      .addItem('Refresh Operations', 'menuRefreshOperations')
      .addItem('Mark Selected SENT', 'menuMarkSelectedPayoutSent')
      .addItem('Mark Selected CONFIRMED', 'menuMarkSelectedPayoutConfirmed')
      .addItem('Cancel Selected DRAFT', 'menuCancelSelectedPayout')
      .addItem('Reverse Selected Payout', 'menuReverseSelectedPayout')
      .addItem('Verify Seller Payouts', 'menuVerifySellerPayouts')
      .addSubMenu(ui.createMenu('Advanced')
        .addItem('Create Draft from Operations Form', 'menuCreateDraftPayout')
        .addItem('New Payout Request (reset form)', 'menuNewPayoutRequest')))
    .addSubMenu(ui.createMenu('Sellers')
      .addItem('Create Seller Sheet', 'menuCreateSellerSheet')
      .addItem('Sync Seller Sheets', 'menuSyncSellerSheets')
      .addItem('Verify Seller Sheets', 'menuVerifySellerSheets'))
    .addSubMenu(ui.createMenu('View')
      .addItem('Operator View', 'menuApplyOperatorView')
      .addItem('Technical View', 'menuApplyTechnicalView'))
    .addToUi();
}

/** Menu: asks for a seller ID, runs createSellerSheet and shows the outcome. */
function menuCreateSellerSheet() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Create Seller Sheet', buildCreateSellerSheetPromptText_(readCreateSellerSheetCandidates_()), ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return null;
  const sellerId = String(response.getResponseText()).trim();
  if (sellerId === '') {
    ui.alert('Create Seller Sheet', 'No seller ID entered; nothing was created.', ui.ButtonSet.OK);
    return null;
  }
  const result = createSellerSheet(sellerId);
  ui.alert('Create Seller Sheet', formatCreateSellerSheetAlert_(result, sellerAlertHiddenIds_()), ui.ButtonSet.OK);
  return result;
}

/** Menu: syncSellerSheets with a summary alert. */
function menuSyncSellerSheets() {
  const result = syncSellerSheets();
  const ui = SpreadsheetApp.getUi();
  ui.alert('Sync All Seller Sheets', formatSellerSyncAlert_(result, sellerAlertHiddenIds_()), ui.ButtonSet.OK);
  return result;
}

/** Menu: verifySellerSheets (read-only) with a summary alert. */
function menuVerifySellerSheets() {
  const report = verifySellerSheets();
  const ui = SpreadsheetApp.getUi();
  ui.alert('Verify Seller Sheets', formatSellerVerifyAlert_(report, sellerAlertHiddenIds_()), ui.ButtonSet.OK);
  return report;
}

/* ---------------------------------------------------------------------------
 * Seller Payout Allocations (classification of payouts to seller settlement obligations)
 * ------------------------------------------------------------------------- */

/** Writes FIFO allocation rows for one DRAFT Seller Payout (never changes the payout or existing rows). */
function autoAllocateSellerPayoutFIFO(payoutId) {
  const result = runSellerPayoutFifo_(payoutId);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Read-only: validates allocations and reports due / paid / remaining and UNPAID / PARTIAL / PAID per seller settlement. */
function verifySellerPayoutAllocations() {
  const report = buildSellerPayoutAllocationsReport_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/* ---------------------------------------------------------------------------
 * Scheduled payment pipeline (twice a day; publishes seller sheets only when everything passes)
 * ------------------------------------------------------------------------- */

/** Runs the whole pipeline once (trigger handler; also safe to run manually). Skips if another run holds the lock. */
function runScheduledPaymentPipeline(e) {
  let hidden = [];
  try { hidden = hiddenOperationsTabs_(getSpreadsheet_()); } catch (err) { hidden = []; }
  const result = runPaymentPipeline_({ trigger: e && e.triggerUid ? 'time-driven' : 'manual' });
  // Outside the stages: keep hidden tabs hidden (a swap shows the tab it rewrites) and refresh Operations. Best effort.
  afterPaymentPipelineRun_(hidden);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Installs / updates exactly two daily pipeline triggers from Settings (idempotent; never duplicates). */
function installScheduledPaymentPipelineTriggers() {
  const result = installPaymentPipelineTriggers_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Explicit Settings update: scheduled_sync_timezone Asia/Ho_Chi_Minh (retired default) -> the Master timezone. Then reinstall triggers. */
function migrateScheduledPipelineTimezoneToMaster() {
  const result = runScheduleTimezoneMigration_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Read-only: exactly two pipeline triggers, installed with the current Settings schedule in the Master timezone. */
function verifyScheduledPaymentPipelineTriggers() {
  const report = buildPipelineTriggersReport_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/** Removes the pipeline triggers (other triggers are untouched). */
function removeScheduledPaymentPipelineTriggers() {
  const removed = removePaymentPipelineTriggers_();
  Logger.log('Removed %s pipeline trigger(s)', removed);
  return removed;
}

/** Read-only: every pipeline health gate (freshness of each layer + accounting invariants). */
function verifyPaymentPipelineHealth() {
  const report = buildPaymentPipelineHealth_();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/* ---------------------------------------------------------------------------
 * Operations tab: operator view of the canonical ledger + controlled Seller Payout operations
 * ------------------------------------------------------------------------- */

/** Re-renders the Operations tab from the canonical Master tabs (writes the Operations tab only). */
function refreshOperations() {
  const result = runRefreshOperations_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Creates one DRAFT Seller Payout from the Operations form and allocates it FIFO (no financial effect). */
function createDraftSellerPayoutFromOperations() {
  const result = runCreateDraftFromOperations_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Starts a new payout request (new token, amount fields cleared); refused while the current request's DRAFT is incomplete. */
function newOperationsPayoutRequest() {
  const result = runResetOperationsRequest_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** DRAFT -> SENT for the payout selected in the Operations payouts table (validated; reduces the seller balance once). */
function markSelectedSellerPayoutSent() {
  const result = runSellerPayoutTransition_(readSelectedOperationsPayout_, 'SENT', '');
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** SENT -> CONFIRMED for the selected payout (no second deduction). */
function markSelectedSellerPayoutConfirmed() {
  const result = runSellerPayoutTransition_(readSelectedOperationsPayout_, 'CONFIRMED', '');
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** DRAFT -> CANCELLED for the selected payout (allocations kept as audit trail; they no longer claim obligations). */
function cancelSelectedSellerPayout(reason) {
  const result = runSellerPayoutTransition_(readSelectedOperationsPayout_, 'CANCELLED', reason || '');
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** SENT / CONFIRMED -> REVERSED for the selected payout; reason required. Restores the balance; nothing is deleted. */
function reverseSelectedSellerPayout(reason) {
  const result = runSellerPayoutTransition_(readSelectedOperationsPayout_, 'REVERSED', reason || '');
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Shows the operator tabs and hides the technical ones (Master tabs only; staging always hidden). */
function applyOperatorView() {
  const result = runApplyOperationsView_('OPERATOR');
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Shows every Master tab (staging stays hidden). */
function applyTechnicalView() {
  const result = runApplyOperationsView_('TECHNICAL');
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** UI alert; the Master, provider-source, template and folder IDs are never shown. */
function operationsAlert_(title, text) {
  const ui = SpreadsheetApp.getUi();
  ui.alert(title, sanitizeSellerAlertText_(String(text), sellerAlertHiddenIds_()), ui.ButtonSet.OK);
}

/** Menu: runs the full pipeline once and shows the outcome. */
function menuRunFullSync() {
  const r = runScheduledPaymentPipeline();
  operationsAlert_('Run Full Sync', r.status + (r.failed_stage ? ' at ' + r.failed_stage : '') + (r.error ? '\n' + r.error : '') + '\n' +
    r.stages.map(function (x) { return x.stage + ': ' + x.status; }).join('\n'));
  return r;
}

/** Menu: pipeline health (read-only report, audited and shown in Operations). */
function menuVerifyHealth() {
  const r = runOperatorHealthCheck_();
  const failed = r.checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name + ': ' + c.detail; }).concat(r.errors);
  operationsAlert_('Verify Health', (r.pass ? 'PASS' : 'FAIL') + ' (' + r.checks.length + ' checks)' + (failed.length ? '\n' + failed.slice(0, 10).join('\n') : ''));
  return r;
}

function menuRefreshOperations() {
  const r = refreshOperations();
  operationsAlert_('Refresh Operations', r.status + (r.error ? '\n' + r.error : '') + (r.problems && r.problems.length ? '\n' + r.problems.join('\n') : ''));
  return r;
}

function menuCreateDraftPayout() {
  const r = createDraftSellerPayoutFromOperations();
  operationsAlert_('Create Draft + FIFO', formatOperationsAlert_(r));
  return r;
}

function menuNewPayoutRequest() {
  const r = newOperationsPayoutRequest();
  operationsAlert_('New Payout Request', r.status === 'SUCCESS' ? 'Form ready for a new payout request.' : formatOperationsAlert_(r));
  return r;
}

/** Shared menu flow for a selected payout: read the selection (read-only), confirm, then run the guarded operation. */
function menuSelectedPayoutAction_(title, question, needsReason, run) {
  const ui = SpreadsheetApp.getUi();
  let selected;
  try {
    selected = readSelectedOperationsPayout_(getSpreadsheet_());
  } catch (err) {
    operationsAlert_(title, err.message);
    return null;
  }
  let reason = '';
  if (needsReason) {
    const response = ui.prompt(title, question.replace('%s', selected.payout_id) + '\n\nReason' + (needsReason === 'required' ? ' (required):' : ' (optional):'),
      ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return null;
    reason = String(response.getResponseText()).trim();
    if (needsReason === 'required' && reason === '') {
      operationsAlert_(title, 'A reason is required; nothing changed.');
      return null;
    }
  } else if (ui.alert(title, question.replace('%s', selected.payout_id), ui.ButtonSet.YES_NO) !== ui.Button.YES) {
    return null;
  }
  const r = run(reason);
  operationsAlert_(title, formatOperationsAlert_(r));
  return r;
}

function menuMarkSelectedPayoutSent() {
  return menuSelectedPayoutAction_('Mark Selected SENT', 'Mark %s SENT? This records that the money was sent and reduces the seller balance.',
    false, function () { return markSelectedSellerPayoutSent(); });
}

function menuMarkSelectedPayoutConfirmed() {
  return menuSelectedPayoutAction_('Mark Selected CONFIRMED', 'Mark %s CONFIRMED (receipt confirmed)? The balance is not reduced again.',
    false, function () { return markSelectedSellerPayoutConfirmed(); });
}

function menuCancelSelectedPayout() {
  return menuSelectedPayoutAction_('Cancel Selected DRAFT', 'Cancel DRAFT %s? It has no financial effect; its allocations stop claiming obligations.',
    'optional', function (reason) { return cancelSelectedSellerPayout(reason); });
}

function menuReverseSelectedPayout() {
  return menuSelectedPayoutAction_('Reverse Selected Payout', 'Reverse %s? The seller balance and obligation statuses are restored; nothing is deleted.',
    'required', function (reason) { return reverseSelectedSellerPayout(reason); });
}

function menuVerifySellerPayouts() {
  const r = verifySellerPayoutAllocations();
  operationsAlert_('Verify Seller Payouts', (r.pass ? 'PASS' : 'FAIL') + '\nEffective payouts: ' + r.effective_payout_count +
    '\nObligation statuses: ' + JSON.stringify(r.payment_status_counts) + (r.errors.length ? '\n' + r.errors.slice(0, 5).join('\n') : ''));
  return r;
}

function menuApplyOperatorView() {
  const r = applyOperatorView();
  operationsAlert_('Operator View', r.status + (r.error ? '\n' + r.error : '\nHidden: ' + r.hidden.length + ' tab(s)'));
  return r;
}

function menuApplyTechnicalView() {
  const r = applyTechnicalView();
  operationsAlert_('Technical View', r.status + (r.error ? '\n' + r.error : '\nShown: ' + r.shown.length + ' tab(s)'));
  return r;
}

/* ---------------------------------------------------------------------------
 * "New Payout" modal (HtmlService). UI only: these endpoints re-read the canonical Master and reuse the guarded
 * Operations workflow (createDraftRequest_, runSellerPayoutFifo_, runSellerPayoutTransition_).
 * ------------------------------------------------------------------------- */

/** Menu: opens the New Payout modal. */
function menuOpenPayoutModal() {
  const html = HtmlService.createHtmlOutputFromFile(PAYOUT_MODAL.htmlFile).setWidth(PAYOUT_MODAL.width).setHeight(PAYOUT_MODAL.height);
  SpreadsheetApp.getUi().showModalDialog(html, PAYOUT_MODAL.title);
}

/** Modal: ACTIVE sellers, Master (New York) date, a request token, active payouts. */
function payoutModalBootstrap() {
  return runPayoutModalBootstrap_();
}

/** Modal: payable lines, open obligations (FIFO) and active payouts of one ACTIVE seller. */
function payoutModalSeller(sellerId) {
  return runPayoutModalSeller_(sellerId);
}

/** Modal: FIFO preview of a payout payload (same plan as Create Draft; writes nothing). */
function payoutModalPreview(payload) {
  return runPayoutModalPreview_(payload);
}

/** Modal: Create Draft (guarded, idempotent by request token). */
function payoutModalCreateDraft(payload) {
  return runPayoutModalCreate_(payload);
}

/** Modal: current canonical view of one payout. */
function payoutModalPayout(payoutId) {
  return runPayoutModalPayout_(payoutId);
}

/** Modal: a named lifecycle action (SEND / CONFIRM / CANCEL / REVERSE) with the status the modal shows. */
function payoutModalTransition(payoutId, action, expectedStatus, reason) {
  return runPayoutModalTransition_(payoutId, action, expectedStatus, reason);
}

/** Modal: reruns FIFO for an incomplete DRAFT (resume). */
function payoutModalRetryAllocation(payoutId) {
  return runPayoutModalRetryAllocation_(payoutId);
}

/** Modal: records the payment proof (method + reference) of a DRAFT before Mark SENT. */
function payoutModalSetPaymentProof(payoutId, expectedStatus, method, reference) {
  return runPayoutModalSetProof_(payoutId, expectedStatus, method, reference);
}
