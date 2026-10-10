/**
 * CanonicalTable.gs
 * Crash-safe replacement of one provider partition inside a schema-managed canonical
 * table (e.g. Provider Transactions), shared by all provider normalizers.
 *
 * Flow (caller holds the script lock):
 *   recover interrupted swap -> read current target -> keep other providers' rows ->
 *   add the new partition -> deterministic sort -> unique-key check ->
 *   NO_CHANGE when the table (excluding volatile columns) is identical ->
 *   otherwise stamp the partition, write the complete table to a formatted hidden
 *   staging tab, verify it, swap it into the target (SafeSwap.gs), verify again.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const CANONICAL_WRITE_CHUNK_ROWS = 5000;
const CANONICAL_LOCK_TIMEOUT_MS = 30000;

/* ----------------------------- Pure helpers ----------------------------- */

/**
 * Returns the data rows of a schema table grid. Row 1 must equal the schema header
 * (extra grid columns must be blank). Fully blank rows are skipped.
 */
function tableRowsFromGrid_(values, columns, label) {
  if (!values || values.length === 0) throw new Error(label + ' is empty; expected a header row.');
  const header = values[0];
  for (let c = 0; c < header.length; c++) {
    const expected = c < columns.length ? columns[c] : '';
    if (String(header[c]).trim() !== expected) {
      throw new Error(label + ' header does not match the schema at column ' + (c + 1) +
        ': expected "' + expected + '", found "' + header[c] + '".');
    }
  }
  if (header.length < columns.length) {
    throw new Error(label + ' has ' + header.length + ' columns; schema has ' + columns.length + '.');
  }
  return values.slice(1)
    .filter(function (row) { return !row.every(isBlankCell_); })
    .map(function (row) { return row.slice(0, columns.length); });
}

/** Header + rows; a header-only table gets one blank row so the grid keeps a data row. */
function buildTableValues_(columns, rows) {
  const values = [columns.slice()].concat(rows.map(function (r) { return r.slice(); }));
  if (values.length < 2) values.push(columns.map(function () { return ''; }));
  return values;
}

/** Checksum of a table grid with the given column indexes blanked in data rows. */
function tableChecksumExcluding_(values, excludeIndexes, digestHex) {
  const masked = values.map(function (row, r) {
    if (r === 0) return row;
    return row.map(function (v, c) { return excludeIndexes.indexOf(c) >= 0 ? '' : v; });
  });
  return computeRawChecksum_(masked, digestHex);
}

/** Rows of other providers are kept; rows of providerId are replaced by partitionRows. */
function mergeProviderPartition_(existingRows, partitionRows, providerIdIndex, providerId) {
  return existingRows
    .filter(function (row) { return row[providerIdIndex] !== providerId; })
    .concat(partitionRows);
}

/** Total, deterministic order across value types: blank < number < Date < boolean < text. */
function compareCanonicalValues_(a, b) {
  const rank = function (v) {
    if (isBlankCell_(v)) return 0;
    if (typeof v === 'number') return 1;
    if (isDateValue_(v)) return 2;
    if (typeof v === 'boolean') return 3;
    return 4;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  const va = ra === 2 ? a.getTime() : ra === 4 ? String(a) : a;
  const vb = rb === 2 ? b.getTime() : rb === 4 ? String(b) : b;
  return va < vb ? -1 : va > vb ? 1 : 0;
}

/** Returns a new array sorted by the given column indexes (stable). */
function sortCanonicalRows_(rows, keyIndexes) {
  return rows
    .map(function (row, i) { return { row: row, i: i }; })
    .sort(function (x, y) {
      for (let k = 0; k < keyIndexes.length; k++) {
        const d = compareCanonicalValues_(x.row[keyIndexes[k]], y.row[keyIndexes[k]]);
        if (d !== 0) return d;
      }
      return x.i - y.i;
    })
    .map(function (x) { return x.row; });
}

/** Composite keys ("a|b|c") that occur more than once, sorted. */
function findDuplicateKeys_(rows, keyIndexes) {
  const counts = {};
  rows.forEach(function (row) {
    const key = keyIndexes.map(function (i) { return String(row[i]); }).join('|');
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.keys(counts).filter(function (k) { return counts[k] > 1; }).sort();
}

/** @return {'NO_CHANGE'|'WRITE'} */
function decideCanonicalWrite_(expectedChecksum, currentChecksum) {
  return currentChecksum && currentChecksum === expectedChecksum ? 'NO_CHANGE' : 'WRITE';
}

function objectToRow_(obj, columns) {
  return columns.map(function (c) { return obj[c] === undefined || obj[c] === null ? '' : obj[c]; });
}

function rowToObject_(row, columns) {
  const obj = {};
  columns.forEach(function (c, i) { obj[c] = row[i]; });
  return obj;
}

/* ---------------------------------- I/O --------------------------------- */

/** Whole sheet grid with its checksum (same definition as readSheetSnapshot_). */
function readSheetGrid_(sheet) {
  const rows = sheet.getMaxRows();
  const columns = sheet.getMaxColumns();
  const values = sheet.getRange(1, 1, rows, columns).getValues();
  return { values: values, rows: rows, columns: columns, checksum: computeRawChecksum_(values) };
}

/** Empty hidden staging tab sized rows x schema columns, formatted like the schema table. */
function prepareTableStaging_(ss, table, stagingName, rows) {
  const columnCount = table.columns.length;
  const staging = prepareStagingSheet_(ss, stagingName, rows, columnCount);
  const filter = staging.getFilter();
  if (filter) filter.remove();
  staging.getRange(1, 1, rows, columnCount).clearDataValidations();
  formatHeader_(staging, columnCount);
  formatColumns_(staging, table.columns);
  ensureFilter_(staging, columnCount);
  protectHeader_(staging, columnCount);
  staging.getRange(1, 1).setNote(table.description);
  return staging;
}

function writeTableValues_(sheet, values) {
  const columns = values[0].length;
  for (let start = 0; start < values.length; start += CANONICAL_WRITE_CHUNK_ROWS) {
    const count = Math.min(CANONICAL_WRITE_CHUNK_ROWS, values.length - start);
    sheet.getRange(start + 1, 1, count, columns).setValues(values.slice(start, start + count));
  }
}

/**
 * Replaces one provider partition of a canonical table. Caller must hold the script lock.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {{table: Object, tab: {targetSheet: string, stagingSheet: string}, providerId: string,
 *          partitionRows: Array<Array<*>>, keyColumns: Array<string>, sortColumns: Array<string>,
 *          stampColumn: string}} spec  partitionRows must have stampColumn blank.
 * @return {{status: string, swapState: string, swapActions: Array<string>, tableRows: number,
 *           tableChecksum: string}}
 */
function replaceCanonicalPartition_(ss, spec) {
  const columns = spec.table.columns.map(function (c) { return c.name; });
  const index = function (name) {
    const i = columns.indexOf(name);
    if (i < 0) throw new Error('Unknown column "' + name + '" in ' + spec.table.sheet);
    return i;
  };
  const providerIdx = index('provider_id');
  const stampIdx = index(spec.stampColumn);
  const keyIdx = spec.keyColumns.map(index);
  const sortIdx = spec.sortColumns.map(index);

  // Must run before reading the target or touching staging.
  const recovery = recoverSwapState_(ss, spec.tab);

  const target = ss.getSheetByName(spec.tab.targetSheet);
  const currentGrid = target ? readSheetGrid_(target) : null;
  const existingRows = currentGrid ? tableRowsFromGrid_(currentGrid.values, columns, spec.tab.targetSheet) : [];

  const merged = sortCanonicalRows_(
    mergeProviderPartition_(existingRows, spec.partitionRows, providerIdx, spec.providerId), sortIdx);
  const duplicates = findDuplicateKeys_(merged, keyIdx);
  if (duplicates.length > 0) {
    throw new Error('Duplicate ' + spec.keyColumns.join(' + ') + ' in ' + spec.table.sheet + ': ' +
      duplicates.slice(0, 20).join(', '));
  }

  const expected = buildTableValues_(columns, merged);
  const expectedChecksum = tableChecksumExcluding_(expected, [stampIdx]);
  const currentChecksum = currentGrid ? tableChecksumExcluding_(currentGrid.values, [stampIdx]) : null;
  const base = { swapState: recovery.state, swapActions: recovery.actions, tableRows: merged.length,
    tableChecksum: expectedChecksum };

  if (decideCanonicalWrite_(expectedChecksum, currentChecksum) === 'NO_CHANGE') {
    return Object.assign({ status: 'NO_CHANGE' }, base);
  }

  // Stamp only the replaced partition; whole seconds so the value round-trips exactly.
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const stamped = merged.map(function (row) {
    if (row[providerIdx] !== spec.providerId) return row;
    const copy = row.slice();
    copy[stampIdx] = now;
    return copy;
  });
  const values = buildTableValues_(columns, stamped);
  const written = { rows: values.length, columns: columns.length, checksum: computeRawChecksum_(values) };

  const staging = prepareTableStaging_(ss, spec.table, spec.tab.stagingSheet, values.length);
  writeTableValues_(staging, values);
  SpreadsheetApp.flush();
  assertSnapshotMatches_(readSheetSnapshot_(staging), written, 'Staging "' + spec.tab.stagingSheet + '"');

  swapStagingIntoTarget_(ss, staging, spec.tab, written, null);
  return Object.assign({ status: 'SUCCESS' }, base);
}
