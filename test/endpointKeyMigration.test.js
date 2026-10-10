// Unit tests for the one-time endpoint key -> token migration (pure parts of src/EndpointKeyMigration.gs).
// Credential suffixes below are FAKE fixtures; real credentials must never be committed.
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
  'Kh001Settlements', 'SellerMapping', 'EndpointKeyMigration']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.gs'), 'utf8'), context, { filename: f + '.gs' });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const SELLER_COLUMNS = js(H.getColumnNames_('Sellers'));
const EM_COLUMNS = js(H.getColumnNames_('Endpoint Mapping'));
const dateKeyOf = (v) => H.providerDateKey_(v, 'America/New_York');
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

// ---- Regression fixture: endpoint name -> token (production pairs), with FAKE secrets ----
const PAIRS = [
  ['Ditech SG', 'glk_r8XToW'], ['Ditech SG 2', 'glk_g7kaNA'], ['Bun', 'glk_gcucLF'],
  ['Huy-pod', 'glk_WuMQAJ'], ['Dino', 'glk_qP5uSk'], ['Dino Woo', 'glk_7VT7Ye'],
];
const FAKE_SECRET = (token) => 'FAKEsecret-' + token.slice(4) + '-XYZ_123';
const full = (token) => token + '.' + FAKE_SECRET(token);
const SELLERS = [ // seller grouping is arbitrary test data
  { id: 'SLR-000001', name: 'Seller A', eps: [0, 1, 2] },
  { id: 'SLR-000002', name: 'Seller B', eps: [3] },
  { id: 'SLR-000003', name: 'Seller C', eps: [4] },
  { id: 'SLR-000004', name: 'Seller D', eps: [5] },
];

function sellerRow(s, keyOf) {
  const row = SELLER_COLUMNS.map(() => '');
  const set = (c, v) => { row[SELLER_COLUMNS.indexOf(c)] = v; };
  set('seller_id', s.id); set('seller_name', s.name); set('status', s.status || 'ACTIVE'); set('effective_from', '2026-10-01');
  s.eps.forEach((p, i) => { set('endpoint_' + (i + 1) + '_name', PAIRS[p][0]); set('endpoint_' + (i + 1) + '_key', keyOf(PAIRS[p][1])); });
  return row;
}
const draftOf = (keyOf, sellers) => H.parseSellersDraft_([SELLER_COLUMNS, ...(sellers || SELLERS).map((s) => sellerRow(s, keyOf))], dateKeyOf);

/** Initial SMV-000001 history as it was published (keyOf decides legacy/full vs token). */
function historyOf(keyOf) {
  const recs = [];
  SELLERS.forEach((s) => s.eps.forEach((p) => {
    const key = keyOf(PAIRS[p][1]);
    recs.push({ mapping_id: H.mappingIdFor_(s.id, key, '2026-10-01'), seller_id: s.id, seller_name_snapshot: s.name,
      endpoint_name: PAIRS[p][0], endpoint_key: key, effective_from: '2026-10-01', effective_to: '', opened_version: 'SMV-000001',
      closed_version: '', status: 'OPEN', opened_at: 'T0', closed_at: '', notes: '' });
  }));
  return recs.sort((a, b) => (a.endpoint_key < b.endpoint_key ? -1 : 1)).map((r, i) => ({ ...r, _index: i }));
}
const ZERO = { 'Source System': 0, Transactions: 0, 'Payment Matches': 0, 'Payment Legs': 0, 'Settlement Items': 0 };
function plan(o) {
  o = o || {};
  const draft = o.draft || draftOf(o.sellerKey || full);
  return H.planEndpointKeyMigration_({
    schemaVersion: o.schemaVersion === undefined ? 7 : o.schemaVersion,
    dependentRowCounts: o.counts || ZERO,
    sellers: draft.sellers,
    draftErrors: js(H.flattenErrors_(draft.errors)),
    records: o.records || historyOf(o.mappingKey || full),
  });
}
const assertNoSecret = (value) => {
  const text = JSON.stringify(value);
  PAIRS.forEach(([, t]) => assert.ok(!text.includes(FAKE_SECRET(t)), 'secret suffix leaked: ' + t));
  assert.ok(!/FAKEsecret/.test(text), 'secret leaked');
};

// ---- Parser ---------------------------------------------------------------------------
test('full legacy key -> short token; short token unchanged; suffix never returned', () => {
  assert.deepEqual(js(H.parseEndpointKeyForMigration_(full('glk_r8XToW'))), { kind: 'LEGACY', token: 'glk_r8XToW' });
  assert.deepEqual(js(H.parseEndpointKeyForMigration_('glk_r8XToW')), { kind: 'SHORT', token: 'glk_r8XToW' });
  assert.deepEqual(js(H.parseEndpointKeyForMigration_('  glk_r8XToW  ')), { kind: 'SHORT', token: 'glk_r8XToW' });
  assertNoSecret(H.parseEndpointKeyForMigration_(full('glk_r8XToW')));
});

test('malformed keys are rejected instead of guessed', () => {
  for (const bad of ['glk_abc.', 'abc_def.ghi', 'GLK_abc.def', 'glk_.x', 'glk_ab c.def', 'glk_abc.de f', 'key_a', '', 'glk_abc..']) {
    const p = js(H.parseEndpointKeyForMigration_(bad));
    if (bad === 'glk_abc..') assert.equal(p.kind, 'LEGACY', 'non-empty suffix "." is still a suffix');
    else assert.equal(p.kind, 'INVALID', bad);
  }
});

// ---- Plan: regression -------------------------------------------------------------------
test('migration produces exactly the expected name/token pairs and recomputed mapping IDs', () => {
  const p = plan();
  assert.equal(p.status, 'CHANGES');
  assert.deepEqual(js(p.errors), []);
  const pairs = js(p.mappingKeyChanges).map((c) => [c.endpoint_name, c.token]).sort();
  assert.deepEqual(pairs, PAIRS.slice().sort());
  assert.deepEqual(js(p.sellerKeyChanges).map((c) => [c.endpoint_name, c.token]).sort(), PAIRS.slice().sort());
  js(p.newRecords).forEach((r) => {
    assert.equal(r.mapping_id, 'EM-' + sha(r.seller_id + '|' + r.endpoint_key + '|2026-10-01'));
    assert.match(r.endpoint_key, /^glk_[A-Za-z0-9]+$/);
  });
  assertNoSecret(p);
});

test('all other history fields are preserved and no new version is created', () => {
  const before = historyOf(full);
  const p = plan({ records: before });
  const after = js(p.newRecords);
  assert.equal(after.length, before.length);
  after.forEach((a, i) => {
    EM_COLUMNS.filter((c) => c !== 'endpoint_key' && c !== 'mapping_id').forEach((c) => assert.deepEqual(a[c], before[i][c], c));
  });
  assert.ok(after.every((r) => r.opened_version === 'SMV-000001' && r.status === 'OPEN' && r.closed_version === ''));
  assert.deepEqual(js(H.mappingVersionBoundaries_(p.newRecords).boundaries).map((b) => b.version), ['SMV-000001']);
  assert.deepEqual(js(H.checkKeyMigrationPreservation_(before, p.newRecords)), []);
  const tampered = js(p.newRecords); tampered[0].seller_name_snapshot = 'X';
  assert.match(js(H.checkKeyMigrationPreservation_(before, tampered)).join(), /field seller_name_snapshot changed/);
});

// ---- Plan: refusals ------------------------------------------------------------------------
test('dependent accounting rows block the migration', () => {
  for (const name of Object.keys(ZERO)) {
    const p = plan({ counts: { ...ZERO, [name]: 3 } });
    assert.equal(p.status, 'FAILED');
    assert.match(js(p.errors).join(), new RegExp('Precondition empty:' + name + ' failed: 3 data row'));
    assert.deepEqual(js(p.sellerKeyChanges), []);
  }
});

test('schema version, later versions, closed rows and other dates block the migration', () => {
  assert.match(js(plan({ schemaVersion: 8 }).errors).join(), /schema_version failed/);
  const later = historyOf(full); later[0] = { ...later[0], opened_version: 'SMV-000002' };
  assert.match(js(plan({ records: later }).errors).join(), /history_is_initial_version_only failed/);
  const closed = historyOf(full); closed[0] = { ...closed[0], status: 'CLOSED', effective_to: '2026-10-31', closed_version: 'SMV-000002', closed_at: 'T1' };
  assert.equal(plan({ records: closed }).status, 'FAILED');
  assert.equal(plan({ records: [] }).status, 'FAILED', 'empty history');
});

test('duplicate resulting tokens fail', () => {
  const dup = SELLERS.map((s) => ({ ...s }));
  const draft = H.parseSellersDraft_([SELLER_COLUMNS, ...dup.map((s) => sellerRow(s, full))].map((r, i) => {
    if (i !== 2) return r;
    const row = r.slice(); row[SELLER_COLUMNS.indexOf('endpoint_1_key')] = 'glk_r8XToW.OTHERfakeSecret'; return row; // same token, different credential
  }), dateKeyOf);
  const p = plan({ draft });
  assert.equal(p.status, 'FAILED');
  assert.match(js(p.errors).join(), /unique_tokens failed: glk_r8XToW/);
  assert.ok(!JSON.stringify(js(p)).includes('OTHERfakeSecret'));
});

test('unrecognized key formats fail without echoing the value', () => {
  const draft = H.parseSellersDraft_([SELLER_COLUMNS, ...SELLERS.map((s) => sellerRow(s, full))].map((r, i) => {
    if (i !== 1) return r;
    const row = r.slice(); row[SELLER_COLUMNS.indexOf('endpoint_2_key')] = 'opaque-value-123'; return row;
  }), dateKeyOf);
  const p = plan({ draft });
  assert.equal(p.status, 'FAILED');
  assert.match(js(p.errors).join(), /Sellers row 2 endpoint "Ditech SG 2" has an unrecognized key format/);
  assert.ok(!JSON.stringify(js(p.errors)).includes('opaque-value-123'));
});

test('draft that does not match published ownership blocks the migration', () => {
  const moved = SELLERS.map((s) => ({ ...s, eps: s.eps.slice() }));
  moved[0].eps = [0, 1]; moved[1].eps = [3, 2]; // Bun moved to another seller
  const p = plan({ draft: draftOf(full, moved) });
  assert.equal(p.status, 'FAILED');
  assert.match(js(p.errors).join(), /draft_matches_published_ownership failed/);
});

// ---- Idempotence / convergence ---------------------------------------------------------------
const short = (t) => t;
test('second run on a fully migrated state is NO_CHANGE', () => {
  const p = plan({ sellerKey: short, mappingKey: short });
  assert.equal(p.status, 'NO_CHANGE');
  assert.deepEqual(js(p.errors), []);
});

test('partially migrated states converge (history done / Sellers done)', () => {
  const sellersPending = plan({ sellerKey: full, mappingKey: short });
  assert.equal(sellersPending.status, 'CHANGES');
  assert.equal(sellersPending.sellerKeyChanges.length, 6);
  assert.equal(sellersPending.mappingKeyChanges.length, 0);
  const historyPending = plan({ sellerKey: short, mappingKey: full });
  assert.equal(historyPending.status, 'CHANGES');
  assert.equal(historyPending.sellerKeyChanges.length, 0);
  assert.equal(historyPending.mappingKeyChanges.length, 6);
  // Applying the plan output yields the NO_CHANGE state.
  const next = plan({ sellerKey: short, records: js(historyPending.newRecords) });
  assert.equal(next.status, 'NO_CHANGE');
  // A mixed Sellers draft (some legacy, some short) also converges.
  const mixed = plan({ sellerKey: (t) => (t === 'glk_gcucLF' ? t : full(t)), mappingKey: full });
  assert.equal(mixed.status, 'CHANGES');
  assert.equal(mixed.sellerKeyChanges.length, 5);
});

// ---- Secret handling -------------------------------------------------------------------------
test('redaction helpers never expose a credential suffix', () => {
  const text = 'endpoint_key "' + full('glk_r8XToW') + '" on rows 2, 3 | ' + full('glk_gcucLF') + ')';
  const red = H.redactEndpointCredentials_(text);
  assert.equal(red, 'endpoint_key "glk_r8XToW.<redacted>" on rows 2, 3 | glk_gcucLF.<redacted>)');
  const deep = js(H.redactDeep_({ a: [full('glk_WuMQAJ'), { b: 'x ' + full('glk_qP5uSk') }], n: 1 }));
  assertNoSecret(deep);
  assert.equal(deep.a[0], 'glk_WuMQAJ.<redacted>');
  assert.equal(H.redactEndpointCredentials_('glk_r8XToW and key_a'), 'glk_r8XToW and key_a', 'tokens untouched');
});

test('failed plans never expose secrets in errors or preconditions', () => {
  [plan({ schemaVersion: 1 }), plan({ counts: { ...ZERO, Transactions: 1 } }), plan({ records: [] })].forEach(assertNoSecret);
});

test('publishing a full credential is refused with a redacted message', () => {
  const draft = draftOf(full);
  assert.throws(() => H.planSellerMappingPublish_(draft.sellers, [], 'T'), (err) => {
    assert.match(err.message, /Sellers contains full endpoint credentials .*enter only the endpoint token glk_r8XToW/);
    assert.ok(!/FAKEsecret/.test(err.message));
    return true;
  });
  assert.deepEqual(js(H.findCredentialEndpointKeys_(draftOf(short).sellers)), []);
  assert.equal(H.planSellerMappingPublish_(draftOf(short).sellers, [], 'T').status, 'CHANGES', 'token keys publish normally');
});
