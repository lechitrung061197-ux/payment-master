/**
 * Kh001ProviderEvents.gs
 * KH001 normalizer: "Raw KH001 PayPal" -> canonical Provider Events (KH001 partition).
 *
 * - One event per raw row with a non-blank "Nhóm GD". Only verified (group, Type, Status, Balance Impact)
 *   combinations are mapped (KH001_PROVIDER_EVENTS.rules); anything else fails normalization (fail closed):
 *     Thanh toán / Express Checkout | Direct Credit Card Payment / Completed+Credit, Pending+Memo -> PAYMENT
 *     Thanh toán / Express Checkout | Direct Credit Card Payment / Reversed+Memo -> PAYMENT_REVERSAL
 *     Reserve PP / Reserve Hold / Completed+Debit -> RESERVE_HOLD; Reserve Release / Completed+Credit -> RESERVE_RELEASE
 *     Hoàn tiền / Payment Refund / Completed+Debit -> REFUND
 *     Tạm giữ dispute / General Hold / Completed+Debit -> DISPUTE_HOLD
 *     Rút tiền / General Withdrawal | User Initiated Withdrawal / Completed+Debit -> WITHDRAWAL
 *     Rút tiền / Reversal of ACH Withdrawal Transaction / Denied+Memo -> WITHDRAWAL_REVERSAL
 * - A PAYMENT_REVERSAL reuses the payment's Transaction ID: it is an event of the existing payment (its own id
 *   PE-...-<txn>-REVERSAL), never a second payment; the payment's economics are not touched. Every other event keeps
 *   PE-KH001-PAYPAL-<Transaction ID> (legacy ids unchanged). Any other reuse of a Transaction ID fails.
 * - REFUND / RESERVE_RELEASE / DISPUTE_HOLD link to the original payment: Txn gốc = the payment's Transaction ID
 *   (an existing Provider Transaction); Reference Txn ID = that payment or another event of it (e.g. the reserve
 *   hold). RESERVE_HOLD keeps its rule (Txn gốc = Reference Txn ID = payment). WITHDRAWAL_REVERSAL (Denied / Memo, no
 *   balance movement): blank Reference Txn ID with Txn gốc = itself -> an unlinked event (as PayPal reports it; no
 *   withdrawal is inferred from amounts, dates or balances); a non-blank Reference Txn ID must resolve to exactly one
 *   WITHDRAWAL (linked), otherwise it fails. Events never create a seller-side financial effect.
 * - PayPal signed amounts are kept as-is (Fee stays negative): gross + fee = net.
 * - balance_effect_amount follows Balance Impact: Credit/Debit = net, Memo = 0.
 * - PAYMENT / RESERVE_HOLD must link to an existing Provider Transaction; WITHDRAWAL has no link.
 * - Before any write or NO_CHANGE, the KH001 Provider Transactions partition must equal what
 *   its normalizer produces from the CURRENT raw tabs (dependency freshness gate).
 * - RESERVE_HOLD is the actual PayPal reserve. It is not the KH001 contractual hold and no
 *   percentage is derived here. No settlements, fees, holds or withdrawal allocation.
 * - Reads only Master tabs (Raw KH001 PayPal for events; Raw KH001 Reconciled and Provider
 *   Transactions only for the dependency/integrity checks).
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const KH001_PROVIDER_EVENTS = Object.freeze({
  providerId: 'KH001',
  paymentSource: 'PAYPAL',
  normalizerVersion: 'KH001_PROVIDER_EVENTS_V1',
  idPrefix: 'PE-KH001-PAYPAL-',
  paypalHeaderRow: 1,
  requiredHeaders: [
    'Mã cổng', 'Type', 'Status', 'Currency', 'Gross', 'Fee', 'Net', 'Transaction ID', 'Reference Txn ID',
    'Invoice Number', 'Balance Impact', 'Thời gian', 'Nhóm GD', 'Txn gốc',
  ],
  amountTolerance: 0.005,
  maxReportedErrors: 20,
  /**
   * Verified mappings only (group + Type + Status/Balance Impact). relation:
   *   SELF        provider_transaction_id = own Transaction ID;   Txn gốc == Transaction ID
   *   REVERSAL    same as SELF, and a PAYMENT row with the same Transaction ID must exist
   *   REFERENCE   provider_transaction_id = Reference Txn ID;     Txn gốc == Reference Txn ID
   *   ROOT        provider_transaction_id = Txn gốc (original payment); Reference Txn ID = Txn gốc or another
   *               event row of that payment
   *   WITHDRAWAL  no provider transaction; Reference Txn ID blank (Txn gốc == Transaction ID; unlinked) or exactly one
   *               WITHDRAWAL event in the same raw (linked)
   *   NONE        no provider transaction;                        Txn gốc == Transaction ID
   */
  rules: [
    { group: 'Thanh toán', eventType: 'PAYMENT', rawTypes: ['Express Checkout Payment', 'Direct Credit Card Payment'],
      statusImpacts: [['Completed', 'Credit'], ['Pending', 'Memo']], relation: 'SELF' },
    { group: 'Thanh toán', eventType: 'PAYMENT_REVERSAL', rawTypes: ['Express Checkout Payment', 'Direct Credit Card Payment'],
      statusImpacts: [['Reversed', 'Memo']], relation: 'REVERSAL' },
    { group: 'Reserve PP', eventType: 'RESERVE_HOLD', rawTypes: ['Reserve Hold'],
      statusImpacts: [['Completed', 'Debit']], relation: 'REFERENCE' },
    { group: 'Reserve PP', eventType: 'RESERVE_RELEASE', rawTypes: ['Reserve Release'],
      statusImpacts: [['Completed', 'Credit']], relation: 'ROOT' },
    { group: 'Hoàn tiền', eventType: 'REFUND', rawTypes: ['Payment Refund'],
      statusImpacts: [['Completed', 'Debit']], relation: 'ROOT' },
    { group: 'Tạm giữ dispute', eventType: 'DISPUTE_HOLD', rawTypes: ['General Hold'],
      statusImpacts: [['Completed', 'Debit']], relation: 'ROOT' },
    { group: 'Rút tiền', eventType: 'WITHDRAWAL', rawTypes: ['General Withdrawal', 'User Initiated Withdrawal'],
      statusImpacts: [['Completed', 'Debit']], relation: 'NONE' },
    { group: 'Rút tiền', eventType: 'WITHDRAWAL_REVERSAL', rawTypes: ['Reversal of ACH Withdrawal Transaction'],
      statusImpacts: [['Denied', 'Memo']], relation: 'WITHDRAWAL' },
  ],
  reversalIdSuffix: '-REVERSAL',
  /** Event types linked to an original payment (Provider Transaction) through related_external_transaction_id. */
  paymentLinkedTypes: ['RESERVE_HOLD', 'RESERVE_RELEASE', 'REFUND', 'DISPUTE_HOLD'],
  /** Balance Impact -> how net_amount moves the provider balance. */
  balanceImpacts: { Credit: 'NET', Debit: 'NET', Memo: 'ZERO' },
});

/**
 * Current-snapshot regression expectations (October 2026 production snapshot).
 * Report only; never used by the normalizer or by the generic verifier pass.
 */
const KH001_PROVIDER_EVENTS_REGRESSION = Object.freeze({
  snapshot: 'KH001 2026-10 production snapshot',
  source_rows: 3000,
  source_columns: 47,
  row_count: 343,
  unique_event_count: 343,
  event_type_counts: { PAYMENT: 169, RESERVE_HOLD: 168, WITHDRAWAL: 6 },
  status_counts: { Completed: 342, Pending: 1 },
  balance_impact_counts: { Credit: 168, Debit: 174, Memo: 1 },
  currency_counts: { USD: 343 },
  totals_by_event_type: {
    PAYMENT: { gross: 10706.35, fee: -420.24, net: 10286.11 },
    RESERVE_HOLD: { gross: -510.29, fee: 0, net: -510.29 },
    WITHDRAWAL: { gross: -9577.79, fee: 0, net: -9577.79 },
  },
  total_net: 198.03,
  total_balance_effect: 119.30,
  linked_counts: { PAYMENT: 169, RESERVE_HOLD: 168, WITHDRAWAL: 0 },
});

/* ----------------------------- Pure helpers ----------------------------- */

/** Deterministic event id: PE-KH001-PAYPAL-<Transaction ID>; a payment reversal (same Transaction ID) gets -REVERSAL. */
function kh001ProviderEventId_(externalEventId, eventType) {
  return KH001_PROVIDER_EVENTS.idPrefix + externalEventId + (eventType === 'PAYMENT_REVERSAL' ? KH001_PROVIDER_EVENTS.reversalIdSuffix : '');
}

/** SHA-256 of the raw PayPal checksum + normalizer version; independent of time. */
function computeKh001EventsFingerprint_(paypalChecksum, digestHex) {
  const digest = digestHex || sha256Hex_;
  return digest(paypalChecksum + '|' + KH001_PROVIDER_EVENTS.normalizerVersion);
}

/**
 * The verified rule for one raw row, or { error } (unmapped group / unverified Type / unverified Status+Balance Impact).
 * Shared by Provider Transactions (which payment rows are payments) and Provider Events.
 */
function classifyKh001PaypalRow_(group, rawType, status, impact) {
  const g = normalizeLabel_(group);
  const t = normalizeLabel_(rawType);
  const st = normalizeLabel_(status);
  const im = normalizeLabel_(impact);
  const inGroup = KH001_PROVIDER_EVENTS.rules.filter(function (r) { return normalizeLabel_(r.group) === g; });
  if (inGroup.length === 0) return { error: 'unmapped Nhóm GD "' + g + '"', kind: 'mapping' };
  const typed = inGroup.filter(function (r) { return r.rawTypes.map(normalizeLabel_).indexOf(t) >= 0; });
  if (typed.length === 0) return { error: 'unverified Type "' + t + '" for Nhóm GD "' + g + '"', kind: 'mapping' };
  const rule = typed.filter(function (r) {
    return r.statusImpacts.some(function (c) { return normalizeLabel_(c[0]) === st && normalizeLabel_(c[1]) === im; });
  })[0];
  if (!rule) return { error: 'unverified Status/Balance Impact "' + st + '/' + im + '" for ' + g + ' / ' + t, kind: 'mapping' };
  return { rule: rule };
}

/**
 * Balance movement for a row: Credit/Debit -> net_amount (Credit must be >= 0, Debit <= 0),
 * Memo -> 0. Returns { amount } or { error }.
 */
function computeBalanceEffect_(balanceImpact, net) {
  const mode = KH001_PROVIDER_EVENTS.balanceImpacts[normalizeLabel_(balanceImpact)];
  if (!mode) return { error: 'Unverified Balance Impact "' + balanceImpact + '"' };
  if (mode === 'ZERO') return { amount: 0 };
  const impact = normalizeLabel_(balanceImpact);
  if (impact === 'Credit' && net < 0) return { error: 'Credit with negative net ' + net };
  if (impact === 'Debit' && net > 0) return { error: 'Debit with positive net ' + net };
  return { amount: net };
}

function signedInvariantHolds_(gross, fee, net) {
  return Math.abs(gross + fee - net) <= KH001_PROVIDER_EVENTS.amountTolerance + 1e-9;
}

/**
 * Index of KH001 Provider Transactions rows: provider_transaction_id -> row object.
 * @param {Array<Object>} providerTransactionRows rows as objects (any provider)
 */
function indexProviderTransactions_(providerTransactionRows) {
  const index = {};
  providerTransactionRows.forEach(function (r) {
    index[String(r.provider_transaction_id)] = r;
  });
  return index;
}

/** Checks an event's link against Provider Transactions. Returns an error message or null. */
function checkEventRelationship_(event, ptIndex) {
  if (event.event_type === 'WITHDRAWAL') {
    return event.provider_transaction_id === '' && event.related_external_transaction_id === ''
      ? null
      : 'WITHDRAWAL ' + event.external_event_id + ' must not link to a provider transaction';
  }
  if (event.event_type === 'WITHDRAWAL_REVERSAL') {
    // related_external_transaction_id: '' (unlinked, as PayPal reports it) or the reversed WITHDRAWAL (checked against
    // the withdrawals by the builder / checkProviderEventRows_). Never a provider transaction.
    return event.provider_transaction_id === ''
      ? null
      : 'WITHDRAWAL_REVERSAL ' + event.external_event_id + ' must not link to a provider transaction';
  }
  const self = event.event_type === 'PAYMENT' || event.event_type === 'PAYMENT_REVERSAL';
  if (event.event_type === 'PAYMENT_REVERSAL' && event.related_external_transaction_id !== event.external_event_id) {
    return 'PAYMENT_REVERSAL ' + event.external_event_id + ' must relate to its own payment Transaction ID';
  }
  const expectedTxId = self ? event.external_event_id : event.related_external_transaction_id;
  if (!expectedTxId) return event.event_type + ' ' + event.external_event_id + ' has no related transaction';
  if (event.provider_transaction_id !== kh001ProviderTransactionId_(expectedTxId)) {
    return event.event_type + ' ' + event.external_event_id + ' has provider_transaction_id ' +
      event.provider_transaction_id + ', expected ' + kh001ProviderTransactionId_(expectedTxId);
  }
  const pt = ptIndex[event.provider_transaction_id];
  if (!pt) {
    return event.event_type + ' ' + event.external_event_id + ' links to missing Provider Transaction ' +
      event.provider_transaction_id;
  }
  if (pt.provider_id !== KH001_PROVIDER_EVENTS.providerId || pt.payment_source !== KH001_PROVIDER_EVENTS.paymentSource ||
      String(pt.external_transaction_id) !== expectedTxId) {
    return event.event_type + ' ' + event.external_event_id + ' links to Provider Transaction ' +
      event.provider_transaction_id + ' with mismatching provider/source/external id';
  }
  return null;
}

function emptyEventErrors_() {
  return { mapping: [], balance_impact: [], amount_invariant: [], relationship: [], duplicate: [], data: [] };
}

function flattenEventErrors_(errors) {
  return [].concat(errors.duplicate, errors.mapping, errors.balance_impact, errors.amount_invariant,
    errors.relationship, errors.data);
}

/**
 * Builds KH001 event objects (keyed by Provider Events columns, normalized_at blank)
 * from the full "Raw KH001 PayPal" grid. Structural header problems throw; row
 * problems are collected by category and returned (see assertNoEventErrors_).
 * @param {Array<Array<*>>} paypalValues
 * @param {Object} ptIndex from indexProviderTransactions_
 * @param {string} sourceFingerprint
 * @return {{rows: Array<Object>, eventRows: number, errors: Object}}
 */
function buildKh001ProviderEvents_(paypalValues, ptIndex, sourceFingerprint) {
  const cfg = KH001_PROVIDER_EVENTS;
  if (paypalValues.length < cfg.paypalHeaderRow) throw new Error('Raw KH001 PayPal has no header row.');
  const map = buildHeaderMap_(paypalValues[cfg.paypalHeaderRow - 1], cfg.requiredHeaders, 'Raw KH001 PayPal');
  const col = function (name) { return map[normalizeLabel_(name)]; };

  const errors = emptyEventErrors_();
  const seen = {};
  const rows = [];
  const pending = [];
  let eventRows = 0;

  for (let r = cfg.paypalHeaderRow; r < paypalValues.length; r++) {
    const row = paypalValues[r];
    const sheetRow = r + 1;
    const group = normalizeLabel_(row[col('Nhóm GD')]);
    const id = canonicalText_(row[col('Transaction ID')]);
    if (group === '') {
      // A transaction without a group would otherwise be dropped silently.
      if (id !== '') errors.mapping.push('Row ' + sheetRow + ': Transaction ID ' + id + ' has blank Nhóm GD');
      continue;
    }
    eventRows++;
    const label = 'Row ' + sheetRow + (id ? ' (' + id + ')' : '');

    const impact = normalizeLabel_(row[col('Balance Impact')]);
    const classified = classifyKh001PaypalRow_(group, row[col('Type')], row[col('Status')], impact);
    if (classified.error) { errors.mapping.push(label + ': ' + classified.error); continue; }
    const rule = classified.rule;
    if (id === '') { errors.data.push(label + ': blank Transaction ID'); continue; }
    // A Transaction ID may appear twice only as PAYMENT + PAYMENT_REVERSAL of the same payment.
    const prior = seen[id];
    if (prior && !(prior.types.length === 1 && [prior.types[0], rule.eventType].sort().join() === 'PAYMENT,PAYMENT_REVERSAL')) {
      errors.duplicate.push('Duplicate event Transaction ID ' + id + ' (rows ' + prior.rows.join(', ') + ', ' + sheetRow + '; ' +
        prior.types.concat([rule.eventType]).join(' + ') + ')');
      continue;
    }
    if (prior) { prior.types.push(rule.eventType); prior.rows.push(sheetRow); } else seen[id] = { types: [rule.eventType], rows: [sheetRow] };

    const gross = row[col('Gross')];
    const fee = row[col('Fee')];
    const net = row[col('Net')];
    if (!isFiniteNumber_(gross) || !isFiniteNumber_(fee) || !isFiniteNumber_(net)) {
      errors.amount_invariant.push(label + ': non-numeric Gross/Fee/Net');
      continue;
    }
    if (!signedInvariantHolds_(gross, fee, net)) {
      errors.amount_invariant.push(label + ': ' + gross + ' + ' + fee + ' != ' + net);
      continue;
    }
    const effect = computeBalanceEffect_(impact, net);
    if (effect.error) { errors.balance_impact.push(label + ': ' + effect.error); continue; }

    const at = row[col('Thời gian')];
    if (!isDateValue_(at) || isNaN(at.getTime())) { errors.data.push(label + ': Thời gian is not a date-time'); continue; }

    const reference = canonicalText_(row[col('Reference Txn ID')]);
    const root = canonicalText_(row[col('Txn gốc')]);
    let related = '';
    let providerTransactionId = '';
    if (rule.relation === 'ROOT' || rule.relation === 'WITHDRAWAL') {
      // Resolved after all rows are read (the reference may be another event row of the same raw).
      pending.push({ rule: rule, label: label, id: id, root: root, reference: reference, row: row, sheetRow: sheetRow, at: at, effect: effect,
        gross: gross, fee: fee, net: net });
      continue;
    }
    if (rule.relation === 'REVERSAL') {
      if (root !== id) { errors.relationship.push(label + ': Txn gốc "' + root + '" != Transaction ID "' + id + '"'); continue; }
      if (reference !== '' && reference !== id) {
        errors.relationship.push(label + ': PAYMENT_REVERSAL Reference Txn ID "' + reference + '" != Transaction ID "' + id + '"');
        continue;
      }
      related = id;
      providerTransactionId = kh001ProviderTransactionId_(id);
    } else if (rule.relation === 'REFERENCE') {
      if (reference === '') { errors.relationship.push(label + ': ' + rule.eventType + ' requires Reference Txn ID'); continue; }
      if (root !== reference) {
        errors.relationship.push(label + ': Txn gốc "' + root + '" != Reference Txn ID "' + reference + '"');
        continue;
      }
      related = reference;
      providerTransactionId = kh001ProviderTransactionId_(reference);
    } else {
      if (root !== id) {
        errors.relationship.push(label + ': Txn gốc "' + root + '" != Transaction ID "' + id + '"');
        continue;
      }
      if (rule.relation === 'SELF') providerTransactionId = kh001ProviderTransactionId_(id);
    }

    const event = {
      provider_event_id: kh001ProviderEventId_(id, rule.eventType),
      provider_id: cfg.providerId,
      payment_source: cfg.paymentSource,
      gateway_id: canonicalText_(row[col('Mã cổng')]),
      external_event_id: id,
      related_external_transaction_id: related,
      provider_transaction_id: providerTransactionId,
      event_type: rule.eventType,
      event_at: at,
      external_status: canonicalText_(row[col('Status')]),
      currency: canonicalText_(row[col('Currency')]),
      gross_amount: gross,
      fee_amount: fee,
      net_amount: net,
      balance_impact: canonicalText_(row[col('Balance Impact')]),
      balance_effect_amount: effect.amount,
      raw_type: canonicalText_(row[col('Type')]),
      raw_group: canonicalText_(row[col('Nhóm GD')]),
      source_paypal_row: sheetRow,
      source_fingerprint: sourceFingerprint,
      normalizer_version: cfg.normalizerVersion,
      normalized_at: '',
    };
    const linkError = checkEventRelationship_(event, ptIndex);
    if (linkError) { errors.relationship.push(label + ': ' + linkError); continue; }
    rows.push(event);
  }

  // Events whose link may go through another event row of the same raw (ROOT / WITHDRAWAL relations).
  const rawById = {};
  for (let r = cfg.paypalHeaderRow; r < paypalValues.length; r++) {
    const rid = canonicalText_(paypalValues[r][col('Transaction ID')]);
    if (rid !== '' && normalizeLabel_(paypalValues[r][col('Nhóm GD')]) !== '') {
      (rawById[rid] = rawById[rid] || []).push({ root: canonicalText_(paypalValues[r][col('Txn gốc')]),
        type: (classifyKh001PaypalRow_(paypalValues[r][col('Nhóm GD')], paypalValues[r][col('Type')], paypalValues[r][col('Status')],
          paypalValues[r][col('Balance Impact')]).rule || {}).eventType });
    }
  }
  pending.forEach(function (p) {
    let related;
    let providerTransactionId = '';
    if (p.rule.relation === 'ROOT') {
      if (p.root === '') { errors.relationship.push(p.label + ': ' + p.rule.eventType + ' requires Txn gốc (the original payment)'); return; }
      if (p.root === p.id) { errors.relationship.push(p.label + ': ' + p.rule.eventType + ' Txn gốc must be the original payment, not itself'); return; }
      if (p.reference === '') { errors.relationship.push(p.label + ': ' + p.rule.eventType + ' requires Reference Txn ID'); return; }
      const viaEvent = (rawById[p.reference] || []).some(function (x) { return x.root === p.root && x.type; });
      if (p.reference !== p.root && !viaEvent) {
        errors.relationship.push(p.label + ': Reference Txn ID "' + p.reference + '" is neither Txn gốc "' + p.root + '" nor an event of that payment');
        return;
      }
      related = p.root;
      providerTransactionId = kh001ProviderTransactionId_(p.root);
    } else if (p.reference === '') {
      // Unlinked reversal (production shape): only valid when Txn gốc is the row itself; nothing is inferred.
      if (p.root !== p.id) {
        errors.relationship.push(p.label + ': WITHDRAWAL_REVERSAL without Reference Txn ID needs Txn gốc = its own Transaction ID (found "' + p.root + '")');
        return;
      }
      related = '';
    } else {
      const target = (rawById[p.reference] || []).filter(function (x) { return x.type === 'WITHDRAWAL'; });
      if (target.length !== 1) {
        errors.relationship.push(p.label + ': WITHDRAWAL_REVERSAL Reference Txn ID "' + p.reference + '" must be exactly one WITHDRAWAL in Raw KH001 PayPal');
        return;
      }
      if (p.root !== p.id && p.root !== p.reference) {
        errors.relationship.push(p.label + ': Txn gốc "' + p.root + '" is neither the reversal nor its withdrawal');
        return;
      }
      related = p.reference;
    }
    const event = {
      provider_event_id: kh001ProviderEventId_(p.id, p.rule.eventType),
      provider_id: cfg.providerId,
      payment_source: cfg.paymentSource,
      gateway_id: canonicalText_(p.row[col('Mã cổng')]),
      external_event_id: p.id,
      related_external_transaction_id: related,
      provider_transaction_id: providerTransactionId,
      event_type: p.rule.eventType,
      event_at: p.at,
      external_status: canonicalText_(p.row[col('Status')]),
      currency: canonicalText_(p.row[col('Currency')]),
      gross_amount: p.gross,
      fee_amount: p.fee,
      net_amount: p.net,
      balance_impact: canonicalText_(p.row[col('Balance Impact')]),
      balance_effect_amount: p.effect.amount,
      raw_type: canonicalText_(p.row[col('Type')]),
      raw_group: canonicalText_(p.row[col('Nhóm GD')]),
      source_paypal_row: p.sheetRow,
      source_fingerprint: sourceFingerprint,
      normalizer_version: cfg.normalizerVersion,
      normalized_at: '',
    };
    const linkError = checkEventRelationship_(event, ptIndex);
    if (linkError) { errors.relationship.push(p.label + ': ' + linkError); return; }
    rows.push(event);
  });
  // A reversal needs the payment it reverses (same Transaction ID) among the events.
  rows.filter(function (e) { return e.event_type === 'PAYMENT_REVERSAL'; }).forEach(function (e) {
    if (!rows.some(function (x) { return x.event_type === 'PAYMENT' && x.external_event_id === e.external_event_id; })) {
      errors.relationship.push('PAYMENT_REVERSAL ' + e.external_event_id + ' has no PAYMENT row with the same Transaction ID');
    }
  });
  rows.sort(function (a, b) { return a.source_paypal_row - b.source_paypal_row; });
  return { rows: rows, eventRows: eventRows, errors: errors };
}

/** Throws one error listing every problem found by buildKh001ProviderEvents_. */
function assertNoEventErrors_(errors) {
  const all = flattenEventErrors_(errors);
  if (all.length === 0) return;
  const shown = all.slice(0, KH001_PROVIDER_EVENTS.maxReportedErrors);
  const more = all.length > shown.length ? ' | ... ' + (all.length - shown.length) + ' more' : '';
  throw new Error('KH001 provider events normalization failed (' + all.length + ' error(s)): ' + shown.join(' | ') + more);
}

/**
 * Generic checks on stored event rows (objects): duplicates, signed amount invariant,
 * balance effect consistency and relationships. Used by the verifier.
 */
function checkProviderEventRows_(rows, ptIndex) {
  const errors = emptyEventErrors_();
  const counts = {};
  const byExternal = {};
  const withdrawals = {};
  rows.forEach(function (e) {
    if (e.event_type === 'WITHDRAWAL') withdrawals[String(e.external_event_id)] = true;
    (byExternal[String(e.external_event_id)] = byExternal[String(e.external_event_id)] || []).push(String(e.event_type));
  });
  rows.forEach(function (e) {
    const id = String(e.external_event_id);
    const eventId = String(e.provider_event_id);
    counts[eventId] = (counts[eventId] || 0) + 1;
    if (eventId !== kh001ProviderEventId_(id, e.event_type)) errors.mapping.push(eventId + ' is not the deterministic id of ' + id + ' / ' + e.event_type);
    const reversed = String(e.related_external_transaction_id === null || e.related_external_transaction_id === undefined ? '' : e.related_external_transaction_id);
    if (e.event_type === 'WITHDRAWAL_REVERSAL' && reversed !== '' && !withdrawals[reversed]) {
      errors.relationship.push('WITHDRAWAL_REVERSAL ' + id + ' references no stored WITHDRAWAL ' + reversed); // blank = unlinked, valid
    }
    if (!isFiniteNumber_(e.gross_amount) || !isFiniteNumber_(e.fee_amount) || !isFiniteNumber_(e.net_amount) ||
        !signedInvariantHolds_(e.gross_amount, e.fee_amount, e.net_amount)) {
      errors.amount_invariant.push(id);
    }
    const effect = isFiniteNumber_(e.net_amount) ? computeBalanceEffect_(e.balance_impact, e.net_amount) : { error: 'x' };
    if (effect.error || !isFiniteNumber_(e.balance_effect_amount) ||
        Math.round(effect.amount * 100) !== Math.round(e.balance_effect_amount * 100)) {
      errors.balance_impact.push(id);
    }
    if (KH001_PROVIDER_EVENTS.rules.map(function (r) { return r.eventType; }).indexOf(e.event_type) < 0) {
      errors.mapping.push(id);
    }
    const link = checkEventRelationship_({
      event_type: e.event_type,
      external_event_id: id,
      related_external_transaction_id: String(e.related_external_transaction_id),
      provider_transaction_id: String(e.provider_transaction_id),
    }, ptIndex);
    if (link) errors.relationship.push(link);
  });
  errors.duplicate = Object.keys(counts).filter(function (k) { return counts[k] > 1; }).sort();
  Object.keys(byExternal).sort().forEach(function (k) {
    const types = byExternal[k].slice().sort();
    if (types.length > 1 && types.join() !== 'PAYMENT,PAYMENT_REVERSAL') errors.duplicate.push(k + ' (' + types.join(' + ') + ')');
  });
  return errors;
}

/** Generic summary of event objects (no snapshot-specific numbers). */
function summarizeProviderEvents_(rows) {
  const tally = function (field) {
    return rows.reduce(function (acc, r) {
      const k = String(r[field]);
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
  };
  const cents = {};
  const linked = {};
  let totalNet = 0;
  let totalEffect = 0;
  rows.forEach(function (r) {
    const t = String(r.event_type);
    cents[t] = cents[t] || { gross: 0, fee: 0, net: 0, balance_effect: 0 };
    cents[t].gross += toCents_(r.gross_amount);
    cents[t].fee += toCents_(r.fee_amount);
    cents[t].net += toCents_(r.net_amount);
    cents[t].balance_effect += toCents_(r.balance_effect_amount);
    linked[t] = (linked[t] || 0) + (String(r.provider_transaction_id) !== '' ? 1 : 0);
    totalNet += toCents_(r.net_amount);
    totalEffect += toCents_(r.balance_effect_amount);
  });
  const totals = {};
  Object.keys(cents).sort().forEach(function (t) {
    totals[t] = { gross: cents[t].gross / 100, fee: cents[t].fee / 100, net: cents[t].net / 100,
      balance_effect: cents[t].balance_effect / 100 };
  });
  const ids = {};
  rows.forEach(function (r) { ids[String(r.external_event_id)] = true; });
  return {
    row_count: rows.length,
    unique_event_count: Object.keys(ids).length,
    event_type_counts: tally('event_type'),
    status_counts: tally('external_status'),
    currency_counts: tally('currency'),
    balance_impact_counts: tally('balance_impact'),
    totals_by_event_type: totals,
    total_net: totalNet / 100,
    total_balance_effect: totalEffect / 100,
    linked_counts: linked,
  };
}

/** Compares a summary with the current-snapshot regression expectations (report only). */
function evaluateKh001ProviderEventsRegression_(summary, source) {
  const exp = KH001_PROVIDER_EVENTS_REGRESSION;
  const checks = [];
  const add = function (name, expected, actual, pass) { checks.push({ name: name, expected: expected, actual: actual, pass: pass }); };
  const sameCounts = function (e, a) {
    return Object.keys(e).every(function (k) { return (a[k] || 0) === e[k]; }) &&
      Object.keys(a).every(function (k) { return Object.prototype.hasOwnProperty.call(e, k); });
  };
  const near = function (e, a) { return isFiniteNumber_(a) && Math.round(e * 100) === Math.round(a * 100); };

  add('source_rows', exp.source_rows, source.paypal_rows, source.paypal_rows === exp.source_rows);
  add('source_columns', exp.source_columns, source.paypal_columns, source.paypal_columns === exp.source_columns);
  add('row_count', exp.row_count, summary.row_count, summary.row_count === exp.row_count);
  add('unique_event_count', exp.unique_event_count, summary.unique_event_count, summary.unique_event_count === exp.unique_event_count);
  ['event_type_counts', 'status_counts', 'balance_impact_counts', 'currency_counts', 'linked_counts'].forEach(function (k) {
    add(k, exp[k], summary[k], sameCounts(exp[k], summary[k] || {}));
  });
  Object.keys(exp.totals_by_event_type).forEach(function (t) {
    ['gross', 'fee', 'net'].forEach(function (f) {
      const actual = summary.totals_by_event_type[t] ? summary.totals_by_event_type[t][f] : null;
      add('totals_by_event_type.' + t + '.' + f, exp.totals_by_event_type[t][f], actual, near(exp.totals_by_event_type[t][f], actual));
    });
  });
  add('total_net', exp.total_net, summary.total_net, near(exp.total_net, summary.total_net));
  add('total_balance_effect', exp.total_balance_effect, summary.total_balance_effect,
    near(exp.total_balance_effect, summary.total_balance_effect));
  return {
    snapshot: exp.snapshot,
    pass: checks.every(function (c) { return c.pass; }),
    failed: checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }),
    checks: checks,
  };
}

/* ---------------------------------- I/O --------------------------------- */

// provider_event_id is unique (a payment and its reversal share external_event_id). The extra sort column only
// breaks ties between those two, so the order (and checksum) of existing rows is unchanged.
const PROVIDER_EVENT_KEY_COLUMNS = ['provider_id', 'payment_source', 'provider_event_id'];
const PROVIDER_EVENT_SORT_COLUMNS = ['provider_id', 'payment_source', 'event_at', 'external_event_id', 'provider_event_id'];

function providerEventsTab_() {
  return { targetSheet: SHEETS.PROVIDER_EVENTS, stagingSheet: '__STAGE_PROVIDER_EVENTS' };
}

/**
 * Reads the Provider Transactions dependency (read-only): requires a NORMAL swap state
 * (recovery of that tab belongs to its own normalizer), indexes its rows for referential
 * integrity, and checks that its KH001 partition is exactly what the Provider Transactions
 * normalizer would produce from the CURRENT Raw KH001 PayPal + Raw KH001 Reconciled.
 * Raw KH001 Reconciled is read only for this freshness check, not as event data.
 * @param {{values: Array<Array<*>>, checksum: string}} paypalGrid already-read Raw KH001 PayPal
 * @return {{index: Object, dependency: Object}}
 */
function readProviderTransactionsDependency_(ss, paypalGrid) {
  const state = detectSwapState_(ss, providerTransactionsTab_()).state;
  if (state !== 'NORMAL') {
    throw new Error('Provider Transactions swap state is ' + state + '; run normalizeKh001ProviderTransactions first.');
  }
  const reconciledSheet = ss.getSheetByName(SHEETS.RAW_KH001_RECONCILED);
  if (!reconciledSheet) throw new Error('Raw tab "' + SHEETS.RAW_KH001_RECONCILED + '" not found. Run syncKh001Raw first.');
  const reconciled = readSheetGrid_(reconciledSheet);

  const sheet = ss.getSheetByName(SHEETS.PROVIDER_TRANSACTIONS);
  const columns = getColumnNames_(SHEETS.PROVIDER_TRANSACTIONS);
  const rows = tableRowsFromGrid_(readSheetGrid_(sheet).values, columns, SHEETS.PROVIDER_TRANSACTIONS);
  const check = checkKh001ProviderTransactionsCurrent_(paypalGrid, reconciled, rows, columns);
  return {
    index: indexProviderTransactions_(rows.map(function (r) { return rowToObject_(r, columns); })),
    dependency: {
      provider_transactions_current: check.current,
      swap_state: state,
      reconciled_checksum: reconciled.checksum,
      expected_checksum: check.expected_checksum,
      stored_checksum: check.stored_checksum,
      expected_rows: check.expected_rows,
      stored_rows: check.stored_rows,
      reason: check.reason,
    },
  };
}

function readKh001EventsInput_(ss) {
  const sheet = ss.getSheetByName(SHEETS.RAW_KH001_PAYPAL);
  if (!sheet) throw new Error('Raw tab "' + SHEETS.RAW_KH001_PAYPAL + '" not found. Run syncKh001Raw first.');
  const paypal = readSheetGrid_(sheet);
  return { paypal: paypal, fingerprint: computeKh001EventsFingerprint_(paypal.checksum) };
}

/** Normalizes KH001 into Provider Events under the script lock. Never throws. */
function runKh001ProviderEventsNormalizer_() {
  const cfg = KH001_PROVIDER_EVENTS;
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  const details = { normalizer_version: cfg.normalizerVersion };
  let status = 'FAILED';
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms.');
    const ss = getSpreadsheet_();
    const table = getTableSchema_(SHEETS.PROVIDER_EVENTS);
    const columns = table.columns.map(function (c) { return c.name; });

    const input = readKh001EventsInput_(ss);
    details.source_fingerprint = input.fingerprint;
    details.paypal_checksum = input.paypal.checksum;

    // Dependency freshness gate: must pass before any write or NO_CHANGE result.
    const dep = readProviderTransactionsDependency_(ss, input.paypal);
    details.provider_transactions_checksum = dep.dependency.stored_checksum;
    if (!dep.dependency.provider_transactions_current) throw new Error(dep.dependency.reason);

    const built = buildKh001ProviderEvents_(input.paypal.values, dep.index, input.fingerprint);
    details.input_event_rows = built.eventRows;
    assertNoEventErrors_(built.errors);

    const partition = built.rows.map(function (o) { return objectToRow_(o, columns); });
    const summary = summarizeProviderEvents_(built.rows);
    details.output_rows = summary.row_count;
    details.output_checksum = partitionChecksum_(partition, columns, PROVIDER_EVENT_SORT_COLUMNS, 'normalized_at');
    details.event_type_counts = summary.event_type_counts;
    details.total_balance_effect = summary.total_balance_effect;

    const result = replaceCanonicalPartition_(ss, {
      table: table,
      tab: providerEventsTab_(),
      providerId: cfg.providerId,
      partitionRows: partition,
      keyColumns: PROVIDER_EVENT_KEY_COLUMNS,
      sortColumns: PROVIDER_EVENT_SORT_COLUMNS,
      stampColumn: 'normalized_at',
    });
    details.swap_state = result.swapState;
    details.swap_actions = result.swapActions;
    details.table_rows = result.tableRows;
    status = result.status;
  } catch (err) {
    details.error = err && err.message ? err.message : String(err);
    status = 'FAILED';
  } finally {
    try {
      appendAuditLog_({
        action: cfg.providerId + '_PROVIDER_EVENTS_NORMALIZE_' + status,
        entityType: 'PROVIDER_EVENTS',
        entityId: cfg.providerId,
        newStatus: status,
        details: details,
      });
    } catch (auditErr) {
      Logger.log('Failed to write audit entry: %s', auditErr);
    }
    if (locked) lock.releaseLock();
  }
  return Object.assign({ provider: cfg.providerId, status: status }, details);
}

/** Read-only verification of the KH001 Provider Events partition. */
function buildKh001ProviderEventsReport_() {
  const cfg = KH001_PROVIDER_EVENTS;
  const report = {
    provider: cfg.providerId,
    normalizer_version: cfg.normalizerVersion,
    source: {},
    output: {},
    event_type_counts: {},
    status_counts: {},
    currency_counts: {},
    balance_impact_counts: {},
    totals_by_event_type: {},
    total_balance_effect: null,
    linked_counts: {},
    dependency: null,
    target_match: false,
    swap_state: null,
    pass: false,
    errors: [],
    regression: null,
  };
  try {
    const ss = getSpreadsheet_();
    const columns = getColumnNames_(SHEETS.PROVIDER_EVENTS);
    const input = readKh001EventsInput_(ss);
    report.source = {
      paypal_rows: input.paypal.rows,
      paypal_columns: input.paypal.columns,
      paypal_checksum: input.paypal.checksum,
      source_fingerprint: input.fingerprint,
      selected_event_rows: null,
    };

    const dep = readProviderTransactionsDependency_(ss, input.paypal);
    const ptIndex = dep.index;
    report.dependency = dep.dependency;
    if (!dep.dependency.provider_transactions_current) report.errors.push(dep.dependency.reason);
    let expectedChecksum = null;
    const built = buildKh001ProviderEvents_(input.paypal.values, ptIndex, input.fingerprint);
    report.source.selected_event_rows = built.eventRows;
    const buildErrors = flattenEventErrors_(built.errors);
    if (buildErrors.length === 0) {
      expectedChecksum = partitionChecksum_(built.rows.map(function (o) { return objectToRow_(o, columns); }),
        columns, PROVIDER_EVENT_SORT_COLUMNS, 'normalized_at');
    } else {
      report.errors.push('Normalizer validation failed with ' + buildErrors.length + ' error(s).');
    }

    report.swap_state = detectSwapState_(ss, providerEventsTab_()).state;
    if (report.swap_state !== 'NORMAL') report.errors.push('Swap state is ' + report.swap_state + '.');

    const target = ss.getSheetByName(SHEETS.PROVIDER_EVENTS);
    if (!target) throw new Error('Provider Events tab not found.');
    const allRows = tableRowsFromGrid_(readSheetGrid_(target).values, columns, SHEETS.PROVIDER_EVENTS);
    const providerIdx = columns.indexOf('provider_id');
    const kh001Rows = allRows.filter(function (r) { return r[providerIdx] === cfg.providerId; });
    const objects = kh001Rows.map(function (r) { return rowToObject_(r, columns); });
    const stored = checkProviderEventRows_(objects, ptIndex);
    const tableDuplicates = findDuplicateKeys_(allRows, PROVIDER_EVENT_KEY_COLUMNS.map(function (c) { return columns.indexOf(c); }));
    const summary = summarizeProviderEvents_(objects);

    const merge = function (a, b) { return a.concat(b.filter(function (x) { return a.indexOf(x) < 0; })); };
    report.output = {
      row_count: summary.row_count,
      unique_event_count: summary.unique_event_count,
      output_checksum: partitionChecksum_(kh001Rows, columns, PROVIDER_EVENT_SORT_COLUMNS, 'normalized_at'),
      expected_checksum: expectedChecksum,
      duplicate_event_ids: merge(stored.duplicate, built.errors.duplicate),
      table_duplicate_keys: tableDuplicates,
      amount_invariant_errors: merge(stored.amount_invariant, built.errors.amount_invariant),
      relationship_errors: merge(stored.relationship, built.errors.relationship),
      mapping_errors: merge(stored.mapping, built.errors.mapping),
      balance_impact_errors: merge(stored.balance_impact, built.errors.balance_impact),
      data_errors: built.errors.data,
      table_rows_all_providers: allRows.length,
    };
    report.event_type_counts = summary.event_type_counts;
    report.status_counts = summary.status_counts;
    report.currency_counts = summary.currency_counts;
    report.balance_impact_counts = summary.balance_impact_counts;
    report.totals_by_event_type = summary.totals_by_event_type;
    report.total_balance_effect = summary.total_balance_effect;
    report.linked_counts = summary.linked_counts;

    // Stored order must equal canonical order: compare stored rows without re-sorting.
    const storedChecksum = tableChecksumExcluding_(buildTableValues_(columns, kh001Rows), [columns.indexOf('normalized_at')]);
    report.target_match = expectedChecksum !== null && storedChecksum === expectedChecksum;
    if (!report.target_match) report.errors.push('Provider Events KH001 partition does not match raw snapshot.');
    ['duplicate_event_ids', 'table_duplicate_keys', 'amount_invariant_errors', 'relationship_errors',
      'mapping_errors', 'balance_impact_errors', 'data_errors'].forEach(function (k) {
      if (report.output[k].length > 0) report.errors.push(k + ': ' + report.output[k].length);
    });

    report.regression = evaluateKh001ProviderEventsRegression_(summary, report.source);
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0 && report.target_match && report.swap_state === 'NORMAL';
  return report;
}
