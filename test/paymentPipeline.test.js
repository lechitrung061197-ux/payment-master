// Unit tests for the scheduled payment pipeline (PaymentPipeline.gs): stage order, stop-on-failure, lock skip,
// idempotency, audit trail, trigger installer, health invariants, and the seller payout status (seller paid vs
// provider paid) published to seller sheets. Fake data.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeSpreadsheet, cloneSpreadsheet } = require('./helpers/sellerFakes');
const { makeMaster } = require('./helpers/sellerMaster');

let uuid = 0;
const Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  computeDigest: (_alg, text) => [...crypto.createHash('sha256').update(text, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
  formatDate: (date, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date),
  getUuid: () => 'uuid-' + (++uuid),
};
const context = vm.createContext({ Utilities, Logger: { log: () => {} } });
for (const f of fs.readdirSync(path.join(__dirname, '..', 'src')).filter((f) => f.endsWith('.gs')).sort()) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), context, { filename: f });
}
const H = context;
const js = (v) => JSON.parse(JSON.stringify(v));
const D = (iso) => vm.runInContext(`new Date(${JSON.stringify(iso)})`, context);
const NY = (v) => H.providerDateKey_(v, 'America/New_York');
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ---- orchestrator with stubbed stage runners -------------------------------------------------------------
const STAGE_RUNNERS = ['syncRawSource_', 'runKh001ProviderTransactionsNormalizer_', 'runKh001ProviderEventsNormalizer_', 'runInternalNormalizer_',
  'runPaymentReconciliation_', 'runKh001SettlementsNormalizer_', 'runPaymentLegsNormalizer_', 'runSettlementItemsNormalizer_',
  'runSellerBalancesNormalizer_', 'readSellerAllocationInputs_', 'buildPaymentPipelineHealth_', 'runSellerSheetsSync_'];
let env;
function install(o) {
  o = o || {};
  env = { calls: [], audit: [], lockHeld: !!o.lockHeld, released: 0 };
  const result = (name, def) => (o[name] !== undefined ? o[name] : def);
  const stub = (name, value) => () => {
    env.calls.push(name);
    const v = typeof value === 'function' ? value() : value;
    return v;
  };
  const okValidation = { errors: H.emptyAllocationErrors_(), summary: { payment_status_counts: { UNPAID: 2 }, effective_payout_count: 0 } };
  Object.assign(context, {
    getSpreadsheet_: () => ({ getId: () => 'MASTER' }),
    readSettingsMap_: () => o.settings || { 'source.KH001.enabled': true },
    pipelineRawSources_: () => o.rawSources || vm.runInContext('RAW_SOURCES', context),
    providerPipelineRunners_: () => o.registry || vm.runInContext('PROVIDER_PIPELINE_RUNNERS', context),
    appendAuditLog_: (e) => env.audit.push(js(e)),
    LockService: { getDocumentLock: () => ({ tryLock: () => !env.lockHeld, releaseLock: () => { env.released++; } }) },
    syncRawSource_: stub('syncRawSource_', result('syncRawSource_', { provider: 'KH001', RAW_PP: 'NO_CHANGE', DoiSoat_GD: 'NO_CHANGE', PhieuDoiSoat: 'NO_CHANGE', Dispute: 'NO_CHANGE' })),
    runKh001ProviderTransactionsNormalizer_: stub('runKh001ProviderTransactionsNormalizer_', result('pt', { status: 'NO_CHANGE' })),
    runKh001ProviderEventsNormalizer_: stub('runKh001ProviderEventsNormalizer_', result('pe', { status: 'NO_CHANGE' })),
    runInternalNormalizer_: stub('runInternalNormalizer_', result('internal', { status: 'NO_CHANGE' })),
    runPaymentReconciliation_: stub('runPaymentReconciliation_', result('reconcile', { status: 'NO_CHANGE' })),
    runKh001SettlementsNormalizer_: stub('runKh001SettlementsNormalizer_', result('settlements', { status: 'NO_CHANGE' })),
    runPaymentLegsNormalizer_: stub('runPaymentLegsNormalizer_', result('legs', { status: 'NO_CHANGE' })),
    runSettlementItemsNormalizer_: stub('runSettlementItemsNormalizer_', result('items', { status: 'NO_CHANGE' })),
    runSellerBalancesNormalizer_: stub('runSellerBalancesNormalizer_', result('balances', { status: 'NO_CHANGE' })),
    readSellerAllocationInputs_: stub('readSellerAllocationInputs_', { validation: result('allocations', okValidation) }),
    buildPaymentPipelineHealth_: stub('buildPaymentPipelineHealth_', result('health', { pass: true, checks: [{ name: 'x', pass: true, detail: 'ok' }], errors: [] })),
    runSellerSheetsSync_: stub('runSellerSheetsSync_', result('sellerSync', { status: 'NO_CHANGE', sellers: [{ seller_id: 'CUS001', status: 'NO_CHANGE' }] })),
  });
}
const actions = () => env.audit.map((e) => e.action);
const STAGES = ['PROVIDER_SYNC', 'PROVIDER_NORMALIZE', 'INTERNAL_NORMALIZE', 'RECONCILE', 'SETTLEMENT_REFRESH', 'PAYMENT_LEGS_REFRESH',
  'SETTLEMENT_ITEMS_REFRESH', 'SELLER_BALANCES_REFRESH', 'SELLER_PAYOUT_STATUS_REFRESH', 'HEALTH_CHECK', 'SELLER_SHEETS_SYNC'];

test('A: full scheduled pipeline success: every stage in order, health PASS, seller sheets synced last, complete audit trail', () => {
  install({ pt: { status: 'SUCCESS' }, legs: { status: 'SUCCESS' }, sellerSync: { status: 'SUCCESS', sellers: [{ seller_id: 'CUS001', status: 'SUCCESS' }] } });
  const r = js(H.runPaymentPipeline_({ trigger: 'time-driven' }));
  assert.equal(r.status, 'SUCCESS', r.error);
  assert.deepEqual(r.stages.map((s) => s.stage), STAGES);
  assert.deepEqual(env.calls, STAGE_RUNNERS, 'existing runners reused in the required order');
  assert.deepEqual(actions(), ['PIPELINE_STARTED', 'PROVIDER_SYNC_NO_CHANGE', 'PROVIDER_NORMALIZE_SUCCESS', 'INTERNAL_NORMALIZE_NO_CHANGE',
    'RECONCILE_NO_CHANGE', 'SETTLEMENT_REFRESH_NO_CHANGE', 'PAYMENT_LEGS_REFRESH_SUCCESS', 'SETTLEMENT_ITEMS_REFRESH_NO_CHANGE',
    'SELLER_BALANCES_REFRESH_NO_CHANGE', 'SELLER_PAYOUT_STATUS_REFRESH_SUCCESS', 'HEALTH_CHECK_PASS', 'SELLER_SHEETS_SYNC_SUCCESS', 'PIPELINE_SUCCESS']);
  env.audit.forEach((e) => { assert.equal(e.entityId, r.pipeline_run_id); assert.equal(e.details.pipeline_run_id, r.pipeline_run_id); });
  const done = env.audit[env.audit.length - 1].details;
  assert.ok(done.started_at && done.completed_at && done.duration_ms >= 0);
  const stage = env.audit[3].details;
  assert.deepEqual(Object.keys(stage).filter((k) => ['stage', 'status', 'started_at', 'completed_at', 'duration_ms'].includes(k)).sort(),
    ['completed_at', 'duration_ms', 'stage', 'started_at', 'status']);
  assert.equal(env.released, 1);
});

test('B: a provider sync failure stops the pipeline: nothing downstream runs, seller sheets are NOT synced', () => {
  install({ syncRawSource_: { provider: 'KH001', RAW_PP: 'FAILED', DoiSoat_GD: 'NO_CHANGE', PhieuDoiSoat: 'NO_CHANGE', Dispute: 'NO_CHANGE' } });
  const r = js(H.runPaymentPipeline_());
  assert.equal(r.status, 'FAILED');
  assert.equal(r.failed_stage, 'PROVIDER_SYNC');
  assert.deepEqual(env.calls, ['syncRawSource_']);
  assert.deepEqual(actions(), ['PIPELINE_STARTED', 'PROVIDER_SYNC_FAILED', 'PIPELINE_FAILED']);
  const failed = env.audit[2].details;
  assert.equal(failed.stage, 'PROVIDER_SYNC');
  assert.ok(failed.started_at && failed.failed_at && failed.error);
});

test('B2: any later stage failure, thrown error or failed health gate also stops before seller sheets', () => {
  for (const [o, stage] of [[{ legs: { status: 'FAILED', error: 'Seller Terms is invalid' } }, 'PAYMENT_LEGS_REFRESH'],
    [{ pe: { status: 'FAILED', error: 'x' } }, 'PROVIDER_NORMALIZE'],
    [{ health: { pass: false, checks: [{ name: 'matched_amount_mismatch_zero', pass: false, detail: 'MATCHED PM-1' }], errors: [] } }, 'HEALTH_CHECK'],
    [{ allocations: { errors: Object.assign(H.emptyAllocationErrors_(), { unallocated_effective_payouts: ['SP1'] }), summary: {} } }, 'SELLER_PAYOUT_STATUS_REFRESH']]) {
    install(o);
    const r = js(H.runPaymentPipeline_());
    assert.equal(r.status, 'FAILED');
    assert.equal(r.failed_stage, stage);
    assert.ok(!env.calls.includes('runSellerSheetsSync_'), stage + ': seller sheets not synced');
  }
  install({ health: { pass: false, checks: [{ name: 'seller_balances_reconcile', pass: false, detail: 'CUS001' }], errors: [] } });
  H.runPaymentPipeline_();
  assert.ok(actions().includes('HEALTH_CHECK_FAIL'));
  install({});
  context.runInternalNormalizer_ = () => { throw new Error('boom'); };
  const thrown = js(H.runPaymentPipeline_());
  assert.deepEqual([thrown.status, thrown.failed_stage, thrown.error], ['FAILED', 'INTERNAL_NORMALIZE', 'boom']);
  install({ sellerSync: { status: 'PARTIAL', sellers: [{ seller_id: 'CUS001', status: 'SUCCESS' }, { seller_id: 'CUS004', status: 'FAILED', error: 'no access' }] } });
  const partial = js(H.runPaymentPipeline_());
  assert.deepEqual([partial.status, partial.failed_stage], ['FAILED', 'SELLER_SHEETS_SYNC']);
  assert.match(partial.error, /CUS004 no access/);
});

test('C: a held pipeline lock skips the run cleanly (no stage runs, PIPELINE_SKIPPED_LOCKED audited)', () => {
  install({ lockHeld: true });
  const r = js(H.runPaymentPipeline_({ trigger: 'time-driven' }));
  assert.equal(r.status, 'SKIPPED_LOCKED');
  assert.deepEqual(env.calls, []);
  assert.deepEqual(actions(), ['PIPELINE_SKIPPED_LOCKED']);
  assert.equal(env.released, 0);
});

test('D: unchanged input -> every stage NO_CHANGE, health PASS, seller sync NO_CHANGE, PIPELINE_SUCCESS twice', () => {
  for (let i = 0; i < 2; i++) {
    install({});
    const r = js(H.runPaymentPipeline_());
    assert.equal(r.status, 'SUCCESS');
    assert.deepEqual(r.stages.map((s) => s.status), ['NO_CHANGE', 'NO_CHANGE', 'NO_CHANGE', 'NO_CHANGE', 'NO_CHANGE', 'NO_CHANGE', 'NO_CHANGE', 'NO_CHANGE',
      'SUCCESS', 'PASS', 'NO_CHANGE']);
  }
});

// ---- provider adapter registry (Phase 2M.1) ---------------------------------------------------------------
const source = (id) => ({ providerId: id, enabledSetting: 'source.' + id + '.enabled', tabs: [] });
const fakeAdapters = (id, o) => {
  const call = (step, def) => () => { env.calls.push(id + '.' + step); return (o && o[step]) || def; };
  return { transactions: call('transactions', { status: 'NO_CHANGE' }), events: call('events', { status: 'NO_CHANGE' }),
    settlements: call('settlements', { status: 'NO_CHANGE' }), eventsReport: call('eventsReport', { pass: true }) };
};

test('registry: KH001 enabled -> exactly the KH001 runners, in order, with per-provider stage details', () => {
  install({});
  const r = js(H.runPaymentPipeline_());
  assert.equal(r.status, 'SUCCESS');
  assert.deepEqual(env.calls.filter((c) => /Kh001|syncRawSource_/.test(c)), ['syncRawSource_', 'runKh001ProviderTransactionsNormalizer_',
    'runKh001ProviderEventsNormalizer_', 'runKh001SettlementsNormalizer_']);
  assert.deepEqual(r.stages[0].providers, ['KH001']);
  assert.deepEqual([r.stages[1].provider_transactions, r.stages[1].provider_events], [{ KH001: 'NO_CHANGE' }, { KH001: 'NO_CHANGE' }]);
  assert.deepEqual(js(H.resolvePipelineProviders_(vm.runInContext('RAW_SOURCES', context), { 'source.KH001.enabled': true },
    vm.runInContext('PROVIDER_PIPELINE_RUNNERS', context))).missing, []);
});

test('registry: an ENABLED provider without adapters fails closed before any fetch; nothing downstream, no seller sync', () => {
  install({ rawSources: { KH001: source('KH001'), KH002: source('KH002') }, settings: { 'source.KH001.enabled': true, 'source.KH002.enabled': true } });
  const r = js(H.runPaymentPipeline_());
  assert.deepEqual([r.status, r.failed_stage], ['FAILED', 'PROVIDER_SYNC']);
  assert.match(r.error, /enabled provider\(s\) without a pipeline adapter: KH002 \(transactions, events, settlements, eventsReport\)/);
  assert.deepEqual(env.calls, [], 'no raw fetch, no normalize, no reconcile, no seller sync');
  const audit = env.audit.find((e) => e.action === 'PROVIDER_SYNC_FAILED');
  assert.deepEqual(audit.details.missing_adapters, ['KH002 (transactions, events, settlements, eventsReport)']);
  assert.deepEqual(actions(), ['PIPELINE_STARTED', 'PROVIDER_SYNC_FAILED', 'PIPELINE_FAILED']);
  const partial = { KH001: vm.runInContext('PROVIDER_PIPELINE_RUNNERS', context).KH001, KH002: { transactions: () => ({}) } };
  assert.deepEqual(js(H.resolvePipelineProviders_({ KH001: source('KH001'), KH002: source('KH002') }, { 'source.KH001.enabled': true,
    'source.KH002.enabled': 'TRUE' }, partial)).missing, ['KH002 (events, settlements, eventsReport)'], 'incomplete adapter sets fail too');
});

test('registry: a DISABLED provider is never fetched or normalized (even without adapters)', () => {
  install({ rawSources: { KH001: source('KH001'), KH009: source('KH009') }, settings: { 'source.KH001.enabled': false, 'source.KH009.enabled': false } });
  const r = js(H.runPaymentPipeline_());
  assert.equal(r.status, 'SUCCESS', r.error);
  assert.ok(!env.calls.some((c) => /Kh001|syncRawSource_/.test(c)), 'no KH001 runner, no raw sync');
  assert.deepEqual([r.stages[0].providers, r.stages[0].disabled_providers], [[], ['KH001', 'KH009']]);
});

test('registry: several enabled providers run one by one; one provider failing stops the pipeline before seller publish', () => {
  const rawSources = { KH001: source('KH001'), KH002: source('KH002') };
  const settings = { 'source.KH001.enabled': true, 'source.KH002.enabled': true };
  install({ rawSources, settings, registry: { KH001: fakeAdapters('KH001'), KH002: fakeAdapters('KH002', { settlements: { status: 'SUCCESS' } }) } });
  let r = js(H.runPaymentPipeline_());
  assert.equal(r.status, 'SUCCESS');
  assert.deepEqual(env.calls.filter((c) => /^KH00|syncRawSource_/.test(c)), ['syncRawSource_', 'syncRawSource_', 'KH001.transactions', 'KH002.transactions',
    'KH001.events', 'KH002.events', 'KH001.settlements', 'KH002.settlements', 'KH001.eventsReport', 'KH002.eventsReport'].filter((c) => !/eventsReport/.test(c)));
  assert.deepEqual(r.stages.find((s) => s.stage === 'SETTLEMENT_REFRESH').status, 'SUCCESS');
  install({ rawSources, settings, registry: { KH001: fakeAdapters('KH001'), KH002: fakeAdapters('KH002', { transactions: { status: 'FAILED', error: 'bad raw' } }) } });
  r = js(H.runPaymentPipeline_());
  assert.deepEqual([r.status, r.failed_stage], ['FAILED', 'PROVIDER_NORMALIZE']);
  assert.match(r.error, /^KH002 Provider Transactions: bad raw/);
  assert.deepEqual(r.stages[1].provider_transactions, { KH001: 'NO_CHANGE', KH002: 'FAILED' });
  assert.ok(!env.calls.includes('KH001.events') && !env.calls.includes('runInternalNormalizer_') && !env.calls.includes('runSellerSheetsSync_'));
  install({ rawSources, settings, registry: { KH001: fakeAdapters('KH001', { settlements: { status: 'FAILED', error: 'x' } }), KH002: fakeAdapters('KH002') } });
  r = js(H.runPaymentPipeline_());
  assert.deepEqual([r.failed_stage, env.calls.includes('KH002.settlements'), env.calls.includes('runSellerSheetsSync_')], ['SETTLEMENT_REFRESH', false, false]);
});

test('raw sync classification: DISABLED sources are skipped; any failed tab fails the stage', () => {
  assert.equal(H.classifyRawSyncSummary_({ provider: 'KH001', status: 'DISABLED' }), 'NO_CHANGE');
  assert.equal(H.classifyRawSyncSummary_({ provider: 'KH001', A: 'SUCCESS', B: 'NO_CHANGE' }), 'SUCCESS');
  assert.equal(H.classifyRawSyncSummary_({ provider: 'KH001', A: 'NO_CHANGE', B: 'FAILED' }), 'FAILED');
  assert.equal(H.combineStageStatuses_(['NO_CHANGE', 'NO_CHANGE']), 'NO_CHANGE');
  assert.equal(H.combineStageStatuses_(['NO_CHANGE', 'SUCCESS']), 'SUCCESS');
});

// ---- schedule / triggers ----------------------------------------------------------------------------------
function installScriptApp(settings, existing) {
  const triggers = (existing || []).slice();
  const created = [];
  context.readSettingsMap_ = () => settings;
  context.ScriptApp = {
    getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.handler, __t: t })),
    deleteTrigger: (t) => { triggers.splice(triggers.indexOf(t.__t), 1); },
    newTrigger: (handler) => {
      const spec = { handler };
      const b = { timeBased: () => b, atHour: (h) => { spec.hour = h; return b; }, nearMinute: (m) => { spec.minute = m; return b; },
        everyDays: (d) => { spec.everyDays = d; return b; }, inTimezone: (tz) => { spec.tz = tz; return b; },
        create: () => { triggers.push(spec); created.push(spec); return spec; } };
      return b;
    },
  };
  context.appendAuditLog_ = () => {};
  return { triggers, created };
}
const SCHEDULE = { scheduled_sync_morning_hour: 8, scheduled_sync_afternoon_hour: 17, scheduled_sync_timezone: 'America/New_York' };

test('triggers: installer creates exactly two daily triggers from Settings and is idempotent (no duplicates, others untouched)', () => {
  const s = installScriptApp(SCHEDULE, [{ handler: 'onOpen' }, { handler: 'runScheduledPaymentPipeline', hour: 3 }]);
  const r1 = js(H.installPaymentPipelineTriggers_());
  assert.deepEqual([r1.removed, r1.created, r1.installed], [1, 2, 2]);
  for (let i = 0; i < 3; i++) H.installPaymentPipelineTriggers_();
  const mine = s.triggers.filter((t) => t.handler === 'runScheduledPaymentPipeline');
  assert.deepEqual(mine.map((t) => [t.hour, t.minute, t.everyDays, t.tz]), [[8, 0, 1, 'America/New_York'], [17, 0, 1, 'America/New_York']]);
  assert.equal(s.triggers.filter((t) => t.handler === 'onOpen').length, 1);
  assert.equal(H.removePaymentPipelineTriggers_(), 2);
  assert.equal(s.triggers.length, 1);
  installScriptApp({ ...SCHEDULE, scheduled_sync_afternoon_hour: '8' });
  assert.throws(() => H.installPaymentPipelineTriggers_(), /morning and afternoon hours must differ/);
  installScriptApp({ ...SCHEDULE, scheduled_sync_morning_hour: 24 });
  assert.throws(() => H.installPaymentPipelineTriggers_(), /scheduled_sync_morning_hour must be a whole hour 0-23/);
  installScriptApp({ ...SCHEDULE, scheduled_sync_timezone: '' });
  assert.throws(() => H.installPaymentPipelineTriggers_(), /scheduled_sync_timezone is blank/);
  assert.deepEqual(js(vm.runInContext('DEFAULT_SETTINGS', context)).filter((x) => x[0].startsWith('scheduled_sync_')).map((x) => [x[0], x[1]]),
    [['scheduled_sync_morning_hour', 8], ['scheduled_sync_afternoon_hour', 17], ['scheduled_sync_timezone', 'America/New_York']]);
});

// ---- health invariants ------------------------------------------------------------------------------------
function baseSpec() {
  return { sellers: [{ seller_id: 'CUS001', seller_name: 'DITECH' }],
    txs: [{ id: 'A1', seller: 'CUS001', order: 104, leg: { fee: 4, rate: 0.08, settlement: 'ST-1' } },
      { id: 'A2', seller: 'CUS001', order: 30, status: 'MISSING_PROVIDER' }] };
}
const invariants = (m) => {
  const v = H.validateSellerPayoutAllocations_({ allocations: m.allocations, payouts: m.payouts, items: m.settlementItems, settlements: m.settlements,
    adjustments: m.adjustments, dateKeyOf: NY });
  return js(H.evaluatePipelineInvariants_({ providerTransactions: [], transactions: m.transactions, matches: m.matches.map((x) => ({ ...x,
    internal_amount: m.transactions.find((t) => t.internal_transaction_id === x.internal_transaction_id).order_amount,
    provider_gross_amount: x.provider_gross_amount })), legs: m.legs, items: m.settlementItems, settlements: m.settlements, adjustments: m.adjustments,
  payouts: m.payouts, allocations: m.allocations, balances: m.balances, sellerIds: ['CUS001'], allocationValidation: v }));
};
const failing = (checks) => checks.filter((c) => !c.pass).map((c) => c.name);

test('health invariants: pass on consistent data; duplicates, MATCHED mismatch, seller equation, balance drift and allocation errors fail', () => {
  assert.deepEqual(failing(invariants(makeMaster(D, baseSpec()))), []);
  let m = makeMaster(D, baseSpec());
  m.legs.push({ ...m.legs[0] });
  assert.ok(failing(invariants(m)).includes('no_duplicate_ids'));
  m = makeMaster(D, baseSpec());
  m.matches[0].provider_gross_amount = 105;
  assert.ok(failing(invariants(m)).includes('matched_amount_mismatch_zero'));
  m = makeMaster(D, baseSpec());
  m.legs[0].seller_available_amount += 1;
  assert.ok(failing(invariants(m)).includes('seller_available_equation'));
  m = makeMaster(D, baseSpec());
  m.balances[0].current_balance += 0.01;
  assert.ok(failing(invariants(m)).includes('seller_balances_reconcile'));
  m = makeMaster(D, { ...baseSpec(), payouts: [{ seller_payout_id: 'SP1', seller_id: 'CUS001', currency: 'USD', amount: 10, status: 'SENT',
    payout_date: D('2026-10-10T04:00:00Z') }] });
  assert.deepEqual(failing(invariants(m)), ['payout_allocations_valid'], 'effective payout without allocation');
});

// ---- seller paid vs provider paid (E-L) ---------------------------------------------------------------------
const OBLIGATION = { sellers: [{ seller_id: 'CUS002', seller_name: 'HUI' }],
  txs: [{ id: 'H1', seller: 'CUS002', order: 100, leg: { fee: 0, rate: 0, holdRate: 0, settlement: 'ST-1' } }] };
const payout = (id, amount, status) => ({ seller_payout_id: id, seller_id: 'CUS002', currency: 'USD', amount, status, payout_date: D('2026-10-10T04:00:00Z'),
  payment_method: 'Bank', reference: 'REF-' + id });
const alloc = (pid, amount) => ({ allocation_id: H.sellerAllocationId_(pid, 'SETTLEMENT', 'ST-1'), seller_payout_id: pid, seller_id: 'CUS002',
  target_type: 'SETTLEMENT', target_id: 'ST-1', payment_source: 'PAYPAL', currency: 'USD', allocated_amount: amount });
function masterState(payouts, allocations) {
  const m = makeMaster(D, { ...OBLIGATION, payouts: payouts || [], allocations: allocations || [] });
  m.settlements[0].source_paid_amount = 100; // provider already paid VNS in full
  m.settlements[0].outstanding_amount = 0;
  const v = H.validateSellerPayoutAllocations_({ allocations: m.allocations, payouts: m.payouts, items: m.settlementItems, settlements: m.settlements,
    adjustments: m.adjustments, dateKeyOf: NY });
  return { m, v, st: js(v.states)[0], errors: js(H.flattenAllocationErrors_(v.errors)) };
}

test('E/F: provider paid VNS (settlement AVAILABLE, source_paid_amount = due) but no seller payout -> seller obligation UNPAID', () => {
  const { m, st, errors } = masterState();
  assert.equal(m.legs[0].settlement_status, 'AVAILABLE', 'provider side: available');
  assert.deepEqual(errors, []);
  assert.deepEqual([st.due_amount, st.paid_amount, st.remaining_amount, st.payment_status], [100, 0, 100, 'UNPAID'], 'seller side: unpaid');
  assert.equal(m.balances[0].current_balance, 100, 'Seller Balance unchanged without payouts');
});

test('G/H: allocation 40 -> PARTIAL (60 outstanding); a further 60 -> PAID (0 outstanding)', () => {
  let s = masterState([payout('SP1', 40, 'SENT')], [alloc('SP1', 40)]).st;
  assert.deepEqual([s.paid_amount, s.remaining_amount, s.payment_status], [40, 60, 'PARTIAL']);
  s = masterState([payout('SP1', 40, 'SENT'), payout('SP2', 60, 'CONFIRMED')], [alloc('SP1', 40), alloc('SP2', 60)]).st;
  assert.deepEqual([s.paid_amount, s.remaining_amount, s.payment_status], [100, 0, 'PAID']);
});

test('I: a paid payout that becomes VOID / REVERSED / CANCELLED / FAILED falls back to UNPAID and restores the balance', () => {
  assert.equal(masterState([payout('SP1', 100, 'SENT')], [alloc('SP1', 100)]).st.payment_status, 'PAID');
  for (const status of ['VOID', 'REVERSED', 'CANCELLED', 'FAILED']) {
    const { m, st, errors } = masterState([payout('SP1', 100, status)], [alloc('SP1', 100)]);
    assert.deepEqual(errors, [], status);
    assert.deepEqual([st.paid_amount, st.payment_status], [0, 'UNPAID'], status);
    assert.equal(m.balances[0].current_balance, 100, status + ': balance restored (never a valid payout)');
  }
  assert.deepEqual(js(vm.runInContext('ENUMS.SELLER_PAYOUT_STATUS', context)), ['DRAFT', 'SENT', 'CONFIRMED', 'VOID', 'REVERSED', 'CANCELLED', 'FAILED']);
});

test('J: an allocation may not exceed its payout; a rerun never duplicates allocation rows', () => {
  assert.match(masterState([payout('SP1', 40, 'SENT')], [alloc('SP1', 60)]).errors.join(), /allocated 60 > payout amount 40/);
  assert.match(masterState([payout('SP1', 100, 'SENT')], [alloc('SP1', 50), alloc('SP1', 50)]).errors.join(), /duplicate seller_payout_id/);
  const p = payout('SP9', 100, 'DRAFT');
  const { v } = masterState([p]);
  const first = js(H.planFifoAllocation_(p, [], v, { SP9: p }, D('2026-10-20T00:00:00Z')));
  assert.equal(first.rows.length, 1);
  const again = js(H.planFifoAllocation_(p, first.rows, v, { SP9: p }, D('2026-10-20T00:00:00Z')));
  assert.deepEqual([again.status, again.rows], ['NO_CHANGE', []]);
});

test('K/L: the seller child shows exactly the Master status; it is never derived from the provider settlement', () => {
  const template = makeSpreadsheet({ id: 'TEMPLATE_ID_0000000000000000001', makeDate: (ms) => vm.runInContext(`new Date(${ms})`, context) });
  for (const [payouts, allocations, expected] of [[[], [], 'UNPAID'], [[payout('SP1', 40, 'SENT')], [alloc('SP1', 40)], 'PARTIAL'],
    [[payout('SP1', 100, 'CONFIRMED')], [alloc('SP1', 100)], 'PAID'], [[payout('SP1', 100, 'REVERSED')], [alloc('SP1', 100)], 'UNPAID']]) {
    const { m, st } = masterState(payouts, allocations);
    const child = cloneSpreadsheet(template, 'CHILD_HUI_000000000000000000001', (ms) => vm.runInContext(`new Date(${ms})`, context));
    const out = H.buildSellerOutputs_({ ...m, sellers: OBLIGATION.sellers, dateKeyOf: NY });
    assert.deepEqual(js(out.errors), []);
    const snap = out.snapshots.CUS002;
    const layouts = js(H.validateSellerWorkbook_(H.readSellerWorkbook_(child.api), { mode: 'child', hiddenIds: [] })).layouts;
    context.SpreadsheetApp = { CopyPasteType: { PASTE_FORMAT: 'PASTE_FORMAT', PASTE_FORMULA: 'PASTE_FORMULA' } };
    H.writeSellerTab_(child.api, 'PhieuDoiSoat', layouts.PhieuDoiSoat, snap.blocks.PhieuDoiSoat);
    const cells = child.sheets.find((s) => s.name === 'PhieuDoiSoat').cells;
    const label = cells['50,1'].v;
    assert.equal(label, 'PAYPAL #1 · ' + st.payment_status, 'child label = Master derived state');
    assert.equal(st.payment_status, expected, 'provider paid in full every time; seller status follows payouts only');
    assert.ok(near(cells['50,8'].v, st.paid_amount) && near(cells['50,9'].v, st.remaining_amount));
    if (expected === 'PAID') assert.equal(cells['50,15'].v, '10/10/2026 · Bank · REF-SP1 · 100', 'payout date / method / reference from Master');
    if (expected === 'UNPAID') assert.ok([undefined, ''].includes(cells['50,15'].v), 'no valid payout -> no payout reference');
  }
});
