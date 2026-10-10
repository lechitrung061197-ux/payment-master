// Unit tests for business-independent raw snapshot helpers (src/RawSnapshot.gs).
// Run: npm test   (uses Node's built-in test runner; no dependencies)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load the Apps Script file into an isolated context. Utilities is only used by the
// default digest, so tests inject a Node SHA-256 implementation instead.
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'RawSnapshot.gs'), 'utf8'), context);
const H = context;

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const checksum = (values) => H.computeRawChecksum_(values, sha256);
// Dates must come from the vm context realm so `instanceof Date` matches.
const ctxDate = (ms) => vm.runInContext(`new Date(${ms})`, context);

test('serializeCell_: blank', () => {
  assert.equal(H.serializeCell_(''), 'E');
  assert.equal(H.serializeCell_(null), 'E');
  assert.equal(H.serializeCell_(undefined), 'E');
});

test('serializeCell_: text keeps exact content and is distinct from numbers', () => {
  assert.equal(H.serializeCell_('abc'), 'S"abc"');
  assert.equal(H.serializeCell_(' 00123 '), 'S" 00123 "');
  assert.notEqual(H.serializeCell_('1'), H.serializeCell_(1));
  assert.notEqual(H.serializeCell_('TRUE'), H.serializeCell_(true));
  assert.equal(H.serializeCell_('Tiếng Việt\n"q"'), 'S' + JSON.stringify('Tiếng Việt\n"q"'));
});

test('serializeCell_: numbers are canonical and locale independent', () => {
  assert.equal(H.serializeCell_(0), 'N0');
  assert.equal(H.serializeCell_(-0), 'N0');
  assert.equal(H.serializeCell_(1234.5), 'N1234.5');
  assert.equal(H.serializeCell_(0.1 + 0.2), 'N0.30000000000000004');
  assert.equal(H.serializeCell_(1e21), 'N1e+21');
  assert.equal(H.serializeCell_(-96.72), 'N-96.72');
});

test('serializeCell_: booleans', () => {
  assert.equal(H.serializeCell_(true), 'B1');
  assert.equal(H.serializeCell_(false), 'B0');
});

test('serializeCell_: Date uses epoch milliseconds (timezone independent)', () => {
  const ms = Date.UTC(2026, 9, 1, 15, 30, 0, 250);
  assert.equal(H.serializeCell_(ctxDate(ms)), 'D' + ms);
  assert.equal(H.serializeCell_(new Date(ms)), 'D' + ms, 'cross-realm Date is still a Date');
  assert.equal(H.serializeCell_(ctxDate('NaN')), 'DNaN');
  assert.notEqual(H.serializeCell_(ctxDate(ms)), H.serializeCell_(ms));
});

test('checksum: identical datasets give identical checksums', () => {
  const a = [['id', 'amount', 'date', 'ok'], ['TX-1', 96, ctxDate(1790000000000), true], ['', 0, '', false]];
  const b = [['id', 'amount', 'date', 'ok'], ['TX-1', 96, ctxDate(1790000000000), true], ['', 0, '', false]];
  assert.equal(checksum(a), checksum(b));
  assert.equal(checksum(a), checksum(a), 'stable across calls');
  assert.match(checksum(a), /^[0-9a-f]{64}$/);
});

test('checksum: one-cell change gives a different checksum', () => {
  const base = [['id', 'amount'], ['TX-1', 96], ['TX-2', 100]];
  const changed = [['id', 'amount'], ['TX-1', 96], ['TX-2', 100.01]];
  const typeChanged = [['id', 'amount'], ['TX-1', '96'], ['TX-2', 100]];
  assert.notEqual(checksum(base), checksum(changed));
  assert.notEqual(checksum(base), checksum(typeChanged));
});

test('checksum: dimensions are part of the checksum', () => {
  assert.notEqual(checksum([['a', 'b']]), checksum([['a'], ['b']]));
  assert.notEqual(checksum([['a', '']]), checksum([['a']]));
});

test('checksum: row order matters and chunk boundaries are deterministic', () => {
  const rows = Array.from({ length: 4500 }, (_, i) => ['TX-' + i, i * 1.5]);
  const swapped = rows.slice();
  [swapped[0], swapped[4499]] = [swapped[4499], swapped[0]];
  assert.equal(checksum(rows), checksum(rows.map((r) => r.slice())));
  assert.notEqual(checksum(rows), checksum(swapped));
  const lastCellChanged = rows.map((r) => r.slice());
  lastCellChanged[4499][1] = -1;
  assert.notEqual(checksum(rows), checksum(lastCellChanged), 'change in the last chunk is detected');
});

test('validateRawDataset_: dimensions', () => {
  assert.deepEqual([...H.validateRawDataset_([['a', 'b'], [1, 2]])], []);
  assert.equal(H.validateRawDataset_([]).length, 1);
  assert.equal(H.validateRawDataset_([[]]).length, 1);
  assert.match(H.validateRawDataset_([['a', 'b'], [1]])[0], /Row 2 has 1 columns; expected 2/);
});

test('validateRawDataset_: trailing blank rows/columns are valid, an all-blank range is not', () => {
  assert.deepEqual([...H.validateRawDataset_([['a', ''], ['', ''], ['', '']])], []);
  assert.deepEqual([...H.validateRawDataset_([[0, false]])], [], '0 and false are content');
  assert.match(H.validateRawDataset_([['']])[0], /entirely blank/);
  assert.match(H.validateRawDataset_([['', ''], ['', '']])[0], /entirely blank/);
});

test('checksum: exact used range, trailing "" cells are part of the snapshot', () => {
  const used = [['h1', 'h2', ''], ['x', 1, ''], ['', '', '']];
  const trimmed = [['h1', 'h2'], ['x', 1]];
  assert.notEqual(checksum(used), checksum(trimmed));
  assert.equal(checksum(used), checksum(used.map((r) => r.slice())));
});

test('decideRawSyncAction_: no-change decision', () => {
  const d = (s, l, t) => H.decideRawSyncAction_({ sourceChecksum: s, lastSuccessfulChecksum: l, targetChecksum: t });
  assert.equal(d('A', null, null), 'WRITE', 'first sync');
  assert.equal(d('A', 'B', 'B'), 'WRITE', 'source changed');
  assert.equal(d('A', 'A', 'X'), 'WRITE', 'target was edited manually');
  assert.equal(d('A', 'A', null), 'WRITE', 'target missing');
  assert.equal(d('A', 'A', 'A'), 'NO_CHANGE');
});

test('buildRawNumberFormats_: text forced to plain text, other formats kept', () => {
  const NUM = '0.###############';
  const date = ctxDate(1790000000000);
  const values = [['00123', 5, date, '', true, 7, date]];
  const formats = [['General', '#,##0.00', 'dd/MM/yyyy', '@', '', '@', '']];
  assert.deepEqual(
    [...H.buildRawNumberFormats_(values, formats)[0]],
    ['@', '#,##0.00', 'dd/MM/yyyy', NUM, NUM, NUM, 'yyyy-mm-dd hh:mm:ss'],
  );
});

test('decideRawSwapRecovery_: every target/swap/staging combination', () => {
  const d = (t, w, g) => {
    const r = H.decideRawSwapRecovery_({ targetExists: t, swapExists: w, stagingExists: g });
    return { state: r.state, actions: [...r.actions], hasError: !!r.error };
  };
  // NORMAL: target present, no swap (staging present or not)
  assert.deepEqual(d(true, false, true), { state: 'NORMAL', actions: [], hasError: false });
  assert.deepEqual(d(true, false, false), { state: 'NORMAL', actions: [], hasError: false });
  // B: interrupted after target -> swap; restore swap first, staging untouched
  assert.deepEqual(d(false, true, true), { state: 'B', actions: ['RENAME_SWAP_TO_TARGET'], hasError: false });
  // C: interrupted after staging -> target; keep last known good (swap)
  assert.deepEqual(d(true, true, false),
    { state: 'C', actions: ['RENAME_TARGET_TO_STAGING', 'RENAME_SWAP_TO_TARGET'], hasError: false });
  // D: only swap left
  assert.deepEqual(d(false, true, false), { state: 'D', actions: ['RENAME_SWAP_TO_TARGET'], hasError: false });
  // Unknown states: no actions, descriptive error
  assert.deepEqual(d(true, true, true), { state: 'UNKNOWN', actions: [], hasError: true });
  assert.deepEqual(d(false, false, true), { state: 'UNKNOWN', actions: [], hasError: true });
  // Nothing exists: nothing to protect
  assert.deepEqual(d(false, false, false), { state: 'NO_TARGET', actions: [], hasError: false });
});

test('decideRawSwapRecovery_: replaying actions on names always ends in NORMAL', () => {
  // Simulate the 3-step swap, hard-stopped after each step, then apply recovery.
  const steps = [
    (n) => { n.delete('T'); n.add('W'); },  // (1) target -> swap
    (n) => { n.delete('G'); n.add('T'); },  // (2) staging -> target
    (n) => { n.delete('W'); n.add('G'); },  // (3) swap -> staging
  ];
  for (let stopAfter = 0; stopAfter <= steps.length; stopAfter++) {
    const names = new Set(['T', 'G']);
    steps.slice(0, stopAfter).forEach((s) => s(names));
    const r = H.decideRawSwapRecovery_({ targetExists: names.has('T'), swapExists: names.has('W'), stagingExists: names.has('G') });
    assert.equal(r.error, null, 'stopAfter=' + stopAfter);
    r.actions.forEach((a) => {
      if (a === 'RENAME_TARGET_TO_STAGING') { names.delete('T'); names.add('G'); }
      if (a === 'RENAME_SWAP_TO_TARGET') { names.delete('W'); names.add('T'); }
    });
    assert.deepEqual([...names].sort(), ['G', 'T'], 'stopAfter=' + stopAfter);
  }
});
