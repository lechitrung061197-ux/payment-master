/**
 * SellerProvisioning.gs
 * Template-based provisioning of a seller child spreadsheet (createSellerSheet) and the Master
 * "Seller Sheets" menu helpers.
 *
 * Recoverable lifecycle of a Seller Destinations row:
 *   INACTIVE + blank ID -> clone template -> INACTIVE + registered ID -> sync + verify -> ACTIVE.
 * - The copy's ID is registered immediately (still INACTIVE), so a failed sync/verification leaves a
 *   registered copy that the next createSellerSheet reuses; a second copy is never cloned and failed
 *   copies are never deleted automatically.
 * - The destination becomes ACTIVE (and its name snapshot current) only after the seller-specific sync
 *   and a full verification of the child pass. An ACTIVE destination is never cloned again.
 * - The template is layout / branding only. After cloning, Master owns the six managed tabs; any other
 *   tab copied from the template is left untouched. A template must not hold accounting formulas used
 *   as a source of truth.
 * - Same gates as syncSellerSheets (Master freshness, destination config, privacy/isolation), plus:
 *   the seller exists and has valid Seller Terms; the template is an accessible Google Spreadsheet that
 *   is not the Master, a provider source or a registered seller destination; the folder is accessible.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const SELLER_PROVISIONING = Object.freeze({
  templateSetting: 'seller_template_spreadsheet_id',
  folderSetting: 'seller_output_folder_id',
  driveIdPattern: /^[A-Za-z0-9_-]{20,}$/,
  spreadsheetMimeType: 'application/vnd.google-apps.spreadsheet',
  menuTitle: 'Seller Sheets',
});

/* ----------------------------- Pure helpers ----------------------------- */

function sellerSheetFileName_(sellerId, sellerName) {
  return 'Seller - ' + sellerId + ' - ' + sellerName;
}

function sellerSheetUrl_(spreadsheetId) {
  return 'https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/edit';
}

/**
 * Static checks of the provisioning settings (no Drive access). IDs are never echoed.
 * @param {string} templateId
 * @param {string} folderId
 * @param {{masterId: string, protectedIds: Array<{id: string, label: string}>}} guard
 * @param {Array<string>} destinationIds every nonblank Seller Destinations spreadsheet_id
 * @return {Array<string>} errors
 */
function validateProvisioningSettings_(templateId, folderId, guard, destinationIds) {
  const errors = [];
  const T_ = SELLER_PROVISIONING.templateSetting;
  const F_ = SELLER_PROVISIONING.folderSetting;
  if (templateId === '') errors.push(T_ + ' is blank (Settings)');
  else if (!SELLER_PROVISIONING.driveIdPattern.test(templateId)) errors.push(T_ + ' is not a Drive file ID (paste the ID, not the URL)');
  if (folderId === '') errors.push(F_ + ' is blank (Settings)');
  else if (!SELLER_PROVISIONING.driveIdPattern.test(folderId)) errors.push(F_ + ' is not a Drive folder ID (paste the ID, not the URL)');
  if (templateId !== '') {
    if (templateId === trimmedText_(guard.masterId)) errors.push(T_ + ' is the Payment Master spreadsheet');
    (guard.protectedIds || []).forEach(function (p) {
      if (trimmedText_(p.id) !== '' && templateId === trimmedText_(p.id)) errors.push(T_ + ' is ' + p.label);
    });
    if (destinationIds.indexOf(templateId) >= 0) errors.push(T_ + ' is a registered seller destination spreadsheet');
  }
  return errors;
}

/** Replaces every hidden ID (Master, provider sources, template, folder) in user-facing text. */
function sanitizeSellerAlertText_(text, hiddenIds) {
  let out = String(text);
  (hiddenIds || []).forEach(function (id) {
    const v = trimmedText_(id);
    if (v !== '') out = out.split(v).join('<hidden id>');
  });
  return redactEndpointCredentials_(out);
}

/** Prompt text for "Create Seller Sheet" listing INACTIVE destinations. */
function buildCreateSellerSheetPromptText_(destinations) {
  const eligible = (destinations || []).filter(function (d) { return d.status === SELLER_DESTINATIONS.inactiveStatus; });
  const lines = ['Enter the seller ID to provision (e.g. CUS001).'];
  if (eligible.length > 0) {
    lines.push('', 'Eligible sellers (INACTIVE destination):');
    eligible.forEach(function (d) {
      lines.push('  ' + d.seller_id + ' - ' + d.seller_name + (d.spreadsheet_id !== '' ? '  (retry: a copy is already registered)' : ''));
    });
  }
  return lines.join('\n');
}

function formatCreateSellerSheetAlert_(result, hiddenIds) {
  const who = (result.seller_id || '(blank)') + (result.seller_name ? ' (' + result.seller_name + ')' : '');
  const lines = [];
  if (result.status === 'SUCCESS') {
    lines.push('Seller sheet ready for ' + who + '.', 'Destination status: ACTIVE', 'URL: ' + sellerSheetUrl_(result.spreadsheet_id));
    if (result.reused_existing_copy) lines.push('Reused the copy registered by an earlier attempt.');
  } else {
    lines.push('Seller sheet NOT activated for ' + who + '.', 'Error: ' + (result.error || 'unknown error'));
    if (result.spreadsheet_id) {
      lines.push('Registered copy (still INACTIVE): ' + sellerSheetUrl_(result.spreadsheet_id),
        'Fix the problem and run Create Seller Sheet again; it reuses this copy.');
    }
  }
  return sanitizeSellerAlertText_(lines.join('\n'), hiddenIds);
}

function formatSellerSyncAlert_(result, hiddenIds) {
  const lines = ['Seller sheet sync: ' + result.status];
  if (result.error) lines.push('Error: ' + result.error);
  (result.sellers || []).forEach(function (s) {
    lines.push(s.seller_id + ' (' + s.seller_name + '): ' + s.status + (s.error ? ' - ' + s.error : ''));
  });
  (result.warnings || []).forEach(function (w) { lines.push('Warning: ' + w); });
  return sanitizeSellerAlertText_(lines.join('\n'), hiddenIds);
}

function formatSellerVerifyAlert_(report, hiddenIds) {
  const lines = ['Seller sheet verification: ' + (report.pass ? 'PASS' : 'FAIL'), 'Master fresh: ' + report.master_fresh,
    'ACTIVE destinations: ' + report.active_destinations + ' (passed ' + report.passed_destinations + ', failed ' + report.failed_destinations + ')'];
  (report.sellers || []).forEach(function (s) {
    lines.push(s.seller_id + ' (' + s.seller_name + '): ' + (s.pass ? 'PASS' : 'FAIL' + (s.errors.length ? ' - ' + s.errors[0] : '')));
  });
  (report.errors || []).slice(0, 5).forEach(function (e) { lines.push('Error: ' + e); });
  return sanitizeSellerAlertText_(lines.join('\n'), hiddenIds);
}

/* ---------------------------------- I/O --------------------------------- */

function writeSellerDestinationCell_(ss, row, column, value) {
  const sheet = ss.getSheetByName(SHEETS.SELLER_DESTINATIONS);
  sheet.getRange(row, getColumnIndex_(SHEETS.SELLER_DESTINATIONS, column)).setValue(value);
}

/** IDs that must never appear in a menu alert. Never throws. */
function sellerAlertHiddenIds_() {
  try {
    const ss = getSpreadsheet_();
    const guard = sellerDestinationGuard_(ss);
    const settings = readSettingsMap_();
    return [guard.masterId].concat(guard.protectedIds.map(function (p) { return p.id; }))
      .concat([settings[SELLER_PROVISIONING.templateSetting], settings[SELLER_PROVISIONING.folderSetting]])
      .map(function (v) { return trimmedText_(v); }).filter(function (v) { return v !== ''; });
  } catch (err) {
    return [];
  }
}

/** INACTIVE destinations for the create prompt. Never throws. */
function readCreateSellerSheetCandidates_() {
  try {
    return readSellerDestinations_(getSpreadsheet_()).parsed.destinations;
  } catch (err) {
    return [];
  }
}

/** createSellerSheet(sellerId): clone (or reuse) -> register -> sync -> verify -> ACTIVE. Never throws. */
function runCreateSellerSheet_(sellerId) {
  const id = trimmedText_(sellerId);
  const details = { seller_id: id, seller_name: '', spreadsheet_id: '', destination_status: '', sync_status: null, verified: false,
    reused_existing_copy: false, created_copy: false, warnings: [] };
  return withSellerSheetsLock_('SELLER_SHEET_CREATE_', id, details, function () {
    const ss = getSpreadsheet_();
    // 2. Master accounting freshness (same gates as syncSellerSheets).
    assertSellerSheetsGates_(ss, details);
    // 3. Seller exists and has valid Seller Terms.
    const seller = readSellersDraft_(ss).parsed.sellers.filter(function (s) { return s.seller_id !== '' && s.seller_id === id; })[0];
    if (!seller) throw new Error('Unknown seller ' + (id || '(blank)') + '; it must exist in Sellers.');
    details.seller_name = seller.seller_name;
    const terms = readSellerTermsValidity_(ss);
    if (!terms.current) throw new Error(terms.reason);
    if (!terms.terms.some(function (t) { return t.seller_id === id; })) throw new Error('Seller ' + id + ' has no valid Seller Terms row.');
    // 4-5. Exactly one destination row, not ACTIVE.
    const dest = readValidSellerDestinations_(ss, details);
    const rows = dest.parsed.destinations.filter(function (d) { return d.seller_id === id; });
    if (rows.length !== 1) {
      throw new Error('Expected exactly one Seller Destinations row for ' + id + ', found ' + rows.length +
        ' (add an INACTIVE row with a blank spreadsheet_id).');
    }
    const d = rows[0];
    details.destination_status = d.status;
    if (d.status === SELLER_DESTINATIONS.activeStatus) {
      details.spreadsheet_id = d.spreadsheet_id;
      throw new Error('Seller Destination for ' + id + ' is already ACTIVE; no new spreadsheet is created (use syncSellerSheet).');
    }
    // 6-7. Template and folder.
    const settings = readSettingsMap_();
    const templateId = trimmedText_(settings[SELLER_PROVISIONING.templateSetting]);
    const folderId = trimmedText_(settings[SELLER_PROVISIONING.folderSetting]);
    const destinationIds = dest.rows.map(function (r) { return trimmedText_(r.spreadsheet_id); }).filter(function (v) { return v !== ''; });
    const problems = validateProvisioningSettings_(templateId, folderId, sellerDestinationGuard_(ss), destinationIds);
    if (problems.length > 0) throw new Error('Seller sheet provisioning settings are invalid: ' + problems.join(' | '));
    let template;
    try {
      template = DriveApp.getFileById(templateId);
      template.getName();
    } catch (err) {
      throw new Error(SELLER_PROVISIONING.templateSetting + ' is not accessible.');
    }
    if (template.getMimeType() !== SELLER_PROVISIONING.spreadsheetMimeType) {
      throw new Error(SELLER_PROVISIONING.templateSetting + ' is not a Google Spreadsheet.');
    }
    let folder;
    try {
      folder = DriveApp.getFolderById(folderId);
      folder.getName();
    } catch (err) {
      throw new Error(SELLER_PROVISIONING.folderSetting + ' is not accessible.');
    }
    // 8-11. Reuse a registered copy, or clone once and register it immediately (still INACTIVE).
    let spreadsheetId = d.spreadsheet_id;
    if (spreadsheetId !== '') {
      if (destinationIds.filter(function (v) { return v === spreadsheetId; }).length > 1) {
        throw new Error('The spreadsheet registered for ' + id + ' is also registered for another seller; refusing to reuse it.');
      }
      details.reused_existing_copy = true;
    } else {
      const copy = template.makeCopy(sellerSheetFileName_(id, seller.seller_name), folder);
      spreadsheetId = copy.getId();
      details.created_copy = true;
      details.spreadsheet_id = spreadsheetId;
      try {
        writeSellerDestinationCell_(ss, d.row, 'spreadsheet_id', spreadsheetId);
        SpreadsheetApp.flush();
      } catch (err) {
        throw new Error('The copy ' + spreadsheetId + ' was created but could not be registered in Seller Destinations (' +
          (err && err.message ? err.message : String(err)) + '); paste this ID into the seller row before retrying.');
      }
    }
    details.spreadsheet_id = spreadsheetId;
    // 12. Seller-specific sync directly against the copy.
    const snapshot = buildCheckedSellerSnapshots_(ss, [{ seller_id: id, seller_name: seller.seller_name }])[id];
    const sync = syncOneSellerSheet_({ seller_id: id, spreadsheet_id: spreadsheetId }, snapshot, ss.getId());
    details.sync_status = sync.status;
    details.written_tabs = sync.written_tabs;
    if (sync.status === 'FAILED') throw new Error('Seller sheet sync failed: ' + sync.error);
    // 13. Full verification of the child output.
    const check = compareChildToSnapshot_(snapshot, readChildState_(SpreadsheetApp.openById(spreadsheetId)));
    if (check.errors.length > 0) throw new Error('Seller sheet verification failed: ' + check.errors.slice(0, 5).join(' | '));
    details.verified = true;
    // 14. Activate only if the row is still this seller's INACTIVE row with the registered copy.
    const now = readValidSellerDestinations_(ss).parsed.destinations.filter(function (x) { return x.seller_id === id; });
    if (now.length !== 1 || now[0].row !== d.row || now[0].spreadsheet_id !== spreadsheetId || now[0].status !== SELLER_DESTINATIONS.inactiveStatus) {
      throw new Error('Seller Destinations row for ' + id + ' changed during provisioning; not activated.');
    }
    writeSellerDestinationCell_(ss, d.row, 'seller_name_snapshot', seller.seller_name);
    writeSellerDestinationCell_(ss, d.row, 'status', SELLER_DESTINATIONS.activeStatus);
    SpreadsheetApp.flush();
    details.destination_status = SELLER_DESTINATIONS.activeStatus;
    return 'SUCCESS';
  });
}
