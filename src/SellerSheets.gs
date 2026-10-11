/**
 * SellerSheets.gs
 * Seller child spreadsheets (I/O): template-driven, output-only projections of Payment Master
 * (contract and pure model in SellerOutput.gs).
 *
 * - Payment Master is the only accounting source of truth; child sheets are never read back into it.
 * - Ownership filter: exact Transactions.seller_id. No row can cross sellers.
 * - Gates: Transactions, Provider Transactions, Payment Matches, Settlements, Seller Terms, Payment Legs,
 *   Settlement Items and Seller Balances current, Seller Destinations valid - before ANY child write.
 * - The child keeps the template UI (formatting, locale, time zone). Writes go only to explicit owned
 *   ranges with setValues (blank padding clears stale rows); sheet.clear() is never used, static labels and
 *   approved presentation formulas are never written. When a block outgrows the template capacity, rows are
 *   inserted inside the block and the template data-row format is copied onto them.
 * - Idempotency: per-tab checksums of the owned content. Unchanged -> NO_CHANGE with zero writes and the
 *   previous synced_at. Otherwise changed tabs are written, then the hidden _Sync commit marker LAST, and
 *   the child is reread and fully verified (contract, leaks, isolation, checksums) before SUCCESS.
 */

const SELLER_WRITE = Object.freeze({
  // Strings Sheets could reinterpret (numbers, dates, booleans, formulas) are written with a quote prefix.
  textGuardPattern: /^\s*[0-9.=+\-@']|^(true|false)$/i,
});

/* ----------------------------- Pure helpers ----------------------------- */

/** Value as written to a child cell: strings that Sheets could reinterpret get a quote prefix. */
function sellerCellValue_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' && v !== '' && SELLER_WRITE.textGuardPattern.test(v)) return "'" + v;
  return v;
}

function sellerPadRows_(rows, count, width) {
  const out = rows.map(function (r) { return r.map(sellerCellValue_); });
  while (out.length < count) out.push(Array(width).fill(''));
  return out;
}

/** Overall sync status from per-seller results. */
function decideSellerSyncStatus_(results) {
  if (results.length === 0) return 'NO_CHANGE';
  const failed = results.filter(function (x) { return x.status === 'FAILED'; }).length;
  const ok = results.length - failed;
  if (failed > 0) return ok > 0 ? 'PARTIAL' : 'FAILED';
  return results.some(function (x) { return x.status === 'SUCCESS'; }) ? 'SUCCESS' : 'NO_CHANGE';
}

/** Endpoint-token / e-mail-like values in the desired output (must be none). */
function findCredentialsInSnapshot_(snapshot) {
  const hits = [];
  SELLER_OUTPUT.visibleTabs.forEach(function (tab) {
    sellerTabCanonical_(tab, snapshot.blocks[tab]).forEach(function (row, r) {
      row.forEach(function (v) {
        if (typeof v === 'string' && (SELLER_OUTPUT.credentialPattern.test(v) || SELLER_OUTPUT.emailPattern.test(v))) {
          hits.push(snapshot.seller_id + ' ' + tab + ' item ' + (r + 1));
        }
      });
    });
  });
  return hits;
}

/* ---------------------------------- I/O --------------------------------- */

/**
 * Every Master layer a seller sheet is projected from must be current. Read-only, never throws.
 * @return {{current: boolean, gates: Object<string, boolean>, reasons: Array<string>}}
 */
function readSellerSheetsGates_(ss) {
  const gates = {};
  const reasons = [];
  const add = function (name, f) {
    gates[name] = !!f.current;
    if (!f.current) reasons.push(f.reason || name + ' is not current');
  };
  const upstream = readSettlementItemsUpstream_(ss);
  Object.keys(upstream).forEach(function (k) { add(k, upstream[k]); });
  const items = readSettlementItemsFreshness_(ss, upstream);
  add('settlement_items', items);
  add('seller_balances', readSellerBalancesFreshness_(ss, items));
  return { current: reasons.length === 0, gates: gates, reasons: reasons };
}

/** Reads the Master tables the projection uses and builds seller outputs for the given sellers. */
function buildSellerSnapshotsFromMaster_(ss, sellers) {
  return buildSellerOutputs_({
    sellers: sellers,
    transactions: readSchemaTableObjects_(ss, SHEETS.TRANSACTIONS, transactionsTab_()).rows,
    matches: readSchemaTableObjects_(ss, SHEETS.PAYMENT_MATCHES, paymentMatchesTab_()).rows,
    legs: readSchemaTableObjects_(ss, SHEETS.PAYMENT_LEGS, paymentLegsTab_()).rows,
    settlements: readSchemaTableObjects_(ss, SHEETS.SETTLEMENTS, settlementsTab_()).rows,
    balances: readSchemaTableObjects_(ss, SHEETS.SELLER_BALANCES, sellerBalancesTab_()).rows,
    payouts: readPlainTableObjects_(ss, SHEETS.SELLER_PAYOUTS),
    adjustments: readPlainTableObjects_(ss, SHEETS.ADJUSTMENTS),
    disputes: readPlainTableObjects_(ss, SHEETS.DISPUTES),
    sellerTerms: readSellerTermsValidity_(ss).terms,
    settlementItems: readSchemaTableObjects_(ss, SHEETS.SETTLEMENT_ITEMS, settlementItemsTab_()).rows,
    allocations: readPlainTableObjects_(ss, SHEETS.SELLER_PAYOUT_ALLOCATIONS),
    masterSchemaVersion: APP.SCHEMA_VERSION,
    dateKeyOf: masterDateKey_,
  });
}

/** IDs that must never appear in seller output: the Master and configured provider source spreadsheets. */
function sellerHiddenIds_(ss) {
  const guard = sellerDestinationGuard_(ss);
  return [guard.masterId].concat(guard.protectedIds.map(function (p) { return p.id; }))
    .map(function (v) { return trimmedText_(v); }).filter(function (v) { return v !== ''; });
}

/** Read-only snapshot of a seller workbook (template or child): every tab's values and formulas. */
function readSellerWorkbook_(spreadsheet) {
  return {
    timeZone: spreadsheet.getSpreadsheetTimeZone(),
    sheets: spreadsheet.getSheets().map(function (sheet) {
      const range = sheet.getRange(1, 1, Math.max(sheet.getMaxRows(), 1), Math.max(sheet.getMaxColumns(), 1));
      return { name: sheet.getName(), hidden: sheet.isSheetHidden(), values: range.getValues(), formulas: range.getFormulas() };
    }),
  };
}

/** Rereads one tab's layout (after a row insertion) from the live sheet. */
function relocateSellerTab_(sheet) {
  const range = sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns());
  const located = locateSellerTabLayout_(sheet.getName(), range.getValues(), range.getFormulas());
  if (!located.layout) throw new Error('Template layout lost after row insertion: ' + located.errors.join(' | '));
  return located.layout;
}

/**
 * Inserts rows INSIDE a dynamic block (before its last row, so presentation formula ranges, filters and
 * conditional formats extend with it) and copies the template data-row format onto the new rows.
 */
function expandSellerBlock_(child, need, layouts) {
  const sheet = child.getSheetByName(need.tab);
  const L = layouts[need.tab];
  const span = need.block === 'sources' ? [L.srcStart, L.srcEnd, 9] : need.block === 'history' ? [L.histStart, L.histEnd, 17]
    : [L.dataStart, L.dataEnd, L.width];
  sheet.insertRowsBefore(span[1], need.extra);
  sheet.getRange(span[0], 1, 1, span[2]).copyTo(sheet.getRange(span[1], 1, need.extra, span[2]), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  if (need.tab === 'Dispute') {
    // "Số ngày còn lại" is an approved per-row presentation formula: copy it onto the new rows.
    sheet.getRange(span[0], L.dayColumn).copyTo(sheet.getRange(span[1], L.dayColumn, need.extra, 1), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
  }
  layouts[need.tab] = relocateSellerTab_(sheet);
}

/** Writes the owned ranges of one visible tab (values only). */
function writeSellerTab_(child, tab, layout, blocks) {
  const sheet = child.getSheetByName(tab);
  const put = function (r, c, rows) { if (rows.length > 0 && rows[0].length > 0) sheet.getRange(r, c, rows.length, rows[0].length).setValues(rows); };
  const L = layout;
  if (tab === 'DoiSoat_GD' || tab === 'TongHop_Thang') {
    put(L.dataStart, 1, sellerPadRows_(blocks.rows, L.dataEnd - L.dataStart + 1, L.width));
    return;
  }
  if (tab === 'Dispute') {
    const rows = sellerPadRows_(blocks.rows, L.dataEnd - L.dataStart + 1, 17);
    put(L.dataStart, 1, rows.map(function (r) { return r.slice(0, 13); }));
    put(L.dataStart, 15, rows.map(function (r) { return r.slice(13); }));
    return;
  }
  const v = sellerCellValue_;
  if (L.legacyHeaderD) put(L.headerD, 9, [[SELLER_TEMPLATE.phieuHeadersD[8]]]); // one-time header migration (value only)
  put(L.seller, 2, [[v(blocks.info[0])]]);
  put(L.from, 2, [[v(blocks.info[1])]]);
  put(L.to, 2, [[v(blocks.info[2])]]);
  put(L.pending, 2, [[v(blocks.info[3]), v(blocks.info[4])]]);
  put(L.pending, 5, [[v(blocks.info[5])]]);
  put(L.srcStart, 1, sellerPadRows_(blocks.sources, L.srcEnd - L.srcStart + 1, 9));
  put(L.totalRow, 2, [blocks.total.map(v)]);
  put(L.bRows[0], 2, blocks.b.map(function (x) { return [v(x)]; }));
  put(L.cRows[0], 2, blocks.c.map(function (r) { return r.map(v); }));
  put(L.checkRow, 2, [[v(blocks.check[0])]]);
  put(L.histStart, 1, sellerPadRows_(blocks.history, L.histEnd - L.histStart + 1, 17));
  put(L.pendRow, 5, [[v(blocks.pending[0])]]);
  put(L.startRow, 2, [[v(blocks.start[0])]]);
}

/** Writes the hidden _Sync commit marker in one setValues call (creating / hiding the tab when needed). */
function commitSellerSync_(child, rows) {
  let sheet = child.getSheetByName(SELLER_OUTPUT.syncTab);
  if (!sheet) sheet = child.insertSheet(SELLER_OUTPUT.syncTab, child.getSheets().length);
  if (!sheet.isSheetHidden()) sheet.hideSheet();
  sheet.getRange(1, 1, rows.length, 2).setValues(rows.map(function (r) { return r.map(sellerCellValue_); }));
}

/** Syncs one destination. Never throws; a failure affects this seller only. */
function syncOneSellerSheet_(dest, snapshot, guard) {
  const result = { seller_id: dest.seller_id, seller_name: snapshot.seller_name, spreadsheet_id: dest.spreadsheet_id, status: 'FAILED',
    written_tabs: [], expanded: [], synced_at: null, combined_checksum: snapshot.checksums.combined, error: null };
  Object.keys(snapshot.totals.counts).forEach(function (k) { result[k] = snapshot.totals.counts[k]; });
  try {
    const child = SpreadsheetApp.openById(dest.spreadsheet_id);
    if (child.getId() === guard.masterId) throw new Error('destination resolves to the Payment Master; refusing to write');
    const before = compareSellerWorkbook_(snapshot, readSellerWorkbook_(child), { requireSync: false, hiddenIds: guard.hiddenIds });
    if (before.errors.length > 0) throw new Error('seller sheet does not satisfy the template contract: ' + before.errors.slice(0, 8).join(' | '));
    if (before.changedTabs.length === 0 && before.sync_match && before.combined_match && before.synced_at) {
      result.status = 'NO_CHANGE';
      result.synced_at = before.synced_at;
      return result;
    }
    const layouts = before.layouts;
    sellerCapacityNeeds_(snapshot, layouts).forEach(function (need) {
      expandSellerBlock_(child, need, layouts);
      result.expanded.push(need.tab + '.' + need.block + '+' + need.extra);
    });
    SELLER_OUTPUT.visibleTabs.forEach(function (tab) {
      const expanded = result.expanded.some(function (e) { return e.indexOf(tab + '.') === 0; });
      if (before.changedTabs.indexOf(tab) < 0 && !expanded) return;
      writeSellerTab_(child, tab, layouts[tab], snapshot.blocks[tab]);
      result.written_tabs.push(tab);
    });
    const at = new Date(Math.floor(Date.now() / 1000) * 1000);
    commitSellerSync_(child, sellerSyncRows_(snapshot, at)); // commit marker, LAST
    result.written_tabs.push(SELLER_OUTPUT.syncTab);
    SpreadsheetApp.flush();
    const after = compareSellerWorkbook_(snapshot, readSellerWorkbook_(child), { requireSync: true, hiddenIds: guard.hiddenIds });
    if (after.errors.length > 0) throw new Error('post-write verification failed: ' + after.errors.slice(0, 5).join(' | '));
    if (!after.synced_at || after.synced_at.getTime() !== at.getTime()) throw new Error('_Sync was not committed');
    result.status = 'SUCCESS';
    result.synced_at = at;
  } catch (err) {
    result.status = 'FAILED';
    result.error = redactEndpointCredentials_(err && err.message ? err.message : String(err));
  }
  return result;
}

/** Valid Seller Destinations or a thrown error: any config ambiguity is a leak risk (nothing is written). */
function readValidSellerDestinations_(ss, details) {
  const dest = readSellerDestinations_(ss);
  const destErrors = flattenDestinationErrors_(dest.parsed.errors);
  if (details) details.warnings = dest.parsed.warnings.slice();
  if (destErrors.length > 0) {
    throw new Error('Seller Destinations is invalid; no seller sheet written (' + destErrors.length + ' error(s)): ' +
      destErrors.slice(0, SELLER_OUTPUT.maxReportedErrors).join(' | '));
  }
  return dest;
}

/** Master freshness gate shared by every seller-sheet writer. Throws when any layer is stale. */
function assertSellerSheetsGates_(ss, details) {
  const gates = readSellerSheetsGates_(ss);
  details.gates = gates.gates;
  if (!gates.current) throw new Error('Payment Master is not current; no seller sheet written: ' + gates.reasons.join(' | '));
}

/** Seller outputs for the given sellers; integrity problems or token / e-mail values fail before any write. */
function buildCheckedSellerSnapshots_(ss, sellers) {
  const built = buildSellerSnapshotsFromMaster_(ss, sellers);
  if (built.errors.length > 0) {
    throw new Error('Seller output is invalid; no seller sheet written (' + built.errors.length + ' error(s)): ' +
      built.errors.slice(0, SELLER_OUTPUT.maxReportedErrors).join(' | '));
  }
  const leaks = [];
  sellers.forEach(function (s) { findCredentialsInSnapshot_(built.snapshots[s.seller_id]).forEach(function (h) { leaks.push(h); }); });
  if (leaks.length > 0) throw new Error('Seller output contains endpoint tokens / e-mail addresses; no seller sheet written: ' + leaks.slice(0, 10).join(' | '));
  return built.snapshots;
}

/** Runs fn(details) under the script lock and audits '<auditPrefix><status>'. Never throws. */
function withSellerSheetsLock_(auditPrefix, entityId, details, fn) {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  let status = 'FAILED';
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms.');
    status = fn(details);
  } catch (err) {
    details.error = redactEndpointCredentials_(err && err.message ? err.message : String(err));
    status = 'FAILED';
  } finally {
    if (details.sellers) details.status_counts = details.sellers.reduce(function (a, x) { a[x.status] = (a[x.status] || 0) + 1; return a; }, {});
    try {
      appendAuditLog_({ action: auditPrefix + status, entityType: 'SELLER_SHEETS', entityId: entityId || '', newStatus: status,
        details: redactDeep_(details) });
    } catch (auditErr) {
      Logger.log('Failed to write audit entry: %s', auditErr);
    }
    if (locked) lock.releaseLock();
  }
  return redactDeep_(Object.assign({ status: status }, details));
}

/** Syncs every ACTIVE Seller Destination under the script lock. Never throws. */
function runSellerSheetsSync_() {
  return withSellerSheetsLock_('SELLER_SHEETS_SYNC_', '', { active_destinations: 0, sellers: [], warnings: [] }, function (details) {
    const ss = getSpreadsheet_();
    const active = readValidSellerDestinations_(ss, details).parsed.active;
    details.active_destinations = active.length;
    if (active.length === 0) {
      details.warnings.push('No ACTIVE Seller Destinations; nothing to sync.');
      return 'NO_CHANGE';
    }
    assertSellerSheetsGates_(ss, details);
    const snapshots = buildCheckedSellerSnapshots_(ss, active.map(function (d) { return { seller_id: d.seller_id, seller_name: d.seller_name }; }));
    const guard = { masterId: ss.getId(), hiddenIds: sellerHiddenIds_(ss) };
    active.forEach(function (d) { details.sellers.push(syncOneSellerSheet_(d, snapshots[d.seller_id], guard)); });
    return decideSellerSyncStatus_(details.sellers);
  });
}

/** Syncs exactly one ACTIVE seller destination (same guards as syncSellerSheets). Never throws. */
function runSingleSellerSheetSync_(sellerId) {
  const id = trimmedText_(sellerId);
  return withSellerSheetsLock_('SELLER_SHEET_SYNC_', id, { seller_id: id, sellers: [], warnings: [] }, function (details) {
    const ss = getSpreadsheet_();
    const dest = readValidSellerDestinations_(ss, details);
    const d = dest.parsed.destinations.filter(function (x) { return x.seller_id === id; })[0];
    if (!d) throw new Error('Seller ' + (id || '(blank)') + ' has no Seller Destinations row.');
    if (d.status !== SELLER_DESTINATIONS.activeStatus) throw new Error('Seller Destination for ' + id + ' is ' + d.status + '; only ACTIVE destinations are synced.');
    assertSellerSheetsGates_(ss, details);
    const snapshots = buildCheckedSellerSnapshots_(ss, [{ seller_id: d.seller_id, seller_name: d.seller_name }]);
    details.sellers.push(syncOneSellerSheet_(d, snapshots[d.seller_id], { masterId: ss.getId(), hiddenIds: sellerHiddenIds_(ss) }));
    return details.sellers[0].status;
  });
}

/** Read-only verification of every ACTIVE seller child spreadsheet. Never writes. */
function buildSellerSheetsReport_() {
  const report = { active_destinations: 0, passed_destinations: 0, failed_destinations: 0, master_fresh: false, destinations_valid: false,
    output_schema_version: SELLER_OUTPUT.schemaVersion, gates: {}, sellers: [], regression: null, pass: false, errors: [], warnings: [] };
  try {
    const ss = getSpreadsheet_();
    const dest = readSellerDestinations_(ss);
    const destErrors = flattenDestinationErrors_(dest.parsed.errors);
    report.destinations_valid = destErrors.length === 0;
    destErrors.forEach(function (e) { report.errors.push('Seller Destinations: ' + e); });
    dest.parsed.warnings.forEach(function (w) { report.warnings.push(w); });
    const gates = readSellerSheetsGates_(ss);
    report.master_fresh = gates.current;
    report.gates = gates.gates;
    gates.reasons.forEach(function (x) { report.errors.push(x); });
    const sellers = dest.sellers.filter(function (s) { return s.seller_id !== ''; })
      .map(function (s) { return { seller_id: s.seller_id, seller_name: s.seller_name }; });
    const built = buildSellerSnapshotsFromMaster_(ss, sellers);
    built.errors.forEach(function (e) { report.errors.push(e); });
    report.regression = evaluateSellerSheetsRegression_(built.snapshots);
    const active = report.destinations_valid ? dest.parsed.active : [];
    const hiddenIds = sellerHiddenIds_(ss);
    report.active_destinations = active.length;
    if (active.length === 0) report.warnings.push('No ACTIVE Seller Destinations to verify.');
    active.forEach(function (d) {
      const snapshot = built.snapshots[d.seller_id];
      const s = { seller_id: d.seller_id, seller_name: d.seller_name, spreadsheet_id: d.spreadsheet_id, accessible: false, doisoat_match: false,
        tonghop_match: false, phieu_match: false, dispute_match: false, sync_match: false, combined_match: false, transaction_rows: 0,
        month_rows: 0, settlement_rows: 0, dispute_rows: 0, synced_at: null, pass: false, errors: [], warnings: [] };
      try {
        if (!snapshot) throw new Error('no seller output could be built for ' + d.seller_id);
        const child = SpreadsheetApp.openById(d.spreadsheet_id);
        s.accessible = true;
        if (child.getId() === ss.getId()) throw new Error('destination resolves to the Payment Master');
        const c = compareSellerWorkbook_(snapshot, readSellerWorkbook_(child), { requireSync: true, hiddenIds: hiddenIds });
        s.doisoat_match = c.matches.DoiSoat_GD === true;
        s.tonghop_match = c.matches.TongHop_Thang === true;
        s.phieu_match = c.matches.PhieuDoiSoat === true;
        s.dispute_match = c.matches.Dispute === true;
        s.sync_match = c.sync_match;
        s.combined_match = c.combined_match;
        s.synced_at = c.synced_at;
        Object.keys(c.counts).forEach(function (k) { s[k] = c.counts[k]; });
        s.errors = c.errors.slice(0, SELLER_OUTPUT.maxReportedErrors);
      } catch (err) {
        s.errors.push(err && err.message ? err.message : String(err));
      }
      s.pass = s.errors.length === 0 && report.master_fresh;
      if (s.pass) report.passed_destinations++; else report.failed_destinations++;
      report.sellers.push(s);
    });
    if (report.failed_destinations > 0) report.errors.push(report.failed_destinations + ' seller destination(s) failed verification.');
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0;
  return redactDeep_(report);
}
