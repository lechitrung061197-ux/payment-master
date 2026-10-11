// Unit tests for Audit Log credential redaction (pure parts of src/SecurityRedaction.gs).
// Credential suffixes are FAKE fixtures.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({});
for (const f of ['Config', 'Utils', 'RawSnapshot', 'CanonicalTable', 'Kh001ProviderTransactions', 'Kh001ProviderEvents',
  'Kh001Settlements', 'SellerMapping', 'EndpointKeyMigration', 'SecurityRedaction']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.gs'), 'utf8'), context, { filename: f + '.gs' });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const D = (iso) => vm.runInContext(`new Date(${JSON.stringify(iso)})`, context);

const HEADER = ['timestamp', 'action', 'entity_type', 'entity_id', 'old_status', 'new_status', 'actor', 'details'];
const details = JSON.stringify({ changes: { new: ['SLR-000001:Bun/glk_gcucLF.FAKEsecretA-1', 'SLR-000002:Dino/glk_qP5uSk.FAKEsecretB_2'] } });
const grid = () => [
  HEADER,
  [D('2026-10-11T08:00:00Z'), 'SCHEMA_SETUP', 'SPREADSHEET', 'id', '', 'SCHEMA_V7', 'system', '{"warnings":[]}'],
  [D('2026-10-11T09:00:00Z'), 'SELLER_MAPPING_PUBLISH_SUCCESS', 'SELLER_MAPPING', 'SMV-000001', '', 'SUCCESS', 'system', details],
  [D('2026-10-11T10:00:00Z'), 'KH001_RAW_SYNC_SUCCESS', 'IMPORT_BATCH', 'IB-1', 'RUNNING', 'SUCCESS', 'system', '{"rows":3000}'],
];

test('only credential substrings are redacted; other cells and characters are preserved', () => {
  const changes = js(H.planCredentialRedactions_(grid()));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].row, 3);
  assert.equal(changes[0].column, 8);
  assert.equal(changes[0].value, details.replace('glk_gcucLF.FAKEsecretA-1', 'glk_gcucLF.<redacted>')
    .replace('glk_qP5uSk.FAKEsecretB_2', 'glk_qP5uSk.<redacted>'));
  assert.ok(!/FAKEsecret/.test(JSON.stringify(changes)));
  assert.ok(JSON.parse(changes[0].value).changes.new[0].startsWith('SLR-000001:Bun/glk_gcucLF.'), 'still valid JSON with tokens kept');
});

test('header row, dates, numbers and token-only text are never changed', () => {
  const g = grid();
  g[0][7] = 'details glk_abc.FAKEsecretHeader';
  g[1][3] = 'glk_r8XToW';
  g[1][4] = 42;
  const changes = js(H.planCredentialRedactions_(g));
  assert.deepEqual(changes.map((c) => [c.row, c.column]), [[3, 8]]);
});

test('credential row counting and idempotence', () => {
  assert.equal(H.countCredentialRows_(grid()), 1);
  const cleaned = grid();
  H.planCredentialRedactions_(cleaned).forEach((c) => { cleaned[c.row - 1][c.column - 1] = c.value; });
  assert.equal(H.countCredentialRows_(cleaned), 0);
  assert.deepEqual(js(H.planCredentialRedactions_(cleaned)), [], 'second run changes nothing');
  assert.equal(H.containsEndpointCredential_('glk_r8XToW.<redacted>'), false);
  assert.equal(H.containsEndpointCredential_(D('2026-10-11T00:00:00Z')), false);
});
