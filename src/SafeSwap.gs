/**
 * SafeSwap.gs
 * Crash-safe replacement of a whole tab via a hidden staging tab, shared by raw sync
 * and canonical tables.
 *
 * A "tab" descriptor is { targetSheet, stagingSheet }. The swap renames, in order:
 *   (1) target -> __SWAP_*   (2) staging -> target   (3) __SWAP_* -> staging
 * recoverSwapState_ must run under the script lock before staging is cleared or
 * reused; it restores the last known good target after a hard termination at any
 * point (see decideRawSwapRecovery_ in RawSnapshot.gs). Nothing here deletes a tab.
 */

const SWAP_SHEET_PREFIX = '__SWAP_';

/**
 * Reads a staging/target tab as a snapshot: its whole sheet grid. Raw sync sizes these
 * tabs exactly to the source used range, so trailing blank cells are part of the grid.
 */
function readSheetSnapshot_(sheet) {
  const rows = sheet.getMaxRows();
  const columns = sheet.getMaxColumns();
  const values = sheet.getRange(1, 1, rows, columns).getValues();
  return { rows: rows, columns: columns, checksum: computeRawChecksum_(values) };
}

function swapSheetName_(tab) {
  return SWAP_SHEET_PREFIX + tab.stagingSheet.slice(STAGING_SHEET_PREFIX.length);
}

/** Read-only: which of the target / swap / staging tabs exist. */
function detectSwapState_(ss, tab) {
  return decideRawSwapRecovery_({
    targetExists: !!ss.getSheetByName(tab.targetSheet),
    swapExists: !!ss.getSheetByName(swapSheetName_(tab)),
    stagingExists: !!ss.getSheetByName(tab.stagingSheet),
  });
}

/**
 * Restores a valid target/staging layout after a hard-terminated swap, before staging
 * is cleared or reused. Never deletes a tab. Throws on unrecognized states.
 * @return {{state: string, actions: Array<string>}}
 */
function recoverSwapState_(ss, tab) {
  const decision = detectSwapState_(ss, tab);
  if (decision.error) throw new Error('Swap recovery for "' + tab.targetSheet + '": ' + decision.error);

  decision.actions.forEach(function (action) {
    if (action === 'RENAME_TARGET_TO_STAGING') {
      // Unconfirmed new snapshot: park it as staging (the next write rebuilds from source).
      const current = ss.getSheetByName(tab.targetSheet);
      current.setName(tab.stagingSheet);
      current.hideSheet();
    } else if (action === 'RENAME_SWAP_TO_TARGET') {
      // Last known good snapshot goes back to the target name.
      const lastKnownGood = ss.getSheetByName(swapSheetName_(tab));
      lastKnownGood.setName(tab.targetSheet);
      lastKnownGood.showSheet();
    }
  });

  // Normalize visibility (an interruption can leave it inconsistent).
  const target = ss.getSheetByName(tab.targetSheet);
  if (target && target.isSheetHidden()) target.showSheet();
  const staging = ss.getSheetByName(tab.stagingSheet);
  if (staging && !staging.isSheetHidden()) staging.hideSheet();

  return { state: decision.state, actions: decision.actions };
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

/**
 * Replaces the target tab with the verified staging tab by renaming.
 * afterSwap(newTarget), when given, runs once the swap is complete (e.g. protection).
 * Until the rename succeeds and the new target verifies, the old target is intact;
 * any failure restores the original names.
 */
function swapStagingIntoTarget_(ss, staging, tab, expected, afterSwap) {
  const oldTarget = ss.getSheetByName(tab.targetSheet);
  const swapName = swapSheetName_(tab);
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
  if (afterSwap) afterSwap(staging);
}
