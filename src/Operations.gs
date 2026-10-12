/**
 * Operations.gs
 * Operator UI (the "Operations" tab) and controlled Seller Payout operations.
 *
 * - The Operations tab is a VIEW + COMMAND FORM only. No accounting module reads it: balances, amounts, payment
 *   statuses and seller ownership come only from the canonical tabs (Seller Balances, Seller Payouts, Seller Payout
 *   Allocations, Settlement Items, Settlements, Adjustments). After an operation the canonical truth lives in Seller
 *   Payouts + Seller Payout Allocations and the tab is re-rendered from them.
 * - Payout lifecycle (no other transition is possible from here):
 *     (new) -> DRAFT -> SENT -> CONFIRMED;  DRAFT -> CANCELLED;  SENT / CONFIRMED -> REVERSED (reason required).
 *   DRAFT / CANCELLED have no financial effect; SENT and CONFIRMED count once (CONFIRMED never deducts again);
 *   REVERSED restores the balance and the derived obligation status. Payouts and allocations are never deleted.
 * - Every mutation holds the DOCUMENT lock, the same outer lock as the scheduled pipeline (so an operator action and a
 *   pipeline run never overlap); the canonical runners it reuses keep their own script lock inside (DocumentLock outer ->
 *   ScriptLock inner, the pipeline's ordering). Busy lock -> SKIPPED_LOCKED, nothing changed.
 * - Draft creation: a request token in the form -> deterministic seller_payout_id (retry / double click never creates a
 *   second payout); validated BEFORE the payout row is written (seller / currency / date / amount, payable balance as of
 *   the payout date minus other DRAFT reservations, open obligations not claimed by another DRAFT, the FIFO plan); then
 *   runSellerPayoutFifo_ (planFifoAllocation_, oldest obligation first) writes the allocation rows.
 * - SENT / CONFIRMED / REVERSED: the new status is simulated through validateSellerPayoutAllocations_ and
 *   buildSellerBalances_ and written only when the simulated ledger has no error; then Seller Balances is rebuilt, the
 *   ledger re-verified, the pipeline health checked and only the affected ACTIVE seller sheet synced.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const OPERATIONS = Object.freeze({
  width: 12,
  title: 'Payment Master - Operations',
  note: 'View + command form only. Not an accounting source: the truth is Seller Payouts, Seller Payout Allocations and ' +
    'Seller Balances. Columns A-L from row 32 down are rewritten on every refresh; keep custom notes in column N or later.',
  refreshedRow: 3,
  statusHeaderRow: 5,
  statusStartRow: 6,
  statusLabels: Object.freeze(['Master schema version', 'Latest pipeline run', 'Latest pipeline status', 'Latest health check',
    'Providers', 'Total seller available', 'Total seller hold', 'Effective seller payouts (SENT / CONFIRMED)', 'DRAFT payouts',
    'Open payout obligations', 'Active seller destinations']),
  formHeaderRow: 18,
  formStartRow: 19,
  formFields: Object.freeze([
    ['seller', 'Seller', 'Dropdown: ACTIVE sellers'],
    ['currency', 'Currency', 'Currency of the seller balance / obligations'],
    ['payout_date', 'Payout Date', 'dd/MM/yyyy'],
    ['amount', 'Amount', 'In Currency, > 0; at most "Available to draft" of the seller'],
    ['payout_currency', 'Payout Currency', 'Blank = same as Currency'],
    ['fx_rate', 'FX Rate', 'Same currency: 1 (automatic). Other currency: required, > 0'],
    ['payout_amount', 'Payout Amount', 'Same currency: = Amount (automatic). Other currency: required, > 0'],
    ['payment_method', 'Payment Method', 'e.g. Bank transfer'],
    ['reference', 'Reference', 'Bank / wallet reference'],
    ['notes', 'Notes', 'Optional'],
  ]),
  tokenRow: 29,
  tokenLabel: 'Request token (automatic)',
  resultRow: 30,
  resultLabel: 'Last result',
  dynamicStartRow: 32,
  payableTitle: 'SELLER PAYABLE',
  payoutsTitle: 'RECENT / ACTIVE PAYOUTS',
  payableHeaders: Object.freeze(['seller_id', 'seller_name', 'currency', 'current_balance', 'seller_hold_balance', 'draft_reserved',
    'available_to_draft', 'open_obligations', 'effective_paid', 'payment_state']),
  payoutHeaders: Object.freeze(['seller_payout_id', 'seller_id', 'payout_date', 'amount', 'currency', 'payout_amount', 'payout_currency',
    'payment_method', 'reference', 'status', 'allocated_amount', 'allocation']),
  dateFormat: 'dd/MM/yyyy',
  lockWaitMs: 5000,
  payoutIdPrefix: 'SP-OPS-',
  recentClosedLimit: 20,
  auditScanRows: 3000,
  activeStatuses: Object.freeze(['DRAFT', 'SENT', 'CONFIRMED']),
  // Allowed transitions: target status -> allowed current statuses.
  transitions: Object.freeze({ SENT: ['DRAFT'], CONFIRMED: ['SENT'], CANCELLED: ['DRAFT'], REVERSED: ['SENT', 'CONFIRMED'] }),
  auditActions: Object.freeze({ DRAFT: 'SELLER_PAYOUT_DRAFT_CREATED', SENT: 'SELLER_PAYOUT_SENT', CONFIRMED: 'SELLER_PAYOUT_CONFIRMED',
    CANCELLED: 'SELLER_PAYOUT_CANCELLED', REVERSED: 'SELLER_PAYOUT_REVERSED' }),
  failedAction: 'SELLER_PAYOUT_OPERATION_FAILED',
  lockedAction: 'SELLER_PAYOUT_OPERATION_SKIPPED_LOCKED',
  // Operator View: these Master tabs stay visible; every other Master tab is hidden. Staging tabs are always hidden.
  operatorVisibleTabs: Object.freeze(['Operations', 'Dashboard', 'Sellers', 'Seller Terms', 'Seller Destinations', 'Seller Payouts',
    'Adjustments', 'Disputes']),
});

/* ----------------------------- Pure helpers ----------------------------- */

function operationsPad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/** Deterministic seller_payout_id of an Operations request token. */
function operationsPayoutId_(token, digestHex) {
  const digest = digestHex || sha256Hex_;
  return OPERATIONS.payoutIdPrefix + digest('OPERATIONS_PAYOUT|' + trimmedText_(token)).slice(0, 16).toUpperCase();
}

/** 'YYYY-MM-DD' of an Operations date input: strict dd/MM/yyyy text, or a date value. Null when invalid. */
function parseOperationsDateKey_(value, dateKeyOf) {
  if (isDateValue_(value)) return sellerDateKeyOrNull_(value, dateKeyOf || masterDateKey_);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmedText_(value));
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo < 1 || mo > 12 || d < 1 || d > days[mo - 1]) return null;
  return y + '-' + operationsPad2_(mo) + '-' + operationsPad2_(d);
}

/** 'YYYY-MM-DD' -> 'dd/MM/yyyy' ('' for blank). */
function formatOperationsDate_(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
}

function operationsSellerOption_(seller) {
  return seller.seller_id + ' · ' + seller.seller_name;
}

/** Seller id of a dropdown value ("CUS001 · NAME") or a typed id. */
function operationsSellerId_(value) {
  return trimmedText_(value).split(' · ')[0].trim();
}

/** A form number: a finite number or a plain decimal string; null when blank / invalid. */
function operationsNumber_(value) {
  if (isFiniteNumber_(value)) return value;
  const text = trimmedText_(value);
  return /^\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

function operationsMicros_(v) {
  return isFiniteNumber_(v) ? Math.round(v * 1e6) : 0;
}

/**
 * Per seller + currency view of the canonical ledger, in micro units: Seller Balances, derived obligation states, DRAFT
 * reservations (DRAFT payout amounts) and DRAFT claims (DRAFT allocation rows). DRAFT is never treated as paid.
 * available_to_draft = max(0, min(current_balance - DRAFT reserved, open obligations not yet claimed by a DRAFT)).
 */
function buildOperationsLines_(input) {
  const lines = {};
  const line = function (seller, currency) {
    const k = seller + '|' + currency;
    return lines[k] = lines[k] || { seller_id: seller, currency: currency, has_balance: false, current: 0, hold: 0, paid: 0,
      draft_reserved: 0, draft_count: 0, draft_claimed: 0, obligations: 0, open_count: 0, open_remaining: 0, paid_obligations: 0,
      unpaid_obligations: 0 };
  };
  (input.balances || []).forEach(function (b) {
    const l = line(trimmedText_(b.seller_id), trimmedText_(b.currency));
    l.has_balance = true;
    l.current = operationsMicros_(b.current_balance);
    l.hold = operationsMicros_(b.seller_hold_balance);
    l.paid = operationsMicros_(b.paid_amount);
  });
  (input.states || []).forEach(function (s) {
    const l = line(s.seller_id, s.currency);
    l.obligations++;
    if (s.payment_status === 'PAID') l.paid_obligations++;
    else l.open_count++;
    if (s.payment_status === 'UNPAID') l.unpaid_obligations++;
    l.open_remaining += Math.max(0, operationsMicros_(s.remaining_amount));
  });
  const drafts = {};
  (input.payouts || []).forEach(function (p) {
    if (trimmedText_(p.status) !== SELLER_ALLOCATIONS.draftStatus) return;
    drafts[trimmedText_(p.seller_payout_id)] = true;
    const l = line(trimmedText_(p.seller_id), trimmedText_(p.currency));
    l.draft_reserved += Math.max(0, operationsMicros_(p.amount));
    l.draft_count++;
  });
  (input.allocations || []).forEach(function (a) {
    if (!drafts[trimmedText_(a.seller_payout_id)]) return;
    line(trimmedText_(a.seller_id), trimmedText_(a.currency)).draft_claimed += Math.max(0, operationsMicros_(a.allocated_amount));
  });
  Object.keys(lines).forEach(function (k) {
    const l = lines[k];
    l.available_to_draft = Math.max(0, Math.min(l.current - l.draft_reserved, l.open_remaining - l.draft_claimed));
    l.payment_state = l.obligations === 0 ? 'NO OBLIGATIONS' : l.paid_obligations === l.obligations ? 'PAID'
      : l.unpaid_obligations === l.obligations ? 'UNPAID' : 'PARTIAL';
  });
  return lines;
}

/**
 * Validates and normalizes the Operations form. Same currency: fx_rate = 1, payout_currency = currency, payout_amount =
 * amount. Other payout currency: fx_rate and payout_amount must be explicit positive numbers (no conversion rule is
 * invented here).
 * @return {{errors: Array<string>, payout: Object}}
 */
function parseOperationsForm_(form, ctx) {
  const errors = [];
  const sellerId = operationsSellerId_(form.seller);
  const seller = (ctx.sellers || []).filter(function (s) { return s.seller_id === sellerId; })[0];
  if (sellerId === '') errors.push('Seller is required.');
  else if (!seller) errors.push('Seller ' + sellerId + ' is not in Sellers.');
  else if (seller.status !== 'ACTIVE') errors.push('Seller ' + sellerId + ' is ' + seller.status + '; only ACTIVE sellers can be paid from Operations.');
  const currency = trimmedText_(form.currency).toUpperCase();
  if (currency === '') errors.push('Currency is required.');
  else if (seller && !(ctx.lines || {})[sellerId + '|' + currency]) errors.push('Seller ' + sellerId + ' has no ' + currency + ' balance or payout obligation.');
  const dateKey = parseOperationsDateKey_(form.payout_date, ctx.dateKeyOf);
  if (!dateKey) errors.push('Payout Date must be a valid date in ' + OPERATIONS.dateFormat + ' (found "' + trimmedText_(form.payout_date) + '").');
  const amount = operationsNumber_(form.amount);
  if (amount === null || !(Math.round(amount * 1e6) > 0)) errors.push('Amount must be a positive number.');
  const payoutCurrency = trimmedText_(form.payout_currency).toUpperCase() || currency;
  let fx = operationsNumber_(form.fx_rate);
  let payoutAmount = operationsNumber_(form.payout_amount);
  if (trimmedText_(form.fx_rate) !== '' && fx === null) errors.push('FX Rate must be a positive number.');
  if (trimmedText_(form.payout_amount) !== '' && payoutAmount === null) errors.push('Payout Amount must be a positive number.');
  if (payoutCurrency === currency) {
    if (fx !== null && fx !== 1) errors.push('Same-currency payout: FX Rate must be 1 or blank.');
    if (payoutAmount !== null && amount !== null && Math.round(payoutAmount * 1e6) !== Math.round(amount * 1e6)) {
      errors.push('Same-currency payout: Payout Amount must equal Amount or be blank.');
    }
    fx = 1;
    payoutAmount = amount;
  } else {
    if (fx === null || !(fx > 0)) errors.push('Payout in ' + payoutCurrency + ': FX Rate is required (> 0).');
    if (payoutAmount === null || !(payoutAmount > 0)) errors.push('Payout in ' + payoutCurrency + ': Payout Amount is required (> 0).');
  }
  return { errors: errors, payout: { seller_id: sellerId, currency: currency, payout_key: dateKey, amount: amount, payout_currency: payoutCurrency,
    fx_rate: fx, payout_amount: payoutAmount, payment_method: trimmedText_(form.payment_method), reference: trimmedText_(form.reference),
    notes: trimmedText_(form.notes) } };
}

/** True when an existing payout row carries exactly the values of the parsed form (retry of the same request). */
function operationsPayoutMatchesForm_(payout, parsed, dateKeyOf) {
  const same = function (a, b) { return operationsMicros_(a) === operationsMicros_(b); };
  return trimmedText_(payout.seller_id) === parsed.seller_id && trimmedText_(payout.currency) === parsed.currency &&
    sellerDateKeyOrNull_(payout.payout_date, dateKeyOf || masterDateKey_) === parsed.payout_key && same(payout.amount, parsed.amount) &&
    trimmedText_(payout.payout_currency) === parsed.payout_currency && same(payout.fx_rate, parsed.fx_rate) &&
    same(payout.payout_amount, parsed.payout_amount) && trimmedText_(payout.payment_method) === parsed.payment_method &&
    trimmedText_(payout.reference) === parsed.reference;
}

/**
 * Plans one DRAFT payout from the Operations form (pure; nothing written).
 * @param {Object} form raw form values
 * @param {{sellers, balances, payouts, allocations, items, settlements, adjustments, validation, payoutId, now, dateKeyOf?,
 *          dateFromKey?, digestHex?}} input
 * @return {{status: string, error: ?string, payout: ?Object, rows: Array<Object>, line: ?Object}}
 */
function planOperationsDraft_(form, input) {
  const fail = function (msg) { return { status: 'FAILED', error: msg, payout: null, rows: [], line: null }; };
  const dateKeyOf = input.dateKeyOf || masterDateKey_;
  const v = input.validation;
  const lines = buildOperationsLines_({ balances: input.balances, states: v.states, payouts: input.payouts, allocations: input.allocations });
  const parsed = parseOperationsForm_(form, { sellers: input.sellers, lines: lines, dateKeyOf: dateKeyOf });
  if (parsed.errors.length > 0) return fail(parsed.errors.join(' '));
  const ledgerErrors = flattenAllocationErrors_(v.errors);
  if (ledgerErrors.length > 0) {
    return fail('Seller Payout Allocations is invalid; fix it first (' + ledgerErrors.length + ' error(s)): ' + ledgerErrors.slice(0, 5).join(' | '));
  }
  const p = parsed.payout;
  const key = p.seller_id + '|' + p.currency;
  const l = lines[key];
  const amount = Math.round(p.amount * 1e6);
  const tol = SELLER_ALLOCATIONS.toleranceMicros;
  if (amount > l.available_to_draft + tol) {
    return fail('Amount ' + p.amount + ' ' + p.currency + ' exceeds what ' + p.seller_id + ' can still be paid: available to draft ' +
      l.available_to_draft / 1e6 + ' (balance ' + l.current / 1e6 + ' - DRAFT reserved ' + l.draft_reserved / 1e6 +
      '; open obligations not claimed by another DRAFT ' + (l.open_remaining - l.draft_claimed) / 1e6 + ').');
  }
  const timeline = v.timeline[key] || { seller_id: p.seller_id, currency: p.currency, credits: [], payouts: [], undated: [] };
  const payableAsOf = sellerPayableAsOf_(timeline, p.payout_key) - l.draft_reserved;
  if (amount > payableAsOf + tol) {
    return fail('Amount ' + p.amount + ' ' + p.currency + ' exceeds the payable balance of ' + p.seller_id + ' as of ' + formatOperationsDate_(p.payout_key) +
      ' (' + payableAsOf / 1e6 + ' after other DRAFT payouts).');
  }
  const payout = { seller_payout_id: input.payoutId, seller_id: p.seller_id, payout_date: (input.dateFromKey || masterDateFromKey_)(p.payout_key),
    currency: p.currency, amount: p.amount, fx_rate: p.fx_rate, payout_currency: p.payout_currency, payout_amount: p.payout_amount,
    payment_method: p.payment_method, reference: p.reference, status: SELLER_ALLOCATIONS.draftStatus, notes: p.notes };
  const payoutsById = {};
  input.payouts.forEach(function (x) { payoutsById[trimmedText_(x.seller_payout_id)] = x; });
  if (payoutsById[input.payoutId]) return fail('Seller Payout ' + input.payoutId + ' already exists.');
  payoutsById[input.payoutId] = payout;
  const plan = planFifoAllocation_(payout, input.allocations, v, payoutsById, input.now, input.digestHex);
  if (plan.status !== 'SUCCESS') return fail(plan.error);
  const check = validateSellerPayoutAllocations_({ allocations: input.allocations.concat(plan.rows), payouts: input.payouts.concat([payout]),
    items: input.items, settlements: input.settlements, adjustments: input.adjustments, dateKeyOf: dateKeyOf, digestHex: input.digestHex });
  const planErrors = flattenAllocationErrors_(check.errors);
  if (planErrors.length > 0) return fail('The DRAFT + FIFO plan would be invalid; nothing written: ' + planErrors.slice(0, 5).join(' | '));
  return { status: 'READY', error: null, payout: payout, rows: plan.rows, line: l, parsed: p };
}

/** Field checks of a payout about to become / stay effective (SENT / CONFIRMED). */
function operationsPayoutFieldErrors_(p, sellerIds, dateKeyOf) {
  const errors = [];
  const id = trimmedText_(p.seller_payout_id);
  const currency = trimmedText_(p.currency);
  if (sellerIds.indexOf(trimmedText_(p.seller_id)) < 0) errors.push('Seller Payout ' + id + ': unknown seller ' + p.seller_id + '.');
  if (currency === '') errors.push('Seller Payout ' + id + ': currency is blank.');
  if (!isFiniteNumber_(p.amount) || !(Math.round(p.amount * 1e6) > 0)) errors.push('Seller Payout ' + id + ': amount must be a positive number.');
  if (!sellerDateKeyOrNull_(p.payout_date, dateKeyOf)) errors.push('Seller Payout ' + id + ': payout_date must be a valid date.');
  const payoutCurrency = trimmedText_(p.payout_currency);
  if (payoutCurrency === '' || payoutCurrency === currency) {
    if (!isBlankCell_(p.fx_rate) && p.fx_rate !== 1) errors.push('Seller Payout ' + id + ': same-currency payout needs fx_rate 1 (or blank).');
    if (!isBlankCell_(p.payout_amount) && operationsMicros_(p.payout_amount) !== operationsMicros_(p.amount)) {
      errors.push('Seller Payout ' + id + ': same-currency payout_amount must equal amount (or be blank).');
    }
  } else {
    if (!isFiniteNumber_(p.fx_rate) || !(p.fx_rate > 0)) errors.push('Seller Payout ' + id + ': fx_rate must be a positive number for a ' + payoutCurrency + ' payout.');
    if (!isFiniteNumber_(p.payout_amount) || !(p.payout_amount > 0)) errors.push('Seller Payout ' + id + ': payout_amount must be a positive number for a ' + payoutCurrency + ' payout.');
  }
  return errors;
}

/**
 * Plans one status transition (pure). Financial transitions (SENT / CONFIRMED / REVERSED) require a valid ledger before
 * and after the simulated change and a clean simulated Seller Balances rebuild; SENT additionally requires the payout to
 * be fully allocated. CANCELLED (DRAFT only) has no financial effect.
 * @param {{payouts, allocations, items, settlements, adjustments, validation, sellerIds, columns, reason?, dateKeyOf?,
 *          digestHex?}} input
 * @return {{status: string, error: ?string, payout: ?Object, from: ?string, to: string, allocations: Array, after: ?Object}}
 */
function planSellerPayoutTransition_(payoutId, toStatus, input) {
  const id = trimmedText_(payoutId);
  const fail = function (msg) { return { status: 'FAILED', error: msg, payout: null, from: null, to: toStatus, allocations: [], after: null }; };
  const allowed = OPERATIONS.transitions[toStatus];
  if (!allowed) return fail('Unsupported target status ' + toStatus + '.');
  const matches = input.payouts.filter(function (p) { return trimmedText_(p.seller_payout_id) === id; });
  if (matches.length !== 1) return fail('Expected exactly one Seller Payout ' + (id || '(blank)') + ', found ' + matches.length + '.');
  const payout = matches[0];
  const from = trimmedText_(payout.status);
  if (allowed.indexOf(from) < 0) return fail('Seller Payout ' + id + ' is ' + from + '; only ' + allowed.join(' / ') + ' -> ' + toStatus + ' is allowed.');
  if (toStatus === 'REVERSED' && trimmedText_(input.reason) === '') return fail('A reason is required to reverse Seller Payout ' + id + '.');
  const own = input.allocations.filter(function (a) { return trimmedText_(a.seller_payout_id) === id; });
  const result = { status: 'READY', error: null, payout: payout, from: from, to: toStatus, allocations: own, after: null };
  if (toStatus === 'CANCELLED') return result;
  const dateKeyOf = input.dateKeyOf || masterDateKey_;
  const before = flattenAllocationErrors_(input.validation.errors);
  if (before.length > 0) return fail('Seller Payout Allocations is invalid; fix it first (' + before.length + ' error(s)): ' + before.slice(0, 5).join(' | '));
  if (toStatus !== 'REVERSED') {
    const fieldErrors = operationsPayoutFieldErrors_(payout, input.sellerIds, dateKeyOf);
    if (fieldErrors.length > 0) return fail(fieldErrors.join(' '));
  }
  const simulated = input.payouts.map(function (p) { return p === payout ? Object.assign({}, p, { status: toStatus }) : p; });
  const after = validateSellerPayoutAllocations_({ allocations: input.allocations, payouts: simulated, items: input.items, settlements: input.settlements,
    adjustments: input.adjustments, dateKeyOf: dateKeyOf, digestHex: input.digestHex });
  if (toStatus === 'SENT') {
    const allocated = after.payoutAllocated[id] || 0;
    const amount = operationsMicros_(payout.amount);
    if (Math.abs(allocated - amount) > SELLER_ALLOCATIONS.toleranceMicros) {
      return fail('Seller Payout ' + id + ' is not fully allocated (' + allocated / 1e6 + ' of ' + amount / 1e6 + '); it stays DRAFT.');
    }
  }
  const afterErrors = flattenAllocationErrors_(after.errors);
  if (afterErrors.length > 0) return fail('Seller Payout ' + id + ' cannot become ' + toStatus + ' (' + afterErrors.length + ' error(s)): ' + afterErrors.slice(0, 5).join(' | '));
  const balances = buildSellerBalances_({ items: input.items, adjustments: input.adjustments, payouts: simulated, sellerIds: input.sellerIds,
    existing: [], now: null, columns: input.columns });
  const balanceErrors = flattenBalanceErrors_(balances.errors);
  if (balanceErrors.length > 0) return fail('Seller Balances would be invalid after ' + toStatus + ': ' + balanceErrors.slice(0, 5).join(' | '));
  result.after = after;
  return result;
}

/** Money per currency for the status section: a number for one currency, else "USD 1 | EUR 2" text. */
function operationsMoney_(byCurrency) {
  const keys = Object.keys(byCurrency).sort();
  if (keys.length === 0) return { value: 0, detail: '' };
  if (keys.length === 1) return { value: byCurrency[keys[0]] / 1e6, detail: keys[0] };
  return { value: keys.map(function (c) { return c + ' ' + byCurrency[c] / 1e6; }).join(' | '), detail: 'multiple currencies' };
}

/**
 * Pure render model of the Operations tab from canonical data.
 * @param {{schemaVersion, pipeline, health, providers, sellers, balances, payouts, allocations, states, activeDestinations, dateKeyOf?}} input
 * @return {{status: Array<Array>, payable: Array<Array>, payouts: Array<Array>, lines: Object}}
 */
function buildOperationsView_(input) {
  const dateKeyOf = input.dateKeyOf || masterDateKey_;
  const lines = buildOperationsLines_(input);
  const keys = Object.keys(lines).sort();
  const sum = function (f, filter) {
    const out = {};
    keys.forEach(function (k) { if (!filter || filter(lines[k])) out[lines[k].currency] = (out[lines[k].currency] || 0) + lines[k][f]; });
    return out;
  };
  const available = operationsMoney_(sum('current', function (l) { return l.has_balance; }));
  const hold = operationsMoney_(sum('hold', function (l) { return l.has_balance; }));
  const effective = {};
  let effectiveCount = 0;
  (input.payouts || []).forEach(function (p) {
    if (SELLER_ALLOCATIONS.effectiveStatuses.indexOf(trimmedText_(p.status)) < 0) return;
    effectiveCount++;
    effective[trimmedText_(p.currency)] = (effective[trimmedText_(p.currency)] || 0) + operationsMicros_(p.amount);
  });
  const effectiveMoney = operationsMoney_(effective);
  const drafts = operationsMoney_(sum('draft_reserved', function (l) { return l.draft_count > 0; }));
  const draftCount = keys.reduce(function (a, k) { return a + lines[k].draft_count; }, 0);
  const openCount = keys.reduce(function (a, k) { return a + lines[k].open_count; }, 0);
  const openRemaining = operationsMoney_(sum('open_remaining', function (l) { return l.open_remaining > 0; }));
  const pipeline = input.pipeline || {};
  const health = input.health || {};
  const providers = (input.providers || []).map(function (p) {
    return p.providerId + ': ' + (p.enabled ? 'ENABLED · ' + (p.problems.length === 0 ? 'raw sync OK' : p.problems.slice(0, 2).join('; ')) : 'DISABLED');
  });
  const destinations = input.activeDestinations || [];
  const status = [
    [input.schemaVersion === null || input.schemaVersion === undefined ? '' : input.schemaVersion, 'expected ' + APP.SCHEMA_VERSION],
    [pipeline.at || 'never', pipeline.run_id || ''],
    [pipeline.status || '', pipeline.error || ''],
    [health.status || 'never', health.at || ''],
    [providers.join(' | ') || 'none', ''],
    [available.value, available.detail],
    [hold.value, hold.detail],
    [effectiveMoney.value, effectiveCount + ' payout(s)' + (effectiveMoney.detail ? ' · ' + effectiveMoney.detail : '')],
    [drafts.value, draftCount + ' DRAFT(s)' + (drafts.detail ? ' · ' + drafts.detail : '')],
    [openCount, openRemaining.detail ? 'remaining ' + openRemaining.value + ' ' + openRemaining.detail : 'remaining 0'],
    [destinations.length, destinations.join(', ')],
  ];
  const names = {};
  (input.sellers || []).forEach(function (s) { names[s.seller_id] = s.seller_name; });
  const payable = keys.map(function (k) {
    const l = lines[k];
    return [l.seller_id, names[l.seller_id] || '', l.currency, l.current / 1e6, l.hold / 1e6, l.draft_reserved / 1e6, l.available_to_draft / 1e6,
      l.open_count, l.paid / 1e6, l.payment_state];
  });
  const allocated = {};
  (input.allocations || []).forEach(function (a) {
    const id = trimmedText_(a.seller_payout_id);
    allocated[id] = (allocated[id] || 0) + Math.max(0, operationsMicros_(a.allocated_amount));
  });
  const withKey = (input.payouts || []).filter(function (p) { return trimmedText_(p.seller_payout_id) !== ''; }).map(function (p) {
    return { p: p, key: sellerDateKeyOrNull_(p.payout_date, dateKeyOf) || '', id: trimmedText_(p.seller_payout_id) };
  }).sort(function (a, b) { return compareCanonicalValues_(b.key, a.key) || compareCanonicalValues_(b.id, a.id); });
  const active = withKey.filter(function (x) { return OPERATIONS.activeStatuses.indexOf(trimmedText_(x.p.status)) >= 0; });
  const closed = withKey.filter(function (x) { return OPERATIONS.activeStatuses.indexOf(trimmedText_(x.p.status)) < 0; }).slice(0, OPERATIONS.recentClosedLimit);
  const shown = active.concat(closed).sort(function (a, b) { return compareCanonicalValues_(b.key, a.key) || compareCanonicalValues_(b.id, a.id); });
  const payouts = shown.map(function (x) {
    const p = x.p;
    const a = allocated[x.id] || 0;
    const amount = isFiniteNumber_(p.amount) ? Math.round(p.amount * 1e6) : null;
    const tol = SELLER_ALLOCATIONS.toleranceMicros;
    const completeness = amount === null ? 'INVALID AMOUNT' : a <= tol ? 'NONE' : Math.abs(a - amount) <= tol ? 'FULL' : a < amount ? 'PARTIAL' : 'OVER';
    return [x.id, trimmedText_(p.seller_id), formatOperationsDate_(x.key), isFiniteNumber_(p.amount) ? p.amount : '', trimmedText_(p.currency),
      isFiniteNumber_(p.payout_amount) ? p.payout_amount : '', trimmedText_(p.payout_currency), trimmedText_(p.payment_method),
      trimmedText_(p.reference), trimmedText_(p.status), a / 1e6, completeness];
  });
  return { status: status, payable: payable, payouts: payouts, lines: lines };
}

/** Rows (1-based sheet rows) of the payouts table, located by its title in column A at/after dynamicStartRow. */
function locateOperationsPayoutTable_(columnA, firstRow) {
  const start = firstRow || 1;
  for (let i = 0; i < columnA.length; i++) {
    if (trimmedText_(columnA[i]) !== OPERATIONS.payoutsTitle) continue;
    const header = start + i + 1;
    let last = header;
    for (let j = i + 2; j < columnA.length && trimmedText_(columnA[j]) !== ''; j++) last = start + j;
    return { header: header, first: header + 1, last: last };
  }
  return null;
}

/** Hidden-state plan of a view. Master tabs only; custom tabs are never touched; staging / swap tabs always hidden. */
function planOperationsView_(mode, sheetNames, masterTabs) {
  const show = [];
  const hide = [];
  sheetNames.forEach(function (n) {
    if (n.indexOf(STAGING_SHEET_PREFIX) === 0 || n.indexOf(SWAP_SHEET_PREFIX) === 0) { hide.push(n); return; }
    if (masterTabs.indexOf(n) < 0) return;
    if (mode === 'TECHNICAL' || OPERATIONS.operatorVisibleTabs.indexOf(n) >= 0) show.push(n);
    else hide.push(n);
  });
  return { show: show, hide: hide };
}

/** Plain-text summary of an operation result for a UI alert. */
function formatOperationsAlert_(result) {
  const lines = [String(result.status || '') + (result.seller_payout_id ? ' · ' + result.seller_payout_id : '')];
  if (result.error) lines.push(result.error);
  if (result.old_status || result.new_status) lines.push('Status: ' + (result.old_status || '(new)') + ' -> ' + (result.new_status || ''));
  if (result.allocations && result.allocations.length) {
    lines.push('Allocated: ' + result.allocations.map(function (a) { return a.target_type + ' ' + a.target_id + ' ' + a.allocated_amount; }).join('; '));
  }
  ['seller_balances', 'ledger', 'health', 'seller_sheet'].forEach(function (k) { if (result[k]) lines.push(k + ': ' + result[k]); });
  if (result.warnings && result.warnings.length) lines.push(result.warnings.join(' '));
  return lines.join('\n');
}

/* ---------------------------------- I/O --------------------------------- */

function operationsMasterTabs_() {
  return Object.keys(SHEETS).map(function (k) { return SHEETS[k]; });
}

function operationsSheetOrThrow_(ss) {
  const sheet = ss.getSheetByName(SHEETS.OPERATIONS);
  if (!sheet) throw new Error('Operations tab not found. Run setupMaster first.');
  return sheet;
}

/**
 * Setup: creates the Operations tab and (re)writes its labels, help text and input formats. Operator input cells
 * (column B of the form) are never overwritten; a missing request token is generated.
 */
function ensureOperationsLayout_(ss) {
  const sheet = ss.getSheetByName(SHEETS.OPERATIONS) || ss.insertSheet(SHEETS.OPERATIONS, 0);
  const O = OPERATIONS;
  sheet.getRange(1, 1).setValue(O.title).setFontWeight('bold').setFontSize(14);
  sheet.getRange(2, 1).setValue(O.note).setFontColor('#666666');
  sheet.getRange(O.refreshedRow, 1).setValue('Last refreshed');
  sheet.getRange(O.statusHeaderRow, 1, 1, 3).setValues([['SYSTEM STATUS', 'Value', 'Detail']]).setFontWeight('bold').setBackground(HEADER_BACKGROUND);
  sheet.getRange(O.statusStartRow, 1, O.statusLabels.length, 1).setValues(O.statusLabels.map(function (l) { return [l]; }));
  sheet.getRange(O.formHeaderRow, 1, 1, 3).setValues([['NEW PAYOUT (menu Payment Master > Payouts > Create Draft + FIFO)', 'Input', 'Help']])
    .setFontWeight('bold').setBackground(HEADER_BACKGROUND);
  sheet.getRange(O.formStartRow, 1, O.formFields.length, 1).setValues(O.formFields.map(function (f) { return [f[1]]; }));
  sheet.getRange(O.formStartRow, 3, O.formFields.length, 1).setValues(O.formFields.map(function (f) { return [f[2]]; })).setFontColor('#666666');
  sheet.getRange(O.tokenRow, 1, 2, 1).setValues([[O.tokenLabel], [O.resultLabel]]);
  sheet.getRange(O.tokenRow, 3).setValue('Changes after each created payout; a retry with the same token never creates a second payout.').setFontColor('#666666');
  const row = function (key) { return O.formStartRow + O.formFields.map(function (f) { return f[0]; }).indexOf(key); };
  sheet.getRange(row('payout_date'), 2).setNumberFormat('@'); // typed dd/MM/yyyy stays text: never re-parsed by the en_US locale
  sheet.getRange(row('amount'), 2).setNumberFormat(FORMATS.AMOUNT4);
  sheet.getRange(row('fx_rate'), 2).setNumberFormat(FORMATS.FX_RATE);
  sheet.getRange(row('payout_amount'), 2).setNumberFormat(FORMATS.AMOUNT4);
  sheet.getRange(O.tokenRow, 2).setNumberFormat('@');
  if (trimmedText_(sheet.getRange(O.tokenRow, 2).getValue()) === '') sheet.getRange(O.tokenRow, 2).setValue(Utilities.getUuid());
  sheet.setColumnWidth(1, 260);
  sheet.setColumnWidth(2, 200);
  sheet.setColumnWidth(3, 320);
  return sheet;
}

/** Reads the form (column B) and the request token. */
function readOperationsForm_(sheet) {
  const O = OPERATIONS;
  const values = sheet.getRange(O.formStartRow, 2, O.formFields.length + 1, 1).getValues();
  const form = {};
  O.formFields.forEach(function (f, i) { form[f[0]] = values[i][0]; });
  form.token = trimmedText_(values[O.formFields.length][0]);
  return form;
}

/** Latest pipeline run and health check from the tail of the Audit Log (read-only). */
function readOperationsAuditStatus_(ss) {
  const out = { pipeline: null, health: null };
  const sheet = ss.getSheetByName(SHEETS.AUDIT_LOG);
  if (!sheet) return out;
  const last = sheet.getLastRow();
  if (last < 2) return out;
  const n = Math.min(last - 1, OPERATIONS.auditScanRows);
  const rows = sheet.getRange(last - n + 1, 1, n, 8).getValues();
  for (let i = rows.length - 1; i >= 0 && (!out.pipeline || !out.health); i--) {
    const action = String(rows[i][1]);
    if (!out.pipeline && ['PIPELINE_SUCCESS', 'PIPELINE_FAILED', 'PIPELINE_SKIPPED_LOCKED'].indexOf(action) >= 0) {
      let error = '';
      try { error = String((JSON.parse(String(rows[i][7] || '{}')) || {}).error || ''); } catch (e) { error = ''; }
      out.pipeline = { at: rows[i][0], status: String(rows[i][5]), run_id: String(rows[i][3]), error: error.slice(0, 200) };
    }
    if (!out.health && (action === 'HEALTH_CHECK_PASS' || action === 'HEALTH_CHECK_FAIL')) {
      out.health = { at: rows[i][0], status: action === 'HEALTH_CHECK_PASS' ? 'PASS' : 'FAIL' };
    }
  }
  return out;
}

/** Re-renders the Operations tab from canonical Master data (writes the Operations tab only). Throws on a missing tab. */
function renderOperations_(ss, lastResult) {
  const O = OPERATIONS;
  const sheet = operationsSheetOrThrow_(ss);
  const problems = [];
  const attempt = function (label, f, fallback) {
    try { return f(); } catch (err) { problems.push(label + ': ' + (err && err.message ? err.message : String(err))); return fallback; }
  };
  const settings = attempt('Settings', function () { return readSettingsMap_(); }, {});
  const audit = attempt('Audit Log', function () { return readOperationsAuditStatus_(ss); }, { pipeline: null, health: null });
  const sources = pipelineRawSources_();
  const providers = attempt('Providers', function () {
    const raw = readRawSyncHealth_(ss);
    return Object.keys(sources).sort().map(function (k) {
      const s = sources[k];
      return { providerId: s.providerId, enabled: isSettingEnabled_(settings[s.enabledSetting]),
        problems: raw.filter(function (x) { return s.tabs.some(function (t) { return x.indexOf(t.targetSheet) === 0; }); }) };
    });
  }, []);
  const sellers = attempt('Sellers', function () { return readSellersDraft_(ss).parsed.sellers; }, []);
  const balances = attempt('Seller Balances', function () { return readSchemaTableObjects_(ss, SHEETS.SELLER_BALANCES, sellerBalancesTab_()).rows; }, []);
  const ledger = attempt('Seller Payout Allocations', function () { return readSellerAllocationInputs_(ss); }, null);
  const destinations = attempt('Seller Destinations', function () {
    return readSellerDestinations_(ss).parsed.active.map(function (d) { return d.seller_id; });
  }, []);
  if (ledger && flattenAllocationErrors_(ledger.validation.errors).length > 0) problems.push('Seller Payout Allocations has validation errors (see Verify Seller Payouts).');
  const view = buildOperationsView_({ schemaVersion: settings.schema_version, pipeline: audit.pipeline, health: audit.health, providers: providers,
    sellers: sellers, balances: balances, payouts: ledger ? ledger.payouts : [], allocations: ledger ? ledger.allocations : [],
    states: ledger ? ledger.validation.states : [], activeDestinations: destinations });

  const now = new Date();
  sheet.getRange(O.refreshedRow, 2, 1, 2).setValues([[now, problems.length ? 'WARNING: ' + problems.join(' | ').slice(0, 900) : 'ok']]);
  sheet.getRange(O.refreshedRow, 2).setNumberFormat(FORMATS.DATETIME);
  sheet.getRange(O.statusStartRow, 2, view.status.length, 2).setValues(view.status);
  sheet.getRange(O.statusStartRow + 1, 2).setNumberFormat(FORMATS.DATETIME); // latest pipeline run (value)
  sheet.getRange(O.statusStartRow + 3, 3).setNumberFormat(FORMATS.DATETIME); // latest health check (detail)
  [5, 6, 7, 8].forEach(function (i) { sheet.getRange(O.statusStartRow + i, 2).setNumberFormat(FORMATS.AMOUNT4); });

  // Form helpers (inputs are never overwritten, only blank defaults and dropdown lists).
  const fieldRow = function (key) { return O.formStartRow + O.formFields.map(function (f) { return f[0]; }).indexOf(key); };
  const activeSellers = sellers.filter(function (s) { return s.seller_id !== '' && s.status === 'ACTIVE'; });
  if (activeSellers.length > 0) {
    sheet.getRange(fieldRow('seller'), 2).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(activeSellers.map(operationsSellerOption_), true).setAllowInvalid(false).build());
  }
  const currencies = Object.keys(view.lines).map(function (k) { return view.lines[k].currency; })
    .filter(function (c, i, a) { return c !== '' && a.indexOf(c) === i; }).sort();
  if (currencies.length > 0) {
    sheet.getRange(fieldRow('currency'), 2).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(currencies, true).setAllowInvalid(false).build());
  }
  const dateCell = sheet.getRange(fieldRow('payout_date'), 2);
  if (trimmedText_(dateCell.getValue()) === '') dateCell.setValue(formatOperationsDate_(masterDateKey_(now)));
  const tokenCell = sheet.getRange(O.tokenRow, 2);
  const token = trimmedText_(tokenCell.getValue());
  const used = ledger && ledger.payouts.some(function (p) { return trimmedText_(p.seller_payout_id) === operationsPayoutId_(token); });
  if (token === '' || used) tokenCell.setValue(Utilities.getUuid());
  if (lastResult) {
    sheet.getRange(O.resultRow, 2, 1, 2).setValues([[String(lastResult.status || ''), formatOperationsAlert_(lastResult).slice(0, 900)]]);
  }

  // Dynamic tables (owned: columns A-L from dynamicStartRow down).
  const width = O.width;
  const lastRow = sheet.getLastRow();
  if (lastRow >= O.dynamicStartRow) sheet.getRange(O.dynamicStartRow, 1, lastRow - O.dynamicStartRow + 1, width).clearContent();
  const pad = function (r) { const x = r.slice(); while (x.length < width) x.push(''); return x; };
  const block = [pad([O.payableTitle]), pad(O.payableHeaders.slice())].concat(view.payable.map(pad));
  const payoutTitleRow = O.dynamicStartRow + block.length + 1;
  const all = block.concat([pad([])], [pad([O.payoutsTitle]), pad(O.payoutHeaders.slice())], view.payouts.map(pad));
  const needed = O.dynamicStartRow + all.length - 1;
  if (sheet.getMaxRows() < needed) sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
  sheet.getRange(O.dynamicStartRow, 1, all.length, width).setValues(all);
  [O.dynamicStartRow, O.dynamicStartRow + 1, payoutTitleRow, payoutTitleRow + 1].forEach(function (r) {
    sheet.getRange(r, 1, 1, width).setFontWeight('bold');
  });
  if (view.payable.length > 0) sheet.getRange(O.dynamicStartRow + 2, 4, view.payable.length, 4).setNumberFormat(FORMATS.AMOUNT4);
  if (view.payable.length > 0) sheet.getRange(O.dynamicStartRow + 2, 9, view.payable.length, 1).setNumberFormat(FORMATS.AMOUNT4);
  if (view.payouts.length > 0) {
    sheet.getRange(payoutTitleRow + 2, 3, view.payouts.length, 1).setNumberFormat('@');
    [4, 6, 11].forEach(function (c) { sheet.getRange(payoutTitleRow + 2, c, view.payouts.length, 1).setNumberFormat(FORMATS.AMOUNT4); });
  }
  return { problems: problems, payable_rows: view.payable.length, payout_rows: view.payouts.length };
}

/** Names of the non-staging tabs that are hidden now. */
function hiddenOperationsTabs_(ss) {
  return ss.getSheets().filter(function (s) { return s.isSheetHidden() && s.getName().indexOf(STAGING_SHEET_PREFIX) !== 0; })
    .map(function (s) { return s.getName(); });
}

/** Re-hides tabs that were hidden before a run (a crash-safe swap shows the tab it writes); never unhides anything. */
function restoreHiddenOperationsTabs_(ss, names) {
  (names || []).forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && !s.isSheetHidden()) s.hideSheet();
  });
}

function operationsAudit_(action, entityId, oldStatus, newStatus, details) {
  try {
    appendAuditLog_({ action: action, entityType: 'SELLER_PAYOUT', entityId: entityId || '', oldStatus: oldStatus || '', newStatus: newStatus || '',
      details: redactDeep_(details) });
  } catch (err) {
    Logger.log('Failed to write audit entry: %s', err);
  }
}

/** Payout fields for audit details (no secrets: Seller Payouts holds none). */
function operationsPayoutAuditFields_(p, allocations) {
  return { seller_payout_id: trimmedText_(p.seller_payout_id), seller_id: trimmedText_(p.seller_id), currency: trimmedText_(p.currency),
    amount: p.amount, payout_currency: trimmedText_(p.payout_currency), payout_amount: p.payout_amount, fx_rate: p.fx_rate,
    payout_date: sellerDateKeyOrNull_(p.payout_date, masterDateKey_), payment_method: trimmedText_(p.payment_method),
    reference: trimmedText_(p.reference),
    allocation_targets: (allocations || []).map(function (a) {
      return { target_type: trimmedText_(a.target_type), target_id: trimmedText_(a.target_id), allocated_amount: a.allocated_amount };
    }) };
}

/**
 * Runs one operator operation under the DOCUMENT lock (same outer lock as the scheduled pipeline). Keeps the tabs that
 * were hidden hidden, re-renders Operations and audits a failure. Never throws.
 */
function withOperationsLock_(operation, fn) {
  const lock = LockService.getDocumentLock();
  if (!lock || !lock.tryLock(OPERATIONS.lockWaitMs)) {
    const skipped = { status: 'SKIPPED_LOCKED', operation: operation,
      error: 'Another pipeline run or payout operation holds the lock; nothing changed. Try again in a minute.' };
    operationsAudit_(OPERATIONS.lockedAction, '', '', 'SKIPPED', skipped);
    return skipped;
  }
  let result;
  let ss = null;
  let hidden = [];
  try {
    ss = getSpreadsheet_();
    hidden = hiddenOperationsTabs_(ss);
    result = fn(ss);
  } catch (err) {
    result = { status: 'FAILED', operation: operation, error: redactEndpointCredentials_(err && err.message ? err.message : String(err)) };
  }
  result.operation = result.operation || operation;
  if (result.status === 'FAILED') {
    operationsAudit_(OPERATIONS.failedAction, result.seller_payout_id, result.old_status, 'FAILED', result);
  }
  try {
    if (ss) restoreHiddenOperationsTabs_(ss, hidden);
  } catch (err) {
    result.warnings = (result.warnings || []).concat(['Could not restore hidden tabs: ' + err.message]);
  }
  try {
    if (ss) renderOperations_(ss, result);
  } catch (err) {
    result.warnings = (result.warnings || []).concat(['Operations not refreshed: ' + err.message]);
  } finally {
    lock.releaseLock();
  }
  return redactDeep_(result);
}

/** fn() under the script lock (the canonical writers' lock). Never nested with a runner: released before runners run. */
function withOperationsScriptLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS)) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms; nothing changed.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Master layers a payout operation depends on must be current. Throws (nothing changed) otherwise. */
function assertOperationsAccountingCurrent_(ss) {
  const items = readSettlementItemsFreshness_(ss);
  if (!items.current) throw new Error('Settlement Items is not current (' + items.reason + '); run the pipeline first. Nothing changed.');
  const balances = readSellerBalancesFreshness_(ss, items);
  if (!balances.current) throw new Error('Seller Balances is not current (' + balances.reason + '); run the pipeline first. Nothing changed.');
}

/** Seller Payouts rows with their sheet row numbers (blank rows skipped). */
function readSellerPayoutRows_(ss) {
  const sheet = ss.getSheetByName(SHEETS.SELLER_PAYOUTS);
  if (!sheet) throw new Error('Seller Payouts tab not found.');
  const columns = getColumnNames_(SHEETS.SELLER_PAYOUTS);
  const grid = readSheetGrid_(sheet);
  tableRowsFromGrid_(grid.values, columns, SHEETS.SELLER_PAYOUTS); // header contract
  const rows = [];
  grid.values.slice(1).forEach(function (r, i) {
    if (r.every(isBlankCell_)) return;
    const o = rowToObject_(r.slice(0, columns.length), columns);
    o._row = i + 2;
    rows.push(o);
  });
  return { sheet: sheet, columns: columns, rows: rows };
}

function appendSellerPayoutRow_(ss, payout) {
  const sheet = ss.getSheetByName(SHEETS.SELLER_PAYOUTS);
  const columns = getColumnNames_(SHEETS.SELLER_PAYOUTS);
  const row = sheet.getLastRow() + 1;
  if (sheet.getMaxRows() < row) sheet.insertRowsAfter(sheet.getMaxRows(), row - sheet.getMaxRows());
  sheet.getRange(row, 1, 1, columns.length).setValues([objectToRow_(payout, columns)]);
  return row;
}

/** Writes the status (and optionally notes) of exactly one payout whose current status is `from`. */
function writeSellerPayoutStatus_(ss, payoutId, from, to, notes) {
  const table = readSellerPayoutRows_(ss);
  const matches = table.rows.filter(function (r) { return trimmedText_(r.seller_payout_id) === payoutId; });
  if (matches.length !== 1) throw new Error('Expected exactly one Seller Payout ' + payoutId + ', found ' + matches.length + '; nothing changed.');
  if (trimmedText_(matches[0].status) !== from) throw new Error('Seller Payout ' + payoutId + ' changed meanwhile (now ' + matches[0].status + '); nothing changed.');
  table.sheet.getRange(matches[0]._row, table.columns.indexOf('status') + 1).setValue(to);
  if (notes !== null && notes !== undefined) table.sheet.getRange(matches[0]._row, table.columns.indexOf('notes') + 1).setValue(notes);
}

function operationsSellerIds_(ss) {
  return readSellersDraft_(ss).parsed.sellers.map(function (s) { return s.seller_id; }).filter(function (id) { return id !== ''; });
}

/** Creates one DRAFT payout from the Operations form and allocates it FIFO. Never throws. */
function runCreateDraftFromOperations_() {
  return withOperationsLock_('CREATE_DRAFT', function (ss) {
    const sheet = operationsSheetOrThrow_(ss);
    const form = readOperationsForm_(sheet);
    if (form.token === '') throw new Error('Request token is missing; run Refresh Operations. Nothing changed.');
    const payoutId = operationsPayoutId_(form.token);
    const result = { status: 'FAILED', operation: 'CREATE_DRAFT', seller_payout_id: payoutId, old_status: '', new_status: '', warnings: [] };
    assertOperationsAccountingCurrent_(ss);
    let created = false;
    let payout = null;
    withOperationsScriptLock_(function () {
      const input = readSellerAllocationInputs_(ss);
      const sellers = readSellersDraft_(ss).parsed.sellers;
      const balances = readSchemaTableObjects_(ss, SHEETS.SELLER_BALANCES, sellerBalancesTab_()).rows;
      const existing = input.payouts.filter(function (p) { return trimmedText_(p.seller_payout_id) === payoutId; });
      if (existing.length > 0) {
        // Retry of the same request: the payout exists; it must be exactly what the form says.
        const lines = buildOperationsLines_({ balances: balances, states: input.validation.states, payouts: input.payouts, allocations: input.allocations });
        const parsed = parseOperationsForm_(form, { sellers: sellers, lines: lines, dateKeyOf: masterDateKey_ });
        if (existing.length > 1 || parsed.errors.length > 0 || !operationsPayoutMatchesForm_(existing[0], parsed.payout, masterDateKey_)) {
          throw new Error('Request token already used by Seller Payout ' + payoutId + ' with other values; run Refresh Operations for a new token. Nothing changed.');
        }
        if (trimmedText_(existing[0].status) !== SELLER_ALLOCATIONS.draftStatus) {
          throw new Error('Seller Payout ' + payoutId + ' (this request) is already ' + existing[0].status + '; nothing changed.');
        }
        payout = existing[0];
        return;
      }
      const plan = planOperationsDraft_(form, { sellers: sellers, balances: balances, payouts: input.payouts, allocations: input.allocations,
        items: input.items, settlements: input.settlements, adjustments: input.adjustments, validation: input.validation, payoutId: payoutId,
        now: new Date(Math.floor(Date.now() / 1000) * 1000) });
      if (plan.status !== 'READY') throw new Error(plan.error + ' Nothing changed.');
      appendSellerPayoutRow_(ss, plan.payout);
      payout = plan.payout;
      created = true;
    });
    // FIFO: the existing allocator (own script lock); oldest obligation first. It never changes the payout status.
    const fifo = runSellerPayoutFifo_(payoutId);
    result.fifo_status = fifo.status;
    result.draft_created = created;
    const after = readSellerAllocationInputs_(ss);
    const own = after.allocations.filter(function (a) { return trimmedText_(a.seller_payout_id) === payoutId; });
    const allocated = own.reduce(function (s, a) { return s + operationsMicros_(a.allocated_amount); }, 0);
    result.allocations = own.map(function (a) { return { target_type: a.target_type, target_id: a.target_id, allocated_amount: a.allocated_amount }; });
    Object.assign(result, operationsPayoutAuditFields_(payout, own));
    if (fifo.status === 'FAILED' || Math.abs(allocated - operationsMicros_(payout.amount)) > SELLER_ALLOCATIONS.toleranceMicros) {
      result.error = 'DRAFT ' + payoutId + (created ? ' was created' : ' exists') + ' but is not fully allocated (' + allocated / 1e6 + ' of ' + payout.amount +
        ')' + (fifo.error ? ': ' + fifo.error : '') + '. A DRAFT has no financial effect and cannot be marked SENT; cancel it or fix the cause and retry.';
      result.new_status = SELLER_ALLOCATIONS.draftStatus;
      return result;
    }
    result.status = created ? 'SUCCESS' : 'NO_CHANGE';
    result.new_status = SELLER_ALLOCATIONS.draftStatus;
    if (!created) result.warnings.push('Same request token: Seller Payout ' + payoutId + ' already exists; no second payout created.');
    operationsAudit_(OPERATIONS.auditActions.DRAFT, payoutId, '', SELLER_ALLOCATIONS.draftStatus, Object.assign({ request: created ? 'NEW' : 'RETRY' },
      operationsPayoutAuditFields_(payout, own)));
    // The request is complete: rotate the token and clear the amount fields, so a second click cannot repeat it.
    const fieldRow = function (key) { return OPERATIONS.formStartRow + OPERATIONS.formFields.map(function (f) { return f[0]; }).indexOf(key); };
    ['amount', 'fx_rate', 'payout_amount', 'reference', 'notes'].forEach(function (k) { sheet.getRange(fieldRow(k), 2).setValue(''); });
    sheet.getRange(OPERATIONS.tokenRow, 2).setValue(Utilities.getUuid());
    return result;
  });
}

/**
 * Applies one controlled status transition to one payout and, for financial transitions, refreshes Seller Balances,
 * re-verifies the ledger and health and syncs only the affected seller sheet. Never throws.
 * @param {function(Spreadsheet): {payout_id: string, status?: string}} select resolves the payout (e.g. the selected row)
 */
function runSellerPayoutTransition_(select, toStatus, reason) {
  const operation = 'MARK_' + toStatus;
  return withOperationsLock_(operation, function (ss) {
    const selected = select(ss);
    const payoutId = trimmedText_(selected.payout_id);
    const result = { status: 'FAILED', operation: operation, seller_payout_id: payoutId, old_status: '', new_status: '', warnings: [],
      reason: trimmedText_(reason) };
    const financial = toStatus !== 'CANCELLED';
    if (financial) assertOperationsAccountingCurrent_(ss);
    let plan = null;
    withOperationsScriptLock_(function () {
      const input = readSellerAllocationInputs_(ss);
      plan = planSellerPayoutTransition_(payoutId, toStatus, { payouts: input.payouts, allocations: input.allocations, items: input.items,
        settlements: input.settlements, adjustments: input.adjustments, validation: input.validation, sellerIds: operationsSellerIds_(ss),
        columns: getColumnNames_(SHEETS.SELLER_BALANCES), reason: reason });
      if (plan.status !== 'READY') throw new Error(plan.error + ' Nothing changed.');
      if (selected.status !== undefined && trimmedText_(selected.status) !== plan.from) {
        throw new Error('The Operations row shows ' + selected.status + ' but Seller Payout ' + payoutId + ' is ' + plan.from +
          '; run Refresh Operations and select again. Nothing changed.');
      }
      let notes = null;
      if (trimmedText_(reason) !== '') {
        const existing = trimmedText_(plan.payout.notes);
        notes = (existing ? existing + ' | ' : '') + toStatus + ' ' + masterDateKey_(new Date()) + ': ' + trimmedText_(reason);
      }
      writeSellerPayoutStatus_(ss, payoutId, plan.from, toStatus, notes);
    });
    result.old_status = plan.from;
    result.new_status = toStatus;
    Object.assign(result, operationsPayoutAuditFields_(plan.payout, plan.allocations));
    let ok = true;
    if (financial) {
      const balances = runSellerBalancesNormalizer_();
      result.seller_balances = balances.status + (balances.error ? ' (' + balances.error + ')' : '');
      if (['SUCCESS', 'NO_CHANGE'].indexOf(balances.status) < 0) ok = false;
      const ledger = readSellerAllocationInputs_(ss).validation;
      const ledgerErrors = flattenAllocationErrors_(ledger.errors);
      result.ledger = ledgerErrors.length === 0 ? 'VALID' : 'INVALID: ' + ledgerErrors.slice(0, 3).join(' | ');
      if (ledgerErrors.length > 0) ok = false;
      result.obligations = ledger.states.filter(function (s) { return s.seller_id === trimmedText_(plan.payout.seller_id); }).map(function (s) {
        return { target_type: s.target_type, target_id: s.target_id, due_amount: s.due_amount, paid_amount: s.paid_amount,
          remaining_amount: s.remaining_amount, payment_status: s.payment_status };
      });
      const health = ok ? buildPaymentPipelineHealth_() : { pass: false, checks: [], errors: ['skipped: Seller Balances / ledger not valid'] };
      const failedChecks = health.checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }).concat(health.errors);
      result.health = health.pass ? 'PASS' : 'FAIL: ' + failedChecks.slice(0, 5).join(' | ');
      if (ok) {
        operationsAudit_(health.pass ? 'HEALTH_CHECK_PASS' : 'HEALTH_CHECK_FAIL', payoutId, '', health.pass ? 'PASS' : 'FAIL', { failed_checks: failedChecks.slice(0, 10) });
      }
      const sellerId = trimmedText_(plan.payout.seller_id);
      if (!health.pass) {
        ok = false;
        result.seller_sheet = 'NOT SYNCED (health ' + (health.pass ? 'PASS' : 'FAIL') + ')';
      } else {
        const dest = readSellerDestinations_(ss).parsed.active.filter(function (d) { return d.seller_id === sellerId; })[0];
        if (!dest) {
          result.seller_sheet = 'SKIPPED (no ACTIVE Seller Destination for ' + sellerId + ')';
        } else {
          const sync = runSingleSellerSheetSync_(sellerId);
          result.seller_sheet = sync.status + (sync.error ? ' (' + sync.error + ')' : '');
          if (['SUCCESS', 'NO_CHANGE'].indexOf(sync.status) < 0) ok = false;
        }
      }
    }
    result.status = ok ? 'SUCCESS' : 'PARTIAL';
    if (!ok) {
      result.error = 'Seller Payout ' + payoutId + ' is now ' + toStatus + ' (recorded), but a follow-up step failed; run the pipeline (Run Full Sync) to finish.';
    }
    operationsAudit_(OPERATIONS.auditActions[toStatus], payoutId, plan.from, toStatus, Object.assign({ reason: trimmedText_(reason) || undefined,
      seller_balances: result.seller_balances, ledger: result.ledger, health: result.health, seller_sheet: result.seller_sheet,
      followup: result.status }, operationsPayoutAuditFields_(plan.payout, plan.allocations)));
    if (!ok) operationsAudit_(OPERATIONS.failedAction, payoutId, plan.from, toStatus, result);
    return result;
  });
}

/** The payout of the selected row of the Operations "RECENT / ACTIVE PAYOUTS" table. Read-only; throws a clear error. */
function readSelectedOperationsPayout_(ss) {
  const hint = 'Select one payout row in the Operations tab (section ' + OPERATIONS.payoutsTitle + ') first; nothing changed.';
  const sheet = ss.getActiveSheet();
  if (!sheet || sheet.getName() !== SHEETS.OPERATIONS) throw new Error(hint);
  const range = ss.getActiveRange();
  if (!range || range.getNumRows() !== 1) throw new Error('Select exactly one payout row. ' + hint);
  const row = range.getRow();
  const last = sheet.getLastRow();
  if (last < OPERATIONS.dynamicStartRow) throw new Error(hint);
  const columnA = sheet.getRange(OPERATIONS.dynamicStartRow, 1, last - OPERATIONS.dynamicStartRow + 1, 1).getValues().map(function (r) { return r[0]; });
  const table = locateOperationsPayoutTable_(columnA, OPERATIONS.dynamicStartRow);
  if (!table || row < table.first || row > table.last) throw new Error('The selected row is not a payout row. ' + hint);
  const values = sheet.getRange(row, 1, 1, OPERATIONS.width).getValues()[0];
  const id = trimmedText_(values[0]);
  if (id === '') throw new Error('The selected row has no seller_payout_id. ' + hint);
  return { payout_id: id, status: trimmedText_(values[OPERATIONS.payoutHeaders.indexOf('status')]), row: row };
}

/** Operator / Technical view: hides or shows Master tabs only (never data, never custom tabs). Never throws. */
function runApplyOperationsView_(mode) {
  const lock = LockService.getDocumentLock();
  if (!lock || !lock.tryLock(OPERATIONS.lockWaitMs)) {
    return { status: 'SKIPPED_LOCKED', mode: mode, error: 'A pipeline run or payout operation holds the lock; try again in a minute.' };
  }
  try {
    const ss = getSpreadsheet_();
    const names = ss.getSheets().map(function (s) { return s.getName(); });
    const plan = planOperationsView_(mode, names, operationsMasterTabs_());
    const first = ss.getSheetByName(mode === 'OPERATOR' ? SHEETS.OPERATIONS : SHEETS.SETTINGS) || ss.getSheetByName(plan.show[0]);
    plan.show.forEach(function (n) { const s = ss.getSheetByName(n); if (s.isSheetHidden()) s.showSheet(); });
    if (first) ss.setActiveSheet(first);
    plan.hide.forEach(function (n) { const s = ss.getSheetByName(n); if (!s.isSheetHidden()) s.hideSheet(); });
    return { status: 'SUCCESS', mode: mode, shown: plan.show, hidden: plan.hide };
  } catch (err) {
    return { status: 'FAILED', mode: mode, error: err && err.message ? err.message : String(err) };
  } finally {
    lock.releaseLock();
  }
}

/** Refreshes the Operations tab under the document lock. Never throws. */
function runRefreshOperations_() {
  const lock = LockService.getDocumentLock();
  if (!lock || !lock.tryLock(OPERATIONS.lockWaitMs)) {
    return { status: 'SKIPPED_LOCKED', error: 'A pipeline run or payout operation holds the lock; try again in a minute.' };
  }
  try {
    const r = renderOperations_(getSpreadsheet_(), null);
    return { status: r.problems.length === 0 ? 'SUCCESS' : 'WARNING', problems: r.problems, payable_rows: r.payable_rows, payout_rows: r.payout_rows };
  } catch (err) {
    return { status: 'FAILED', error: err && err.message ? err.message : String(err) };
  } finally {
    lock.releaseLock();
  }
}

/** Operator health check: the read-only pipeline health report, audited (HEALTH_CHECK_PASS / _FAIL) and shown in Operations. */
function runOperatorHealthCheck_() {
  const report = buildPaymentPipelineHealth_();
  const failed = report.checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name + ': ' + c.detail; }).concat(report.errors);
  try {
    appendAuditLog_({ action: report.pass ? 'HEALTH_CHECK_PASS' : 'HEALTH_CHECK_FAIL', entityType: 'OPERATIONS', entityId: '',
      newStatus: report.pass ? 'PASS' : 'FAIL', details: redactDeep_({ failed_checks: failed.slice(0, 10) }) });
  } catch (err) {
    Logger.log('Failed to write audit entry: %s', err);
  }
  runRefreshOperations_();
  return report;
}

/**
 * After a scheduled / manual pipeline run (outside its stages and lock): keeps the tabs that were hidden before the run
 * hidden and refreshes Operations. Best effort; never throws, never changes the pipeline result.
 */
function afterPaymentPipelineRun_(hiddenBefore) {
  const lock = LockService.getDocumentLock();
  if (!lock || !lock.tryLock(OPERATIONS.lockWaitMs)) return 'SKIPPED_LOCKED';
  try {
    const ss = getSpreadsheet_();
    restoreHiddenOperationsTabs_(ss, hiddenBefore);
    if (ss.getSheetByName(SHEETS.OPERATIONS)) renderOperations_(ss, null);
    return 'DONE';
  } catch (err) {
    Logger.log('Operations refresh after pipeline failed: %s', err);
    return 'FAILED';
  } finally {
    lock.releaseLock();
  }
}
