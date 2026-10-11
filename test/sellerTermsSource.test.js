// Unit tests for payment-source-specific Seller Terms (schema v14): seller + payment_source + effective date,
// fail-closed resolution, frozen history and the v13 -> v14 migration. Fake data.
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
const context = vm.createContext({ Utilities, Logger: { log: () => {} } });
for (const f of fs.readdirSync(path.join(__dirname, '..', 'src')).filter((f) => f.endsWith('.gs')).sort()) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), context, { filename: f });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const NY = (v) => H.providerDateKey_(v, 'America/New_York');
const SELLERS = [{ seller_id: 'CUS002', seller_name: 'HUI' }];
const term = (source, rate, from, to) => ({ seller_id: 'CUS002', payment_source: source, seller_name_snapshot: 'HUI', seller_fee_rate: rate,
  effective_from: from, effective_to: to || '' });
const parse = (rows) => H.parseSellerTerms_(rows, SELLERS, NY);
const errs = (p) => js(H.flattenSellerTermErrors_(p.errors)).join(' | ');
const leg = (source, net, hold) => ({ payment_source: source, net_amount: net, provider_hold_amount: hold });

test('same seller, same period, different payment_source: PAYPAL 8% and STRIPE 5%', () => {
  const p = parse([term('PAYPAL', 0.08, '2026-10-01'), term('STRIPE', 0.05, '2026-10-01')]);
  assert.equal(errs(p), '', 'overlapping periods of different sources are fine');
  assert.equal(H.resolveSellerTerm_(p.terms, 'CUS002', 'PAYPAL', '2026-10-15').seller_fee_rate, 0.08);
  assert.equal(H.resolveSellerTerm_(p.terms, 'CUS002', 'STRIPE', '2026-10-15').seller_fee_rate, 0.05);
  const paypal = js(H.sellerEconomicsForLeg_(leg('PAYPAL', 100, 10), p.terms, 'CUS002', '2026-10-15'));
  const stripe = js(H.sellerEconomicsForLeg_(leg('STRIPE', 100, 10), p.terms, 'CUS002', '2026-10-15'));
  assert.deepEqual([paypal.seller_fee_rate, paypal.seller_fee, paypal.seller_available_amount], [0.08, 8, 82]);
  assert.deepEqual([stripe.seller_fee_rate, stripe.seller_fee, stripe.seller_available_amount], [0.05, 5, 85]);
});

test('missing source-specific term fails closed: PAYPAL terms are never used for STRIPE', () => {
  const p = parse([term('PAYPAL', 0.08, '2026-10-01')]);
  assert.throws(() => H.resolveSellerTerm_(p.terms, 'CUS002', 'STRIPE', '2026-10-15'), /No Seller Terms row for CUS002 \/ STRIPE on 2026-10-15/);
  assert.throws(() => H.sellerEconomicsForLeg_(leg('STRIPE', 100, 10), p.terms, 'CUS002', '2026-10-15'), /No Seller Terms row for CUS002 \/ STRIPE/);
  assert.throws(() => H.resolveSellerTerm_(p.terms, 'CUS002', '', '2026-10-15'), /\(blank source\)/);
});

test('payment_source is required and validated; overlaps are checked per seller + source', () => {
  assert.match(errs(parse([{ ...term('PAYPAL', 0.08, '2026-10-01'), payment_source: '' }])), /payment_source is blank \(required\)/);
  assert.match(errs(parse([term('VENMO', 0.08, '2026-10-01')])), /unknown payment_source "VENMO"/);
  assert.match(errs(parse([term('STRIPE', 0.05, '2026-10-01'), term('STRIPE', 0.04, '2026-10-10')])), /CUS002\/STRIPE: 2 open-ended rows/);
  assert.equal(js(parse([term('stripe', 0.05, '2026-10-01')]).terms)[0].payment_source, 'STRIPE', 'normalized to upper case');
});

test('future STRIPE rate change applies from its date only; the earlier STRIPE rate and PAYPAL are unchanged', () => {
  const p = parse([term('PAYPAL', 0.08, '2026-10-01'), term('STRIPE', 0.05, '2026-10-01', '2026-11-30'), term('STRIPE', 0.045, '2026-12-01')]);
  assert.equal(errs(p), '');
  assert.equal(H.resolveSellerTerm_(p.terms, 'CUS002', 'STRIPE', '2026-11-30').seller_fee_rate, 0.05);
  assert.equal(H.resolveSellerTerm_(p.terms, 'CUS002', 'STRIPE', '2026-12-01').seller_fee_rate, 0.045);
  assert.equal(H.resolveSellerTerm_(p.terms, 'CUS002', 'PAYPAL', '2026-12-01').seller_fee_rate, 0.08);
});

test('historical snapshot stays frozen: a frozen item rejects a retroactive rate change of its own source', () => {
  const frozenItem = { settlement_item_id: 'SI-1', payment_leg_id: 'PL-1', settlement_id: 'ST-1', payment_source: 'PAYPAL', seller_fee_rate: 0.08,
    seller_fee: 8, seller_available_amount: 82, seller_hold_amount: 10, net_amount: 100 };
  const fresh = (rate) => ({ ...frozenItem, settlement_status: 'AVAILABLE', seller_fee_rate: rate, seller_fee: 100 * rate,
    seller_available_amount: 100 - 100 * rate - 10 });
  assert.deepEqual(js(H.checkLegsAgainstFrozenItems_([fresh(0.08)], [frozenItem])), []);
  assert.match(js(H.checkLegsAgainstFrozenItems_([fresh(0.07)], [frozenItem])).join(), /differs from the frozen item in seller_fee_rate/);
  // A future STRIPE term does not change the PAYPAL leg economics at all.
  const p = parse([term('PAYPAL', 0.08, '2026-10-01'), term('STRIPE', 0.05, '2026-12-01')]);
  assert.deepEqual(js(H.sellerEconomicsForLeg_(leg('PAYPAL', 100, 10), p.terms, 'CUS002', '2026-10-02')).seller_fee, 8);
});

test('seed assigns PAYPAL; the v13 -> v14 migration inserts payment_source = PAYPAL and preserves every other cell', () => {
  assert.equal(js(H.planSellerTermsSeed_([{ seller_id: 'CUS002', seller_name: 'HUI' }], 0.08, [], '2026-10-01'))[0].payment_source, 'PAYPAL');
  const legacy = js(vm.runInContext('SELLER_TERMS.legacyHeaderV13', context));
  const fromDate = vm.runInContext('new Date("2026-10-01T04:00:00Z")', context);
  let grid = [legacy, ['CUS001', 'DITECH', 0.08, fromDate, '', 'seed'], ['CUS002', 'HUI', 0.08, fromDate, '', ''], ['', '', '', '', '', '']];
  const fmts = [];
  const sheet = {
    getLastColumn: () => Math.max(...grid.map((r) => { let n = r.length; while (n > 0 && (r[n - 1] === '' || r[n - 1] == null)) n--; return n; })),
    getLastRow: () => { for (let r = grid.length; r > 0; r--) if (grid[r - 1].some((v) => v !== '')) return r; return 0; },
    insertColumnsAfter: (after, n) => { grid = grid.map((r) => [...r.slice(0, after), ...Array(n).fill(''), ...r.slice(after)]); },
    getRange: (r, c, nr, nc) => {
      nr = nr || 1; nc = nc || 1;
      const rg = {
        getDisplayValues: () => grid.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc).map(String)),
        getValues: () => grid.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)),
        setValue: (v) => { grid[r - 1][c - 1] = v; return rg; },
        setValues: (vs) => { vs.forEach((row, i) => row.forEach((v, j) => { grid[r - 1 + i][c - 1 + j] = v; })); return rg; },
        setNumberFormat: (f) => { fmts.push(f); return rg; },
      };
      return rg;
    },
  };
  const ss = { getSheetByName: (n) => (n === 'Seller Terms' ? sheet : null) };
  assert.equal(H.migrateSellerTermsPaymentSource_(ss), 2);
  assert.deepEqual(grid[0], js(H.getColumnNames_('Seller Terms')));
  assert.deepEqual(grid[1].slice(0, 3).concat(grid[1].slice(4, 7)), ['CUS001', 'PAYPAL', 'DITECH', fromDate, '', 'seed']);
  assert.equal(grid[1][3], 0.08, 'rate preserved');
  assert.equal(grid[2][1], 'PAYPAL');
  assert.equal(grid[3][1], '', 'blank rows stay blank');
  assert.equal(H.migrateSellerTermsPaymentSource_(ss), 0, 'already v14: no-op');
});
