/**
 * SellerMapping.gs
 * Seller / endpoint ownership mapping.
 *
 * - "Sellers" (user-managed, 1 row = 1 seller) holds the DESIRED open mapping. Endpoints are
 *   endpoint_<N>_name / endpoint_<N>_key column pairs discovered from the header; slot order,
 *   row order and notes have no meaning.
 * - "Endpoint Mapping" (system-managed) holds effective-dated ownership history. It is written
 *   only by publishSellerMapping(), as a whole table through the crash-safe staging swap.
 * - A publish compares the desired mapping with the OPEN history rows. Changed endpoints are
 *   closed (effective_to = new effective_from - 1 day) and replacements opened; all changes of
 *   one publish share one effective date and one version (SMV-######). After the initial
 *   (backfill) publish, changes must be strictly after the latest published mapping VERSION
 *   BOUNDARY, where opened_version boundary = effective_from and closed_version boundary =
 *   effective_to + 1 day (so a publish that only closed rows still sets a boundary).
 *   CLOSED rows never change; an OPEN row only ever gets its closure fields set.
 * - Resolver helpers answer "who owned endpoint X on date D" for later phases.
 *
 * endpoint_key is the stable internal endpoint TOKEN (exact match with the internal export field
 * endpoint_token), never an API credential; publishing a <token>.<secret> value is refused and
 * credentials are redacted from errors, audit details and reports.
 *
 * Seller hold is NOT configured here. Locked KH001 invariant for the next phase:
 * seller_hold_amount = the frozen provider_hold_amount of the same transaction (1:1, policy
 * MIRROR_PROVIDER); Settings default_seller_hold_rate is legacy and not used for KH001.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const SELLER_MAPPING = Object.freeze({
  sellerIdPrefix: 'SLR-',
  versionPrefix: 'SMV-',
  sequenceDigits: 6,
  mappingIdPrefix: 'EM-',
  endpointHeaderPattern: /^endpoint_(\d+)_(name|key)$/,
  maxReportedErrors: 30,
});

const CHANGE_TYPE = Object.freeze({
  NEW: 'NEW',
  REMOVED: 'REMOVED',
  MOVED: 'MOVED_TO_ANOTHER_SELLER',
  NAME_CHANGED: 'NAME_CHANGED',
  KEY_CHANGED: 'KEY_CHANGED',
});

/* ----------------------------- Pure helpers ----------------------------- */

/** Case-insensitive comparison key for endpoint/seller names (NFC, trimmed, collapsed spaces). */
function endpointNameKey_(name) {
  return normalizeLabel_(name).replace(/\s+/g, ' ').toLowerCase();
}

function trimmedText_(value) {
  return canonicalText_(value).trim();
}

/** YYYY-MM-DD key shifted by whole calendar days. */
function addDaysToDateKey_(key, days) {
  const p = key.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days)).toISOString().slice(0, 10);
}

function formatSequenceId_(prefix, n) {
  const s = String(n);
  return prefix + (s.length >= SELLER_MAPPING.sequenceDigits ? s : ('000000000' + s).slice(-SELLER_MAPPING.sequenceDigits));
}

/** Number of a PREFIX-digits ID, or null. */
function parseSequenceId_(prefix, id) {
  const text = String(id === null || id === undefined ? '' : id);
  if (text.indexOf(prefix) !== 0) return null;
  const rest = text.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

/** Deterministic, immutable mapping ID: EM-<sha256(seller_id|endpoint_key|effective_from)>. */
function mappingIdFor_(sellerId, endpointKey, effectiveFrom, digestHex) {
  const digest = digestHex || sha256Hex_;
  return SELLER_MAPPING.mappingIdPrefix + digest(sellerId + '|' + endpointKey + '|' + effectiveFrom);
}

/** endpoint pair slots discovered from the header: [{n, nameIdx, keyIdx}] sorted by n. */
function sellerEndpointSlots_(header) {
  const slots = {};
  header.forEach(function (h, i) {
    const m = SELLER_MAPPING.endpointHeaderPattern.exec(String(h).trim());
    if (!m) return;
    const n = Number(m[1]);
    slots[n] = slots[n] || { n: n };
    slots[n][m[2] === 'name' ? 'nameIdx' : 'keyIdx'] = i;
  });
  const list = Object.keys(slots).map(function (k) { return slots[k]; }).sort(function (a, b) { return a.n - b.n; });
  const broken = list.filter(function (s) { return s.nameIdx === undefined || s.keyIdx === undefined; });
  if (broken.length > 0) {
    throw new Error('Sellers header has unpaired endpoint column(s): ' + broken.map(function (s) { return 'endpoint_' + s.n; }).join(', '));
  }
  return list;
}

function emptyDraftErrors_() {
  return { invalid: [], half_filled_endpoint_pairs: [], duplicate_seller_ids: [], duplicate_seller_names: [],
    duplicate_endpoint_keys: [], duplicate_endpoint_names: [] };
}

function flattenErrors_(errors) {
  return Object.keys(errors).reduce(function (acc, k) { return acc.concat(errors[k]); }, []);
}

/**
 * Parses the Sellers grid (row 1 = header). Header-driven over endpoint pairs.
 * @param {Array<Array<*>>} values
 * @param {function(*): string} dateKeyOf value -> 'YYYY-MM-DD' | '' (throws when invalid)
 * @return {{sellers: Array<Object>, errors: Object}}
 */
function parseSellersDraft_(values, dateKeyOf) {
  const errors = emptyDraftErrors_();
  if (!values || values.length === 0) throw new Error('Sellers is empty; expected a header row.');
  const header = values[0].map(function (h) { return String(h).trim(); });
  const col = {};
  ['seller_id', 'seller_name', 'status', 'effective_from'].forEach(function (name) {
    col[name] = header.indexOf(name);
    if (col[name] < 0) throw new Error('Sellers header is missing column "' + name + '".');
  });
  const slots = sellerEndpointSlots_(header);

  const sellers = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(isBlankCell_)) continue;
    const sheetRow = r + 1;
    const label = 'Sellers row ' + sheetRow;
    const seller = {
      row: sheetRow,
      seller_id: trimmedText_(row[col.seller_id]),
      seller_name: trimmedText_(row[col.seller_name]),
      status: trimmedText_(row[col.status]).toUpperCase(),
      effective_from: '',
      endpoints: [],
    };
    if (seller.seller_name === '') errors.invalid.push(label + ': seller_name is required');
    if (ENUMS.SELLER_STATUS.indexOf(seller.status) < 0) {
      errors.invalid.push(label + ': status must be ' + ENUMS.SELLER_STATUS.join(' or ') + ' (found "' + row[col.status] + '")');
    }
    try {
      seller.effective_from = dateKeyOf(row[col.effective_from]);
    } catch (e) {
      errors.invalid.push(label + ': effective_from ' + e.message);
    }
    slots.forEach(function (s) {
      const name = trimmedText_(row[s.nameIdx]);
      const key = trimmedText_(row[s.keyIdx]);
      if (name === '' && key === '') return;
      if (name === '' || key === '') {
        errors.half_filled_endpoint_pairs.push(label + ': endpoint_' + s.n + ' has ' + (name === '' ? 'a key but no name' : 'a name but no key'));
        return;
      }
      seller.endpoints.push({ slot: s.n, endpoint_name: name, endpoint_key: key, name_key: endpointNameKey_(name) });
    });
    sellers.push(seller);
  }

  const dupes = function (items, keyOf) {
    const seen = {};
    items.forEach(function (it) {
      const k = keyOf(it);
      if (k === '') return;
      (seen[k] = seen[k] || []).push(it);
    });
    return Object.keys(seen).filter(function (k) { return seen[k].length > 1; }).map(function (k) { return { key: k, items: seen[k] }; });
  };
  dupes(sellers, function (s) { return s.seller_id; }).forEach(function (d) {
    errors.duplicate_seller_ids.push('seller_id ' + d.key + ' on rows ' + d.items.map(function (s) { return s.row; }).join(', '));
  });
  dupes(sellers, function (s) { return endpointNameKey_(s.seller_name); }).forEach(function (d) {
    errors.duplicate_seller_names.push('seller_name "' + d.items[0].seller_name + '" on rows ' + d.items.map(function (s) { return s.row; }).join(', '));
  });
  const activeEndpoints = [];
  sellers.forEach(function (s) {
    if (s.status !== 'ACTIVE') return;
    s.endpoints.forEach(function (e) { activeEndpoints.push({ row: s.row, endpoint: e }); });
  });
  dupes(activeEndpoints, function (x) { return x.endpoint.endpoint_key; }).forEach(function (d) {
    errors.duplicate_endpoint_keys.push('endpoint_key "' + d.key + '" on rows ' + d.items.map(function (x) { return x.row; }).join(', '));
  });
  dupes(activeEndpoints, function (x) { return x.endpoint.name_key; }).forEach(function (d) {
    errors.duplicate_endpoint_names.push('endpoint_name "' + d.items[0].endpoint.endpoint_name + '" (case-insensitive) on rows ' +
      d.items.map(function (x) { return x.row; }).join(', '));
  });
  return { sellers: sellers, errors: errors };
}

/**
 * Seller IDs for rows without one: next numbers after the highest SLR-###### seen in the
 * draft OR the history (IDs are never recycled). Assigned in sheet row order.
 * @return {Array<{row: number, seller_id: string}>}
 */
function planSellerIdAssignments_(sellers, historySellerIds) {
  let max = 0;
  sellers.map(function (s) { return s.seller_id; }).concat(historySellerIds).forEach(function (id) {
    const n = parseSequenceId_(SELLER_MAPPING.sellerIdPrefix, id);
    if (n !== null && n > max) max = n;
  });
  return sellers
    .filter(function (s) { return s.seller_id === ''; })
    .sort(function (a, b) { return a.row - b.row; })
    .map(function (s) { max++; return { row: s.row, seller_id: formatSequenceId_(SELLER_MAPPING.sellerIdPrefix, max) }; });
}

/** Desired OPEN mapping from ACTIVE sellers, sorted by seller_id, endpoint_key, name key. */
function desiredMappings_(sellers) {
  const out = [];
  sellers.forEach(function (s) {
    if (s.status !== 'ACTIVE') return;
    s.endpoints.forEach(function (e) {
      out.push({ seller_id: s.seller_id, seller_name: s.seller_name, endpoint_name: e.endpoint_name,
        endpoint_key: e.endpoint_key, name_key: e.name_key });
    });
  });
  return out.sort(compareMappingEntries_);
}

function compareMappingEntries_(a, b) {
  const fields = ['seller_id', 'endpoint_key', 'name_key'];
  for (let i = 0; i < fields.length; i++) {
    const x = String(a[fields[i]]);
    const y = String(b[fields[i]]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Ownership checksum: seller_id, endpoint_name, endpoint_key, status (order independent). */
function ownershipChecksum_(entries, digestHex) {
  const digest = digestHex || sha256Hex_;
  const lines = entries
    .map(function (e) { return { seller_id: e.seller_id, endpoint_key: e.endpoint_key, name_key: endpointNameKey_(e.endpoint_name), e: e }; })
    .sort(compareMappingEntries_)
    .map(function (x) { return [x.e.seller_id, x.e.endpoint_name, x.e.endpoint_key, 'ACTIVE'].map(serializeCell_).join('\u001f'); });
  return digest('OWNERSHIP_V1\u001e' + lines.join('\u001e'));
}

/** Endpoint Mapping row object (sheet values) -> record with date keys. Throws on bad dates. */
function toMappingRecord_(obj, dateKeyOf, index) {
  const rec = {};
  Object.keys(obj).forEach(function (k) { rec[k] = obj[k]; });
  ['mapping_id', 'seller_id', 'seller_name_snapshot', 'endpoint_name', 'endpoint_key', 'opened_version',
    'closed_version', 'status', 'notes'].forEach(function (k) { rec[k] = trimmedText_(obj[k]); });
  rec.effective_from = dateKeyOf(obj.effective_from);
  rec.effective_to = dateKeyOf(obj.effective_to);
  rec._index = index;
  return rec;
}

/**
 * Validates history records (date keys). Returns integrity and overlap errors.
 * @param {Array<Object>} records
 */
function validateMappingHistory_(records, digestHex) {
  const integrity = [];
  const overlap = [];
  const versionOk = function (v) { return parseSequenceId_(SELLER_MAPPING.versionPrefix, v) !== null; };
  const ids = {};
  records.forEach(function (r, i) {
    const label = 'Endpoint Mapping ' + (r.mapping_id || '(row ' + (i + 2) + ')');
    if (ids[r.mapping_id]) integrity.push(label + ': duplicate mapping_id');
    ids[r.mapping_id] = true;
    if (r.seller_id === '') integrity.push(label + ': seller_id is blank');
    if (r.seller_name_snapshot === '') integrity.push(label + ': seller_name_snapshot is blank');
    if (isBlankCell_(r.opened_at)) integrity.push(label + ': opened_at is blank');
    if (r.endpoint_name === '') integrity.push(label + ': endpoint_name is blank');
    if (r.endpoint_key === '') integrity.push(label + ': endpoint_key is blank');
    if (r.effective_from === '') integrity.push(label + ': effective_from is required');
    if (r.effective_to !== '' && r.effective_from !== '' && r.effective_to < r.effective_from) {
      integrity.push(label + ': effective_to ' + r.effective_to + ' is before effective_from ' + r.effective_from);
    }
    if (r.status === 'OPEN' && (r.effective_to !== '' || r.closed_version !== '' || !isBlankCell_(r.closed_at))) {
      integrity.push(label + ': OPEN row must have blank effective_to, closed_version and closed_at');
    }
    if (r.status === 'CLOSED' && r.effective_to === '') integrity.push(label + ': CLOSED row requires effective_to');
    if (r.status === 'CLOSED' && isBlankCell_(r.closed_at)) integrity.push(label + ': CLOSED row requires closed_at');
    if (r.status !== 'OPEN' && r.status !== 'CLOSED') integrity.push(label + ': status must be OPEN or CLOSED');
    if (!versionOk(r.opened_version)) integrity.push(label + ': invalid opened_version "' + r.opened_version + '"');
    if (r.status === 'CLOSED') {
      if (!versionOk(r.closed_version)) integrity.push(label + ': invalid closed_version "' + r.closed_version + '"');
      else if (versionOk(r.opened_version) && parseSequenceId_(SELLER_MAPPING.versionPrefix, r.closed_version) <=
        parseSequenceId_(SELLER_MAPPING.versionPrefix, r.opened_version)) {
        integrity.push(label + ': closed_version must be after opened_version');
      }
    }
    if (r.seller_id !== '' && r.endpoint_key !== '' && r.effective_from !== '' &&
        r.mapping_id !== mappingIdFor_(r.seller_id, r.endpoint_key, r.effective_from, digestHex)) {
      integrity.push(label + ': mapping_id does not match seller_id|endpoint_key|effective_from');
    }
  });

  const checkOverlaps = function (keyOf, what) {
    const groups = {};
    records.forEach(function (r) {
      const k = keyOf(r);
      if (k === '' || r.effective_from === '') return;
      (groups[k] = groups[k] || []).push(r);
    });
    Object.keys(groups).forEach(function (k) {
      const list = groups[k].slice().sort(function (a, b) { return a.effective_from < b.effective_from ? -1 : a.effective_from > b.effective_from ? 1 : 0; });
      const openEnded = list.filter(function (r) { return r.effective_to === ''; });
      if (openEnded.length > 1) overlap.push(what + ' "' + k + '" has ' + openEnded.length + ' open-ended mappings');
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1];
        if (prev.effective_to === '' || list[i].effective_from <= prev.effective_to) {
          overlap.push(what + ' "' + k + '": ' + prev.mapping_id + ' overlaps ' + list[i].mapping_id);
        }
      }
    });
  };
  checkOverlaps(function (r) { return r.endpoint_key; }, 'endpoint_key');
  checkOverlaps(function (r) { return endpointNameKey_(r.endpoint_name); }, 'endpoint_name');
  return { integrity: integrity, overlap: overlap, versionBoundary: mappingVersionBoundaries_(records).errors };
}

/** All history validation errors as one list. */
function historyValidationErrors_(check) {
  return check.integrity.concat(check.overlap).concat(check.versionBoundary);
}

/**
 * Effective date of every mapping version, derived from history:
 *   opened_version -> effective_from;  closed_version -> effective_to + 1 day (CLOSED rows).
 * Every occurrence of a version must give the same date, and dates must strictly increase
 * with the version number.
 * @return {{boundaries: Array<{version: string, number: number, date: string}>, errors: Array<string>}}
 */
function mappingVersionBoundaries_(records) {
  const dates = {};
  const errors = [];
  const add = function (version, date, source) {
    const n = parseSequenceId_(SELLER_MAPPING.versionPrefix, version);
    if (n === null || date === '') return;
    (dates[version] = dates[version] || { number: n, seen: {} }).seen[date] = (dates[version].seen[date] || []).concat([source]);
  };
  records.forEach(function (r) {
    add(r.opened_version, r.effective_from, r.mapping_id + ' opened');
    if (r.status === 'CLOSED' && r.effective_to !== '') add(r.closed_version, addDaysToDateKey_(r.effective_to, 1), r.mapping_id + ' closed');
  });
  const boundaries = Object.keys(dates).map(function (v) {
    const d = Object.keys(dates[v].seen).sort();
    if (d.length > 1) {
      errors.push('Version ' + v + ' has conflicting effective dates: ' +
        d.map(function (x) { return x + ' (' + dates[v].seen[x].join(', ') + ')'; }).join('; '));
    }
    return { version: v, number: dates[v].number, date: d[0] };
  }).sort(function (a, b) { return a.number - b.number; });
  for (let i = 1; i < boundaries.length; i++) {
    if (!(boundaries[i].date > boundaries[i - 1].date)) {
      errors.push('Version ' + boundaries[i].version + ' (' + boundaries[i].date + ') is not after ' +
        boundaries[i - 1].version + ' (' + boundaries[i - 1].date + ')');
    }
  }
  return { boundaries: boundaries, errors: errors };
}

/** Latest published version boundary {version, date}, or null for empty history. */
function latestMappingBoundary_(records) {
  const b = mappingVersionBoundaries_(records).boundaries;
  if (b.length === 0) return null;
  return b.reduce(function (m, x) { return x.date > m.date ? x : m; }, b[0]);
}

/**
 * Every seller_id that ever appeared in history must be on exactly one Sellers row (it may
 * be INACTIVE with no endpoints). Duplicates are reported by the draft parser.
 */
function checkHistoricalSellersRetained_(sellers, records) {
  const present = {};
  sellers.forEach(function (s) { if (s.seller_id) present[s.seller_id] = true; });
  const historical = {};
  records.forEach(function (r) { if (r.seller_id) historical[r.seller_id] = true; });
  return Object.keys(historical).sort()
    .filter(function (id) { return !present[id]; })
    .map(function (id) {
      return 'Historical seller ' + id + ' is missing from Sellers; keep its row (it may be INACTIVE with no endpoints)';
    });
}

/**
 * Diff between desired mapping and OPEN history records.
 * Operations: close every OPEN row whose (seller_id, endpoint_key, endpoint_name) is not
 * desired; open every desired entry not already OPEN. Classification is for reporting.
 */
function diffSellerMapping_(desired, openRecords) {
  const tuple = function (e) { return [e.seller_id, e.endpoint_key, e.endpoint_name].join('\u0000'); };
  const desiredByTuple = {};
  desired.forEach(function (d) { desiredByTuple[tuple(d)] = d; });
  const openByTuple = {};
  openRecords.forEach(function (o) { openByTuple[tuple(o)] = o; });

  const unchanged = openRecords.filter(function (o) { return desiredByTuple[tuple(o)]; });
  const toClose = openRecords.filter(function (o) { return !desiredByTuple[tuple(o)]; });
  const toOpen = desired.filter(function (d) { return !openByTuple[tuple(d)]; });

  const paired = {};
  const changes = [];
  toClose.forEach(function (o) {
    let d = toOpen.find(function (x) { return !paired[tuple(x)] && x.endpoint_key === o.endpoint_key; });
    let type;
    if (d) type = d.seller_id !== o.seller_id ? CHANGE_TYPE.MOVED : CHANGE_TYPE.NAME_CHANGED;
    else {
      d = toOpen.find(function (x) { return !paired[tuple(x)] && x.name_key === endpointNameKey_(o.endpoint_name); });
      if (d) type = d.seller_id !== o.seller_id ? CHANGE_TYPE.MOVED : CHANGE_TYPE.KEY_CHANGED;
    }
    if (d) { paired[tuple(d)] = true; changes.push({ type: type, from: o, to: d }); }
    else changes.push({ type: CHANGE_TYPE.REMOVED, from: o, to: null });
  });
  toOpen.forEach(function (d) { if (!paired[tuple(d)]) changes.push({ type: CHANGE_TYPE.NEW, from: null, to: d }); });
  return { unchanged: unchanged, toClose: toClose, toOpen: toOpen, changes: changes };
}

/** Summary counts of a diff by change type. */
function summarizeMappingChanges_(diff) {
  const out = { new: [], removed: [], moved: [], renamed_or_key_changed: [] };
  diff.changes.forEach(function (c) {
    const text = (c.from ? c.from.seller_id + ':' + c.from.endpoint_name + '/' + c.from.endpoint_key : '') +
      (c.from && c.to ? ' -> ' : '') + (c.to ? c.to.seller_id + ':' + c.to.endpoint_name + '/' + c.to.endpoint_key : '');
    if (c.type === CHANGE_TYPE.NEW) out.new.push(text);
    else if (c.type === CHANGE_TYPE.REMOVED) out.removed.push(text);
    else if (c.type === CHANGE_TYPE.MOVED) out.moved.push(text);
    else out.renamed_or_key_changed.push(c.type + ' ' + text);
  });
  return out;
}

/**
 * The single effective date of a publish, from the Sellers rows involved in changes:
 * the old owner row of every closed mapping and the new owner row of every opened mapping.
 * @return {{effectiveFrom: ?string, errors: Array<string>}}
 */
function resolvePublishEffectiveDate_(diff, sellers) {
  const errors = [];
  const byId = {};
  sellers.forEach(function (s) { if (s.seller_id) byId[s.seller_id] = s; });
  const involved = {};
  diff.toClose.forEach(function (o) {
    const s = byId[o.seller_id];
    if (!s) {
      errors.push('Seller ' + o.seller_id + ' owns OPEN mapping ' + o.endpoint_name + '/' + o.endpoint_key +
        ' but its row was removed from Sellers; keep the row and remove the endpoint or set INACTIVE with effective_from');
    } else involved[s.seller_id] = s;
  });
  diff.toOpen.forEach(function (d) { if (byId[d.seller_id]) involved[d.seller_id] = byId[d.seller_id]; });
  const dates = {};
  Object.keys(involved).forEach(function (id) {
    const s = involved[id];
    if (s.effective_from === '') errors.push('Seller ' + id + ' (Sellers row ' + s.row + ') changes ownership but has no effective_from');
    else (dates[s.effective_from] = dates[s.effective_from] || []).push(id);
  });
  const distinct = Object.keys(dates).sort();
  if (distinct.length > 1) {
    errors.push('Changed seller rows specify different effective_from dates: ' +
      distinct.map(function (d) { return d + ' (' + dates[d].join(', ') + ')'; }).join('; '));
  }
  return { effectiveFrom: errors.length === 0 && distinct.length === 1 ? distinct[0] : null, errors: errors };
}

/**
 * After the initial publish, a change must start strictly after the latest published version
 * boundary (which also covers publishes that only closed rows) and after the effective_from
 * of every row it closes.
 */
function checkNonRetroactive_(effectiveFrom, records, toClose) {
  const errors = [];
  if (records.length === 0) return errors;
  const latest = latestMappingBoundary_(records);
  if (latest && !(effectiveFrom > latest.date)) {
    errors.push('effective_from ' + effectiveFrom + ' must be after the latest published version boundary ' +
      latest.date + ' (' + latest.version + ')');
  }
  toClose.forEach(function (o) {
    if (!(effectiveFrom > o.effective_from)) {
      errors.push('effective_from ' + effectiveFrom + ' must be after ' + o.mapping_id + ' effective_from ' + o.effective_from);
    }
  });
  return errors;
}

function nextMappingVersion_(records) {
  let max = 0;
  records.forEach(function (r) {
    [r.opened_version, r.closed_version].forEach(function (v) {
      const n = parseSequenceId_(SELLER_MAPPING.versionPrefix, v);
      if (n !== null && n > max) max = n;
    });
  });
  return formatSequenceId_(SELLER_MAPPING.versionPrefix, max + 1);
}

/**
 * New history records: existing records unchanged except closures (effective_to,
 * closed_version, status, closed_at), plus new OPEN records. Sorted by endpoint_key,
 * effective_from, mapping_id.
 */
function buildPublishedHistory_(records, diff, effectiveFrom, version, publishedAt, sellers, digestHex) {
  const closeIds = {};
  diff.toClose.forEach(function (o) { closeIds[o.mapping_id] = true; });
  const nameById = {};
  sellers.forEach(function (s) { nameById[s.seller_id] = s.seller_name; });
  const effectiveTo = addDaysToDateKey_(effectiveFrom, -1);

  const out = records.map(function (r) {
    if (!closeIds[r.mapping_id]) return r;
    const closed = Object.assign({}, r);
    closed.effective_to = effectiveTo;
    closed.closed_version = version;
    closed.status = 'CLOSED';
    closed.closed_at = publishedAt;
    closed._closedNow = true;
    return closed;
  });
  diff.toOpen.forEach(function (d) {
    out.push({
      mapping_id: mappingIdFor_(d.seller_id, d.endpoint_key, effectiveFrom, digestHex),
      seller_id: d.seller_id,
      seller_name_snapshot: nameById[d.seller_id] || d.seller_name,
      endpoint_name: d.endpoint_name,
      endpoint_key: d.endpoint_key,
      effective_from: effectiveFrom,
      effective_to: '',
      opened_version: version,
      closed_version: '',
      status: 'OPEN',
      opened_at: publishedAt,
      closed_at: '',
      notes: '',
      _new: true,
    });
  });
  return out.sort(function (a, b) {
    const fa = [a.endpoint_key, a.effective_from, a.mapping_id];
    const fb = [b.endpoint_key, b.effective_from, b.mapping_id];
    for (let i = 0; i < fa.length; i++) if (fa[i] !== fb[i]) return fa[i] < fb[i] ? -1 : 1;
    return 0;
  });
}

/** Fields an existing row may change when it is closed. */
const MAPPING_CLOSURE_FIELDS = Object.freeze(['effective_to', 'closed_version', 'status', 'closed_at']);

/** Errors when any previously stored record changed outside the allowed closure fields. */
function checkHistoryImmutability_(before, after) {
  const errors = [];
  const afterById = {};
  after.forEach(function (r) { afterById[r.mapping_id] = r; });
  before.forEach(function (b) {
    const a = afterById[b.mapping_id];
    if (!a) { errors.push(b.mapping_id + ' was removed'); return; }
    const fields = getColumnNames_(SHEETS.ENDPOINT_MAPPING);
    fields.forEach(function (f) {
      const same = serializeCell_(a[f]) === serializeCell_(b[f]);
      if (same) return;
      if (b.status === 'OPEN' && a.status === 'CLOSED' && MAPPING_CLOSURE_FIELDS.indexOf(f) >= 0) return;
      errors.push(b.mapping_id + ': field ' + f + ' changed');
    });
  });
  return errors;
}

/**
 * Pure publish plan for a valid draft whose seller IDs are all assigned, against validated
 * history. Throws on any rule violation; never mutates its inputs.
 * @return {{status: 'NO_CHANGE'|'CHANGES', desired: Array<Object>, diff: Object,
 *           effectiveFrom: ?string, version: ?string, newRecords: ?Array<Object>}}
 */
function planSellerMappingPublish_(sellers, records, publishedAt, digestHex) {
  // endpoint_key is the ownership token, never a credential (see EndpointKeyMigration.gs).
  throwIfErrors_('Sellers contains full endpoint credentials', findCredentialEndpointKeys_(sellers));
  throwIfErrors_('Historical seller IDs are missing from Sellers', checkHistoricalSellersRetained_(sellers, records));
  const desired = desiredMappings_(sellers);
  const diff = diffSellerMapping_(desired, records.filter(function (r) { return r.status === 'OPEN'; }));
  const plan = { status: 'NO_CHANGE', desired: desired, diff: diff, effectiveFrom: null, version: null, newRecords: null };
  if (diff.changes.length === 0) return plan;

  const eff = resolvePublishEffectiveDate_(diff, sellers);
  throwIfErrors_('Effective date is invalid', eff.errors);
  throwIfErrors_('Retroactive change', checkNonRetroactive_(eff.effectiveFrom, records, diff.toClose));
  const version = nextMappingVersion_(records);
  const newRecords = buildPublishedHistory_(records, diff, eff.effectiveFrom, version, publishedAt, sellers, digestHex);
  const after = validateMappingHistory_(newRecords, digestHex);
  throwIfErrors_('Resulting Endpoint Mapping history is invalid',
    historyValidationErrors_(after).concat(checkHistoryImmutability_(records, newRecords)));
  plan.status = 'CHANGES';
  plan.effectiveFrom = eff.effectiveFrom;
  plan.version = version;
  plan.newRecords = newRecords;
  return plan;
}

/** Record -> sheet row; date keys become Master date values via dateFromKey. */
function mappingRecordToRow_(rec, columns, dateFromKey) {
  return columns.map(function (c) {
    const v = rec[c];
    if (c === 'effective_from' || c === 'effective_to') return v === '' ? '' : dateFromKey(v);
    return v === undefined || v === null ? '' : v;
  });
}

/**
 * Ownership on a date: rows with effective_from <= date <= effective_to (blank = open).
 * Zero -> UNMAPPED; one -> MAPPED; more -> throws (overlapping history corruption).
 * @param {'endpoint_key'|'endpoint_name'} field
 */
function resolveEndpointMapping_(records, field, value, dateKey) {
  const want = field === 'endpoint_key' ? trimmedText_(value) : endpointNameKey_(value);
  const matches = records.filter(function (r) {
    const have = field === 'endpoint_key' ? r.endpoint_key : endpointNameKey_(r.endpoint_name);
    return have === want && r.effective_from !== '' && r.effective_from <= dateKey &&
      (r.effective_to === '' || dateKey <= r.effective_to);
  });
  if (matches.length > 1) {
    throw new Error('Overlapping Endpoint Mapping history for ' + field + ' "' + value + '" on ' + dateKey + ': ' +
      matches.map(function (m) { return m.mapping_id; }).join(', '));
  }
  return matches.length === 1 ? { status: 'MAPPED', mapping: matches[0] } : { status: 'UNMAPPED', mapping: null };
}

function resolveEndpointByKey_(records, endpointKey, dateKey) {
  return resolveEndpointMapping_(records, 'endpoint_key', endpointKey, dateKey);
}

function resolveEndpointByName_(records, endpointName, dateKey) {
  return resolveEndpointMapping_(records, 'endpoint_name', endpointName, dateKey);
}

/** Both name and key must resolve to the same mapping row (or both be unmapped); else throws. */
function resolveEndpointByNameAndKey_(records, endpointName, endpointKey, dateKey) {
  const byName = resolveEndpointByName_(records, endpointName, dateKey);
  const byKey = resolveEndpointByKey_(records, endpointKey, dateKey);
  const idOf = function (r) { return r.mapping ? r.mapping.mapping_id : null; };
  if (idOf(byName) !== idOf(byKey)) {
    throw new Error('Endpoint name "' + endpointName + '" and key "' + endpointKey + '" resolve to different mappings on ' +
      dateKey + ' (' + (idOf(byName) || 'UNMAPPED') + ' vs ' + (idOf(byKey) || 'UNMAPPED') + ')');
  }
  return byKey;
}

/* ---------------------------------- I/O --------------------------------- */

function endpointMappingTab_() {
  return { targetSheet: SHEETS.ENDPOINT_MAPPING, stagingSheet: '__STAGE_ENDPOINT_MAPPING' };
}

/** Date-only key in the Master timezone. */
function masterDateKey_(value) {
  return providerDateKey_(value, APP.TIMEZONE);
}

function readSellersDraft_(ss) {
  const sheet = ss.getSheetByName(SHEETS.SELLERS);
  if (!sheet) throw new Error('Sellers tab not found. Run setupMaster first.');
  const grid = readSheetGrid_(sheet);
  return { sheet: sheet, values: grid.values, parsed: parseSellersDraft_(grid.values, masterDateKey_) };
}

/** Endpoint Mapping history as records (date keys). Read-only. */
function readEndpointMappingRecords_(ss) {
  const sheet = ss.getSheetByName(SHEETS.ENDPOINT_MAPPING);
  if (!sheet) throw new Error('Endpoint Mapping tab not found. Run setupMaster first.');
  const columns = getColumnNames_(SHEETS.ENDPOINT_MAPPING);
  const grid = readSheetGrid_(sheet);
  const rows = tableRowsFromGrid_(grid.values, columns, SHEETS.ENDPOINT_MAPPING);
  return {
    checksum: grid.checksum,
    records: rows.map(function (r, i) { return toMappingRecord_(rowToObject_(r, columns), masterDateKey_, i); }),
    rows: rows,
  };
}

/** Writes assigned seller IDs back to the Sellers seller_id column in one batch. */
function writeSellerIds_(sheet, values, assignments) {
  const idCol = values[0].map(function (h) { return String(h).trim(); }).indexOf('seller_id');
  const first = Math.min.apply(null, assignments.map(function (a) { return a.row; }));
  const last = Math.max.apply(null, assignments.map(function (a) { return a.row; }));
  const column = [];
  for (let row = first; row <= last; row++) column.push([values[row - 1][idCol]]);
  assignments.forEach(function (a) { column[a.row - first][0] = a.seller_id; });
  sheet.getRange(first, idCol + 1, column.length, 1).setValues(column);
}

function throwIfErrors_(label, errors) {
  const all = Array.isArray(errors) ? errors : flattenErrors_(errors);
  if (all.length === 0) return;
  const shown = all.slice(0, SELLER_MAPPING.maxReportedErrors);
  throw new Error(label + ' (' + all.length + ' error(s)): ' + shown.join(' | ') +
    (all.length > shown.length ? ' | ... ' + (all.length - shown.length) + ' more' : ''));
}

/** Publishes the Sellers draft into Endpoint Mapping under the script lock. Never throws. */
function runPublishSellerMapping_() {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  const details = { assigned_seller_ids: [] };
  let status = 'FAILED';
  let ss = null;
  const tab = endpointMappingTab_();
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms.');
    ss = getSpreadsheet_();

    // 1. Recover an interrupted Endpoint Mapping swap before reading it.
    const recovery = recoverSwapState_(ss, tab);
    details.initial_swap_state = recovery.state;
    details.recovery_actions = recovery.actions;

    // 2. Draft + current history (history is needed so seller IDs are never recycled).
    let draft = readSellersDraft_(ss);
    throwIfErrors_('Sellers draft is invalid', draft.parsed.errors);
    const history = readEndpointMappingRecords_(ss);
    throwIfErrors_('Endpoint Mapping history is invalid', historyValidationErrors_(validateMappingHistory_(history.records)));
    // Historical seller rows must still exist before anything is written back to Sellers.
    throwIfErrors_('Historical seller IDs are missing from Sellers',
      checkHistoricalSellersRetained_(draft.parsed.sellers, history.records));

    // 3-4. Assign missing seller IDs, then re-read and re-validate.
    const assignments = planSellerIdAssignments_(draft.parsed.sellers, history.records.map(function (r) { return r.seller_id; }));
    if (assignments.length > 0) {
      writeSellerIds_(draft.sheet, draft.values, assignments);
      SpreadsheetApp.flush();
      details.assigned_seller_ids = assignments.map(function (a) { return a.seller_id + ' (row ' + a.row + ')'; });
      draft = readSellersDraft_(ss);
      throwIfErrors_('Sellers draft is invalid after seller ID assignment', draft.parsed.errors);
      if (draft.parsed.sellers.some(function (s) { return s.seller_id === ''; })) throw new Error('Seller ID assignment did not persist.');
    }

    // 5-13. Pure plan: diff, single effective date, non-retroactive, version, new history.
    const sellers = draft.parsed.sellers;
    const publishedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const plan = planSellerMappingPublish_(sellers, history.records, publishedAt);
    details.draft_seller_count = sellers.length;
    details.draft_endpoint_count = plan.desired.length;
    details.draft_checksum = ownershipChecksum_(plan.desired);
    details.changes = summarizeMappingChanges_(plan.diff);

    if (plan.status === 'NO_CHANGE') {
      details.open_mapping_count_after = history.records.filter(function (r) { return r.status === 'OPEN'; }).length;
      details.history_checksum = history.checksum;
      status = 'NO_CHANGE';
    } else {
      // 14-15. Whole-table crash-safe write (unchanged rows keep their stored values).
      const columns = getColumnNames_(SHEETS.ENDPOINT_MAPPING);
      const rows = plan.newRecords.map(function (r) {
        if (!r._new && !r._closedNow) return history.rows[r._index];
        if (r._closedNow) {
          const row = history.rows[r._index].slice();
          row[columns.indexOf('effective_to')] = masterDateFromKey_(r.effective_to);
          row[columns.indexOf('closed_version')] = r.closed_version;
          row[columns.indexOf('status')] = r.status;
          row[columns.indexOf('closed_at')] = r.closed_at;
          return row;
        }
        return mappingRecordToRow_(r, columns, masterDateFromKey_);
      });
      const written = writeCanonicalTable_(ss, getTableSchema_(SHEETS.ENDPOINT_MAPPING), tab, rows);
      details.effective_from = plan.effectiveFrom;
      details.mapping_version = plan.version;
      details.opened_count = plan.diff.toOpen.length;
      details.closed_count = plan.diff.toClose.length;
      details.open_mapping_count_after = plan.newRecords.filter(function (r) { return r.status === 'OPEN'; }).length;
      details.history_checksum = written.checksum;
      details.writer_recovery_state = written.swapState;
      status = 'SUCCESS';
    }
  } catch (err) {
    details.error = redactEndpointCredentials_(err && err.message ? err.message : String(err));
    status = 'FAILED';
  } finally {
    try {
      if (ss) details.final_swap_state = detectSwapState_(ss, tab).state;
    } catch (stateErr) {
      details.final_swap_state = 'UNKNOWN (' + stateErr.message + ')';
    }
    try {
      appendAuditLog_({
        action: 'SELLER_MAPPING_PUBLISH_' + status,
        entityType: 'SELLER_MAPPING',
        entityId: details.mapping_version || '',
        newStatus: status,
        details: redactDeep_(details),
      });
    } catch (auditErr) {
      Logger.log('Failed to write audit entry: %s', auditErr);
    }
    if (locked) lock.releaseLock();
  }
  return redactDeep_(Object.assign({ status: status }, details));
}

/** Read-only verification of the Sellers draft and the Endpoint Mapping history. */
function buildSellerMappingReport_() {
  const report = {
    schema_version: APP.SCHEMA_VERSION,
    draft_seller_count: 0,
    draft_active_seller_count: 0,
    draft_endpoint_count: 0,
    assigned_seller_ids: [],
    rows_missing_seller_id: [],
    duplicate_seller_ids: [],
    duplicate_seller_names: [],
    duplicate_endpoint_keys: [],
    duplicate_endpoint_names: [],
    half_filled_endpoint_pairs: [],
    invalid_seller_rows: [],
    history_row_count: 0,
    open_mapping_count: 0,
    closed_mapping_count: 0,
    latest_mapping_version: null,
    latest_mapping_effective_date: null,
    version_boundary_errors: [],
    missing_historical_seller_ids: [],
    history_overlap_errors: [],
    history_integrity_errors: [],
    desired_open_mapping_count: 0,
    published_open_mapping_count: 0,
    published_match: false,
    unpublished_changes: { new: [], removed: [], moved: [], renamed_or_key_changed: [] },
    effective_date_errors: [],
    swap_state: null,
    pass: false,
    errors: [],
    warnings: [],
  };
  try {
    const ss = getSpreadsheet_();
    report.swap_state = detectSwapState_(ss, endpointMappingTab_()).state;
    if (report.swap_state !== 'NORMAL') report.errors.push('Endpoint Mapping swap state is ' + report.swap_state + '.');

    const draft = readSellersDraft_(ss).parsed;
    const e = draft.errors;
    report.draft_seller_count = draft.sellers.length;
    report.draft_active_seller_count = draft.sellers.filter(function (s) { return s.status === 'ACTIVE'; }).length;
    report.assigned_seller_ids = draft.sellers.map(function (s) { return s.seller_id; }).filter(function (id) { return id !== ''; });
    report.rows_missing_seller_id = draft.sellers.filter(function (s) { return s.seller_id === ''; }).map(function (s) { return s.row; });
    report.duplicate_seller_ids = e.duplicate_seller_ids;
    report.duplicate_seller_names = e.duplicate_seller_names;
    report.duplicate_endpoint_keys = e.duplicate_endpoint_keys;
    report.duplicate_endpoint_names = e.duplicate_endpoint_names;
    report.half_filled_endpoint_pairs = e.half_filled_endpoint_pairs;
    report.invalid_seller_rows = e.invalid;
    const draftErrors = flattenErrors_(e);
    if (draftErrors.length > 0) report.errors.push('Sellers draft has ' + draftErrors.length + ' error(s).');
    if (report.rows_missing_seller_id.length > 0) {
      report.warnings.push('Sellers rows without seller_id (assigned on publish): ' + report.rows_missing_seller_id.join(', '));
    }

    const history = readEndpointMappingRecords_(ss);
    const check = validateMappingHistory_(history.records);
    report.history_row_count = history.records.length;
    report.open_mapping_count = history.records.filter(function (r) { return r.status === 'OPEN'; }).length;
    report.closed_mapping_count = history.records.filter(function (r) { return r.status === 'CLOSED'; }).length;
    const latest = latestMappingBoundary_(history.records);
    report.latest_mapping_version = latest ? latest.version : null;
    report.latest_mapping_effective_date = latest ? latest.date : null;
    report.history_integrity_errors = check.integrity;
    report.history_overlap_errors = check.overlap;
    report.version_boundary_errors = check.versionBoundary;
    if (historyValidationErrors_(check).length > 0) report.errors.push('Endpoint Mapping history is invalid.');
    report.missing_historical_seller_ids = checkHistoricalSellersRetained_(draft.sellers, history.records);
    if (report.missing_historical_seller_ids.length > 0) report.errors.push('Historical seller IDs are missing from Sellers.');

    // Dry run of the publish diff (IDs assigned in memory only).
    const planned = planSellerIdAssignments_(draft.sellers, history.records.map(function (r) { return r.seller_id; }));
    const plannedById = {};
    planned.forEach(function (p) { plannedById[p.row] = p.seller_id; });
    const sellers = draft.sellers.map(function (s) {
      return s.seller_id !== '' ? s : Object.assign({}, s, { seller_id: plannedById[s.row] });
    });
    const desired = desiredMappings_(sellers);
    const open = history.records.filter(function (r) { return r.status === 'OPEN'; });
    const diff = diffSellerMapping_(desired, open);
    report.desired_open_mapping_count = desired.length;
    report.draft_endpoint_count = draft.sellers.reduce(function (n, s) { return n + s.endpoints.length; }, 0);
    report.published_open_mapping_count = open.length;
    report.unpublished_changes = summarizeMappingChanges_(diff);
    report.published_match = diff.changes.length === 0 && report.rows_missing_seller_id.length === 0 &&
      ownershipChecksum_(desired) === ownershipChecksum_(open);
    if (diff.changes.length > 0) {
      const eff = resolvePublishEffectiveDate_(diff, sellers);
      report.effective_date_errors = eff.errors.concat(eff.effectiveFrom ? checkNonRetroactive_(eff.effectiveFrom, history.records, diff.toClose) : []);
      report.warnings.push('Unpublished ownership changes: ' + diff.changes.length + '. Run publishSellerMapping().');
    }
    if (!report.published_match) report.errors.push('Sellers draft is not published (published_match = false).');
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0 && report.swap_state === 'NORMAL' && report.published_match;
  return redactDeep_(report);
}
