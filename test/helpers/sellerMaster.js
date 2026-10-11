// Master accounting fixtures for seller-output tests (fake data). Balances mirror normalizeSellerBalances:
// AVAILABLE seller amounts + APPLIED adjustments - SENT/CONFIRMED payouts; hold = AVAILABLE seller hold - releases.
'use strict';

/**
 * @param {function(string): Date} D Date factory in the Apps Script realm
 * @param {{sellers: Array, txs: Array, settlements?: Array, payouts?: Array, adjustments?: Array, disputes?: Array, terms?: Array}} spec
 */
function makeMaster(D, spec) {
  const transactions = [];
  const matches = [];
  const legs = [];
  spec.txs.forEach((x) => {
    const source = x.source || 'PAYPAL';
    transactions.push({ internal_transaction_id: x.id, created_at: D(x.created || '2026-10-02T15:00:00Z'), payment_source: source, seller_id: x.seller,
      store_domain: 'shop.example', sub_account: x.sub || 'SUB-1', order_id: 'O-' + x.id, order_amount: x.order, currency: 'USD',
      customer: 'buyer@example.com', endpoint_token: 'glk_secret' + x.seller, ownership_status: 'MAPPED' });
    const status = x.status || 'MATCHED';
    matches.push({ match_id: 'PM-' + x.id, payment_source: source, internal_transaction_id: x.id,
      external_transaction_id: status === 'MISSING_PROVIDER' ? '' : x.id, provider_id: status === 'MISSING_PROVIDER' ? '' : (x.provider || 'KH001'),
      reconciliation_status: status, match_status: status === 'MATCHED' ? 'CONFIRMED' : '',
      provider_gross_amount: status === 'MISSING_PROVIDER' ? '' : (x.providerGross !== undefined ? x.providerGross : x.order),
      amount_difference: status === 'MISSING_PROVIDER' ? '' : (x.providerGross !== undefined ? x.providerGross - x.order : 0) });
    if (status === 'MATCHED' && x.leg) {
      const l = x.leg;
      const gross = l.gross !== undefined ? l.gross : x.order;
      const net = Math.round((gross - l.fee) * 100) / 100;
      const known = l.unknownHold !== true;
      const hold = known ? net * (l.holdRate === undefined ? 0.1 : l.holdRate) : '';
      const sellerFee = net * l.rate;
      legs.push({ payment_leg_id: 'PL-' + x.id, match_id: 'PM-' + x.id, internal_transaction_id: x.id, payment_source: source, provider: x.provider || 'KH001',
        external_transaction_id: x.id, currency: 'USD', gross_amount: gross, processing_fee: l.fee, net_amount: net,
        provider_fee_rate: known ? 0.07 : '', provider_fee: known ? net * 0.07 : '', provider_hold_rate: known ? 0.1 : '', provider_hold_amount: hold,
        seller_fee_rate: l.rate, seller_fee: sellerFee, seller_hold_rate: known ? 0.1 : '', seller_hold_amount: hold,
        seller_available_amount: known ? net - sellerFee - hold : '', settlement_id: l.settlement || '', settlement_status: l.status || 'AVAILABLE' });
    }
  });
  const payouts = spec.payouts || [];
  const adjustments = spec.adjustments || [];
  const micro = (v) => (typeof v === 'number' ? Math.round(v * 1e6) : 0);
  const balances = spec.sellers.map((s) => {
    const own = legs.filter((l) => transactions.find((t) => t.internal_transaction_id === l.internal_transaction_id).seller_id === s.seller_id &&
      l.settlement_status === 'AVAILABLE');
    const settled = own.reduce((a, l) => a + micro(l.seller_available_amount), 0);
    const hold = own.reduce((a, l) => a + micro(l.seller_hold_amount), 0);
    const adj = adjustments.filter((a) => a.seller_id === s.seller_id && a.status === 'APPLIED');
    const released = adj.filter((a) => a.adjustment_type === 'HOLD_RELEASE').reduce((a, x) => a + micro(x.amount), 0);
    const adjTotal = adj.reduce((a, x) => a + micro(x.amount), 0);
    const paid = payouts.filter((p) => p.seller_id === s.seller_id && ['SENT', 'CONFIRMED'].includes(p.status)).reduce((a, p) => a + micro(p.amount), 0);
    const current = (settled + adjTotal - paid) / 1e6;
    return { seller_id: s.seller_id, currency: 'USD', settled_amount: settled / 1e6, available_amount: current, paid_amount: paid / 1e6,
      seller_hold_balance: (hold - released) / 1e6, adjustments: adjTotal / 1e6, current_balance: current };
  }).filter((b) => b.settled_amount !== 0 || b.current_balance !== 0 || b.seller_hold_balance !== 0);
  return {
    transactions, matches, legs, balances, payouts, adjustments,
    settlements: spec.settlements || [{ settlement_id: 'ST-1', source_settlement_number: 1, period_start_date: D('2026-10-01T04:00:00Z'),
      period_end_date: D('2026-10-04T04:00:00Z'), source_payment_date: D('2026-10-06T04:00:00Z'), hold_release_due_from_date: '', hold_release_due_to_date: '' }],
    disputes: spec.disputes || [],
    sellerTerms: spec.terms || spec.sellers.map((s) => ({ seller_id: s.seller_id, payment_source: 'PAYPAL', seller_fee_rate: 0.08, effective_from: '2026-10-01', effective_to: '' })),
    masterSchemaVersion: 14,
  };
}

/** CUS002 / HUI with the production totals: 74 MATCHED+AVAILABLE PAYPAL legs, 69 MISSING_PROVIDER. */
function huiSpec() {
  const txs = [];
  const split = (total, n) => { const base = Math.floor(total / n); return Array.from({ length: n }, (_x, i) => (i < n - 1 ? base : total - base * (n - 1))); };
  const gross = split(386051, 74);
  const fees = split(15631, 74);
  gross.forEach((g, i) => txs.push({ id: 'HUI-M' + String(i).padStart(3, '0'), seller: 'CUS002', order: g / 100,
    leg: { fee: fees[i] / 100, rate: 0.08, settlement: 'ST-1', status: 'AVAILABLE' } }));
  split(350176, 69).forEach((o, i) => txs.push({ id: 'HUI-X' + String(i).padStart(3, '0'), seller: 'CUS002', order: o / 100, status: 'MISSING_PROVIDER',
    created: '2026-10-08T15:00:00Z' }));
  return { sellers: [{ seller_id: 'CUS002', seller_name: 'HUI' }], txs };
}

module.exports = { makeMaster, huiSpec };
