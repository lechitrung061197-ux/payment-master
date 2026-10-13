// Phase 2O.2: one operational timezone for Payment Master (America/New_York). Scheduled pipeline hours, trigger
// installation and Master-generated dates use APP.TIMEZONE; the KH001 provider source timezone (America/Los_Angeles)
// stays separate and read-only. Fake data on the production-shaped simulation.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildMasterSim } = require('./helpers/masterSim');

const sim = buildMasterSim();
const { call, mS } = sim;
const js = (v) => JSON.parse(JSON.stringify(v));
const SRC = path.join(__dirname, '..', 'src');
const near = (a, b) => Math.abs(a - b) < 1e-6;

function settings() {
  const a = mS('Settings').api;
  return Object.fromEntries(a.getRange(2, 1, a.getLastRow() - 1, 5).getValues().map((r) => [r[0], { value: r[1], description: r[3], updated_at: r[4] }]));
}
function setSetting(key, value) {
  const a = mS('Settings').api;
  const keys = a.getRange(2, 1, a.getLastRow() - 1, 1).getValues().map((x) => x[0]);
  a.getRange(2 + keys.indexOf(key), 2).setValue(value);
}
/** ScriptApp stub recording what the installer asks for. */
function installScriptApp(existing) {
  const triggers = (existing || []).map((t) => ({ ...t }));
  let id = 0;
  sim.ctx.ScriptApp = {
    getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.handler, getUniqueId: () => t.id || 'T' + (++id), __t: t })),
    deleteTrigger: (x) => { triggers.splice(triggers.indexOf(x.__t), 1); },
    newTrigger: (handler) => {
      const spec = { handler };
      const b = { timeBased: () => b, atHour: (h) => { spec.hour = h; return b; }, nearMinute: (m) => { spec.minute = m; return b; },
        everyDays: (d) => { spec.everyDays = d; return b; }, inTimezone: (tz) => { spec.tz = tz; return b; },
        create: () => { triggers.push(spec); return spec; } };
      return b;
    },
  };
  return triggers;
}

test.beforeEach(() => sim.restore());

test('1: the canonical default schedule is 08:00 / 17:00 in the Master timezone America/New_York', () => {
  assert.equal(call('APP.TIMEZONE'), 'America/New_York');
  const defaults = js(call('DEFAULT_SETTINGS')).filter((x) => x[0].startsWith('scheduled_sync_')).map((x) => [x[0], x[1]]);
  assert.deepEqual(defaults, [['scheduled_sync_morning_hour', 8], ['scheduled_sync_afternoon_hour', 17], ['scheduled_sync_timezone', 'America/New_York']]);
  const s = settings();
  assert.deepEqual([s.scheduled_sync_morning_hour.value, s.scheduled_sync_afternoon_hour.value, s.scheduled_sync_timezone.value], [8, 17, 'America/New_York'],
    'a fresh setup seeds New York');
  assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'appsscript.json'), 'utf8')).timeZone, 'America/New_York', 'script timezone');
});

test('2: the trigger installer creates exactly two daily triggers 08:00 / 17:00 in America/New_York (idempotent); verify passes', () => {
  const triggers = installScriptApp([{ handler: 'onOpen' }, { handler: 'runScheduledPaymentPipeline', hour: 8, tz: 'Asia/Ho_Chi_Minh' },
    { handler: 'runScheduledPaymentPipeline', hour: 17, tz: 'Asia/Ho_Chi_Minh' }]);
  const r = js(call('installScheduledPaymentPipelineTriggers()'));
  assert.deepEqual([r.removed, r.created, r.installed, r.time_zone, r.master_timezone, r.warnings], [2, 2, 2, 'America/New_York', 'America/New_York', []]);
  call('installScheduledPaymentPipelineTriggers()');
  const mine = triggers.filter((t) => t.handler === 'runScheduledPaymentPipeline');
  assert.deepEqual(mine.map((t) => [t.hour, t.minute, t.everyDays, t.tz]), [[8, 0, 1, 'America/New_York'], [17, 0, 1, 'America/New_York']], 'no duplicates');
  assert.equal(triggers.filter((t) => t.handler === 'onOpen').length, 1, 'other triggers untouched');
  const v = js(call('verifyScheduledPaymentPipelineTriggers()'));
  assert.equal(v.pass, true, JSON.stringify(v.errors));
  assert.deepEqual([v.trigger_count, v.last_install.time_zone, v.last_install.morning_hour, v.last_install.afternoon_hour], [2, 'America/New_York', 8, 17]);
});

test('3: the Operations default payout date is the New York date (not the Vietnam date)', () => {
  // 2026-10-13 02:30 UTC = 12/10 22:30 in New York = 13/10 09:30 in Ho Chi Minh City
  const FIXED = Date.parse('2026-10-13T02:30:00Z');
  const RealDate = vm.runInContext('Date', sim.ctx);
  vm.runInContext(`Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(${FIXED}); } static now() { return ${FIXED}; } };`, sim.ctx);
  try {
    sim.setForm({ payout_date: '' });
    assert.equal(js(call('refreshOperations()')).status, 'SUCCESS');
    assert.equal(sim.formValue('payout_date'), '12/10/2026');
    assert.equal(call('masterDateKey_(new Date())'), '2026-10-12');
    // an operator date that is already filled is never replaced
    sim.setForm({ payout_date: '11/10/2026' });
    call('refreshOperations()');
    assert.equal(sim.formValue('payout_date'), '11/10/2026');
  } finally {
    sim.ctx.Date = RealDate;
  }
});

test('4: no operational hard-coded Vietnam timezone (Asia/Ho_Chi_Minh, GMT+7, +07:00) remains in src', () => {
  const offenders = [];
  fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).forEach((f) => {
    fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/\/\*\*.*$/, '');
      if (/retiredScheduleTimezones/.test(code)) return; // the migration's list of the retired value it replaces
      if (/Ho_Chi_Minh|GMT\s*\+\s*7|\+07:00|Asia\/Saigon/.test(code)) offenders.push(f + ':' + (i + 1) + ' ' + line.trim());
    });
  });
  assert.deepEqual(offenders, []);
});

test('5: explicit migration Asia/Ho_Chi_Minh -> America/New_York (setup never overwrites); KH001 provider timezone stays Los Angeles', () => {
  setSetting('scheduled_sync_timezone', 'Asia/Ho_Chi_Minh'); // production today
  call('setupMaster()');
  assert.equal(settings().scheduled_sync_timezone.value, 'Asia/Ho_Chi_Minh', 'setupMaster does not silently overwrite an existing Settings value');
  installScriptApp([]);
  const warn = js(call('installScheduledPaymentPipelineTriggers()'));
  assert.match(warn.warnings[0], /differs from the Master timezone America\/New_York/);
  assert.equal(js(call('verifyScheduledPaymentPipelineTriggers()')).pass, false);
  const before = settings();
  const r = js(call('migrateScheduledPipelineTimezoneToMaster()'));
  assert.deepEqual([r.status, r.old_value, r.new_value], ['SUCCESS', 'Asia/Ho_Chi_Minh', 'America/New_York']);
  assert.match(r.next_step, /installScheduledPaymentPipelineTriggers/);
  const after = settings();
  assert.equal(after.scheduled_sync_timezone.value, 'America/New_York');
  assert.match(after.scheduled_sync_timezone.description, /Master timezone/);
  Object.keys(before).filter((k) => k !== 'scheduled_sync_timezone').forEach((k) => assert.deepEqual(js(after[k]), js(before[k]), k + ' unchanged'));
  assert.equal(after['source.KH001.timezone'].value, 'America/Los_Angeles', 'provider source timezone kept');
  assert.equal(js(call('DEFAULT_SETTINGS')).find((x) => x[0] === 'source.KH001.timezone')[1], 'America/Los_Angeles');
  const audit = sim.audit().filter((a) => a.action === 'PIPELINE_SCHEDULE_TIMEZONE_MIGRATED');
  assert.deepEqual(audit.map((a) => [a.entity_id, a.old_status, a.new_status]), [['scheduled_sync_timezone', 'Asia/Ho_Chi_Minh', 'America/New_York']]);
  assert.equal(js(call('verifyScheduledPaymentPipelineTriggers()')).pass, false, 'triggers still from the old schedule until reinstalled');
  call('installScheduledPaymentPipelineTriggers()');
  assert.equal(js(call('verifyScheduledPaymentPipelineTriggers()')).pass, true);
  assert.equal(js(call('migrateScheduledPipelineTimezoneToMaster()')).status, 'NO_CHANGE', 'idempotent');
  setSetting('scheduled_sync_timezone', 'Europe/London'); // an operator's own choice is never replaced
  const custom = js(call('migrateScheduledPipelineTimezoneToMaster()'));
  assert.equal(custom.status, 'FAILED');
  assert.equal(settings().scheduled_sync_timezone.value, 'Europe/London');
  // the provider timezone is still what reads KH001 dates: settlement payment dates unchanged
  assert.equal(js(call('normalizeKh001Settlements()')).status, 'NO_CHANGE');
});

test('6: DST is left to the IANA zone: fixed UTC offsets are rejected and no offset arithmetic exists', () => {
  ['GMT+7', 'UTC', 'UTC-05:00', 'Etc/GMT-7', 'Etc/GMT+5', '+07:00', 'EST'].forEach((tz) => {
    const p = js(call('parsePipelineSchedule_')({ scheduled_sync_morning_hour: 8, scheduled_sync_afternoon_hour: 17, scheduled_sync_timezone: tz }));
    assert.match(p.errors.join(), /must be an IANA region time zone/, tz);
  });
  ['America/New_York', 'Asia/Ho_Chi_Minh', 'America/Argentina/Buenos_Aires'].forEach((tz) => {
    assert.deepEqual(js(call('parsePipelineSchedule_')({ scheduled_sync_morning_hour: 8, scheduled_sync_afternoon_hour: 17, scheduled_sync_timezone: tz })).errors, [], tz);
  });
  const pipeline = fs.readFileSync(path.join(SRC, 'PaymentPipeline.gs'), 'utf8');
  const code = pipeline.split('\n').map((l) => l.replace(/\/\/.*$/, '').replace(/^\s*(\/\*\*|\*).*$/, '')).join('\n');
  assert.ok(!/getTimezoneOffset|UTC[+-]\d|setUTCHours|\* 3600000|3600 \* 1000/.test(code), 'no fixed-offset arithmetic');
  assert.match(pipeline, /\.atHour\(h\)\.nearMinute\(0\)\.everyDays\(1\)\.inTimezone\(schedule\.timeZone\)/, 'wall-clock hour in the IANA zone');
  // the same 08:00 New York wall clock is 12:00 UTC in summer (EDT) and 13:00 UTC in winter (EST)
  const ny8 = (day) => require('./helpers/masterSim').zonedMidnight(day, 'America/New_York').getTime() + 8 * 3600e3;
  assert.equal(new Date(ny8('2026-10-12')).getUTCHours(), 12);
  assert.equal(new Date(ny8('2026-12-01')).getUTCHours(), 13);
});

test('7: accounting regression unchanged by the timezone patch (168 items, 8370.0516 / 1020.738, 7 UNPAID, no payouts)', () => {
  setSetting('scheduled_sync_timezone', 'Asia/Ho_Chi_Minh');
  call('migrateScheduledPipelineTimezoneToMaster()');
  const p = js(call('runScheduledPaymentPipeline()'));
  assert.equal(p.status, 'SUCCESS', p.error);
  const b = sim.rows('Seller Balances');
  assert.ok(near(b.reduce((a, x) => a + x.available_amount, 0), 8370.0516));
  assert.ok(near(b.reduce((a, x) => a + x.seller_hold_balance, 0), 1020.738));
  assert.equal(sim.rows('Settlement Items').length, 168);
  assert.equal(sim.rows('Payment Legs').filter((l) => l.settlement_status === 'AVAILABLE').length, 168);
  const states = js(call('verifySellerPayoutAllocations()')).obligation_states;
  assert.deepEqual([states.length, states.every((s) => s.payment_status === 'UNPAID')], [7, true]);
  assert.deepEqual([sim.rows('Seller Payouts').length, sim.rows('Seller Payout Allocations').length], [0, 0]);
  assert.equal(call('SELLER_OUTPUT.schemaVersion'), 4);
  assert.equal(call('APP.SCHEMA_VERSION'), 18, 'no schema bump');
});
