/**
 * RawSnapshot.gs
 * Pure helpers for raw snapshot sync: canonical serialization, checksum,
 * validation, the no-change decision and the swap-recovery decision.
 *
 * No Apps Script service is called at load time or inside these helpers, except
 * the default digest function, so they can be unit-tested in Node (see test/).
 */

const RAW_CHECKSUM_ALGORITHM = 'SHA-256';
const RAW_CHECKSUM_CHUNK_ROWS = 2000;

/**
 * Canonical, locale-independent serialization of one cell value.
 * Type tags keep "1" (text) and 1 (number) distinct, and blank distinct from "".
 *   blank   -> E
 *   string  -> S<JSON string>
 *   number  -> N<shortest round-trip decimal>   (-0 is treated as 0)
 *   boolean -> B1 / B0
 *   Date    -> D<epoch milliseconds>            (invalid Date -> DNaN)
 *   other   -> O<JSON>
 */
function serializeCell_(value) {
  if (value === null || value === undefined || value === '') return 'E';
  if (isDateValue_(value)) {
    const ms = value.getTime();
    return isNaN(ms) ? 'DNaN' : 'D' + ms;
  }
  switch (typeof value) {
    case 'string':
      return 'S' + JSON.stringify(value);
    case 'number':
      return 'N' + (Object.is(value, -0) ? '0' : String(value));
    case 'boolean':
      return value ? 'B1' : 'B0';
    default:
      return 'O' + JSON.stringify(value);
  }
}

function isDateValue_(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

function serializeRow_(row) {
  return row.map(serializeCell_).join('\u001f');
}

/** Default digest: SHA-256 hex via Apps Script Utilities. */
function sha256Hex_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytesToHex_(bytes);
}

function bytesToHex_(bytes) {
  return bytes.map(function (b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

/**
 * Deterministic checksum of a 2D array of values.
 * Rows are serialized and hashed in fixed-size chunks; the final hash covers the
 * dimensions and every chunk hash, so any dimension or cell change alters it.
 * @param {Array<Array<*>>} values rectangular 2D array
 * @param {function(string): string=} digestHex hex digest function (defaults to SHA-256 via Utilities)
 */
function computeRawChecksum_(values, digestHex) {
  const digest = digestHex || sha256Hex_;
  const dims = getDimensions_(values);
  const chunkHashes = [];
  for (let start = 0; start < values.length; start += RAW_CHECKSUM_CHUNK_ROWS) {
    const chunk = values.slice(start, start + RAW_CHECKSUM_CHUNK_ROWS);
    chunkHashes.push(digest(chunk.map(serializeRow_).join('\u001e')));
  }
  return digest('v1|' + dims.rows + 'x' + dims.columns + '|' + chunkHashes.join(','));
}

function getDimensions_(values) {
  return { rows: values.length, columns: values.length > 0 ? values[0].length : 0 };
}

function isBlankCell_(value) {
  return value === null || value === undefined || value === '';
}

/** Returns a list of validation errors (empty when valid). */
function validateRawDataset_(values) {
  const errors = [];
  if (!Array.isArray(values) || values.length === 0) {
    errors.push('Dataset has no rows.');
    return errors;
  }
  const columns = Array.isArray(values[0]) ? values[0].length : 0;
  if (columns === 0) {
    errors.push('Dataset has no columns.');
    return errors;
  }
  for (let r = 0; r < values.length; r++) {
    if (!Array.isArray(values[r]) || values[r].length !== columns) {
      errors.push('Row ' + (r + 1) + ' has ' + (Array.isArray(values[r]) ? values[r].length : 'no') +
        ' columns; expected ' + columns + '.');
      return errors;
    }
  }
  // Guard the last known good snapshot against an accidentally emptied source tab.
  const hasContent = values.some(function (row) { return !row.every(isBlankCell_); });
  if (!hasContent) errors.push('Dataset is entirely blank.');
  return errors;
}

/**
 * Swap-recovery decision. The swap renames, in order:
 *   (1) target -> swap   (2) staging -> target   (3) swap -> staging
 * A hard termination between steps can leave these name combinations. Given which
 * of the three tab names currently exist, returns the recovery to apply BEFORE
 * staging is cleared or reused. Recovery never deletes a tab and always restores
 * the last known good snapshot (the swap tab) when one exists.
 *
 *   T W G   state      actions
 *   1 0 *   NORMAL     none
 *   0 1 1   B          swap -> target            (interrupted after step 1)
 *   1 1 0   C          target -> staging, swap -> target
 *                                               (interrupted after step 2: new target unconfirmed)
 *   0 1 0   D          swap -> target
 *   1 1 1   UNKNOWN    throw, manual inspection
 *   0 0 1   UNKNOWN    throw, manual inspection (target missing, not a swap state)
 *   0 0 0   NO_TARGET  none (nothing to protect; sync creates the target)
 *
 * @param {{targetExists: boolean, swapExists: boolean, stagingExists: boolean}} s
 * @return {{state: string, actions: Array<string>, error: ?string}}
 */
function decideRawSwapRecovery_(s) {
  const t = !!s.targetExists;
  const w = !!s.swapExists;
  const g = !!s.stagingExists;
  if (t && !w) return { state: 'NORMAL', actions: [], error: null };
  if (!t && w && g) return { state: 'B', actions: ['RENAME_SWAP_TO_TARGET'], error: null };
  if (t && w && !g) {
    return { state: 'C', actions: ['RENAME_TARGET_TO_STAGING', 'RENAME_SWAP_TO_TARGET'], error: null };
  }
  if (!t && w && !g) return { state: 'D', actions: ['RENAME_SWAP_TO_TARGET'], error: null };
  if (!t && !w && !g) return { state: 'NO_TARGET', actions: [], error: null };
  return {
    state: 'UNKNOWN',
    actions: [],
    error: 'Unrecognized raw swap state (target=' + t + ', swap=' + w + ', staging=' + g +
      '). Nothing was changed; inspect the tabs manually.',
  };
}

/**
 * Decides whether a source must be written.
 * NO_CHANGE only when the source matches the last successful checksum AND the current
 * target still holds that same snapshot (guards against a manually edited target).
 * @param {{sourceChecksum: string, lastSuccessfulChecksum: ?string, targetChecksum: ?string}} state
 * @return {'NO_CHANGE'|'WRITE'}
 */
function decideRawSyncAction_(state) {
  if (!state.lastSuccessfulChecksum) return 'WRITE';
  if (state.sourceChecksum !== state.lastSuccessfulChecksum) return 'WRITE';
  if (state.targetChecksum !== state.sourceChecksum) return 'WRITE';
  return 'NO_CHANGE';
}

/** Fallback format for non-text cells without a usable source format. */
const RAW_DEFAULT_NUMBER_FORMAT = '0.###############';
const RAW_DEFAULT_DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss';

/**
 * Builds per-cell number formats for writing a snapshot.
 * Strings are forced to plain text ("@") so values such as "00123", "TRUE" or "=A1"
 * are stored as text and not re-parsed. Other cells keep the source format; cells
 * whose source format is empty or plain text get an explicit fallback.
 */
function buildRawNumberFormats_(values, sourceFormats) {
  return values.map(function (row, r) {
    return row.map(function (value, c) {
      const sourceFormat = sourceFormats && sourceFormats[r] ? sourceFormats[r][c] : '';
      if (typeof value === 'string' && value !== '') return '@';
      const usable = sourceFormat && sourceFormat !== '@';
      if (isDateValue_(value)) return usable ? sourceFormat : RAW_DEFAULT_DATE_FORMAT;
      return usable ? sourceFormat : RAW_DEFAULT_NUMBER_FORMAT;
    });
  });
}
