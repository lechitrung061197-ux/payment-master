/**
 * PayoutModal.gs
 * Server side of the "New Payout" modal (HtmlService, src/PayoutModalView.html). The modal is a UI only:
 *
 * - It is not an accounting authority. Every endpoint re-reads the canonical Master (Seller Balances, Seller Payouts,
 *   Seller Payout Allocations, Settlement Items, Settlements, Adjustments); numbers sent by the browser are never trusted.
 * - The FIFO preview runs planOperationsDraft_ / planFifoAllocation_ - the exact plan Create Draft validates - and writes
 *   nothing.
 * - Create Draft goes through createDraftRequest_ (the Operations form's guarded workflow: request token ->
 *   deterministic seller_payout_id, validation, DRAFT row, runSellerPayoutFifo_, full allocation, audit) under the
 *   DOCUMENT lock (DocumentLock outer -> ScriptLock inner).
 * - Status changes are named actions only (SEND / CONFIRM / CANCEL / REVERSE), mapped to the guarded
 *   runSellerPayoutTransition_ with the status the browser last saw (stale -> rejected). Retry Allocation reruns the
 *   existing FIFO allocator for an incomplete DRAFT. Set Payment Proof (runSetPayoutProof_) is the only payout edit:
 *   method + reference of a DRAFT. The client can never send a status value.
 * - Lists: open payouts (DRAFT / SENT, never dropped) and the 20 most recent CONFIRMED (still reversible).
 * - Dates: the Master timezone (America/New_York) on the server; the browser clock / timezone is never used.
 *
 * The first part of this file is pure (unit-tested in Node); the I/O part follows.
 */

const PAYOUT_MODAL = Object.freeze({
  // Apps Script file names must be unique across .gs and .html, so the page cannot be named PayoutModal too.
  htmlFile: 'src/PayoutModalView',
  title: 'New Payout',
  width: 980,
  height: 760,
  previewPayoutId: 'SP-PREVIEW',
  // Named actions -> target status (the only mutations the modal can request).
  actions: Object.freeze({ SEND: 'SENT', CONFIRM: 'CONFIRMED', CANCEL: 'CANCELLED', REVERSE: 'REVERSED' }),
  payloadKeys: Object.freeze(['token', 'seller_id', 'currency', 'payout_date', 'amount', 'payout_currency', 'fx_rate', 'payout_amount',
    'payment_method', 'reference', 'notes']),
});

/* ----------------------------- Pure helpers ----------------------------- */

/** JSON-safe copy for google.script.run (Dates -> ISO strings, no functions / undefined). */
function payoutModalSafe_(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

/** Actions valid for a payout status (what the modal may show). */
function payoutModalActions_(status, fullyAllocated) {
  if (status === 'DRAFT') return fullyAllocated ? ['SEND', 'CANCEL'] : ['RETRY_ALLOCATION', 'CANCEL'];
  if (status === 'SENT') return ['CONFIRM', 'REVERSE'];
  if (status === 'CONFIRMED') return ['REVERSE'];
  return [];
}

/** Whitelisted payload -> the form shape createDraftRequest_ / planOperationsDraft_ read. */
function payoutModalForm_(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const form = {};
  PAYOUT_MODAL.payloadKeys.forEach(function (k) {
    const v = p[k];
    form[k] = typeof v === 'number' || typeof v === 'string' ? v : '';
  });
  form.seller = form.seller_id;
  delete form.seller_id;
  return form;
}

/**
 * Open (not PAID) obligations of one seller + currency in FIFO order, with the DRAFT claims on each.
 * @return {Array<Object>} amounts in currency units
 */
function buildPayoutModalObligations_(states, payouts, allocations, sellerId, currency, dateKeyOf) {
  const drafts = {};
  (payouts || []).forEach(function (p) { if (trimmedText_(p.status) === SELLER_ALLOCATIONS.draftStatus) drafts[trimmedText_(p.seller_payout_id)] = true; });
  const claimed = {};
  (allocations || []).forEach(function (a) {
    if (!drafts[trimmedText_(a.seller_payout_id)]) return;
    const k = trimmedText_(a.target_type) + '|' + trimmedText_(a.target_id);
    claimed[k] = (claimed[k] || 0) + operationsMicros_(a.allocated_amount);
  });
  return (states || []).filter(function (s) { return s.seller_id === sellerId && s.currency === currency && s.payment_status !== 'PAID'; })
    .map(function (s) {
      const date = s.target_type === SELLER_ALLOCATIONS.settlementTarget ? s.source_payment_date : s.effective_date;
      const c = claimed[s.target_type + '|' + s.target_id] || 0;
      return { target_type: s.target_type, target_id: s.target_id, settlement_number: s.source_settlement_number || '',
        payment_source: s.payment_source, date: formatOperationsDate_(sellerDateKeyOrNull_(date, dateKeyOf || masterDateKey_)),
        due_amount: s.due_amount, paid_amount: s.paid_amount, remaining_amount: s.remaining_amount, draft_claimed: c / 1e6,
        open_amount: Math.max(0, operationsMicros_(s.remaining_amount) - c) / 1e6, payment_status: s.payment_status };
    });
}

/** FIFO preview rows from a planned allocation: remaining before, allocated now, status if this payout becomes effective. */
function buildPayoutPreview_(rows, obligations) {
  const byTarget = {};
  (rows || []).forEach(function (r) { byTarget[r.target_type + '|' + r.target_id] = (byTarget[r.target_type + '|' + r.target_id] || 0) + operationsMicros_(r.allocated_amount); });
  return obligations.map(function (o) {
    const allocated = byTarget[o.target_type + '|' + o.target_id] || 0;
    const paidAfter = operationsMicros_(o.paid_amount) + allocated;
    return { target_type: o.target_type, target_id: o.target_id, settlement_number: o.settlement_number, date: o.date,
      remaining_amount: o.open_amount, allocated_amount: allocated / 1e6, remaining_after: Math.max(0, operationsMicros_(o.open_amount) - allocated) / 1e6,
      status_now: o.payment_status, status_after: allocated > 0 ? sellerSettlementStatus_(operationsMicros_(o.due_amount), paidAfter) : o.payment_status };
  });
}

/** Open (DRAFT / SENT, all) and recent CONFIRMED (bounded) payout views, newest first. */
function payoutModalLists_(payouts, allocations, sellerId, dateKeyOf) {
  const views = (payouts || []).filter(function (p) { return trimmedText_(p.seller_payout_id) !== '' && (!sellerId || trimmedText_(p.seller_id) === sellerId); })
    .map(function (p) { return Object.assign(buildPayoutModalView_(p, allocations, dateKeyOf), { _key: sellerDateKeyOrNull_(p.payout_date, dateKeyOf || masterDateKey_) || '' }); })
    .sort(function (a, b) { return compareCanonicalValues_(b._key, a._key) || compareCanonicalValues_(b.seller_payout_id, a.seller_payout_id); });
  const strip = function (v) { delete v._key; return v; };
  return { open_payouts: views.filter(function (v) { return OPERATIONS.openStatuses.indexOf(v.status) >= 0; }).map(strip),
    recent_confirmed: views.filter(function (v) { return v.status === 'CONFIRMED'; }).slice(0, OPERATIONS.recentClosedLimit).map(strip) };
}

/** Read-only summary of one payout for the modal. */
function buildPayoutModalView_(payout, allocations, dateKeyOf) {
  const id = trimmedText_(payout.seller_payout_id);
  const own = (allocations || []).filter(function (a) { return trimmedText_(a.seller_payout_id) === id; });
  const allocated = own.reduce(function (s, a) { return s + operationsMicros_(a.allocated_amount); }, 0);
  const amount = operationsMicros_(payout.amount);
  const full = isFiniteNumber_(payout.amount) && Math.abs(allocated - amount) <= SELLER_ALLOCATIONS.toleranceMicros;
  const status = trimmedText_(payout.status);
  return { seller_payout_id: id, seller_id: trimmedText_(payout.seller_id), payout_date: formatOperationsDate_(sellerDateKeyOrNull_(payout.payout_date, dateKeyOf || masterDateKey_)),
    currency: trimmedText_(payout.currency), amount: payout.amount, payout_currency: trimmedText_(payout.payout_currency), payout_amount: payout.payout_amount,
    fx_rate: payout.fx_rate, payment_method: trimmedText_(payout.payment_method), reference: trimmedText_(payout.reference), notes: trimmedText_(payout.notes),
    status: status, allocated_amount: allocated / 1e6, allocation_status: allocated <= SELLER_ALLOCATIONS.toleranceMicros ? 'NONE' : full ? 'FULL' : 'PARTIAL',
    allocations: own.map(function (a) { return { target_type: trimmedText_(a.target_type), target_id: trimmedText_(a.target_id), allocated_amount: a.allocated_amount }; }),
    needs_proof: trimmedText_(payout.payment_method) === '' || trimmedText_(payout.reference) === '', actions: payoutModalActions_(status, full) };
}

/* ---------------------------------- I/O --------------------------------- */

/** Canonical reads shared by the modal endpoints (read-only). */
function readPayoutModalContext_(ss) {
  const input = readSellerAllocationInputs_(ss);
  const sellers = readSellersDraft_(ss).parsed.sellers;
  const balances = readSchemaTableObjects_(ss, SHEETS.SELLER_BALANCES, sellerBalancesTab_()).rows;
  const lines = buildOperationsLines_({ balances: balances, states: input.validation.states, payouts: input.payouts, allocations: input.allocations });
  return { input: input, sellers: sellers, balances: balances, lines: lines };
}

function payoutModalLine_(l, name) {
  return { seller_id: l.seller_id, seller_name: name, currency: l.currency, current_balance: l.current / 1e6, seller_hold_balance: l.hold / 1e6,
    draft_reserved: l.draft_reserved / 1e6, available_to_draft: l.available_to_draft / 1e6, open_obligations: l.open_count, effective_paid: l.paid / 1e6,
    payment_state: l.payment_state };
}

function payoutModalListsOf_(ctx, sellerId) {
  return payoutModalLists_(ctx.input.payouts, ctx.input.allocations, sellerId);
}

/** Modal start: ACTIVE sellers, the Master (New York) date, a fresh request token, active payouts to resume. Never throws. */
function runPayoutModalBootstrap_() {
  try {
    const ss = getSpreadsheet_();
    const ctx = readPayoutModalContext_(ss);
    return payoutModalSafe_({ status: 'SUCCESS', master_timezone: APP.TIMEZONE, today: formatOperationsDate_(masterDateKey_(new Date())),
      token: Utilities.getUuid(), sellers: ctx.sellers.filter(function (s) { return s.seller_id !== '' && s.status === 'ACTIVE'; })
        .map(function (s) { return { seller_id: s.seller_id, seller_name: s.seller_name }; }),
      lists: payoutModalListsOf_(ctx, '') });
  } catch (err) {
    return { status: 'FAILED', error: err && err.message ? err.message : String(err) };
  }
}

/** One ACTIVE seller: payable lines per currency, open obligations (FIFO order) and active payouts. Never throws. */
function runPayoutModalSeller_(sellerId) {
  try {
    const id = trimmedText_(sellerId);
    const ss = getSpreadsheet_();
    const ctx = readPayoutModalContext_(ss);
    const seller = ctx.sellers.filter(function (s) { return s.seller_id === id; })[0];
    if (!seller) throw new Error('Seller ' + (id || '(blank)') + ' is not in Sellers.');
    if (seller.status !== 'ACTIVE') throw new Error('Seller ' + id + ' is ' + seller.status + '; only ACTIVE sellers can be paid.');
    const lines = Object.keys(ctx.lines).sort().map(function (k) { return ctx.lines[k]; }).filter(function (l) { return l.seller_id === id; });
    const obligations = {};
    lines.forEach(function (l) {
      obligations[l.currency] = buildPayoutModalObligations_(ctx.input.validation.states, ctx.input.payouts, ctx.input.allocations, id, l.currency);
    });
    return payoutModalSafe_({ status: 'SUCCESS', seller_id: id, seller_name: seller.seller_name,
      lines: lines.map(function (l) { return payoutModalLine_(l, seller.seller_name); }),
      default_currency: lines.length === 1 ? lines[0].currency : '', obligations: obligations, lists: payoutModalListsOf_(ctx, id),
      ledger_errors: flattenAllocationErrors_(ctx.input.validation.errors).slice(0, 5) });
  } catch (err) {
    return { status: 'FAILED', error: err && err.message ? err.message : String(err) };
  }
}

/**
 * FIFO preview of the payload: the same plan Create Draft validates (planOperationsDraft_ -> planFifoAllocation_) on
 * freshly read canonical data, plus the freshness gate. Writes nothing. Never throws.
 */
function runPayoutModalPreview_(payload) {
  try {
    const ss = getSpreadsheet_();
    const items = readSettlementItemsFreshness_(ss);
    if (!items.current) throw new Error('Settlement Items is not current (' + items.reason + '); run the pipeline first.');
    const balancesFresh = readSellerBalancesFreshness_(ss, items);
    if (!balancesFresh.current) throw new Error('Seller Balances is not current (' + balancesFresh.reason + '); run the pipeline first.');
    const ctx = readPayoutModalContext_(ss);
    const form = payoutModalForm_(payload);
    const plan = planOperationsDraft_(form, { sellers: ctx.sellers, balances: ctx.balances, payouts: ctx.input.payouts, allocations: ctx.input.allocations,
      items: ctx.input.items, settlements: ctx.input.settlements, adjustments: ctx.input.adjustments, validation: ctx.input.validation,
      payoutId: PAYOUT_MODAL.previewPayoutId, now: new Date(Math.floor(Date.now() / 1000) * 1000) });
    if (plan.status !== 'READY') return payoutModalSafe_({ status: 'FAILED', error: plan.error });
    const obligations = buildPayoutModalObligations_(ctx.input.validation.states, ctx.input.payouts, ctx.input.allocations, plan.payout.seller_id,
      plan.payout.currency);
    return payoutModalSafe_({ status: 'READY', amount: plan.payout.amount, currency: plan.payout.currency, payout_currency: plan.payout.payout_currency,
      fx_rate: plan.payout.fx_rate, payout_amount: plan.payout.payout_amount, payout_date: formatOperationsDate_(plan.parsed.payout_key),
      available_to_draft: plan.line.available_to_draft / 1e6,
      allocations: plan.rows.map(function (r) { return { target_type: r.target_type, target_id: r.target_id, allocated_amount: r.allocated_amount }; }),
      preview: buildPayoutPreview_(plan.rows, obligations) });
  } catch (err) {
    return { status: 'FAILED', error: err && err.message ? err.message : String(err) };
  }
}

/** Current canonical view of one payout. Never throws. */
function runPayoutModalPayout_(payoutId) {
  try {
    const id = trimmedText_(payoutId);
    const input = readSellerAllocationInputs_(getSpreadsheet_());
    const p = input.payouts.filter(function (x) { return trimmedText_(x.seller_payout_id) === id; });
    if (p.length !== 1) throw new Error('Expected exactly one Seller Payout ' + (id || '(blank)') + ', found ' + p.length + '.');
    return payoutModalSafe_({ status: 'SUCCESS', payout: buildPayoutModalView_(p[0], input.allocations) });
  } catch (err) {
    return { status: 'FAILED', error: err && err.message ? err.message : String(err) };
  }
}

/** Attaches the canonical payout view (read after the operation) to a result. */
function withPayoutModalView_(result, payoutId) {
  const out = payoutModalSafe_(result);
  if (payoutId) {
    const view = runPayoutModalPayout_(payoutId);
    if (view.status === 'SUCCESS') out.payout = view.payout;
  }
  return out;
}

/** Create Draft from the modal: the shared guarded workflow; a complete request returns a fresh next_token. Never throws. */
function runPayoutModalCreate_(payload) {
  const result = withOperationsLock_('CREATE_DRAFT', function (ss) {
    const r = createDraftRequest_(ss, payoutModalForm_(payload), 'MODAL');
    if (r.allocation_status === 'FULL') r.next_token = Utilities.getUuid();
    return r;
  });
  return withPayoutModalView_(result, result.seller_payout_id);
}

/**
 * A named lifecycle action from the modal. expectedStatus = the status the browser shows; the guarded transition rejects
 * a stale one. Unknown actions never reach the ledger. Never throws.
 */
function runPayoutModalTransition_(payoutId, action, expectedStatus, reason) {
  const id = trimmedText_(payoutId);
  const to = PAYOUT_MODAL.actions[String(action)];
  if (!to) return { status: 'FAILED', seller_payout_id: id, error: 'Unknown action "' + action + '"; nothing changed.' };
  if (trimmedText_(expectedStatus) === '') return { status: 'FAILED', seller_payout_id: id, error: 'The current status is required; reload the payout. Nothing changed.' };
  const result = runSellerPayoutTransition_(function () { return { payout_id: id, status: trimmedText_(expectedStatus) }; }, to, reason || '');
  return withPayoutModalView_(result, id);
}

/** Reruns the existing FIFO allocator for one incomplete DRAFT (resume after a failed allocation). Never throws. */
function runPayoutModalRetryAllocation_(payoutId) {
  const id = trimmedText_(payoutId);
  const result = withOperationsLock_('RETRY_ALLOCATION', function (ss) {
    const r = { status: 'FAILED', operation: 'RETRY_ALLOCATION', seller_payout_id: id, warnings: [] };
    assertOperationsAccountingCurrent_(ss);
    const before = readSellerAllocationInputs_(ss).payouts.filter(function (p) { return trimmedText_(p.seller_payout_id) === id; });
    if (before.length !== 1) throw new Error('Expected exactly one Seller Payout ' + (id || '(blank)') + ', found ' + before.length + '; nothing changed.');
    if (trimmedText_(before[0].status) !== SELLER_ALLOCATIONS.draftStatus) throw new Error('Seller Payout ' + id + ' is ' + before[0].status + '; only a DRAFT is allocated.');
    const fifo = runSellerPayoutFifo_(id);
    const after = readSellerAllocationInputs_(ss);
    const view = buildPayoutModalView_(before[0], after.allocations);
    r.fifo_status = fifo.status;
    r.allocation_status = view.allocation_status;
    r.allocated_amount = view.allocated_amount;
    if (view.allocation_status === 'FULL') {
      r.status = fifo.status === 'NO_CHANGE' ? 'NO_CHANGE' : 'SUCCESS';
    } else {
      r.error = 'DRAFT ' + id + ' is still not fully allocated (' + view.allocated_amount + ' of ' + before[0].amount + ')' +
        (fifo.error ? ': ' + fifo.error : '') + '. It has no financial effect; cancel it or fix the cause and retry.';
    }
    return r;
  });
  return withPayoutModalView_(result, id);
}

/** Records method + reference of a DRAFT (the only payout edit the modal can make). Never throws. */
function runPayoutModalSetProof_(payoutId, expectedStatus, method, reference) {
  const id = trimmedText_(payoutId);
  return withPayoutModalView_(runSetPayoutProof_(id, expectedStatus, method, reference), id);
}
