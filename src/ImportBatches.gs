/**
 * ImportBatches.gs
 * One "Import Batches" row per source-tab sync attempt.
 * Rows are appended once (RUNNING) and completed once (final status).
 */

const IMPORT_BATCH_STATUS = Object.freeze({
  RUNNING: 'RUNNING',
  SUCCESS: 'SUCCESS',
  NO_CHANGE: 'NO_CHANGE',
  FAILED: 'FAILED',
});

function getImportBatchesSheet_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.IMPORT_BATCHES);
  if (!sheet) throw new Error('Import Batches tab not found. Run setupMaster first.');
  return sheet;
}

function newImportBatchId_(providerId) {
  const stamp = Utilities.formatDate(new Date(), APP.TIMEZONE, "yyyyMMdd'T'HHmmss");
  return 'IB-' + providerId + '-' + stamp + '-' + Utilities.getUuid().slice(0, 8);
}

/**
 * Appends a RUNNING batch row and returns a handle used to complete it.
 * @param {{providerId: string, sourceSpreadsheetId: string, sourceSheet: string, targetSheet: string}} info
 */
function startImportBatch_(info) {
  const sheet = getImportBatchesSheet_();
  const columns = getColumnNames_(SHEETS.IMPORT_BATCHES);
  const batch = {
    import_batch_id: newImportBatchId_(info.providerId),
    provider_id: info.providerId,
    source_spreadsheet_id: info.sourceSpreadsheetId || '',
    source_sheet: info.sourceSheet || '',
    target_sheet: info.targetSheet || '',
    started_at: new Date(),
    completed_at: '',
    source_rows: '',
    source_columns: '',
    checksum: '',
    status: IMPORT_BATCH_STATUS.RUNNING,
    error_message: '',
    actor: APP.SYSTEM_ACTOR,
  };
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, columns.length).setValues([columns.map(function (c) { return batch[c]; })]);
  batch._row = row;
  return batch;
}

/**
 * Completes a batch row with its final status.
 * @param {Object} batch handle from startImportBatch_
 * @param {{status: string, rows?: number, columns?: number, checksum?: string, errorMessage?: string}} result
 */
function completeImportBatch_(batch, result) {
  const sheet = getImportBatchesSheet_();
  const columns = getColumnNames_(SHEETS.IMPORT_BATCHES);
  batch.completed_at = new Date();
  batch.status = result.status;
  batch.source_rows = result.rows === undefined ? '' : result.rows;
  batch.source_columns = result.columns === undefined ? '' : result.columns;
  batch.checksum = result.checksum || '';
  batch.error_message = result.errorMessage ? String(result.errorMessage).slice(0, 5000) : '';
  sheet.getRange(batch._row, 1, 1, columns.length).setValues([columns.map(function (c) { return batch[c]; })]);
}

/** Reads all batch rows as objects keyed by column name. */
function readImportBatches_() {
  const sheet = getImportBatchesSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const columns = getColumnNames_(SHEETS.IMPORT_BATCHES);
  return sheet.getRange(2, 1, lastRow - 1, columns.length).getValues().map(function (row) {
    const obj = {};
    columns.forEach(function (c, i) { obj[c] = row[i]; });
    return obj;
  });
}

/**
 * Latest SUCCESS or NO_CHANGE batch for one provider + source tab + target tab.
 * Both statuses mean the target held a verified snapshot with that checksum.
 */
function findLastSuccessfulBatch_(batches, key) {
  for (let i = batches.length - 1; i >= 0; i--) {
    const b = batches[i];
    if (b.provider_id === key.providerId &&
        b.source_spreadsheet_id === key.sourceSpreadsheetId &&
        b.source_sheet === key.sourceSheet &&
        b.target_sheet === key.targetSheet &&
        (b.status === IMPORT_BATCH_STATUS.SUCCESS || b.status === IMPORT_BATCH_STATUS.NO_CHANGE)) {
      return b;
    }
  }
  return null;
}
