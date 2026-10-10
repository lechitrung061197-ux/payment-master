/**
 * RawSync.gs
 * Safe raw snapshot sync: mirrors the used range of an external source tab into a
 * Master target tab as evaluated values (no formulas, no normalization, no timezone
 * conversion, no filtering).
 *
 * Per source tab:
 *   lock -> read source -> validate -> checksum -> compare with last successful batch
 *   -> NO_CHANGE (no write)  or  write staging -> verify staging -> swap staging into
 *   target by renaming -> verify target (rollback on mismatch) -> log -> unlock.
 *
 * The current target tab is never cleared or partially written: the new snapshot is
 * fully written and verified in a hidden staging tab first, then swapped in by
 * renaming. The previous target becomes the staging tab for the next run.
 */

const RAW_SYNC_LOCK_TIMEOUT_MS = 30000;
const RAW_WRITE_CHUNK_ROWS = 5000;
const RAW_TARGET_PROTECTION_DESCRIPTION = 'Raw snapshot (managed by raw sync)';

/**
 * Syncs every tab of a raw source. A failure in one tab does not stop the others.
 * @return {Object} summary keyed by source tab name
 */
function syncRawSource_(source) {
  const summary = { provider: source.providerId };
  const settings = readSettingsMap_();
  if (!isSettingEnabled_(settings[source.enabledSetting])) {
    summary.status = 'DISABLED';
    return summary;
  }
  source.tabs.forEach(function (tab) {
    const result = syncRawTab_(source, tab);
    summary[result.sourceSheet || tab.targetSheet] = result.status;
  });
  return summary;
}

/**
 * Syncs one source tab into its target tab. Never throws; returns the batch outcome.
 * @return {{status: string, sourceSheet: string, batchId: ?string, error: ?string}}
 */
function syncRawTab_(source, tab) {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(RAW_SYNC_LOCK_TIMEOUT_MS);
  let batch = null;
  let sourceSheet = '';

  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + RAW_SYNC_LOCK_TIMEOUT_MS + ' ms.');

    const settings = readSettingsMap_();
    if (!isSettingEnabled_(settings[source.enabledSetting])) {
      return { status: 'DISABLED', sourceSheet: '', batchId: null, error: null };
    }
    const spreadsheetId = String(getRequiredSetting_(settings, source.spreadsheetIdSetting));
    sourceSheet = String(getRequiredSetting_(settings, tab.sourceSheetSetting));

    batch = startImportBatch_({
      providerId: source.providerId,
      sourceSpreadsheetId: spreadsheetId,
      sourceSheet: sourceSheet,
      targetSheet: tab.targetSheet,
    });

    // 1-4. Read the complete source used range once, validate, checksum.
    const snapshot = readSourceSnapshot_(spreadsheetId, sourceSheet);

    // 5-6. Compare with the last successful snapshot; skip the write when unchanged.
    const ss = getSpreadsheet_();
    const last = findLastSuccessfulBatch_(readImportBatches_(), {
      providerId: source.providerId,
      sourceSpreadsheetId: spreadsheetId,
      sourceSheet: sourceSheet,
      targetSheet: tab.targetSheet,
    });
    const target = ss.getSheetByName(tab.targetSheet);
    const lastChecksum = last ? String(last.checksum) : null;
    const targetChecksum = lastChecksum === snapshot.checksum && target
      ? readSheetSnapshot_(target).checksum
      : null;

    const action = decideRawSyncAction_({
      sourceChecksum: snapshot.checksum,
      lastSuccessfulChecksum: lastChecksum,
      targetChecksum: targetChecksum,
    });

    if (action === 'NO_CHANGE') {
      return finishRawTab_(source, tab, batch, IMPORT_BATCH_STATUS.NO_CHANGE, snapshot, null);
    }

    // 7-8. Write the full dataset to staging and verify it.
    const staging = prepareStagingSheet_(ss, tab.stagingSheet, snapshot.rows, snapshot.columns);
    writeSnapshot_(staging, snapshot.values, snapshot.formats);
    SpreadsheetApp.flush();
    assertSnapshotMatches_(readSheetSnapshot_(staging), snapshot, 'Staging "' + tab.stagingSheet + '"');

    // 9-10. Swap staging into target and verify; rolls back on mismatch.
    swapStagingIntoTarget_(ss, staging, tab, snapshot);

    // 11. Log success.
    return finishRawTab_(source, tab, batch, IMPORT_BATCH_STATUS.SUCCESS, snapshot, null);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    try {
      if (!batch) {
        batch = startImportBatch_({ providerId: source.providerId, sourceSheet: sourceSheet, targetSheet: tab.targetSheet });
      }
      return finishRawTab_(source, tab, batch, IMPORT_BATCH_STATUS.FAILED, null, message);
    } catch (logErr) {
      Logger.log('Failed to record FAILED batch for %s: %s (original error: %s)', tab.targetSheet, logErr, message);
      return { status: IMPORT_BATCH_STATUS.FAILED, sourceSheet: sourceSheet, batchId: null, error: message };
    }
  } finally {
    // 13. Release lock.
    if (locked) lock.releaseLock();
  }
}

/** Completes the batch row, writes the operation-level audit entry and returns the outcome. */
function finishRawTab_(source, tab, batch, status, snapshot, errorMessage) {
  completeImportBatch_(batch, {
    status: status,
    rows: snapshot ? snapshot.rows : undefined,
    columns: snapshot ? snapshot.columns : undefined,
    checksum: snapshot ? snapshot.checksum : '',
    errorMessage: errorMessage,
  });
  appendAuditLog_({
    action: source.providerId + '_RAW_SYNC_' + status,
    entityType: 'IMPORT_BATCH',
    entityId: batch.import_batch_id,
    oldStatus: IMPORT_BATCH_STATUS.RUNNING,
    newStatus: status,
    details: {
      source_sheet: batch.source_sheet,
      target_sheet: tab.targetSheet,
      rows: snapshot ? snapshot.rows : null,
      columns: snapshot ? snapshot.columns : null,
      checksum: snapshot ? snapshot.checksum : null,
      error: errorMessage,
    },
  });
  return { status: status, sourceSheet: batch.source_sheet, batchId: batch.import_batch_id, error: errorMessage };
}

/** Reads the source used range (evaluated values + number formats), trimmed and validated. */
function readSourceSnapshot_(spreadsheetId, sheetName) {
  const sourceSs = SpreadsheetApp.openById(spreadsheetId);
  const sheet = sourceSs.getSheetByName(sheetName);
  if (!sheet) throw new Error('Source sheet "' + sheetName + '" not found in spreadsheet ' + spreadsheetId + '.');

  const range = sheet.getDataRange();
  const rawValues = range.getValues();
  const rawFormats = range.getNumberFormats();
  const dims = computeTrimmedDimensions_(rawValues);
  const values = sliceTo_(rawValues, dims);

  const errors = validateRawDataset_(values);
  if (errors.length > 0) {
    throw new Error('Source sheet "' + sheetName + '" failed validation: ' + errors.join(' '));
  }

  return {
    values: values,
    formats: sliceTo_(rawFormats, dims),
    rows: dims.rows,
    columns: dims.columns,
    checksum: computeRawChecksum_(values),
  };
}

/** Reads a Master tab as a snapshot (values only), trimmed the same way as the source. */
function readSheetSnapshot_(sheet) {
  const rawValues = sheet.getDataRange().getValues();
  const dims = computeTrimmedDimensions_(rawValues);
  const values = sliceTo_(rawValues, dims);
  return { rows: dims.rows, columns: dims.columns, checksum: computeRawChecksum_(values) };
}

function assertSnapshotMatches_(actual, expected, label) {
  if (actual.rows !== expected.rows || actual.columns !== expected.columns || actual.checksum !== expected.checksum) {
    throw new Error(label + ' verification failed: expected ' + expected.rows + 'x' + expected.columns +
      ' ' + expected.checksum + ', got ' + actual.rows + 'x' + actual.columns + ' ' + actual.checksum + '.');
  }
}

/** Returns an empty, hidden staging tab sized exactly rows x columns. */
function prepareStagingSheet_(ss, name, rows, columns) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name, ss.getNumSheets());
  }
  sheet.hideSheet();
  sheet.clear();
  sheet.clearNotes();

  const maxRows = sheet.getMaxRows();
  if (maxRows < rows) sheet.insertRowsAfter(maxRows, rows - maxRows);
  else if (maxRows > rows) sheet.deleteRows(rows + 1, maxRows - rows);

  const maxColumns = sheet.getMaxColumns();
  if (maxColumns < columns) sheet.insertColumnsAfter(maxColumns, columns - maxColumns);
  else if (maxColumns > columns) sheet.deleteColumns(columns + 1, maxColumns - columns);

  return sheet;
}

/** Batch-writes formats then values in row chunks (formats first so text stays text). */
function writeSnapshot_(sheet, values, formats) {
  const columns = values[0].length;
  const numberFormats = buildRawNumberFormats_(values, formats);
  for (let start = 0; start < values.length; start += RAW_WRITE_CHUNK_ROWS) {
    const count = Math.min(RAW_WRITE_CHUNK_ROWS, values.length - start);
    const range = sheet.getRange(start + 1, 1, count, columns);
    range.setNumberFormats(numberFormats.slice(start, start + count));
    range.setValues(values.slice(start, start + count));
  }
}

/**
 * Replaces the target tab with the verified staging tab by renaming.
 * Until the rename succeeds and the new target verifies, the old target is intact;
 * any failure restores the original names.
 */
function swapStagingIntoTarget_(ss, staging, tab, expected) {
  const oldTarget = ss.getSheetByName(tab.targetSheet);
  const swapName = '__SWAP_' + tab.stagingSheet.slice(STAGING_SHEET_PREFIX.length);
  const targetIndex = oldTarget ? oldTarget.getIndex() : null;

  function rollback() {
    if (staging.getName() === tab.targetSheet) {
      staging.setName(tab.stagingSheet);
      staging.hideSheet();
    }
    if (oldTarget && oldTarget.getName() !== tab.targetSheet) {
      oldTarget.setName(tab.targetSheet);
      oldTarget.showSheet();
    }
  }

  try {
    if (oldTarget) oldTarget.setName(swapName);
    staging.setName(tab.targetSheet);
    staging.showSheet();
    if (targetIndex) {
      ss.setActiveSheet(staging);
      ss.moveActiveSheet(targetIndex);
    }
    SpreadsheetApp.flush();
    assertSnapshotMatches_(readSheetSnapshot_(staging), expected, 'Target "' + tab.targetSheet + '"');
  } catch (err) {
    try { rollback(); } catch (rollbackErr) {
      throw new Error('Swap failed (' + err.message + ') and rollback failed (' + rollbackErr.message + ').');
    }
    throw new Error('Swap failed and was rolled back: ' + err.message);
  }

  // 12. The previous snapshot becomes the hidden staging tab for the next run.
  if (oldTarget) {
    oldTarget.setName(tab.stagingSheet);
    oldTarget.hideSheet();
  }
  protectRawTarget_(staging);
}

/** Warning-only protection so manual edits to a raw snapshot prompt a confirmation. */
function protectRawTarget_(sheet) {
  const exists = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).some(function (p) {
    return p.getDescription() === RAW_TARGET_PROTECTION_DESCRIPTION;
  });
  if (!exists) sheet.protect().setDescription(RAW_TARGET_PROTECTION_DESCRIPTION).setWarningOnly(true);
}

/**
 * Read-only comparison of every source tab with its target tab.
 * Does not lock, write, or log anything to the spreadsheet.
 */
function verifyRawSource_(source) {
  const settings = readSettingsMap_();
  const spreadsheetId = String(settings[source.spreadsheetIdSetting] || '');
  const batches = readImportBatches_();
  const ss = getSpreadsheet_();

  const results = source.tabs.map(function (tab) {
    const sourceSheet = String(settings[tab.sourceSheetSetting] || '');
    const report = {
      provider_id: source.providerId,
      source_spreadsheet_id: spreadsheetId,
      source_sheet: sourceSheet,
      target_sheet: tab.targetSheet,
      source_rows: null,
      target_rows: null,
      source_columns: null,
      target_columns: null,
      source_checksum: null,
      target_checksum: null,
      match: false,
      last_successful_batch_id: null,
      last_successful_sync_at: null,
      error: null,
    };
    try {
      const last = findLastSuccessfulBatch_(batches, {
        providerId: source.providerId,
        sourceSpreadsheetId: spreadsheetId,
        sourceSheet: sourceSheet,
        targetSheet: tab.targetSheet,
      });
      if (last) {
        report.last_successful_batch_id = last.import_batch_id;
        report.last_successful_sync_at = last.completed_at instanceof Date
          ? Utilities.formatDate(last.completed_at, APP.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX")
          : String(last.completed_at);
      }

      const src = readSourceSnapshot_(spreadsheetId, sourceSheet);
      report.source_rows = src.rows;
      report.source_columns = src.columns;
      report.source_checksum = src.checksum;

      const target = ss.getSheetByName(tab.targetSheet);
      if (!target) throw new Error('Target tab "' + tab.targetSheet + '" not found.');
      const tgt = readSheetSnapshot_(target);
      report.target_rows = tgt.rows;
      report.target_columns = tgt.columns;
      report.target_checksum = tgt.checksum;

      report.match = src.rows === tgt.rows && src.columns === tgt.columns && src.checksum === tgt.checksum;
      if (!report.match) report.error = 'MISMATCH between source "' + sourceSheet + '" and target "' + tab.targetSheet + '".';
    } catch (err) {
      report.error = err && err.message ? err.message : String(err);
    }
    return report;
  });

  return {
    provider: source.providerId,
    pass: results.every(function (r) { return r.match; }),
    mismatches: results.filter(function (r) { return !r.match; }).map(function (r) { return r.source_sheet || r.target_sheet; }),
    sources: results,
  };
}
