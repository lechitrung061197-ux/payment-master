/**
 * Audit.gs
 * Append-only audit logging into the "Audit Log" tab.
 */

/**
 * Appends one audit entry.
 * @param {{action: string, entityType: string, entityId: string, oldStatus?: string,
 *          newStatus?: string, actor?: string, details?: (string|Object)}} entry
 */
function appendAuditLog_(entry) {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.AUDIT_LOG);
  if (!sheet) throw new Error('Audit Log tab not found. Run setupMaster first.');

  const details = typeof entry.details === 'object' && entry.details !== null
    ? JSON.stringify(entry.details)
    : (entry.details || '');

  const row = [
    new Date(),
    entry.action,
    entry.entityType,
    entry.entityId,
    entry.oldStatus || '',
    entry.newStatus || '',
    entry.actor || APP.SYSTEM_ACTOR,
    details,
  ];

  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}
