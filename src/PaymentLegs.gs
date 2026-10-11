/**
 * PaymentLegs.gs
 * Payment Legs: one leg per CONFIRMED MATCHED Payment Match, with KH001 actual provider
 * economics and canonical settlement membership. No seller economics, refunds or disputes.
 *
 * - Eligible: Payment Matches with reconciliation_status = MATCHED and match_status = CONFIRMED.
 *   Only provider KH001 / PAYPAL is supported; any other eligible provider/source fails.
 * - payment_leg_id = PL-<sha256(payment_source|external_transaction_id)>.
 * - Base values (currency, gross, processing fee, net, created_at = transaction_at) come from the
 *   exact Provider Transactions row named by the match; source/id/provider must agree.
 * - RECONCILED KH001 transactions: exactly one Raw KH001 Reconciled row (exact Transaction ID);
 *   gross / PayPal fee / net must equal Provider Transactions (< 0.005); provider_fee = "Phí thuê
 *   OP", provider_hold_amount = "Hold" (actual, authoritative, never from Settings); rates are
 *   derived amount / net (blank when net = 0); net - fee - hold = "Thực nhận" (< 0.005).
 *   "Lần chốt (ngày)" (provider timezone date key) resolves to exactly one KH001 Settlements row
 *   by period_end_date -> settlement_id; blank date -> WAITING_SETTLEMENT. With a settlement the leg is
 *   SETTLED, and AVAILABLE only when the provider has fully paid it (Phase 2J): source_payment_date set,
 *   source_paid_amount >= total_due_amount - 0.005 and outstanding_amount <= 0.005.
 * - Frozen Settlement Items guard (Phase 2J): a leg that already has a frozen Settlement Item must stay
 *   AVAILABLE with identical economics; any divergence fails before Payment Legs is written.
 * - Not yet RECONCILED: base values only, provider economics and settlement blank, WAITING_SETTLEMENT.
 * - Per-settlement aggregates of legs must equal the Settlements header (counts, gross, fee, net,
 *   provider fee, provider hold, derived transaction payout).
 * - Seller economics (Phase 2I): the leg's internal Transaction (exact payment_source +
 *   internal_transaction_id) must be MAPPED to a seller; seller_fee_rate comes from the Seller Terms
 *   row in effect on the transaction's created date (Master timezone); seller_fee = net x rate
 *   (unrounded). With actual provider economics: seller_hold_amount = provider_hold_amount (KH001
 *   MIRROR_PROVIDER, 1:1), seller_hold_rate = hold / net, seller_available_amount = net - seller_fee -
 *   seller_hold_amount. Without actual provider hold, seller hold / available stay blank (never estimated).
 *   system_margin = seller_fee - provider_fee (reported, not stored).
 * - Refund/dispute fields stay blank (blank = not computed, not zero).
 * - Upstream freshness gates: Transactions, Provider Transactions KH001, Payment Matches and
 *   Settlements KH001 must all be current and Seller Terms valid. Writes only Payment Legs (SafeSwap)
 *   and Audit Log.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

/** Leg fields frozen in a Settlement Item; a fresh leg must keep them identical. */
const FROZEN_LEG_FIELDS = Object.freeze(['settlement_id', 'internal_transaction_id', 'payment_source', 'external_transaction_id',
  'currency', 'gross_amount', 'processing_fee', 'net_amount', 'provider_fee_rate', 'provider_fee', 'provider_hold_rate',
  'provider_hold_amount', 'seller_fee_rate', 'seller_fee', 'seller_hold_rate', 'seller_hold_amount', 'seller_available_amount']);

const PAYMENT_LEGS = Object.freeze({
  idPrefix: 'PL-',
  supported: [{ provider: 'KH001', paymentSource: 'PAYPAL' }],
  reconciledHeaderRow: 6,
  reconciledHeaders: ['Transaction ID', 'Trạng thái', 'Doanh thu (Gross)', 'Phí PayPal', 'Net', 'Phí thuê OP', 'Hold',
    'Lần chốt (ngày)', 'Thực nhận (chưa gồm hoàn hold)'],
  amountToleranceMicros: 5000,   // < 0.005 for currency amounts
  economicsToleranceMicros: 50,  // < 0.00005 for unrounded provider fee / hold / payout aggregates
  maxReportedErrors: 30,
});

/** Current production regression (after Phase 2G). Report only. */
const PAYMENT_LEGS_REGRESSION = Object.freeze({
  snapshot: 'Production after Phase 2G (168 confirmed KH001 matches)',
  payment_leg_rows: 168,
  payment_source_counts: { PAYPAL: 168 },
  provider_counts: { KH001: 168 },
  settlement_counts: { 'ST-KH001-PAYPAL-000001': 94, 'ST-KH001-PAYPAL-000002': 74 },
  status_counts: { AVAILABLE: 168 },
  gross_total: 10627.62,
  processing_fee_total: 420.24,
  net_total: 10207.38,
  provider_fee_total: 714.5166,
  provider_hold_total: 1020.738,
  provider_transaction_payout_total: 8472.1254,
  provider_fee_rate_counts: { '7.00%': 168 },
  provider_hold_rate_counts: { '10.00%': 168 },
  seller_fee_rate_counts: { '8.00%': 168 },
  seller_hold_rate_counts: { '10.00%': 168 },
  seller_fee_total: 816.5904,
  seller_hold_total: 1020.738,
  seller_available_total: 8370.0516,
  system_margin_total: 102.0738,
  by_seller: {
    CUS001: { count: 43, net: 2340.73, seller_fee: 187.2584, seller_hold: 234.073, seller_available: 1919.3986, system_margin: 23.4073 },
    CUS002: { count: 74, net: 3704.2, seller_fee: 296.336, seller_hold: 370.42, seller_available: 3037.444, system_margin: 37.042 },
    CUS003: { count: 4, net: 313.13, seller_fee: 25.0504, seller_hold: 31.313, seller_available: 256.7666, system_margin: 3.1313 },
    CUS004: { count: 47, net: 3849.32, seller_fee: 307.9456, seller_hold: 384.932, seller_available: 3156.4424, system_margin: 38.4932 },
  },
});

/* ----------------------------- Pure helpers ----------------------------- */

function paymentLegId_(paymentSource, externalTransactionId, digestHex) {
  const digest = digestHex || sha256Hex_;
  return PAYMENT_LEGS.idPrefix + digest(String(paymentSource) + '|' + String(externalTransactionId));
}

function microsDiff_(a, b) {
  return Math.abs(Math.round((a - b) * 1e6));
}

function emptyLegErrors_() {
  return { duplicate_leg_keys: [], missing_provider_transactions: [], unsupported: [], provider_amount_mismatches: [],
    provider_economics_errors: [], settlement_resolution_errors: [], settlement_aggregate_errors: [], seller_economics_errors: [],
    frozen_item_conflicts: [] };
}

function flattenLegErrors_(errors) {
  return Object.keys(errors).reduce(function (acc, k) { return acc.concat(errors[k]); }, []);
}

/**
 * Builds Payment Legs (objects, updated_at blank).
 * @param {{matches: Array<Object>, providerTransactions: Array<Object>, reconciledValues: Array<Array<*>>,
 *          settlements: Array<Object>, transactions: Array<Object>, sellerTerms: Array<Object>,
 *          providerDateKeyOf: function(*): string, settlementDateKeyOf: function(*): string,
 *          transactionDateKeyOf: function(*): string, digestHex?: Function}} input
 *   settlements: stored Settlements rows (objects, all providers); dates are Master date values.
 *   sellerTerms: parsed Seller Terms (parseSellerTerms_().terms).
 *   frozenItems: existing Settlement Items rows (objects), optional.
 */
function buildPaymentLegs_(input) {
  const errors = emptyLegErrors_();
  const eligible = input.matches.filter(function (m) {
    return m.reconciliation_status === 'MATCHED' && m.match_status === 'CONFIRMED';
  });

  // Uniqueness guards.
  const keyCount = function (rows, idField) {
    const counts = {};
    rows.forEach(function (r) { const k = String(r.payment_source) + '|' + String(r[idField]); counts[k] = (counts[k] || 0) + 1; });
    return Object.keys(counts).filter(function (k) { return counts[k] > 1; }).sort();
  };
  keyCount(eligible, 'external_transaction_id').forEach(function (k) { errors.duplicate_leg_keys.push('eligible Payment Matches key ' + k); });
  keyCount(input.providerTransactions, 'external_transaction_id').forEach(function (k) { errors.duplicate_leg_keys.push('Provider Transactions key ' + k); });
  const ptById = {};
  input.providerTransactions.forEach(function (p) { ptById[String(p.provider_transaction_id)] = p; });
  const txByKey = {};
  (input.transactions || []).forEach(function (t) { txByKey[String(t.payment_source) + '|' + String(t.internal_transaction_id)] = t; });
  const legSellers = {};

  // Raw KH001 Reconciled index (exact Transaction ID).
  let rc = null;
  const rcById = {};
  if (input.reconciledValues.length >= PAYMENT_LEGS.reconciledHeaderRow) {
    rc = buildHeaderMap_(input.reconciledValues[PAYMENT_LEGS.reconciledHeaderRow - 1], PAYMENT_LEGS.reconciledHeaders, 'Raw KH001 Reconciled');
    for (let r = PAYMENT_LEGS.reconciledHeaderRow; r < input.reconciledValues.length; r++) {
      const id = canonicalText_(input.reconciledValues[r][rc[normalizeLabel_('Transaction ID')]]);
      if (id !== '') (rcById[id] = rcById[id] || []).push(r);
    }
  }
  const rcVal = function (rowIdx, name) { return input.reconciledValues[rowIdx][rc[normalizeLabel_(name)]]; };

  // KH001 settlements by provider date key of period_end_date.
  const settlementsByDate = {};
  const kh001Settlements = input.settlements.filter(function (s) { return s.provider_id === 'KH001' && s.payment_source === 'PAYPAL'; });
  kh001Settlements.forEach(function (s) {
    const key = input.settlementDateKeyOf(s.period_end_date);
    (settlementsByDate[key] = settlementsByDate[key] || []).push(s);
  });

  const legs = [];
  eligible.forEach(function (m) {
    const label = 'Match ' + m.payment_source + '|' + m.external_transaction_id;
    const pt = ptById[String(m.provider_transaction_id)];
    if (!pt) { errors.missing_provider_transactions.push(label + ': Provider Transaction ' + m.provider_transaction_id + ' not found'); return; }
    if (pt.payment_source !== m.payment_source || String(pt.external_transaction_id) !== String(m.external_transaction_id) ||
        pt.provider_id !== m.provider_id) {
      errors.missing_provider_transactions.push(label + ': Provider Transaction ' + m.provider_transaction_id + ' does not agree on source / id / provider');
      return;
    }
    const supported = PAYMENT_LEGS.supported.some(function (s) { return s.provider === pt.provider_id && s.paymentSource === pt.payment_source; });
    if (!supported) { errors.unsupported.push(label + ': provider ' + pt.provider_id + ' / ' + pt.payment_source + ' is not supported for Payment Legs yet'); return; }

    const leg = {
      payment_leg_id: paymentLegId_(pt.payment_source, pt.external_transaction_id, input.digestHex),
      match_id: m.match_id, internal_transaction_id: m.internal_transaction_id, payment_source: pt.payment_source,
      provider: pt.provider_id, external_transaction_id: pt.external_transaction_id, currency: pt.currency,
      gross_amount: pt.gross_amount, processing_fee: pt.processing_fee, net_amount: pt.net_amount,
      provider_fee_rate: '', provider_fee: '', provider_hold_rate: '', provider_hold_amount: '',
      seller_fee_rate: '', seller_fee: '', seller_hold_rate: '', seller_hold_amount: '', seller_available_amount: '',
      refund_amount: '', dispute_amount: '', dispute_fee: '',
      settlement_id: '', settlement_status: 'WAITING_SETTLEMENT', created_at: pt.transaction_at, updated_at: '',
    };

    if (pt.provider_reconciliation_status === 'RECONCILED') {
      if (!rc) { errors.provider_economics_errors.push(label + ': Raw KH001 Reconciled has no header row'); return; }
      const rows = rcById[String(pt.external_transaction_id)] || [];
      if (rows.length !== 1) { errors.provider_economics_errors.push(label + ': expected exactly 1 Raw KH001 Reconciled row, found ' + rows.length); return; }
      const r = rows[0];
      let status;
      try { status = mapKh001ReconciliationStatus_(rcVal(r, 'Trạng thái')); } catch (e) { errors.provider_economics_errors.push(label + ': ' + e.message); return; }
      if (status !== 'RECONCILED') { errors.provider_economics_errors.push(label + ': Raw KH001 Reconciled status is ' + status); return; }
      const v = {};
      let bad = false;
      [['gross', 'Doanh thu (Gross)'], ['fee', 'Phí PayPal'], ['net', 'Net'], ['providerFee', 'Phí thuê OP'], ['hold', 'Hold'],
        ['payout', 'Thực nhận (chưa gồm hoàn hold)']].forEach(function (f) {
        const x = rcVal(r, f[1]);
        if (!isFiniteNumber_(x)) { errors.provider_economics_errors.push(label + ': non-numeric ' + f[1]); bad = true; }
        v[f[0]] = x;
      });
      if (bad) return;
      const mismatches = [];
      if (microsDiff_(v.gross, pt.gross_amount) >= PAYMENT_LEGS.amountToleranceMicros) mismatches.push('gross ' + v.gross + ' vs ' + pt.gross_amount);
      if (microsDiff_(v.fee, pt.processing_fee) >= PAYMENT_LEGS.amountToleranceMicros) mismatches.push('processing fee ' + v.fee + ' vs ' + pt.processing_fee);
      if (microsDiff_(v.net, pt.net_amount) >= PAYMENT_LEGS.amountToleranceMicros) mismatches.push('net ' + v.net + ' vs ' + pt.net_amount);
      if (mismatches.length > 0) { errors.provider_amount_mismatches.push(label + ': ' + mismatches.join('; ')); return; }
      if (v.providerFee < 0 || v.hold < 0) { errors.provider_economics_errors.push(label + ': negative provider fee or hold'); return; }
      if (microsDiff_(pt.net_amount - v.providerFee - v.hold, v.payout) >= PAYMENT_LEGS.amountToleranceMicros) {
        errors.provider_economics_errors.push(label + ': net - provider fee - hold != Thực nhận (' + pt.net_amount + ' - ' + v.providerFee +
          ' - ' + v.hold + ' != ' + v.payout + ')');
        return;
      }
      leg.provider_fee = v.providerFee;
      leg.provider_hold_amount = v.hold;
      if (isFiniteNumber_(pt.net_amount) && pt.net_amount !== 0) {
        leg.provider_fee_rate = v.providerFee / pt.net_amount;
        leg.provider_hold_rate = v.hold / pt.net_amount;
      }
      const rawDate = rcVal(r, 'Lần chốt (ngày)');
      if (!isBlankCell_(rawDate)) {
        let key;
        try { key = input.providerDateKeyOf(rawDate); } catch (e) { errors.settlement_resolution_errors.push(label + ': Lần chốt (ngày) ' + e.message); return; }
        const found = settlementsByDate[key] || [];
        if (found.length !== 1) {
          errors.settlement_resolution_errors.push(label + ': settlement date ' + key + ' resolves to ' + found.length + ' KH001 settlement(s)');
          return;
        }
        leg.settlement_id = found[0].settlement_id;
        leg.settlement_status = isSettlementProviderPaid_(found[0]) ? 'AVAILABLE' : 'SETTLED';
      }
    }

    // Seller economics: exact internal transaction -> seller -> effective Seller Terms.
    const tx = txByKey[String(m.payment_source) + '|' + String(m.internal_transaction_id)];
    if (!tx) { errors.seller_economics_errors.push(label + ': internal Transaction ' + m.internal_transaction_id + ' not found'); return; }
    if (tx.ownership_status !== 'MAPPED' || trimmedText_(tx.seller_id) === '') {
      errors.seller_economics_errors.push(label + ': internal Transaction ' + m.internal_transaction_id + ' is not assigned to a seller');
      return;
    }
    const sellerId = trimmedText_(tx.seller_id);
    let term;
    try {
      term = resolveSellerTerm_(input.sellerTerms || [], sellerId, input.transactionDateKeyOf(tx.created_at));
    } catch (e) {
      errors.seller_economics_errors.push(label + ': ' + e.message);
      return;
    }
    leg.seller_fee_rate = term.seller_fee_rate;
    if (isFiniteNumber_(leg.net_amount)) leg.seller_fee = leg.net_amount * term.seller_fee_rate;
    if (isFiniteNumber_(leg.provider_hold_amount) && isFiniteNumber_(leg.seller_fee)) {
      leg.seller_hold_amount = leg.provider_hold_amount; // KH001 MIRROR_PROVIDER: exact provider hold
      leg.seller_hold_rate = leg.net_amount !== 0 ? leg.provider_hold_amount / leg.net_amount : '';
      leg.seller_available_amount = leg.net_amount - leg.seller_fee - leg.seller_hold_amount;
    }
    legSellers[leg.payment_leg_id] = sellerId;
    legs.push(leg);
  });

  const legKeys = keyCount(legs, 'external_transaction_id');
  legKeys.forEach(function (k) { errors.duplicate_leg_keys.push('Payment Legs key ' + k); });
  const ids = {};
  legs.forEach(function (l) { if (ids[l.payment_leg_id]) errors.duplicate_leg_keys.push('payment_leg_id ' + l.payment_leg_id); ids[l.payment_leg_id] = true; });

  errors.settlement_aggregate_errors = checkSettlementAggregates_(legs, kh001Settlements);
  errors.frozen_item_conflicts = checkLegsAgainstFrozenItems_(legs, input.frozenItems || []);
  legs.sort(function (a, b) {
    return compareCanonicalValues_(a.payment_source, b.payment_source) ||
      compareCanonicalValues_(String(a.external_transaction_id), String(b.external_transaction_id));
  });
  return { legs: legs, errors: errors, legSellers: legSellers, stats: { eligible_match_rows: eligible.length } };
}

/**
 * Provider-paid rule: payment date present, paid / due / outstanding numeric, paid covers the total
 * due (within 0.005) and nothing is outstanding (<= 0.005). Membership alone is not availability.
 */
function isSettlementProviderPaid_(s) {
  if (isBlankCell_(s.source_payment_date)) return false;
  if (!isFiniteNumber_(s.source_paid_amount) || !isFiniteNumber_(s.total_due_amount) || !isFiniteNumber_(s.outstanding_amount)) return false;
  return Math.round((s.source_paid_amount - s.total_due_amount) * 1e6) >= -5000 && Math.round(s.outstanding_amount * 1e6) <= 5000;
}

/** Fresh legs must agree with already frozen Settlement Items (same economics, still AVAILABLE). */
function checkLegsAgainstFrozenItems_(legs, frozenItems) {
  const errors = [];
  const byLeg = {};
  legs.forEach(function (l) { byLeg[l.payment_leg_id] = l; });
  frozenItems.forEach(function (item) {
    const leg = byLeg[String(item.payment_leg_id)];
    const label = 'Settlement Item ' + item.settlement_item_id;
    if (!leg) { errors.push(label + ': its Payment Leg ' + item.payment_leg_id + ' is no longer produced'); return; }
    if (leg.settlement_status !== 'AVAILABLE') { errors.push(label + ': Payment Leg would become ' + leg.settlement_status); return; }
    const changed = FROZEN_LEG_FIELDS.filter(function (f) { return serializeCell_(leg[f]) !== serializeCell_(item[f]); });
    if (changed.length > 0) errors.push(label + ': fresh Payment Leg differs from the frozen item in ' + changed.join(', '));
  });
  return errors;
}

/** Aggregates legs per settlement_id and compares with the KH001 Settlements headers. */
function checkSettlementAggregates_(legs, settlements) {
  const errors = [];
  const agg = {};
  legs.forEach(function (l) {
    if (!l.settlement_id) return;
    const a = agg[l.settlement_id] = agg[l.settlement_id] || { count: 0, gross: 0, fee: 0, net: 0, providerFee: 0, hold: 0 };
    a.count++; a.gross += l.gross_amount; a.fee += l.processing_fee; a.net += l.net_amount;
    a.providerFee += l.provider_fee; a.hold += l.provider_hold_amount;
  });
  const n = function (v) { return isFiniteNumber_(v) ? v : 0; };
  settlements.forEach(function (s) {
    const a = agg[s.settlement_id] || { count: 0, gross: 0, fee: 0, net: 0, providerFee: 0, hold: 0 };
    const label = s.settlement_id;
    const cmp = function (name, got, want, tol) {
      if (microsDiff_(got, want) >= tol) errors.push(label + ': legs ' + name + ' ' + fmt4_(got) + ' != settlement ' + fmt4_(want));
    };
    if (a.count !== n(s.transaction_count)) errors.push(label + ': legs count ' + a.count + ' != settlement transaction_count ' + s.transaction_count);
    cmp('gross', a.gross, n(s.gross_amount), PAYMENT_LEGS.amountToleranceMicros);
    cmp('processing fee', a.fee, n(s.processing_fee_amount), PAYMENT_LEGS.amountToleranceMicros);
    cmp('net', a.net, n(s.net_amount), PAYMENT_LEGS.amountToleranceMicros);
    cmp('provider fee', a.providerFee, n(s.provider_fee_amount), PAYMENT_LEGS.economicsToleranceMicros);
    cmp('provider hold', a.hold, n(s.provider_hold_created_amount), PAYMENT_LEGS.economicsToleranceMicros);
    cmp('transaction payout', a.net - a.providerFee - a.hold, n(s.transaction_payout_amount), PAYMENT_LEGS.economicsToleranceMicros);
    delete agg[s.settlement_id];
  });
  Object.keys(agg).forEach(function (id) { errors.push(id + ': legs reference a settlement that is not a KH001 settlement'); });
  return errors;
}

/** Row content without updated_at. */
function paymentLegContentKey_(row, columns) {
  return serializeRow_(columns.map(function (c) { return c === 'updated_at' ? '' : row[c]; }));
}

/** updated_at kept for unchanged legs, now for new/changed ones; disappearing legs are errors. */
function mergePaymentLegTimestamps_(freshLegs, existingLegs, now, columns) {
  const existing = {};
  existingLegs.forEach(function (e) { existing[String(e.payment_leg_id)] = e; });
  const seen = {};
  const legs = freshLegs.map(function (f) {
    seen[f.payment_leg_id] = true;
    const e = existing[f.payment_leg_id];
    const row = Object.assign({}, f);
    row.updated_at = e && !isBlankCell_(e.updated_at) && paymentLegContentKey_(e, columns) === paymentLegContentKey_(f, columns)
      ? e.updated_at : now;
    return row;
  });
  const disappeared = Object.keys(existing).filter(function (id) { return !seen[id]; }).sort();
  return { legs: legs, errors: disappeared.map(function (id) { return 'Existing Payment Leg ' + id + ' is no longer produced'; }) };
}

/** Generic summary of Payment Legs (no snapshot-specific numbers). legSellers: payment_leg_id -> seller_id. */
function summarizePaymentLegs_(legs, legSellers) {
  const tally = function (keyOf) {
    return legs.reduce(function (acc, l) { const k = keyOf(l); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  };
  const sumMicros = function (field) {
    return legs.reduce(function (acc, l) { return acc + (isFiniteNumber_(l[field]) ? Math.round(l[field] * 1e6) : 0); }, 0) / 1e6;
  };
  const withEconomics = legs.filter(function (l) { return isFiniteNumber_(l.provider_fee); });
  const pct = function (v) { return isFiniteNumber_(v) ? (Math.round(v * 10000) / 100).toFixed(2) + '%' : '(blank)'; };
  return {
    payment_leg_rows: legs.length,
    waiting_settlement_rows: legs.filter(function (l) { return l.settlement_status === 'WAITING_SETTLEMENT'; }).length,
    settled_rows: legs.filter(function (l) { return l.settlement_status === 'SETTLED'; }).length,
    available_rows: legs.filter(function (l) { return l.settlement_status === 'AVAILABLE'; }).length,
    status_counts: tally(function (l) { return l.settlement_status; }),
    provider_counts: tally(function (l) { return l.provider; }),
    payment_source_counts: tally(function (l) { return l.payment_source; }),
    currency_counts: tally(function (l) { return l.currency; }),
    settlement_counts: tally(function (l) { return l.settlement_id || '(none)'; }),
    gross_total: sumMicros('gross_amount'),
    processing_fee_total: sumMicros('processing_fee'),
    net_total: sumMicros('net_amount'),
    provider_fee_total: sumMicros('provider_fee'),
    provider_hold_total: sumMicros('provider_hold_amount'),
    provider_transaction_payout_total: withEconomics.reduce(function (acc, l) {
      return acc + Math.round((l.net_amount - l.provider_fee - l.provider_hold_amount) * 1e6);
    }, 0) / 1e6,
    actual_economics_rows: withEconomics.length,
    unreconciled_provider_rows: legs.length - withEconomics.length,
    provider_fee_rate_counts: tally(function (l) { return pct(l.provider_fee_rate); }),
    provider_hold_rate_counts: tally(function (l) { return pct(l.provider_hold_rate); }),
    seller_fee_rate_counts: tally(function (l) { return pct(l.seller_fee_rate); }),
    seller_hold_rate_counts: tally(function (l) { return pct(l.seller_hold_rate); }),
    seller_fee_total: sumMicros('seller_fee'),
    seller_hold_total: sumMicros('seller_hold_amount'),
    seller_available_total: sumMicros('seller_available_amount'),
    system_margin_total: withEconomics.reduce(function (acc, l) {
      return acc + (isFiniteNumber_(l.seller_fee) ? Math.round((l.seller_fee - l.provider_fee) * 1e6) : 0);
    }, 0) / 1e6,
    seller_hold_mismatches: withEconomics.filter(function (l) {
      return !isFiniteNumber_(l.seller_hold_amount) || microsDiff_(l.seller_hold_amount, l.provider_hold_amount) !== 0;
    }).map(function (l) { return l.payment_leg_id; }),
    seller_available_equation_errors: legs.filter(function (l) {
      return isFiniteNumber_(l.seller_available_amount) &&
        microsDiff_(l.seller_available_amount, l.net_amount - l.seller_fee - l.seller_hold_amount) !== 0;
    }).map(function (l) { return l.payment_leg_id; }),
    by_seller: summarizeLegsBySeller_(legs, legSellers || {}),
  };
}

/** Per seller: count, net, seller fee / hold / available, system margin (micro-unit sums). */
function summarizeLegsBySeller_(legs, legSellers) {
  const out = {};
  const add = function (o, k, v) { o[k] += isFiniteNumber_(v) ? Math.round(v * 1e6) : 0; };
  legs.forEach(function (l) {
    const id = legSellers[l.payment_leg_id] || '(unknown)';
    const o = out[id] = out[id] || { count: 0, net: 0, seller_fee: 0, seller_hold: 0, seller_available: 0, system_margin: 0 };
    o.count++;
    add(o, 'net', l.net_amount); add(o, 'seller_fee', l.seller_fee); add(o, 'seller_hold', l.seller_hold_amount);
    add(o, 'seller_available', l.seller_available_amount);
    if (isFiniteNumber_(l.seller_fee) && isFiniteNumber_(l.provider_fee)) o.system_margin += Math.round((l.seller_fee - l.provider_fee) * 1e6);
  });
  Object.keys(out).forEach(function (id) {
    ['net', 'seller_fee', 'seller_hold', 'seller_available', 'system_margin'].forEach(function (k) { out[id][k] = out[id][k] / 1e6; });
  });
  return out;
}

function evaluatePaymentLegsRegression_(summary) {
  const exp = PAYMENT_LEGS_REGRESSION;
  const checks = [];
  const add = function (n, e, a, pass) { checks.push({ name: n, expected: e, actual: a, pass: pass }); };
  const same = function (e, a) {
    return Object.keys(e).every(function (k) { return (a[k] || 0) === e[k]; }) &&
      Object.keys(a).every(function (k) { return Object.prototype.hasOwnProperty.call(e, k); });
  };
  add('payment_leg_rows', exp.payment_leg_rows, summary.payment_leg_rows, summary.payment_leg_rows === exp.payment_leg_rows);
  ['payment_source_counts', 'provider_counts', 'settlement_counts', 'status_counts', 'provider_fee_rate_counts',
    'provider_hold_rate_counts', 'seller_fee_rate_counts', 'seller_hold_rate_counts'].forEach(function (k) {
    add(k, exp[k], summary[k], same(exp[k], summary[k] || {}));
  });
  ['seller_fee_total', 'seller_hold_total', 'seller_available_total', 'system_margin_total'].forEach(function (k) {
    add(k, exp[k], summary[k], Math.abs(summary[k] - exp[k]) < 0.00005);
  });
  Object.keys(exp.by_seller).forEach(function (id) {
    const e = exp.by_seller[id];
    const a = (summary.by_seller || {})[id] || {};
    Object.keys(e).forEach(function (k) {
      add('by_seller.' + id + '.' + k, e[k], a[k] === undefined ? null : a[k],
        k === 'count' ? a[k] === e[k] : isFiniteNumber_(a[k]) && Math.abs(a[k] - e[k]) < 0.00005);
    });
  });
  [['gross_total', 0.005], ['processing_fee_total', 0.005], ['net_total', 0.005], ['provider_fee_total', 0.00005],
    ['provider_hold_total', 0.00005], ['provider_transaction_payout_total', 0.00005]].forEach(function (t) {
    add(t[0], exp[t[0]], summary[t[0]], Math.abs(summary[t[0]] - exp[t[0]]) < t[1]);
  });
  return { snapshot: exp.snapshot, pass: checks.every(function (c) { return c.pass; }),
    failed: checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }), checks: checks };
}

/* ---------------------------------- I/O --------------------------------- */

function paymentLegsTab_() {
  return { targetSheet: SHEETS.PAYMENT_LEGS, stagingSheet: '__STAGE_PAYMENT_LEGS' };
}

/** All four upstream canonical inputs; each {current, reason, ...}. Read-only, never throws. */
function readPaymentLegsUpstream_(ss) {
  return {
    transactions: readInternalTransactionsFreshness_(ss),
    provider_transactions: readProviderTransactionsFreshness_(ss),
    payment_matches: readPaymentMatchesFreshness_(ss),
    settlements: readKh001SettlementsFreshness_(ss),
    seller_terms: readSellerTermsValidity_(ss),
  };
}

function readPaymentLegsInputs_(ss) {
  const matches = readSchemaTableObjects_(ss, SHEETS.PAYMENT_MATCHES, paymentMatchesTab_());
  const pt = readSchemaTableObjects_(ss, SHEETS.PROVIDER_TRANSACTIONS, providerTransactionsTab_());
  const settlements = readSchemaTableObjects_(ss, SHEETS.SETTLEMENTS, settlementsTab_());
  const rcSheet = ss.getSheetByName(SHEETS.RAW_KH001_RECONCILED);
  if (!rcSheet) throw new Error('Raw tab "' + SHEETS.RAW_KH001_RECONCILED + '" not found.');
  const timeZone = String(getRequiredSetting_(readSettingsMap_(), KH001_SETTLEMENTS.timezoneSetting));
  const transactions = readSchemaTableObjects_(ss, SHEETS.TRANSACTIONS, transactionsTab_());
  const frozen = readSchemaTableObjects_(ss, SHEETS.SETTLEMENT_ITEMS, settlementItemsTab_());
  return buildPaymentLegs_({
    frozenItems: frozen.rows,
    matches: matches.rows,
    providerTransactions: pt.rows,
    reconciledValues: readSheetGrid_(rcSheet).values,
    settlements: settlements.rows,
    transactions: transactions.rows,
    sellerTerms: readSellerTermsValidity_(ss).terms,
    providerDateKeyOf: function (v) { return providerDateKey_(v, timeZone); },
    settlementDateKeyOf: masterDateKey_,
    transactionDateKeyOf: masterDateKey_,
  });
}

/** Freshness of stored Payment Legs against a fresh build, ignoring only updated_at. */
function checkPaymentLegsFresh_(built, storedValues, columns) {
  const updatedIdx = [columns.indexOf('updated_at')];
  const stored = tableChecksumExcluding_(storedValues, updatedIdx);
  const problems = flattenLegErrors_(built.errors).length;
  if (problems > 0) {
    return { current: false, expected_checksum: null, stored_checksum: stored,
      reason: 'Payment Legs is stale; run normalizePaymentLegs first (Payment Legs input has ' + problems + ' error(s)).' };
  }
  const expected = tableChecksumExcluding_(buildTableValues_(columns, built.legs.map(function (o) { return objectToRow_(o, columns); })), updatedIdx);
  const current = expected === stored;
  return { current: current, expected_checksum: expected, stored_checksum: stored,
    reason: current ? null : 'Payment Legs is stale; run normalizePaymentLegs first.' };
}

/** Read-only freshness of Payment Legs (rebuild from current inputs). Never throws. */
function readPaymentLegsFreshness_(ss) {
  try {
    const built = readPaymentLegsInputs_(ss);
    const stored = readSchemaTableObjects_(ss, SHEETS.PAYMENT_LEGS, paymentLegsTab_());
    return checkPaymentLegsFresh_(built, stored.grid.values, getColumnNames_(SHEETS.PAYMENT_LEGS));
  } catch (err) {
    return { current: false, expected_checksum: null, stored_checksum: null,
      reason: 'Payment Legs is stale; run normalizePaymentLegs first (' + (err && err.message ? err.message : String(err)) + ').' };
  }
}

function throwIfLegErrors_(label, list) {
  if (list.length === 0) return;
  const shown = list.slice(0, PAYMENT_LEGS.maxReportedErrors);
  throw new Error(label + ' (' + list.length + ' error(s)): ' + shown.join(' | ') +
    (list.length > shown.length ? ' | ... ' + (list.length - shown.length) + ' more' : ''));
}

/** Rebuilds Payment Legs under the script lock. Never throws. */
function runPaymentLegsNormalizer_() {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  const details = {};
  let status = 'FAILED';
  let ss = null;
  const tab = paymentLegsTab_();
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms.');
    ss = getSpreadsheet_();
    const recovery = recoverSwapState_(ss, tab);
    details.initial_swap_state = recovery.state;
    details.recovery_actions = recovery.actions;

    const upstream = readPaymentLegsUpstream_(ss);
    Object.keys(upstream).forEach(function (k) { details[k === 'seller_terms' ? 'seller_terms_valid' : k + '_current'] = upstream[k].current; });
    ['transactions', 'provider_transactions', 'payment_matches', 'settlements', 'seller_terms'].forEach(function (k) {
      if (!upstream[k].current) throw new Error(upstream[k].reason);
    });

    const built = readPaymentLegsInputs_(ss);
    details.eligible_match_rows = built.stats.eligible_match_rows;
    throwIfLegErrors_('Payment Legs input is invalid', flattenLegErrors_(built.errors));

    const columns = getColumnNames_(SHEETS.PAYMENT_LEGS);
    const current = readSchemaTableObjects_(ss, SHEETS.PAYMENT_LEGS, tab);
    const merged = mergePaymentLegTimestamps_(built.legs, current.rows, new Date(Math.floor(Date.now() / 1000) * 1000), columns);
    throwIfLegErrors_('Payment Legs would disappear', merged.errors);
    const rows = merged.legs.map(function (o) { return objectToRow_(o, columns); });
    const expected = computeRawChecksum_(buildTableValues_(columns, rows));
    const summary = summarizePaymentLegs_(merged.legs, built.legSellers);
    ['payment_leg_rows', 'status_counts', 'settlement_counts', 'net_total', 'provider_fee_total', 'provider_hold_total',
      'provider_transaction_payout_total', 'seller_fee_total', 'seller_hold_total', 'seller_available_total',
      'system_margin_total'].forEach(function (k) { details[k] = summary[k]; });
    details.payment_legs_checksum = expected;
    if (expected === current.grid.checksum) {
      status = 'NO_CHANGE';
    } else {
      writeCanonicalTable_(ss, getTableSchema_(SHEETS.PAYMENT_LEGS), tab, rows);
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
      appendAuditLog_({ action: 'PAYMENT_LEGS_NORMALIZE_' + status, entityType: 'PAYMENT_LEGS', entityId: '',
        newStatus: status, details: redactDeep_(details) });
    } catch (auditErr) {
      Logger.log('Failed to write audit entry: %s', auditErr);
    }
    if (locked) lock.releaseLock();
  }
  return redactDeep_(Object.assign({ status: status }, details));
}

/** Read-only verification of Payment Legs. */
function buildPaymentLegsReport_() {
  const report = {
    eligible_match_rows: 0, payment_leg_rows: 0, waiting_settlement_rows: 0, settled_rows: 0, available_rows: 0,
    provider_counts: {}, payment_source_counts: {}, currency_counts: {}, gross_total: 0, processing_fee_total: 0, net_total: 0,
    provider_fee_total: 0, provider_hold_total: 0, provider_transaction_payout_total: 0, actual_economics_rows: 0,
    unreconciled_provider_rows: 0, settlement_counts: {}, duplicate_leg_keys: [], missing_provider_transactions: [],
    unsupported_providers: [], provider_amount_mismatches: [], provider_economics_errors: [], settlement_resolution_errors: [],
    settlement_aggregate_errors: [], disappearing_payment_legs: [], transactions_current: false,
    provider_transactions_current: false, payment_matches_current: false, settlements_current: false, seller_terms_valid: false,
    seller_economics_errors: [], seller_fee_total: 0, seller_hold_total: 0, seller_available_total: 0, system_margin_total: 0,
    seller_hold_mismatches: [], seller_available_equation_errors: [], by_seller: {}, frozen_item_conflicts: [],
    payment_legs_match: false, swap_state: null, pass: false, errors: [], warnings: [], regression: null,
  };
  try {
    const ss = getSpreadsheet_();
    const tab = paymentLegsTab_();
    report.swap_state = detectSwapState_(ss, tab).state;
    if (report.swap_state !== 'NORMAL') report.errors.push('Payment Legs swap state is ' + report.swap_state);
    const upstream = readPaymentLegsUpstream_(ss);
    Object.keys(upstream).forEach(function (k) {
      report[k === 'seller_terms' ? 'seller_terms_valid' : k + '_current'] = upstream[k].current;
      if (!upstream[k].current) report.errors.push(upstream[k].reason);
    });

    const built = readPaymentLegsInputs_(ss);
    report.eligible_match_rows = built.stats.eligible_match_rows;
    report.duplicate_leg_keys = built.errors.duplicate_leg_keys;
    report.missing_provider_transactions = built.errors.missing_provider_transactions;
    report.unsupported_providers = built.errors.unsupported;
    report.provider_amount_mismatches = built.errors.provider_amount_mismatches;
    report.provider_economics_errors = built.errors.provider_economics_errors;
    report.settlement_resolution_errors = built.errors.settlement_resolution_errors;
    report.settlement_aggregate_errors = built.errors.settlement_aggregate_errors;
    report.seller_economics_errors = built.errors.seller_economics_errors;
    report.frozen_item_conflicts = built.errors.frozen_item_conflicts;
    if (flattenLegErrors_(built.errors).length > 0) report.errors.push('Payment Legs input has ' + flattenLegErrors_(built.errors).length + ' error(s).');

    const summary = summarizePaymentLegs_(built.legs, built.legSellers);
    Object.keys(summary).forEach(function (k) { if (k in report) report[k] = summary[k]; });
    if (summary.seller_hold_mismatches.length + summary.seller_available_equation_errors.length > 0) {
      report.errors.push('Seller economics invariants failed.');
    }

    const columns = getColumnNames_(SHEETS.PAYMENT_LEGS);
    const current = readSchemaTableObjects_(ss, SHEETS.PAYMENT_LEGS, tab);
    report.disappearing_payment_legs = mergePaymentLegTimestamps_(built.legs, current.rows, null, columns).errors;
    if (report.disappearing_payment_legs.length > 0) report.errors.push('Existing Payment Legs are no longer produced.');
    report.payment_legs_match = checkPaymentLegsFresh_(built, current.grid.values, columns).current;
    if (!report.payment_legs_match) report.errors.push('Payment Legs is stale (run normalizePaymentLegs).');
    if (summary.waiting_settlement_rows > 0) report.warnings.push(summary.waiting_settlement_rows + ' leg(s) waiting for provider settlement.');
    report.regression = evaluatePaymentLegsRegression_(summary);
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0;
  return redactDeep_(report);
}
