/**
 * EndpointKeyMigration.gs
 * ONE-TIME, guarded correction of endpoint ownership keys (Phase 2E.1).
 *
 * Endpoint Mapping.endpoint_key is the stable internal endpoint TOKEN (e.g. glk_r8XToW) - an
 * ownership identifier, not an API credential. The internal transaction export field
 * endpoint_token maps to it by exact equality. Full endpoint credentials (<token>.<secret>)
 * must never be stored in ownership history, audit details, errors or logs.
 *
 * The initial production publish stored full credentials. While no accounting object
 * references a mapping yet (Source System, Transactions, Payment Matches, Payment Legs and
 * Settlement Items are empty) and history is exactly the initial version, this migration
 * rewrites every legacy key to its token in Sellers and Endpoint Mapping, recomputing
 * mapping_id. It is not a publish: no new version, no other history field changes.
 *
 * The legacy parser below is for this migration only and must never be used to match
 * transactions.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const ENDPOINT_KEY_MIGRATION = Object.freeze({
  expectedSchemaVersion: 7,
  expectedVersion: 'SMV-000001',
  expectedEffectiveFrom: '2026-10-01',
  tokenPattern: /^glk_[A-Za-z0-9_-]+$/,
  legacyPattern: /^(glk_[A-Za-z0-9_-]+)\.(\S+)$/,
  // Anything that looks like <glk token>.<suffix> inside free text.
  credentialInText: /(glk_[A-Za-z0-9_-]+)\.[^\s"'`()|,;\[\]{}<>]+/g,
});

/* ----------------------------- Pure helpers ----------------------------- */

/**
 * Migration-only classification of an endpoint key value. Never returns the suffix.
 * @return {{kind: 'SHORT'|'LEGACY'|'INVALID', token: ?string}}
 */
function parseEndpointKeyForMigration_(value) {
  const text = trimmedText_(value);
  if (ENDPOINT_KEY_MIGRATION.tokenPattern.test(text)) return { kind: 'SHORT', token: text };
  const m = ENDPOINT_KEY_MIGRATION.legacyPattern.exec(text);
  if (m && m[2].length > 0) return { kind: 'LEGACY', token: m[1] };
  return { kind: 'INVALID', token: null };
}

/** Masks every <token>.<secret> occurrence in a string as <token>.<redacted>. */
function redactEndpointCredentials_(text) {
  return String(text).replace(ENDPOINT_KEY_MIGRATION.credentialInText, '$1.<redacted>');
}

/** Deep copy with every string redacted (Dates and numbers untouched). */
function redactDeep_(value) {
  if (typeof value === 'string') return redactEndpointCredentials_(value);
  if (Array.isArray(value)) return value.map(redactDeep_);
  if (value && typeof value === 'object' && !isDateValue_(value)) {
    const out = {};
    Object.keys(value).forEach(function (k) { out[k] = redactDeep_(value[k]); });
    return out;
  }
  return value;
}

/** Sellers endpoints whose key is a full credential (publishing those is refused). */
function findCredentialEndpointKeys_(sellers) {
  const found = [];
  sellers.forEach(function (s) {
    s.endpoints.forEach(function (e) {
      const p = parseEndpointKeyForMigration_(e.endpoint_key);
      if (p.kind === 'LEGACY') {
        found.push('Sellers row ' + s.row + ' endpoint "' + e.endpoint_name + '": endpoint key is a full credential; ' +
          'enter only the endpoint token ' + p.token);
      }
    });
  });
  return found;
}

/** Sheets whose rows would reference mappings; all must be empty before the migration. */
function endpointKeyMigrationDependentSheets_() {
  return [SHEETS.SOURCE_SYSTEM, SHEETS.TRANSACTIONS, SHEETS.PAYMENT_MATCHES, SHEETS.PAYMENT_LEGS, SHEETS.SETTLEMENT_ITEMS];
}

/**
 * Pure migration plan. Never mutates inputs; never puts credential suffixes in output.
 * @param {{schemaVersion: *, dependentRowCounts: Object<string, number>, sellers: Array<Object>,
 *          draftErrors: Array<string>, records: Array<Object>}} input
 *   sellers: parseSellersDraft_ output; records: Endpoint Mapping records (date keys).
 * @return {{status: 'FAILED'|'NO_CHANGE'|'CHANGES', preconditions: Array<Object>, errors: Array<string>,
 *           sellerKeyChanges: Array<Object>, mappingKeyChanges: Array<Object>, newRecords: Array<Object>}}
 *   newRecords is [] when FAILED; on NO_CHANGE / CHANGES every key in it is a token.
 */
function planEndpointKeyMigration_(input, digestHex) {
  const cfg = ENDPOINT_KEY_MIGRATION;
  const preconditions = [];
  const check = function (name, pass, detail) { preconditions.push({ name: name, pass: !!pass, detail: detail || '' }); };
  const records = input.records;

  check('schema_version', Number(input.schemaVersion) === cfg.expectedSchemaVersion,
    'expected ' + cfg.expectedSchemaVersion + ', found ' + input.schemaVersion);
  Object.keys(input.dependentRowCounts).forEach(function (name) {
    check('empty:' + name, input.dependentRowCounts[name] === 0, input.dependentRowCounts[name] + ' data row(s)');
  });
  check('history_not_empty', records.length > 0, records.length + ' row(s)');
  const offVersion = records.filter(function (r) {
    return r.opened_version !== cfg.expectedVersion || r.status !== 'OPEN' || r.closed_version !== '' ||
      r.effective_to !== '' || r.effective_from !== cfg.expectedEffectiveFrom;
  });
  check('history_is_initial_version_only', offVersion.length === 0,
    offVersion.length + ' row(s) not OPEN ' + cfg.expectedVersion + ' from ' + cfg.expectedEffectiveFrom);
  const historyErrors = historyValidationErrors_(validateMappingHistory_(records, digestHex));
  check('history_valid', historyErrors.length === 0, historyErrors.length + ' error(s)');
  check('sellers_draft_valid', input.draftErrors.length === 0, input.draftErrors.length + ' error(s)');

  // Every key must be a token or a recognized legacy credential; never guess.
  const keyErrors = [];
  input.sellers.forEach(function (s) {
    s.endpoints.forEach(function (e) {
      if (parseEndpointKeyForMigration_(e.endpoint_key).kind === 'INVALID') {
        keyErrors.push('Sellers row ' + s.row + ' endpoint "' + e.endpoint_name + '" has an unrecognized key format');
      }
    });
  });
  records.forEach(function (r) {
    if (parseEndpointKeyForMigration_(r.endpoint_key).kind === 'INVALID') {
      keyErrors.push('Endpoint Mapping endpoint "' + r.endpoint_name + '" (' + r.seller_id + ') has an unrecognized key format');
    }
  });
  check('keys_recognized', keyErrors.length === 0, keyErrors.length + ' unrecognized key(s)');

  // Token-normalized views (seller_id, endpoint_name, token).
  const tokenOf = function (key) { return parseEndpointKeyForMigration_(key).token; };
  const desired = desiredMappings_(input.sellers).map(function (d) {
    return { seller_id: d.seller_id, endpoint_name: d.endpoint_name, endpoint_key: tokenOf(d.endpoint_key) };
  });
  const open = records.filter(function (r) { return r.status === 'OPEN'; }).map(function (r) {
    return { seller_id: r.seller_id, endpoint_name: r.endpoint_name, endpoint_key: tokenOf(r.endpoint_key) };
  });
  const dupTokens = function (entries) {
    const seen = {};
    entries.forEach(function (e) { if (e.endpoint_key) seen[e.endpoint_key] = (seen[e.endpoint_key] || 0) + 1; });
    return Object.keys(seen).filter(function (k) { return seen[k] > 1; }).sort();
  };
  const duplicateTokens = dupTokens(desired).concat(dupTokens(open)).filter(function (t, i, a) { return a.indexOf(t) === i; });
  check('unique_tokens', duplicateTokens.length === 0, duplicateTokens.join(', '));
  const retained = checkHistoricalSellersRetained_(input.sellers, records);
  check('historical_sellers_retained', retained.length === 0, retained.length + ' missing');
  const ownershipMatch = keyErrors.length === 0 && ownershipChecksum_(desired, digestHex) === ownershipChecksum_(open, digestHex);
  check('draft_matches_published_ownership', ownershipMatch, 'token-normalized seller_id + endpoint_name + token');

  const errors = preconditions.filter(function (p) { return !p.pass; })
    .map(function (p) { return 'Precondition ' + p.name + ' failed: ' + p.detail; })
    .concat(keyErrors).concat(input.draftErrors).concat(historyErrors).concat(retained)
    .map(redactEndpointCredentials_);
  // A FAILED plan carries no records, so legacy credentials never leave this function.
  const result = { status: 'FAILED', preconditions: preconditions, errors: errors, sellerKeyChanges: [], mappingKeyChanges: [],
    newRecords: [] };
  if (errors.length > 0) return result;

  input.sellers.forEach(function (s) {
    s.endpoints.forEach(function (e) {
      const p = parseEndpointKeyForMigration_(e.endpoint_key);
      if (p.kind === 'LEGACY') {
        result.sellerKeyChanges.push({ row: s.row, slot: e.slot, seller_id: s.seller_id, endpoint_name: e.endpoint_name, token: p.token });
      }
    });
  });
  result.newRecords = records.map(function (r) {
    const p = parseEndpointKeyForMigration_(r.endpoint_key);
    if (p.kind !== 'LEGACY') return r;
    const migrated = Object.assign({}, r);
    migrated.endpoint_key = p.token;
    migrated.mapping_id = mappingIdFor_(r.seller_id, p.token, r.effective_from, digestHex);
    migrated._keyMigrated = true;
    result.mappingKeyChanges.push({ seller_id: r.seller_id, endpoint_name: r.endpoint_name, token: p.token,
      new_mapping_id: migrated.mapping_id });
    return migrated;
  });

  const after = historyValidationErrors_(validateMappingHistory_(result.newRecords, digestHex))
    .concat(checkKeyMigrationPreservation_(records, result.newRecords));
  if (after.length > 0) {
    result.errors = after.map(redactEndpointCredentials_);
    result.sellerKeyChanges = [];
    result.mappingKeyChanges = [];
    result.newRecords = [];
    return result;
  }
  result.status = result.sellerKeyChanges.length + result.mappingKeyChanges.length === 0 ? 'NO_CHANGE' : 'CHANGES';
  return result;
}

/** Every Endpoint Mapping field except endpoint_key and mapping_id must be preserved, row by row. */
function checkKeyMigrationPreservation_(before, after) {
  const errors = [];
  if (before.length !== after.length) return ['row count changed from ' + before.length + ' to ' + after.length];
  const columns = getColumnNames_(SHEETS.ENDPOINT_MAPPING).filter(function (c) { return c !== 'endpoint_key' && c !== 'mapping_id'; });
  before.forEach(function (b, i) {
    columns.forEach(function (c) {
      if (serializeCell_(b[c]) !== serializeCell_(after[i][c])) errors.push('row ' + (i + 1) + ': field ' + c + ' changed');
    });
  });
  return errors;
}

/* ---------------------------------- I/O --------------------------------- */

function countDataRows_(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return 0;
  return readSheetGrid_(sheet).values.slice(1).filter(function (row) { return !row.every(isBlankCell_); }).length;
}

function readEndpointKeyMigrationInput_(ss) {
  const counts = {};
  endpointKeyMigrationDependentSheets_().forEach(function (name) { counts[name] = countDataRows_(ss, name); });
  const draft = readSellersDraft_(ss);
  const history = readEndpointMappingRecords_(ss);
  return {
    draft: draft,
    history: history,
    plan: planEndpointKeyMigration_({
      schemaVersion: readSettingsMap_().schema_version,
      dependentRowCounts: counts,
      sellers: draft.parsed.sellers,
      draftErrors: flattenErrors_(draft.parsed.errors),
      records: history.records,
    }),
    dependentRowCounts: counts,
  };
}

/** Runs the one-time endpoint key migration under the script lock. Never throws. */
function runEndpointKeyMigration_() {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  const details = {};
  let status = 'FAILED';
  let ss = null;
  const tab = endpointMappingTab_();
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms.');
    ss = getSpreadsheet_();
    const recovery = recoverSwapState_(ss, tab);
    details.initial_swap_state = recovery.state;
    details.recovery_actions = recovery.actions;

    const input = readEndpointKeyMigrationInput_(ss);
    const plan = input.plan;
    details.precondition_results = plan.preconditions;
    details.seller_count = input.draft.parsed.sellers.length;
    details.endpoint_count = input.draft.parsed.sellers.reduce(function (n, s) { return n + s.endpoints.length; }, 0);
    details.mapping_count = input.history.records.length;
    details.old_mapping_checksum = input.history.checksum;
    if (plan.status === 'FAILED') throw new Error('Endpoint key migration refused: ' + plan.errors.slice(0, 20).join(' | '));

    details.changed_seller_keys = plan.sellerKeyChanges.map(function (c) {
      return { seller_id: c.seller_id, endpoint_name: c.endpoint_name, token: c.token };
    });
    details.changed_mapping_keys = plan.mappingKeyChanges.map(function (c) {
      return { seller_id: c.seller_id, endpoint_name: c.endpoint_name, token: c.token, mapping_id: c.new_mapping_id };
    });

    if (plan.status === 'NO_CHANGE') {
      details.new_mapping_checksum = input.history.checksum;
      status = 'NO_CHANGE';
    } else {
      // 1. Endpoint Mapping: same stored values except endpoint_key/mapping_id, through SafeSwap.
      if (plan.mappingKeyChanges.length > 0) {
        const columns = getColumnNames_(SHEETS.ENDPOINT_MAPPING);
        const keyIdx = columns.indexOf('endpoint_key');
        const idIdx = columns.indexOf('mapping_id');
        const rows = plan.newRecords
          .map(function (r) {
            const row = input.history.rows[r._index].slice();
            row[keyIdx] = r.endpoint_key;
            row[idIdx] = r.mapping_id;
            return { r: r, row: row };
          })
          .sort(function (a, b) {
            const fa = [a.r.endpoint_key, a.r.effective_from, a.r.mapping_id];
            const fb = [b.r.endpoint_key, b.r.effective_from, b.r.mapping_id];
            for (let i = 0; i < fa.length; i++) if (fa[i] !== fb[i]) return fa[i] < fb[i] ? -1 : 1;
            return 0;
          })
          .map(function (x) { return x.row; });
        writeCanonicalTable_(ss, getTableSchema_(SHEETS.ENDPOINT_MAPPING), tab, rows);
      }
      // 2. Sellers: one batch write of the affected row block (only key cells change).
      if (plan.sellerKeyChanges.length > 0) {
        const values = input.draft.values;
        const header = values[0].map(function (h) { return String(h).trim(); });
        const first = Math.min.apply(null, plan.sellerKeyChanges.map(function (c) { return c.row; }));
        const last = Math.max.apply(null, plan.sellerKeyChanges.map(function (c) { return c.row; }));
        const block = values.slice(first - 1, last).map(function (row) { return row.slice(); });
        plan.sellerKeyChanges.forEach(function (c) {
          block[c.row - first][header.indexOf('endpoint_' + c.slot + '_key')] = c.token;
        });
        input.draft.sheet.getRange(first, 1, block.length, header.length).setValues(block);
      }
      SpreadsheetApp.flush();

      // 3. Re-read and validate the final state.
      const post = verifyEndpointKeyState_(ss);
      details.post_validation = post;
      details.new_mapping_checksum = post.mapping_checksum;
      if (!post.pass) throw new Error('Post-migration validation failed: ' + post.errors.join(' | '));
      status = 'SUCCESS';
    }
  } catch (err) {
    details.error = redactEndpointCredentials_(err && err.message ? err.message : String(err));
    status = 'FAILED';
  } finally {
    try {
      if (ss) details.final_swap_state = detectSwapState_(ss, tab).state;
    } catch (stateErr) {
      details.final_swap_state = 'UNKNOWN';
    }
    try {
      appendAuditLog_({
        action: 'SELLER_ENDPOINT_KEY_MIGRATION_' + status,
        entityType: 'SELLER_MAPPING',
        entityId: ENDPOINT_KEY_MIGRATION.expectedVersion,
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

/**
 * Read-only state check: counts, legacy keys, duplicate tokens, mapping IDs, published match,
 * dependent tables and whether the migration may run. Output is credential-redacted.
 */
function verifyEndpointKeyState_(ss) {
  const report = {
    seller_count: 0,
    endpoint_count: 0,
    mapping_count: 0,
    seller_legacy_full_key_count: 0,
    mapping_legacy_full_key_count: 0,
    unrecognized_key_count: 0,
    duplicate_short_tokens: [],
    mapping_id_errors: [],
    published_match: false,
    dependent_table_row_counts: {},
    safe_to_migrate: false,
    swap_state: null,
    mapping_checksum: null,
    pass: false,
    errors: [],
  };
  try {
    report.swap_state = detectSwapState_(ss, endpointMappingTab_()).state;
    const input = readEndpointKeyMigrationInput_(ss);
    const sellers = input.draft.parsed.sellers;
    const records = input.history.records;
    report.seller_count = sellers.length;
    report.endpoint_count = sellers.reduce(function (n, s) { return n + s.endpoints.length; }, 0);
    report.mapping_count = records.length;
    report.mapping_checksum = input.history.checksum;
    report.dependent_table_row_counts = input.dependentRowCounts;

    const kinds = function (keys) {
      return keys.map(parseEndpointKeyForMigration_).reduce(function (acc, p) { acc[p.kind] = (acc[p.kind] || 0) + 1; return acc; }, {});
    };
    const sellerKinds = kinds([].concat.apply([], sellers.map(function (s) { return s.endpoints.map(function (e) { return e.endpoint_key; }); })));
    const mappingKinds = kinds(records.map(function (r) { return r.endpoint_key; }));
    report.seller_legacy_full_key_count = sellerKinds.LEGACY || 0;
    report.mapping_legacy_full_key_count = mappingKinds.LEGACY || 0;
    report.unrecognized_key_count = (sellerKinds.INVALID || 0) + (mappingKinds.INVALID || 0);

    const tokens = {};
    desiredMappings_(sellers).forEach(function (d) {
      const t = parseEndpointKeyForMigration_(d.endpoint_key).token;
      if (t) tokens[t] = (tokens[t] || 0) + 1;
    });
    report.duplicate_short_tokens = Object.keys(tokens).filter(function (t) { return tokens[t] > 1; }).sort();
    report.mapping_id_errors = validateMappingHistory_(records).integrity.filter(function (e) { return /mapping_id/.test(e); });

    const draftErrors = flattenErrors_(input.draft.parsed.errors);
    const diff = diffSellerMapping_(desiredMappings_(sellers), records.filter(function (r) { return r.status === 'OPEN'; }));
    report.published_match = draftErrors.length === 0 && diff.changes.length === 0;
    report.safe_to_migrate = input.plan.status !== 'FAILED';

    if (report.swap_state !== 'NORMAL') report.errors.push('Endpoint Mapping swap state is ' + report.swap_state);
    if (report.seller_legacy_full_key_count + report.mapping_legacy_full_key_count > 0) {
      report.errors.push('Legacy full endpoint keys present (run migrateSellerEndpointKeysToTokens)');
    }
    if (report.unrecognized_key_count > 0) report.errors.push(report.unrecognized_key_count + ' unrecognized endpoint key(s)');
    if (report.duplicate_short_tokens.length > 0) report.errors.push('Duplicate endpoint tokens');
    if (report.mapping_id_errors.length > 0) report.errors.push('Mapping ID errors');
    const historyErrors = historyValidationErrors_(validateMappingHistory_(records));
    if (historyErrors.length > 0) report.errors.push('Endpoint Mapping history invalid: ' + historyErrors.length + ' error(s)');
    if (!report.published_match) report.errors.push('Sellers draft does not match published ownership');
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0;
  return redactDeep_(report);
}
