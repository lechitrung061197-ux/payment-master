/**
 * PaymentPipeline.gs
 * Scheduled end-to-end pipeline (twice a day) that runs the existing Payment Master stages in order and publishes
 * seller sheets only when every stage and every health gate passes:
 *
 *   PROVIDER_SYNC -> PROVIDER_NORMALIZE (transactions, events) -> INTERNAL_NORMALIZE -> RECONCILE ->
 *   SETTLEMENT_REFRESH (provider settlements / provider-paid availability) -> PAYMENT_LEGS_REFRESH ->
 *   SETTLEMENT_ITEMS_REFRESH -> SELLER_BALANCES_REFRESH -> SELLER_PAYOUT_STATUS_REFRESH -> HEALTH_CHECK ->
 *   SELLER_SHEETS_SYNC
 *
 * - Reuses the existing runners (each keeps its own script lock, staging / swap, freshness gates, idempotency and
 *   audit). The pipeline itself holds the DOCUMENT lock, so a second scheduled run is SKIPPED (never parallel) and
 *   never deadlocks against the stage runners' script lock.
 * - Any stage failure stops the run immediately: no downstream stage, and in particular no seller-sheet publish.
 * - Provider paid (Settlements: source_paid_amount / source_payment_date -> AVAILABLE) and seller paid (Seller Payouts +
 *   Seller Payout Allocations -> UNPAID / PARTIAL / PAID) are separate ledgers; the pipeline never derives one from
 *   the other. Seller payout status is derived in SellerPayoutAllocations.gs and only published to seller sheets.
 * - Every run has a pipeline_run_id; audit actions: PIPELINE_STARTED, <STAGE>_<STATUS> (entity_type PIPELINE),
 *   HEALTH_CHECK_PASS / _FAIL, PIPELINE_SUCCESS / PIPELINE_FAILED / PIPELINE_SKIPPED_LOCKED.
 *
 * Providers: the pipeline runs only providers ENABLED in RAW_SOURCES (Settings source.<ID>.enabled) and uses each one's
 * adapters from PROVIDER_PIPELINE_RUNNERS (transactions, events, settlements, eventsReport). An enabled provider without
 * a complete adapter fails the run closed before any fetch (audited with the provider id); disabled providers are never
 * fetched or normalized.
 *
 * Schedule: Settings scheduled_sync_morning_hour / scheduled_sync_afternoon_hour / scheduled_sync_timezone (default: the
 * Master timezone APP.TIMEZONE, America/New_York; an IANA region name, so DST is handled by Apps Script - fixed UTC
 * offsets are rejected); installScheduledPaymentPipelineTriggers() replaces this pipeline's triggers (idempotent, never
 * duplicates). migrateScheduledPipelineTimezoneToMaster() moves the retired default (Asia/Ho_Chi_Minh) to the Master
 * timezone explicitly; setup never overwrites an existing Settings value.
 */

const PAYMENT_PIPELINE = Object.freeze({
  handler: 'runScheduledPaymentPipeline',
  runIdPrefix: 'PRUN-',
  lockWaitMs: 5000,
  morningHourSetting: 'scheduled_sync_morning_hour',
  afternoonHourSetting: 'scheduled_sync_afternoon_hour',
  timezoneSetting: 'scheduled_sync_timezone',
  // Stage results that count as success (anything else stops the pipeline).
  okStatuses: Object.freeze(['SUCCESS', 'NO_CHANGE', 'PASS']),
  moneyToleranceMicros: 5000, // 0.005: MATCHED amount mismatch tolerance (Payment Matches convention)
  // Retired scheduled_sync_timezone defaults that the explicit migration may move to the Master timezone.
  retiredScheduleTimezones: Object.freeze(['Asia/Ho_Chi_Minh']),
  triggersInstalledAction: 'PIPELINE_TRIGGERS_INSTALLED',
});

/**
 * Canonical pipeline adapters per provider (the existing provider-specific runners; closures resolve at call time).
 * Adding a provider = add its RAW_SOURCES entry AND its adapters here; an enabled provider without them fails closed.
 */
const PROVIDER_PIPELINE_RUNNERS = Object.freeze({
  KH001: Object.freeze({
    transactions: function () { return runKh001ProviderTransactionsNormalizer_(); },
    events: function () { return runKh001ProviderEventsNormalizer_(); },
    settlements: function () { return runKh001SettlementsNormalizer_(); },
    eventsReport: function () { return buildKh001ProviderEventsReport_(); },
  }),
});

const PROVIDER_ADAPTER_KEYS = Object.freeze(['transactions', 'events', 'settlements', 'eventsReport']);

/* ----------------------------- Pure helpers ----------------------------- */

/**
 * Enabled providers and their adapters. Fails (missing) for an enabled provider without a complete adapter set.
 * @param {Object} rawSources RAW_SOURCES-like map
 * @param {Object} settings Settings map
 * @param {Object} registry PROVIDER_PIPELINE_RUNNERS-like map
 * @return {{enabled: Array<{providerId: string, source: Object, runners: Object}>, missing: Array<string>, disabled: Array<string>}}
 */
function resolvePipelineProviders_(rawSources, settings, registry) {
  const out = { enabled: [], missing: [], disabled: [] };
  Object.keys(rawSources).sort().forEach(function (k) {
    const source = rawSources[k];
    if (!isSettingEnabled_(settings[source.enabledSetting])) { out.disabled.push(source.providerId); return; }
    const runners = registry[source.providerId];
    const lacking = PROVIDER_ADAPTER_KEYS.filter(function (a) { return !runners || typeof runners[a] !== 'function'; });
    if (lacking.length > 0) { out.missing.push(source.providerId + ' (' + lacking.join(', ') + ')'); return; }
    out.enabled.push({ providerId: source.providerId, source: source, runners: runners });
  });
  return out;
}

/** Validated schedule from Settings values: two distinct whole hours 0-23 and a time zone. */
function parsePipelineSchedule_(settings) {
  const errors = [];
  const hour = function (key) {
    const v = settings[key];
    const n = typeof v === 'number' ? v : Number(String(v === undefined ? '' : v).trim());
    if (String(v === undefined ? '' : v).trim() === '' || !isFinite(n) || Math.floor(n) !== n || n < 0 || n > 23) {
      errors.push(key + ' must be a whole hour 0-23');
      return null;
    }
    return n;
  };
  const morning = hour(PAYMENT_PIPELINE.morningHourSetting);
  const afternoon = hour(PAYMENT_PIPELINE.afternoonHourSetting);
  const timeZone = String(settings[PAYMENT_PIPELINE.timezoneSetting] || '').trim();
  if (timeZone === '') errors.push(PAYMENT_PIPELINE.timezoneSetting + ' is blank');
  else if (!isIanaRegionTimeZone_(timeZone)) {
    errors.push(PAYMENT_PIPELINE.timezoneSetting + ' must be an IANA region time zone such as ' + APP.TIMEZONE +
      ' (found "' + timeZone + '"); fixed UTC offsets would ignore daylight saving time');
  }
  if (morning !== null && afternoon !== null && morning === afternoon) errors.push('morning and afternoon hours must differ');
  return { morning: morning, afternoon: afternoon, timeZone: timeZone, errors: errors };
}

/** "Area/Location" IANA names only: no fixed offsets (GMT+7, UTC-05:00, Etc/GMT-7, UTC). */
function isIanaRegionTimeZone_(tz) {
  return /^[A-Za-z]+(\/[A-Za-z0-9_\-]+)+$/.test(tz) && !/^Etc\//i.test(tz) && !/^(GMT|UTC)/i.test(tz);
}

/** Classifies a raw-sync summary ({provider, <tab>: status}): FAILED if any tab failed. */
function classifyRawSyncSummary_(summary) {
  if (summary.status === 'DISABLED') return 'NO_CHANGE';
  const statuses = Object.keys(summary).filter(function (k) { return k !== 'provider' && k !== 'status'; }).map(function (k) { return summary[k]; });
  if (statuses.some(function (s) { return s !== 'SUCCESS' && s !== 'NO_CHANGE' && s !== 'DISABLED'; })) return 'FAILED';
  return statuses.some(function (s) { return s === 'SUCCESS'; }) ? 'SUCCESS' : 'NO_CHANGE';
}

/** Combines sub-step statuses: FAILED wins, then SUCCESS, else NO_CHANGE. */
function combineStageStatuses_(statuses) {
  if (statuses.some(function (s) { return PAYMENT_PIPELINE.okStatuses.indexOf(s) < 0; })) return 'FAILED';
  return statuses.some(function (s) { return s === 'SUCCESS'; }) ? 'SUCCESS' : 'NO_CHANGE';
}

/**
 * Accounting invariants checked before publishing (pure).
 * @param {{providerTransactions: Array, transactions: Array, matches: Array, legs: Array, items: Array, settlements: Array,
 *          adjustments: Array, payouts: Array, allocations: Array, balances: Array, sellerIds: Array<string>,
 *          allocationValidation: Object}} t
 * @return {Array<{name: string, pass: boolean, detail: string}>}
 */
function evaluatePipelineInvariants_(t) {
  const checks = [];
  const add = function (name, problems) {
    checks.push({ name: name, pass: problems.length === 0, detail: problems.length === 0 ? 'ok' : problems.slice(0, 10).join(' | ') +
      (problems.length > 10 ? ' | ... ' + (problems.length - 10) + ' more' : '') });
  };
  const dupes = [];
  [['Provider Transactions', t.providerTransactions, function (r) { return r.provider_transaction_id; }],
    ['Transactions', t.transactions, function (r) { return r.payment_source + '|' + r.internal_transaction_id; }],
    ['Payment Matches', t.matches, function (r) { return r.match_id; }],
    ['Payment Legs', t.legs, function (r) { return r.payment_leg_id; }],
    ['Settlements', t.settlements, function (r) { return r.settlement_id; }],
    ['Settlement Items', t.items, function (r) { return r.settlement_item_id; }],
    ['Adjustments', t.adjustments, function (r) { return r.adjustment_id; }],
    ['Seller Payouts', t.payouts, function (r) { return r.seller_payout_id; }],
    ['Seller Payout Allocations', t.allocations, function (r) { return r.allocation_id; }],
    ['Seller Balances', t.balances, function (r) { return r.seller_id + '|' + r.currency; }]].forEach(function (spec) {
    const seen = {};
    (spec[1] || []).forEach(function (r) {
      const k = String(spec[2](r));
      if (seen[k]) dupes.push(spec[0] + ' ' + k);
      seen[k] = true;
    });
  });
  add('no_duplicate_ids', dupes);
  add('matched_amount_mismatch_zero', (t.matches || []).filter(function (m) {
    return m.reconciliation_status === 'MATCHED' && (!isFiniteNumber_(m.internal_amount) || !isFiniteNumber_(m.provider_gross_amount) ||
      Math.abs(Math.round((m.internal_amount - m.provider_gross_amount) * 1e6)) >= PAYMENT_PIPELINE.moneyToleranceMicros);
  }).map(function (m) { return 'MATCHED ' + m.match_id + ' internal ' + m.internal_amount + ' != provider ' + m.provider_gross_amount; }));
  const equation = [];
  [['Payment Leg', t.legs, 'payment_leg_id'], ['Settlement Item', t.items, 'settlement_item_id']].forEach(function (spec) {
    (spec[1] || []).forEach(function (r) {
      if (![r.net_amount, r.seller_fee, r.seller_hold_amount, r.seller_available_amount].every(isFiniteNumber_)) return;
      if (Math.abs(Math.round((r.seller_available_amount - (r.net_amount - r.seller_fee - r.seller_hold_amount)) * 1e6)) > 1) {
        equation.push(spec[0] + ' ' + r[spec[2]] + ': seller_available != net - seller_fee - seller_hold');
      }
    });
  });
  add('seller_available_equation', equation);
  add('payout_allocations_valid', flattenAllocationErrors_(t.allocationValidation.errors));
  add('paid_not_above_obligation', t.allocationValidation.states.filter(function (s) {
    return Math.round(s.paid_amount * 1e6) > Math.round(s.due_amount * 1e6) + SELLER_ALLOCATIONS.toleranceMicros;
  }).map(function (s) { return s.target_type + ' ' + s.target_id + ' (' + s.seller_id + '): paid ' + s.paid_amount + ' > due ' + s.due_amount; }));
  // Seller Balance = Settlement Items + APPLIED adjustments - valid (SENT / CONFIRMED) payouts.
  const rebuilt = buildSellerBalances_({ items: t.items || [], adjustments: t.adjustments || [], payouts: t.payouts || [], sellerIds: t.sellerIds,
    existing: [], now: null, columns: getColumnNames_(SHEETS.SELLER_BALANCES) });
  const recon = flattenBalanceErrors_(rebuilt.errors).slice();
  const stored = {};
  (t.balances || []).forEach(function (b) { stored[trimmedText_(b.seller_id) + '|' + trimmedText_(b.currency)] = b; });
  const fields = ['settled_amount', 'available_amount', 'paid_amount', 'seller_hold_balance', 'adjustments', 'current_balance'];
  rebuilt.rows.forEach(function (r) {
    const k = r.seller_id + '|' + r.currency;
    const s = stored[k];
    if (!s) { recon.push(k + ' missing in Seller Balances'); return; }
    fields.forEach(function (f) {
      if (!isFiniteNumber_(s[f]) || Math.round(s[f] * 1e6) !== Math.round(r[f] * 1e6)) recon.push(k + '.' + f + ' stored ' + s[f] + ' != ' + r[f]);
    });
    delete stored[k];
  });
  Object.keys(stored).forEach(function (k) { recon.push(k + ' in Seller Balances has no source'); });
  add('seller_balances_reconcile', recon);
  return checks;
}

/* ---------------------------------- I/O --------------------------------- */

/** Overridable accessors (tests): the configured raw sources and the provider adapter registry. */
function pipelineRawSources_() { return RAW_SOURCES; }
function providerPipelineRunners_() { return PROVIDER_PIPELINE_RUNNERS; }

/** Enabled providers with adapters; throws (fail closed) when an enabled provider has no complete adapter set. */
function readPipelineProviders_() {
  const resolved = resolvePipelineProviders_(pipelineRawSources_(), readSettingsMap_(), providerPipelineRunners_());
  if (resolved.missing.length > 0) {
    const err = new Error('enabled provider(s) without a pipeline adapter: ' + resolved.missing.join(', ') + ' - nothing fetched or normalized');
    err.missingAdapters = resolved.missing;
    throw err;
  }
  return resolved;
}

/** Runs one adapter step for every enabled provider in order; stops at the first failure. */
function runProviderAdapters_(providers, step, label) {
  const results = {};
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const r = p.runners[step]();
    const st = r && r.status ? r.status : 'FAILED';
    results[p.providerId] = st;
    if (PAYMENT_PIPELINE.okStatuses.indexOf(st) < 0) {
      return { status: 'FAILED', providers: results, error: p.providerId + ' ' + label + ': ' + ((r && r.error) || st) };
    }
  }
  return { status: combineStageStatuses_(Object.keys(results).map(function (k) { return results[k]; })), providers: results };
}

/** Raw sync of every enabled provider source (stage 1), after the adapter preflight. */
function syncEnabledRawSources_() {
  let providers;
  try {
    providers = readPipelineProviders_();
  } catch (err) {
    return { status: 'FAILED', error: err.message, missing_adapters: err.missingAdapters || [] };
  }
  const results = providers.enabled.map(function (p) { return syncRawSource_(p.source); });
  const failed = [];
  results.forEach(function (r) {
    Object.keys(r).forEach(function (k) {
      if (k !== 'provider' && k !== 'status' && ['SUCCESS', 'NO_CHANGE', 'DISABLED'].indexOf(r[k]) < 0) failed.push(r.provider + ' ' + k + ' ' + r[k]);
    });
  });
  return { status: combineStageStatuses_(results.map(classifyRawSyncSummary_)), sources: results,
    providers: providers.enabled.map(function (p) { return p.providerId; }), disabled_providers: providers.disabled,
    error: failed.length ? 'raw sync failed: ' + failed.join(', ') + ' (see Import Batches)' : null };
}

/** Raw current: for every enabled source tab, swap state NORMAL and the latest batch SUCCESS / NO_CHANGE. */
function readRawSyncHealth_(ss) {
  const settings = readSettingsMap_();
  const batches = readImportBatches_();
  const problems = [];
  const sources = pipelineRawSources_();
  Object.keys(sources).forEach(function (k) {
    const source = sources[k];
    if (!isSettingEnabled_(settings[source.enabledSetting])) return;
    source.tabs.forEach(function (tab) {
      const state = detectSwapState_(ss, tab).state;
      if (state !== 'NORMAL') problems.push(tab.targetSheet + ' swap state ' + state);
      const last = batches.filter(function (b) { return b.provider_id === source.providerId && b.target_sheet === tab.targetSheet; })
        .sort(function (a, b) { return compareCanonicalValues_(a.started_at, b.started_at); }).pop();
      if (!last) problems.push(tab.targetSheet + ' has never been synced');
      else if (last.status !== 'SUCCESS' && last.status !== 'NO_CHANGE') problems.push(tab.targetSheet + ' last raw sync is ' + last.status);
    });
  });
  return problems;
}

/** Read-only health report: freshness gates of every layer + accounting invariants. Never throws. */
function buildPaymentPipelineHealth_() {
  const report = { pass: false, checks: [], errors: [] };
  const add = function (name, pass, detail) { report.checks.push({ name: name, pass: !!pass, detail: detail || (pass ? 'ok' : 'failed') }); };
  try {
    const ss = getSpreadsheet_();
    const raw = readRawSyncHealth_(ss);
    add('raw_provider_sync_current', raw.length === 0, raw.join(' | '));
    const providers = readPipelineProviders_();
    providers.enabled.forEach(function (p) {
      const events = p.runners.eventsReport();
      add('provider_events_current.' + p.providerId, events.pass === true, (events.errors || []).slice(0, 5).join(' | '));
    });
    const gates = readSellerSheetsGates_(ss);
    Object.keys(gates.gates).forEach(function (g) { add(g + '_current', gates.gates[g], gates.gates[g] ? 'ok' : 'stale / invalid'); });
    if (!gates.current) report.errors = report.errors.concat(gates.reasons);
    const alloc = readSellerAllocationInputs_(ss);
    const sellers = readSellersDraft_(ss).parsed.sellers.map(function (s) { return s.seller_id; }).filter(function (id) { return id !== ''; });
    evaluatePipelineInvariants_({
      providerTransactions: readSchemaTableObjects_(ss, SHEETS.PROVIDER_TRANSACTIONS, providerTransactionsTab_()).rows,
      transactions: readSchemaTableObjects_(ss, SHEETS.TRANSACTIONS, transactionsTab_()).rows,
      matches: readSchemaTableObjects_(ss, SHEETS.PAYMENT_MATCHES, paymentMatchesTab_()).rows,
      legs: readSchemaTableObjects_(ss, SHEETS.PAYMENT_LEGS, paymentLegsTab_()).rows,
      items: alloc.items, settlements: alloc.settlements, adjustments: alloc.adjustments, payouts: alloc.payouts, allocations: alloc.allocations,
      balances: readSchemaTableObjects_(ss, SHEETS.SELLER_BALANCES, sellerBalancesTab_()).rows, sellerIds: sellers,
      allocationValidation: alloc.validation,
    }).forEach(function (c) { report.checks.push(c); });
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0 && report.checks.length > 0 && report.checks.every(function (c) { return c.pass; });
  return redactDeep_(report);
}

/** Pipeline stages in order. Each run() returns an object with a status; names reference the existing runners. */
function paymentPipelineStages_() {
  const status = function (r) { return r && r.status ? r.status : 'FAILED'; };
  return [
    { name: 'PROVIDER_SYNC', run: function () { return syncEnabledRawSources_(); } },
    { name: 'PROVIDER_NORMALIZE', run: function () {
      const providers = readPipelineProviders_().enabled;
      const tx = runProviderAdapters_(providers, 'transactions', 'Provider Transactions');
      if (tx.status === 'FAILED') return { status: 'FAILED', error: tx.error, provider_transactions: tx.providers };
      const ev = runProviderAdapters_(providers, 'events', 'Provider Events');
      if (ev.status === 'FAILED') return { status: 'FAILED', error: ev.error, provider_transactions: tx.providers, provider_events: ev.providers };
      return { status: combineStageStatuses_([tx.status, ev.status]), provider_transactions: tx.providers, provider_events: ev.providers };
    } },
    { name: 'INTERNAL_NORMALIZE', run: function () { return runInternalNormalizer_(); } },
    { name: 'RECONCILE', run: function () { return runPaymentReconciliation_(); } },
    { name: 'SETTLEMENT_REFRESH', run: function () { return runProviderAdapters_(readPipelineProviders_().enabled, 'settlements', 'Settlements'); } },
    { name: 'PAYMENT_LEGS_REFRESH', run: function () { return runPaymentLegsNormalizer_(); } }, // provider-paid availability lives here
    { name: 'SETTLEMENT_ITEMS_REFRESH', run: function () { return runSettlementItemsNormalizer_(); } },
    { name: 'SELLER_BALANCES_REFRESH', run: function () { return runSellerBalancesNormalizer_(); } },
    { name: 'SELLER_PAYOUT_STATUS_REFRESH', run: function () {
      // Seller payout status is DERIVED (never stored): validate the payout / allocation ledger and report the states.
      const v = readSellerAllocationInputs_(getSpreadsheet_()).validation;
      const errors = flattenAllocationErrors_(v.errors);
      return { status: errors.length === 0 ? 'SUCCESS' : 'FAILED', error: errors.length ? errors.slice(0, 10).join(' | ') : null,
        payment_status_counts: v.summary.payment_status_counts, effective_payout_count: v.summary.effective_payout_count };
    } },
    { name: 'HEALTH_CHECK', run: function () {
      const h = buildPaymentPipelineHealth_();
      const failed = h.checks.filter(function (c) { return !c.pass; });
      return { status: h.pass ? 'PASS' : 'FAIL', failed_checks: failed.map(function (c) { return c.name + ': ' + c.detail; }),
        error: h.pass ? null : failed.map(function (c) { return c.name; }).concat(h.errors).slice(0, 10).join(' | ') };
    } },
    { name: 'SELLER_SHEETS_SYNC', run: function () {
      const r = runSellerSheetsSync_();
      const sellers = (r.sellers || []).map(function (s) { return { seller_id: s.seller_id, status: s.status, error: s.error || null }; });
      // PARTIAL counts as a failed publish for the pipeline (alerting); the synced sellers stay synced.
      return { status: r.status === 'PARTIAL' ? 'FAILED' : r.status, seller_status: r.status, sellers: sellers, error: r.error ||
        (r.status === 'PARTIAL' ? 'some seller sheets failed: ' + sellers.filter(function (s) { return s.status === 'FAILED'; })
          .map(function (s) { return s.seller_id + ' ' + s.error; }).join(' | ') : null) };
    } },
  ];
}

function pipelineAudit_(action, runId, status, details) {
  try {
    appendAuditLog_({ action: action, entityType: 'PIPELINE', entityId: runId, newStatus: status || '', details: redactDeep_(details) });
  } catch (err) {
    Logger.log('Failed to write pipeline audit entry: %s', err);
  }
}

/**
 * The scheduled pipeline. Never throws.
 * @param {{trigger?: string}=} options
 * @return {{pipeline_run_id: string, status: string, stages: Array<Object>, failed_stage: ?string, error: ?string}}
 */
function runPaymentPipeline_(options) {
  const runId = PAYMENT_PIPELINE.runIdPrefix + Utilities.getUuid();
  const startedAt = new Date();
  const result = { pipeline_run_id: runId, status: 'FAILED', started_at: startedAt, completed_at: null, duration_ms: null, stages: [],
    failed_stage: null, error: null, trigger: (options && options.trigger) || 'manual' };
  const lock = LockService.getDocumentLock();
  if (!lock || !lock.tryLock(PAYMENT_PIPELINE.lockWaitMs)) {
    result.status = 'SKIPPED_LOCKED';
    result.completed_at = new Date();
    result.error = 'another pipeline run holds the lock';
    pipelineAudit_('PIPELINE_SKIPPED_LOCKED', runId, 'SKIPPED', { pipeline_run_id: runId, started_at: startedAt, trigger: result.trigger });
    return result;
  }
  try {
    pipelineAudit_('PIPELINE_STARTED', runId, 'RUNNING', { pipeline_run_id: runId, started_at: startedAt, trigger: result.trigger });
    const stages = paymentPipelineStages_();
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const stageStart = new Date();
      let out;
      try {
        out = stage.run() || { status: 'FAILED', error: 'stage returned nothing' };
      } catch (err) {
        out = { status: 'FAILED', error: err && err.message ? err.message : String(err) };
      }
      const stageEnd = new Date();
      const entry = { stage: stage.name, status: out.status || 'FAILED', started_at: stageStart, completed_at: stageEnd,
        duration_ms: stageEnd.getTime() - stageStart.getTime(), error: out.error || null };
      ['providers', 'disabled_providers', 'missing_adapters', 'provider_transactions', 'provider_events', 'payment_status_counts',
        'effective_payout_count', 'failed_checks', 'seller_status', 'sellers']
        .forEach(function (k) { if (out[k] !== undefined) entry[k] = out[k]; });
      result.stages.push(entry);
      pipelineAudit_(stage.name + '_' + entry.status, runId, entry.status, Object.assign({ pipeline_run_id: runId }, entry));
      if (PAYMENT_PIPELINE.okStatuses.indexOf(entry.status) < 0) {
        result.failed_stage = stage.name;
        result.error = entry.error || stage.name + ' ' + entry.status;
        break; // stop: nothing downstream runs, seller sheets are not published
      }
    }
    result.status = result.failed_stage ? 'FAILED' : 'SUCCESS';
  } catch (err) {
    result.status = 'FAILED';
    result.error = err && err.message ? err.message : String(err);
  } finally {
    result.completed_at = new Date();
    result.duration_ms = result.completed_at.getTime() - startedAt.getTime();
    pipelineAudit_(result.status === 'SUCCESS' ? 'PIPELINE_SUCCESS' : 'PIPELINE_FAILED', runId, result.status, {
      pipeline_run_id: runId, started_at: startedAt, completed_at: result.completed_at, failed_at: result.failed_stage ? result.completed_at : null,
      duration_ms: result.duration_ms, stage: result.failed_stage, status: result.status, error: result.error,
      stages: result.stages.map(function (s) { return s.stage + ':' + s.status; }) });
    lock.releaseLock();
  }
  return redactDeep_(result);
}

/** Replaces this pipeline's time-driven triggers with exactly two daily triggers from Settings. Idempotent. */
function installPaymentPipelineTriggers_() {
  const schedule = parsePipelineSchedule_(readSettingsMap_());
  if (schedule.errors.length > 0) throw new Error('Pipeline schedule settings are invalid: ' + schedule.errors.join(' | '));
  const removed = removePaymentPipelineTriggers_();
  [schedule.morning, schedule.afternoon].forEach(function (h) {
    ScriptApp.newTrigger(PAYMENT_PIPELINE.handler).timeBased().atHour(h).nearMinute(0).everyDays(1).inTimezone(schedule.timeZone).create();
  });
  const installed = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === PAYMENT_PIPELINE.handler; }).length;
  const result = { removed: removed, created: 2, installed: installed, morning_hour: schedule.morning, afternoon_hour: schedule.afternoon,
    time_zone: schedule.timeZone, master_timezone: APP.TIMEZONE, warnings: [] };
  if (schedule.timeZone !== APP.TIMEZONE) {
    result.warnings.push('scheduled_sync_timezone ' + schedule.timeZone + ' differs from the Master timezone ' + APP.TIMEZONE +
      '; run migrateScheduledPipelineTimezoneToMaster() if this is the retired default.');
  }
  pipelineAudit_(PAYMENT_PIPELINE.triggersInstalledAction, '', 'SUCCESS', result);
  return result;
}

/**
 * Explicit, audited Settings update: scheduled_sync_timezone from a retired default (Asia/Ho_Chi_Minh) to the Master
 * timezone (APP.TIMEZONE). Already the Master timezone -> NO_CHANGE; any other (operator-chosen) value -> FAILED, not
 * touched. Hours, other Settings (source.KH001.timezone included) and triggers are not changed: run
 * installScheduledPaymentPipelineTriggers() afterwards. Never throws.
 */
function runScheduleTimezoneMigration_() {
  const key = PAYMENT_PIPELINE.timezoneSetting;
  const result = { status: 'FAILED', setting: key, old_value: null, new_value: null, master_timezone: APP.TIMEZONE, next_step: null, error: null };
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(CANONICAL_LOCK_TIMEOUT_MS);
  try {
    if (!locked) throw new Error('Could not acquire script lock within ' + CANONICAL_LOCK_TIMEOUT_MS + ' ms; nothing changed.');
    const sheet = getSpreadsheet_().getSheetByName(SHEETS.SETTINGS);
    if (!sheet) throw new Error('Settings tab not found. Run setupMaster first.');
    const index = readSettingKeys_(sheet).indexOf(key);
    if (index < 0) throw new Error(key + ' is missing in Settings; run setupMaster (it seeds ' + APP.TIMEZONE + ').');
    const row = 2 + index;
    const current = String(sheet.getRange(row, getColumnIndex_(SHEETS.SETTINGS, 'value')).getValue()).trim();
    result.old_value = current;
    if (current === APP.TIMEZONE) {
      result.status = 'NO_CHANGE';
      result.new_value = current;
    } else if (PAYMENT_PIPELINE.retiredScheduleTimezones.indexOf(current) >= 0) {
      sheet.getRange(row, getColumnIndex_(SHEETS.SETTINGS, 'value')).setValue(APP.TIMEZONE);
      sheet.getRange(row, getColumnIndex_(SHEETS.SETTINGS, 'description')).setValue(findDefaultSetting_(key)[3]);
      sheet.getRange(row, getColumnIndex_(SHEETS.SETTINGS, 'updated_at')).setValue(new Date());
      result.status = 'SUCCESS';
      result.new_value = APP.TIMEZONE;
    } else {
      result.error = key + ' is "' + current + '" (not a retired default); left unchanged. Edit it intentionally if needed.';
    }
    if (result.status !== 'FAILED') result.next_step = 'Run installScheduledPaymentPipelineTriggers() so the two triggers use ' + APP.TIMEZONE + '.';
  } catch (err) {
    result.error = err && err.message ? err.message : String(err);
  } finally {
    try {
      appendAuditLog_({ action: 'PIPELINE_SCHEDULE_TIMEZONE_' + (result.status === 'SUCCESS' ? 'MIGRATED' : result.status), entityType: 'SETTINGS',
        entityId: key, oldStatus: result.old_value || '', newStatus: result.new_value || '', details: result });
    } catch (auditErr) {
      Logger.log('Failed to write audit entry: %s', auditErr);
    }
    if (locked) lock.releaseLock();
  }
  return result;
}

/**
 * Read-only: the pipeline's installed triggers vs. Settings. Apps Script triggers do not expose their hour / time zone,
 * so the schedule is checked against the latest PIPELINE_TRIGGERS_INSTALLED audit row. Never throws.
 */
function buildPipelineTriggersReport_() {
  const report = { pass: false, trigger_count: 0, schedule: null, last_install: null, master_timezone: APP.TIMEZONE, errors: [] };
  try {
    report.trigger_count = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === PAYMENT_PIPELINE.handler; }).length;
    const schedule = parsePipelineSchedule_(readSettingsMap_());
    report.schedule = { morning_hour: schedule.morning, afternoon_hour: schedule.afternoon, time_zone: schedule.timeZone };
    schedule.errors.forEach(function (e) { report.errors.push(e); });
    if (report.trigger_count !== 2) report.errors.push('expected exactly 2 pipeline triggers, found ' + report.trigger_count);
    if (schedule.timeZone !== APP.TIMEZONE) report.errors.push('scheduled_sync_timezone ' + schedule.timeZone + ' is not the Master timezone ' + APP.TIMEZONE);
    const audit = getSpreadsheet_().getSheetByName(SHEETS.AUDIT_LOG);
    const last = audit ? audit.getLastRow() : 0;
    if (last >= 2) {
      const n = Math.min(last - 1, 3000);
      const rows = audit.getRange(last - n + 1, 1, n, 8).getValues();
      for (let i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i][1]) !== PAYMENT_PIPELINE.triggersInstalledAction) continue;
        let d = {};
        try { d = JSON.parse(String(rows[i][7] || '{}')) || {}; } catch (e) { d = {}; }
        report.last_install = { at: rows[i][0], morning_hour: d.morning_hour, afternoon_hour: d.afternoon_hour, time_zone: d.time_zone };
        break;
      }
    }
    const li = report.last_install;
    if (!li) report.errors.push('no ' + PAYMENT_PIPELINE.triggersInstalledAction + ' audit row found');
    else if (li.morning_hour !== schedule.morning || li.afternoon_hour !== schedule.afternoon || li.time_zone !== schedule.timeZone) {
      report.errors.push('the last trigger install (' + li.morning_hour + '/' + li.afternoon_hour + ' ' + li.time_zone + ') differs from Settings; ' +
        'run installScheduledPaymentPipelineTriggers()');
    }
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  report.pass = report.errors.length === 0;
  return report;
}

/** Deletes every trigger of this pipeline (other triggers are untouched). @return {number} removed */
function removePaymentPipelineTriggers_() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === PAYMENT_PIPELINE.handler) { ScriptApp.deleteTrigger(t); removed++; }
  });
  return removed;
}
