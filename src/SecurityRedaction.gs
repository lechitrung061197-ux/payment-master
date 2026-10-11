/**
 * SecurityRedaction.gs
 * Controlled security exception to the append-only Audit Log: replaces endpoint credentials
 * (<glk_token>.<secret>) that were written into existing Audit Log cells with
 * <glk_token>.<redacted>, then appends a SECURITY_REDACTION entry recording which rows were
 * cleaned (never the removed values).
 *
 * Only credential substrings change; every other character of every cell is preserved and
 * non-text cells are never touched. Rotation of the exposed credentials is the real fix:
 * spreadsheet version history and old execution logs cannot be guaranteed clean.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const SECURITY_REDACTION_REASON = 'Endpoint credentials removed from audit details (Phase 2E.1 endpoint token correction)';

/* ----------------------------- Pure helpers ----------------------------- */

/** True when a cell value contains a credential-like <glk_token>.<suffix> substring. */
function containsEndpointCredential_(value) {
  return typeof value === 'string' && redactEndpointCredentials_(value) !== value;
}

/**
 * Planned cell redactions for a grid (row 1 = header, which is never changed).
 * @return {Array<{row: number, column: number, value: string}>} 1-based positions, redacted values
 */
function planCredentialRedactions_(values) {
  const changes = [];
  for (let r = 1; r < values.length; r++) {
    for (let c = 0; c < values[r].length; c++) {
      const v = values[r][c];
      if (containsEndpointCredential_(v)) changes.push({ row: r + 1, column: c + 1, value: redactEndpointCredentials_(v) });
    }
  }
  return changes;
}

/** Number of data rows with at least one credential-like cell. */
function countCredentialRows_(values) {
  let n = 0;
  for (let r = 1; r < values.length; r++) if (values[r].some(containsEndpointCredential_)) n++;
  return n;
}

/* ---------------------------------- I/O --------------------------------- */

/** Read-only: rows still holding credential-like values per tab (counts only, never values). */
function buildCredentialExposureReport_() {
  const ss = getSpreadsheet_();
  const report = { audit_log_rows: 0, sellers_rows: 0, endpoint_mapping_rows: 0, pass: false, errors: [] };
  try {
    [[SHEETS.AUDIT_LOG, 'audit_log_rows'], [SHEETS.SELLERS, 'sellers_rows'], [SHEETS.ENDPOINT_MAPPING, 'endpoint_mapping_rows']]
      .forEach(function (t) {
        const sheet = ss.getSheetByName(t[0]);
        report[t[1]] = sheet ? countCredentialRows_(readSheetGrid_(sheet).values) : 0;
      });
    if (report.sellers_rows + report.endpoint_mapping_rows > 0) {
      report.errors.push('Sellers / Endpoint Mapping still hold credentials: run migrateSellerEndpointKeysToTokens');
    }
    if (report.audit_log_rows > 0) report.errors.push('Audit Log still holds credentials: run redactAuditLogCredentials');
  } catch (err) {
    report.errors.push(redactEndpointCredentials_(err && err.message ? err.message : String(err)));
  }
  report.pass = report.errors.length === 0;
  return report;
}

/** Redacts credential substrings in existing Audit Log cells under the script lock. Never throws. */
function runAuditLogCredentialRedaction_() {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  const details = { reason: SECURITY_REDACTION_REASON, redacted_rows: [], cells_changed: 0 };
  let status = 'FAILED';
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms.');
    const sheet = getSpreadsheet_().getSheetByName(SHEETS.AUDIT_LOG);
    if (!sheet) throw new Error('Audit Log tab not found.');
    const values = readSheetGrid_(sheet).values;
    const changes = planCredentialRedactions_(values);
    details.cells_changed = changes.length;

    const timestampCol = getColumnIndex_(SHEETS.AUDIT_LOG, 'timestamp') - 1;
    const actionCol = getColumnIndex_(SHEETS.AUDIT_LOG, 'action') - 1;
    const rows = {};
    changes.forEach(function (c) { (rows[c.row] = rows[c.row] || []).push(c); });
    Object.keys(rows).map(Number).sort(function (a, b) { return a - b; }).forEach(function (row) {
      const updated = values[row - 1].slice();
      rows[row].forEach(function (c) { updated[c.column - 1] = c.value; });
      sheet.getRange(row, 1, 1, updated.length).setValues([updated]);
      const ts = values[row - 1][timestampCol];
      details.redacted_rows.push({ row: row, action: String(values[row - 1][actionCol]),
        timestamp: isDateValue_(ts) ? ts.toISOString() : String(ts), cells: rows[row].length });
    });
    SpreadsheetApp.flush();

    const remaining = countCredentialRows_(readSheetGrid_(sheet).values);
    if (remaining > 0) throw new Error(remaining + ' Audit Log row(s) still contain credentials after redaction.');
    status = changes.length === 0 ? 'NO_CHANGE' : 'SUCCESS';
  } catch (err) {
    details.error = redactEndpointCredentials_(err && err.message ? err.message : String(err));
    status = 'FAILED';
  } finally {
    try {
      appendAuditLog_({
        action: 'SECURITY_REDACTION',
        entityType: 'AUDIT_LOG',
        entityId: SHEETS.AUDIT_LOG,
        newStatus: status,
        details: redactDeep_(details),
      });
    } catch (auditErr) {
      Logger.log('Failed to write audit entry: %s', redactEndpointCredentials_(String(auditErr)));
    }
    if (locked) lock.releaseLock();
  }
  return redactDeep_(Object.assign({ status: status }, details));
}
