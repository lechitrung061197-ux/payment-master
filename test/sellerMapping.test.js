// Unit tests for seller / endpoint mapping (pure parts of src/SellerMapping.gs).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  computeDigest: (_alg, text) => [...crypto.createHash('sha256').update(text, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
  formatDate: (date, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date),
};
const context = vm.createContext({ Utilities });
for (const f of ['Config', 'Utils', 'RawSnapshot', 'CanonicalTable', 'Kh001ProviderTransactions', 'Kh001ProviderEvents',
  'Kh001Settlements', 'SellerMapping']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.gs'), 'utf8'), context, { filename: f + '.gs' });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const SELLER_COLUMNS = js(H.getColumnNames_('Sellers'));
const EM_COLUMNS = js(H.getColumnNames_('Endpoint Mapping'));
const dateKeyOf = (v) => H.providerDateKey_(v, 'America/New_York');
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

// ---- Fixtures ---------------------------------------------------------------
/** Sellers row: endpoints = [[name, key, slot?], ...] (slot defaults to position). */
function seller(o) {
  const row = SELLER_COLUMNS.map(() => '');
  const set = (c, v) => { row[SELLER_COLUMNS.indexOf(c)] = v; };
  set('seller_id', o.id || '');
  set('seller_name', o.name || '');
  set('status', o.status === undefined ? 'ACTIVE' : o.status);
  set('effective_from', o.from || '');
  (o.endpoints || []).forEach(([name, key, slot], i) => {
    const n = slot || i + 1;
    set('endpoint_' + n + '_name', name);
    set('endpoint_' + n + '_key', key);
  });
  set('notes', o.notes || '');
  return row;
}
const grid = (rows) => [SELLER_COLUMNS, ...rows];

/** Pure replica of publishSellerMapping(): returns { status, records, sellers, diff, ... } or throws. */
function publish(draftRows, records, at) {
  const draft = H.parseSellersDraft_(grid(draftRows), dateKeyOf);
  const errs = js(H.flattenErrors_(draft.errors));
  if (errs.length) throw new Error('DRAFT: ' + errs.join(' | '));
  const hist = H.validateMappingHistory_(records);
  if (hist.integrity.length + hist.overlap.length) throw new Error('HISTORY: ' + js(hist.integrity.concat(hist.overlap)).join(' | '));
  const assignments = js(H.planSellerIdAssignments_(draft.sellers, records.map((r) => r.seller_id)));
  const byRow = Object.fromEntries(assignments.map((a) => [a.row, a.seller_id]));
  const sellers = draft.sellers.map((s) => (s.seller_id ? s : { ...s, seller_id: byRow[s.row] }));
  const desired = H.desiredMappings_(sellers);
  const diff = H.diffSellerMapping_(desired, records.filter((r) => r.status === 'OPEN'));
  if (diff.changes.length === 0) return { status: 'NO_CHANGE', records, sellers, diff, assignments };
  const eff = H.resolvePublishEffectiveDate_(diff, sellers);
  if (eff.errors.length) throw new Error('EFFECTIVE: ' + js(eff.errors).join(' | '));
  const retro = js(H.checkNonRetroactive_(eff.effectiveFrom, records, diff.toClose));
  if (retro.length) throw new Error('RETRO: ' + retro.join(' | '));
  const version = H.nextMappingVersion_(records);
  const next = H.buildPublishedHistory_(records, diff, eff.effectiveFrom, version, at || 'T', sellers);
  const after = H.validateMappingHistory_(next);
  const imm = js(H.checkHistoryImmutability_(records, next));
  if (after.integrity.length + after.overlap.length + imm.length) {
    throw new Error('RESULT: ' + js(after.integrity.concat(after.overlap)).concat(imm).join(' | '));
  }
  const clean = next.map((r, i) => { const x = { ...r, _index: i }; delete x._new; delete x._closedNow; return x; });
  return { status: 'SUCCESS', records: clean, sellers, diff, assignments, version, effectiveFrom: eff.effectiveFrom };
}
const open = (records) => records.filter((r) => r.status === 'OPEN');
const owner = (records, key, date) => { const r = H.resolveEndpointByKey_(records, key, date); return r.mapping ? r.mapping.seller_id : null; };

const DITECH = (o) => seller({ id: 'SLR-000001', name: 'Seller One', from: '2026-10-01',
  endpoints: [['Endpoint A', 'key_a'], ['Endpoint B', 'key_b']], ...o });
const OTHER = (o) => seller({ id: 'SLR-000002', name: 'Seller Two', from: '2026-10-01', endpoints: [['Endpoint C', 'key_c']], ...o });
const initial = () => publish([DITECH(), OTHER()], [], 'T0');

// ---- Draft parsing ----------------------------------------------------------------
test('one seller with multiple endpoint pairs; header-driven pair discovery', () => {
  const d = H.parseSellersDraft_(grid([seller({ id: 'SLR-000001', name: 'S', endpoints: [['A', 'k1'], ['B', 'k2'], ['C', 'k3', 10]] })]), dateKeyOf);
  assert.deepEqual(js(H.flattenErrors_(d.errors)), []);
  assert.deepEqual(js(d.sellers[0].endpoints).map((e) => e.endpoint_key), ['k1', 'k2', 'k3']);
  assert.deepEqual(js(H.sellerEndpointSlots_(SELLER_COLUMNS)).map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const wider = SELLER_COLUMNS.slice(0, -1).concat(['endpoint_11_name', 'endpoint_11_key', 'notes']);
  assert.equal(H.sellerEndpointSlots_(wider).length, 11, 'endpoint_11 is a schema-only change');
  assert.throws(() => H.sellerEndpointSlots_(SELLER_COLUMNS.concat(['endpoint_12_name'])), /unpaired endpoint column\(s\): endpoint_12/);
});

test('paired name/key validation: half-filled pair fails; surrounding whitespace trimmed', () => {
  const d = H.parseSellersDraft_(grid([seller({ name: 'S', endpoints: [['  Name A  ', ' key_a '], ['Only name', ''], ['', 'only_key']] })]), dateKeyOf);
  assert.deepEqual(js(d.errors.half_filled_endpoint_pairs), ['Sellers row 2: endpoint_2 has a name but no key', 'Sellers row 2: endpoint_3 has a key but no name']);
  assert.equal(d.sellers[0].endpoints[0].endpoint_name, 'Name A');
  assert.equal(d.sellers[0].endpoints[0].endpoint_key, 'key_a');
});

test('seller_name and status are required; status validated', () => {
  const d = H.parseSellersDraft_(grid([seller({ id: 'X', name: '', status: 'PAUSED' })]), dateKeyOf);
  assert.match(js(d.errors.invalid).join(' | '), /seller_name is required.*status must be ACTIVE or INACTIVE/);
});

test('duplicate seller ID fails', () => {
  const d = H.parseSellersDraft_(grid([DITECH(), OTHER({ id: 'SLR-000001' })]), dateKeyOf);
  assert.deepEqual(js(d.errors.duplicate_seller_ids), ['seller_id SLR-000001 on rows 2, 3']);
});

test('duplicate active endpoint key fails; name duplicates are case-insensitive; inactive sellers ignored', () => {
  const k = H.parseSellersDraft_(grid([DITECH(), OTHER({ endpoints: [['Endpoint X', 'key_a']] })]), dateKeyOf);
  assert.deepEqual(js(k.errors.duplicate_endpoint_keys), ['endpoint_key "key_a" on rows 2, 3']);
  const n = H.parseSellersDraft_(grid([DITECH(), OTHER({ endpoints: [['  endpoint   a ', 'key_x']] })]), dateKeyOf);
  assert.match(js(n.errors.duplicate_endpoint_names).join(), /endpoint_name "Endpoint A" \(case-insensitive\) on rows 2, 3/);
  const inactive = H.parseSellersDraft_(grid([DITECH(), OTHER({ status: 'INACTIVE', endpoints: [['Endpoint A', 'key_a']] })]), dateKeyOf);
  assert.deepEqual(js(H.flattenErrors_(inactive.errors)), []);
});

// ---- Seller IDs ----------------------------------------------------------------------
test('seller ID auto-assignment: next number after draft and history, in row order', () => {
  const d = H.parseSellersDraft_(grid([seller({ name: 'New A' }), DITECH(), seller({ name: 'New B' }), seller({ id: 'CUSTOM-7', name: 'Custom' })]), dateKeyOf);
  assert.deepEqual(js(H.planSellerIdAssignments_(d.sellers, ['SLR-000005'])), [
    { row: 2, seller_id: 'SLR-000006' }, { row: 4, seller_id: 'SLR-000007' }]);
});

test('seller ID stability: IDs in history are never recycled even if the row is gone', () => {
  const r = initial().records;
  const d = H.parseSellersDraft_(grid([seller({ name: 'Brand new' })]), dateKeyOf);
  assert.deepEqual(js(H.planSellerIdAssignments_(d.sellers, r.map((x) => x.seller_id))), [{ row: 2, seller_id: 'SLR-000003' }]);
});

// ---- Publish lifecycle --------------------------------------------------------------
test('initial historical publish opens one mapping per endpoint with version SMV-000001', () => {
  const p = initial();
  assert.equal(p.status, 'SUCCESS');
  assert.equal(p.version, 'SMV-000001');
  assert.equal(p.effectiveFrom, '2026-10-01');
  assert.equal(open(p.records).length, 3);
  const a = p.records.find((r) => r.endpoint_key === 'key_a');
  assert.deepEqual({ ...a, _index: undefined }, { ...a, _index: undefined, mapping_id: 'EM-' + sha('SLR-000001|key_a|2026-10-01'),
    seller_id: 'SLR-000001', seller_name_snapshot: 'Seller One', endpoint_name: 'Endpoint A', effective_from: '2026-10-01',
    effective_to: '', opened_version: 'SMV-000001', closed_version: '', status: 'OPEN', opened_at: 'T0', closed_at: '' });
});

test('unchanged rerun is NO_CHANGE; row order, slot order, blank slots and notes do not matter', () => {
  const r = initial().records;
  assert.equal(publish([DITECH(), OTHER()], r).status, 'NO_CHANGE');
  const reshuffled = [OTHER({ notes: 'changed note' }), DITECH({ endpoints: [['Endpoint B', 'key_b', 7], ['Endpoint A', 'key_a', 3]] })];
  assert.equal(publish(reshuffled, r).status, 'NO_CHANGE');
  assert.equal(H.ownershipChecksum_(H.desiredMappings_(H.parseSellersDraft_(grid(reshuffled), dateKeyOf).sellers)),
    H.ownershipChecksum_(open(r)));
});

test('seller name-only change does not change ownership history', () => {
  const r = initial().records;
  const p = publish([DITECH({ name: 'Seller One Renamed', from: '2026-11-01' }), OTHER()], r);
  assert.equal(p.status, 'NO_CHANGE');
  assert.ok(r.every((x) => x.seller_name_snapshot !== 'Seller One Renamed'));
});

test('add an endpoint in the future: only a new OPEN row, old rows untouched', () => {
  const r = initial().records;
  const p = publish([DITECH({ from: '2026-11-01', endpoints: [['Endpoint A', 'key_a'], ['Endpoint B', 'key_b'], ['Endpoint D', 'key_d']] }), OTHER()], r, 'T1');
  assert.equal(p.status, 'SUCCESS');
  assert.equal(p.version, 'SMV-000002');
  assert.deepEqual(js(p.diff.changes).map((c) => c.type), ['NEW']);
  const d = p.records.find((x) => x.endpoint_key === 'key_d');
  assert.equal(d.effective_from, '2026-11-01');
  assert.equal(d.opened_version, 'SMV-000002');
  assert.equal(owner(p.records, 'key_d', '2026-10-31'), null);
  assert.equal(owner(p.records, 'key_d', '2026-11-01'), 'SLR-000001');
});

test('remove an endpoint in the future: closes it the day before, no reopen', () => {
  const r = initial().records;
  const p = publish([DITECH({ from: '2026-11-01', endpoints: [['Endpoint A', 'key_a']] }), OTHER()], r, 'T1');
  assert.deepEqual(js(p.diff.changes).map((c) => c.type), ['REMOVED']);
  const b = p.records.find((x) => x.endpoint_key === 'key_b');
  assert.equal(b.status, 'CLOSED');
  assert.equal(b.effective_to, '2026-10-31');
  assert.equal(b.closed_version, 'SMV-000002');
  assert.equal(b.closed_at, 'T1');
  assert.equal(owner(p.records, 'key_b', '2026-10-31'), 'SLR-000001');
  assert.equal(owner(p.records, 'key_b', '2026-11-01'), null);
});

test('move an endpoint to another seller: historical resolver returns old seller before, new seller after', () => {
  const r = initial().records;
  const p = publish([DITECH({ from: '2026-11-01', endpoints: [['Endpoint A', 'key_a']] }),
    OTHER({ from: '2026-11-01', endpoints: [['Endpoint C', 'key_c'], ['Endpoint B', 'key_b']] })], r, 'T1');
  assert.deepEqual(js(p.diff.changes).map((c) => c.type), ['MOVED_TO_ANOTHER_SELLER']);
  assert.equal(owner(p.records, 'key_b', '2026-10-15'), 'SLR-000001');
  assert.equal(owner(p.records, 'key_b', '2026-10-31'), 'SLR-000001');
  assert.equal(owner(p.records, 'key_b', '2026-11-01'), 'SLR-000002');
  assert.equal(H.resolveEndpointByName_(p.records, 'endpoint b', '2026-12-01').mapping.seller_id, 'SLR-000002');
  assert.equal(owner(p.records, 'key_b', '2026-09-30'), null, 'before initial backfill');
});

test('name change and key change are classified and close/reopen', () => {
  const r = initial().records;
  const renamed = publish([DITECH({ from: '2026-11-01', endpoints: [['Endpoint A2', 'key_a'], ['Endpoint B', 'key_b']] }), OTHER()], r);
  assert.deepEqual(js(renamed.diff.changes).map((c) => c.type), ['NAME_CHANGED']);
  const rekeyed = publish([DITECH({ from: '2026-11-01', endpoints: [['Endpoint A', 'key_a2'], ['Endpoint B', 'key_b']] }), OTHER()], r);
  assert.deepEqual(js(rekeyed.diff.changes).map((c) => c.type), ['KEY_CHANGED']);
  assert.equal(H.resolveEndpointByName_(rekeyed.records, 'Endpoint A', '2026-10-31').mapping.endpoint_key, 'key_a');
  assert.equal(H.resolveEndpointByName_(rekeyed.records, 'Endpoint A', '2026-11-01').mapping.endpoint_key, 'key_a2');
});

test('deactivate seller closes all its mappings', () => {
  const r = initial().records;
  const p = publish([DITECH({ status: 'INACTIVE', from: '2026-11-01' }), OTHER()], r, 'T1');
  assert.deepEqual(js(p.diff.changes).map((c) => c.type), ['REMOVED', 'REMOVED']);
  assert.deepEqual(open(p.records).map((x) => x.endpoint_key), ['key_c']);
  assert.equal(owner(p.records, 'key_a', '2026-10-31'), 'SLR-000001');
});

test('changed rows with different effective dates fail', () => {
  const r = initial().records;
  assert.throws(() => publish([DITECH({ from: '2026-11-01', endpoints: [['Endpoint A', 'key_a']] }),
    OTHER({ from: '2026-11-02', endpoints: [['Endpoint C', 'key_c'], ['Endpoint B', 'key_b']] })], r),
  /different effective_from dates: 2026-11-01 \(SLR-000001\); 2026-11-02 \(SLR-000002\)/);
});

test('a changed row without effective_from fails; unchanged rows may keep old dates', () => {
  const r = initial().records;
  assert.throws(() => publish([DITECH({ from: '', endpoints: [['Endpoint A', 'key_a']] }), OTHER()], r), /SLR-000001 .* has no effective_from/);
  assert.equal(publish([DITECH({ from: '2026-11-01', endpoints: [['Endpoint A', 'key_a']] }), OTHER({ from: '2026-10-01' })], r).status, 'SUCCESS');
});

test('retroactive future publish fails (strictly after the latest published effective date)', () => {
  const r = initial().records;
  assert.throws(() => publish([DITECH({ from: '2026-10-01', endpoints: [['Endpoint A', 'key_a']] }), OTHER()], r),
    /RETRO: effective_from 2026-10-01 must be after the latest published effective_from 2026-10-01/);
  assert.throws(() => publish([DITECH({ from: '2026-09-15', endpoints: [['Endpoint A', 'key_a']] }), OTHER()], r), /RETRO/);
});

test('deleting a seller row that owns OPEN mappings fails', () => {
  const r = initial().records;
  assert.throws(() => publish([OTHER()], r), /Seller SLR-000001 owns OPEN mapping .* its row was removed from Sellers/);
});

test('old effective_from is never rewritten; closure changes only the allowed fields; closed rows immutable', () => {
  const p0 = initial();
  const p1 = publish([DITECH({ from: '2026-11-01', endpoints: [['Endpoint A', 'key_a']] }), OTHER()], p0.records, 'T1');
  const before = p0.records.find((x) => x.endpoint_key === 'key_b');
  const after = p1.records.find((x) => x.endpoint_key === 'key_b');
  const changed = EM_COLUMNS.filter((c) => JSON.stringify(before[c]) !== JSON.stringify(after[c]));
  assert.deepEqual(changed, ['effective_to', 'closed_version', 'status', 'closed_at']);
  assert.equal(after.effective_from, '2026-10-01');
  // Next publish leaves the CLOSED row byte-identical.
  const p2 = publish([DITECH({ from: '2026-12-01', endpoints: [['Endpoint A', 'key_a'], ['Endpoint B', 'key_b']] }), OTHER()], p1.records, 'T2');
  const closed = p2.records.find((x) => x.mapping_id === after.mapping_id);
  assert.deepEqual(EM_COLUMNS.map((c) => closed[c]), EM_COLUMNS.map((c) => after[c]));
  assert.equal(p2.version, 'SMV-000003');
  // The guard itself rejects edits outside the closure fields and edits to CLOSED rows.
  const tampered = p1.records.map((x) => (x.mapping_id === after.mapping_id ? { ...x, endpoint_name: 'Hacked' } : x));
  assert.match(js(H.checkHistoryImmutability_(p1.records, tampered)).join(), /field endpoint_name changed/);
  const reopened = p1.records.map((x) => (x.mapping_id === after.mapping_id ? { ...x, closed_at: 'T9' } : x));
  assert.match(js(H.checkHistoryImmutability_(p1.records, reopened)).join(), /field closed_at changed/);
});

test('deterministic mapping_id and version increment', () => {
  assert.equal(H.mappingIdFor_('SLR-000001', 'key_a', '2026-10-01'), 'EM-' + sha('SLR-000001|key_a|2026-10-01'));
  assert.equal(H.nextMappingVersion_([]), 'SMV-000001');
  assert.equal(H.nextMappingVersion_([{ opened_version: 'SMV-000004', closed_version: 'SMV-000009' }]), 'SMV-000010');
  assert.deepEqual(js(initial().records), js(initial().records));
});

// ---- History validation / resolver --------------------------------------------------
test('endpoint key overlap and endpoint name overlap are detected', () => {
  const r = initial().records;
  const keyOverlap = r.concat([{ ...r[0], mapping_id: H.mappingIdFor_('SLR-000002', r[0].endpoint_key, '2026-10-15'),
    seller_id: 'SLR-000002', effective_from: '2026-10-15', endpoint_name: 'Other name' }]);
  const v1 = H.validateMappingHistory_(keyOverlap);
  assert.match(js(v1.overlap).join(' | '), /endpoint_key "key_a" has 2 open-ended mappings/);
  const nameOverlap = r.concat([{ ...r[0], mapping_id: H.mappingIdFor_('SLR-000002', 'key_zz', '2026-10-15'), seller_id: 'SLR-000002',
    endpoint_key: 'key_zz', endpoint_name: 'ENDPOINT A', effective_from: '2026-10-15', effective_to: '2026-10-20', status: 'CLOSED',
    closed_version: 'SMV-000002', closed_at: 'T' }]);
  assert.match(js(H.validateMappingHistory_(nameOverlap).overlap).join(' | '), /endpoint_name "endpoint a": .* overlaps/);
  assert.throws(() => H.resolveEndpointByKey_(keyOverlap, 'key_a', '2026-10-20'), /Overlapping Endpoint Mapping history for endpoint_key "key_a"/);
});

test('history integrity checks', () => {
  const r = initial().records;
  const bad = [
    { ...r[0], status: 'OPEN', effective_to: '2026-10-05' },
    { ...r[1], status: 'CLOSED', effective_to: '' },
    { ...r[2], opened_version: 'v1', mapping_id: 'EM-wrong' },
  ];
  const v = js(H.validateMappingHistory_(bad).integrity).join(' | ');
  assert.match(v, /OPEN row must have blank effective_to/);
  assert.match(v, /CLOSED row requires effective_to/);
  assert.match(v, /invalid opened_version "v1"/);
  assert.match(v, /mapping_id does not match/);
  assert.match(js(H.validateMappingHistory_([r[0], r[0]]).integrity).join(), /duplicate mapping_id/);
});

test('combined name + key resolver requires the same mapping row', () => {
  const p = publish([DITECH({ from: '2026-11-01', endpoints: [['Endpoint A', 'key_a']] }),
    OTHER({ from: '2026-11-01', endpoints: [['Endpoint C', 'key_c'], ['Endpoint B', 'key_b']] })], initial().records);
  assert.equal(H.resolveEndpointByNameAndKey_(p.records, 'Endpoint B', 'key_b', '2026-11-05').mapping.seller_id, 'SLR-000002');
  assert.throws(() => H.resolveEndpointByNameAndKey_(p.records, 'Endpoint A', 'key_b', '2026-11-05'), /resolve to different mappings/);
  assert.throws(() => H.resolveEndpointByNameAndKey_(p.records, 'Unknown', 'key_a', '2026-11-05'), /UNMAPPED vs EM-/);
  assert.equal(H.resolveEndpointByNameAndKey_(p.records, 'Unknown', 'nokey', '2026-11-05').status, 'UNMAPPED');
});

test('date key helpers', () => {
  assert.equal(H.addDaysToDateKey_('2026-11-01', -1), '2026-10-31');
  assert.equal(H.addDaysToDateKey_('2027-03-01', -1), '2027-02-28');
  assert.equal(H.addDaysToDateKey_('2026-01-01', -1), '2025-12-31');
});

test('mapping record rows follow the 13-column schema and convert date keys', () => {
  const rec = initial().records[0];
  const row = H.mappingRecordToRow_(rec, EM_COLUMNS, (k) => 'DATE(' + k + ')');
  assert.equal(row.length, 13);
  assert.equal(row[EM_COLUMNS.indexOf('effective_from')], 'DATE(2026-10-01)');
  assert.equal(row[EM_COLUMNS.indexOf('effective_to')], '');
});

test('publish SUCCESS then NO_CHANGE and published ownership matches the draft', () => {
  const p = initial();
  const draft = H.parseSellersDraft_(grid([DITECH(), OTHER()]), dateKeyOf);
  assert.equal(H.ownershipChecksum_(H.desiredMappings_(draft.sellers)), H.ownershipChecksum_(open(p.records)));
  assert.equal(publish([DITECH(), OTHER()], p.records).status, 'NO_CHANGE');
});
