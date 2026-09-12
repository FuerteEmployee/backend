// Integration test for day reconciliation against a REAL mongod.
//
// The pure rule engine is already covered by reconcile.test.js. What this
// proves is everything that only exists at the database boundary: that the
// schemas register, that the TTL and unique indexes actually build, that the
// upsert/dedupe behaves under a genuine duplicate-key error, and that
// derivedFields correctly protects an explicit app punch from being overwritten.
//
// Run from the backend directory:  node <this file>
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SRC = path.join(__dirname, '..', 'src');
const Attendance = require(path.join(SRC, 'models/Attendance'));
const PunchLog = require(path.join(SRC, 'models/PunchLog'));
const User = require(path.join(SRC, 'models/User'));
const Settings = require(path.join(SRC, 'models/Settings'));
const { reconcileDay, debounceMs } = require(path.join(SRC, 'utils/punch_reconcile'));
const { parseDeviceTimestamp, istDateKey, istStartOfDay } = require(path.join(SRC, 'utils/attendance_helpers'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};
const hhmm = (d) => d ? new Date(new Date(d).getTime() + 5.5 * 3600e3).toISOString().slice(11, 16) : null;

// A fixed "now" so drift rejection is deterministic.
const NOW = new Date('2026-09-10T12:00:00Z');
const DAY = '2026-09-10';

let adminId, employeeId;

async function tap(hh, { serial = 'SN-TEST-1', pin = '42', discarded = false } = {}) {
  const deviceTime = parseDeviceTimestamp(`${DAY} ${hh}`, NOW);
  return PunchLog.create({
    adminId, employeeId, dayKey: istDateKey(deviceTime), deviceTime,
    serialNumber: serial, pin, source: 'biometric',
    discarded, discardReason: discarded ? 'debounced' : null,
  });
}

async function reset() {
  await PunchLog.deleteMany({});
  await Attendance.deleteMany({});
}

async function run(dayKey = DAY) {
  return reconcileDay({ Attendance, PunchLog, User, Settings, adminId, employeeId, dayKey });
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'reconcile_test' });
  console.log('connected to in-memory mongod\n');

  // Building indexes is itself part of what we are verifying.
  await Promise.all([PunchLog.syncIndexes(), Attendance.syncIndexes()]);
  const idx = await PunchLog.collection.indexes();
  console.log('— indexes —');
  ok('unique index on (serialNumber, pin, deviceTime) built',
     idx.some(i => i.unique && i.key.serialNumber === 1 && i.key.pin === 1 && i.key.deviceTime === 1));
  ok('TTL index on createdAt built', idx.some(i => typeof i.expireAfterSeconds === 'number'));

  const admin = await User.create({ name: 'Test Co', phone: '9000000001', role: 'admin', isActive: true });
  adminId = admin._id;
  const emp = await User.create({ name: 'Ramesh', phone: '9000000002', role: 'employee', adminId, isActive: true });
  employeeId = emp._id;
  await Settings.create({ adminId });

  console.log('\n— reconcileDay(): the product rule, persisted —');
  await reset();
  await tap('09:30');
  let a = await run();
  ok('1 tap → punchIn set, day open', hhmm(a.punchIn) === '09:30' && !a.punchOut);
  ok('1 tap → punchOut marked NOT provisional', a.punchOutIsProvisional === false);

  await reset();
  await tap('09:30'); await tap('18:30');
  a = await run();
  ok('2 taps → in + out, no lunch',
     hhmm(a.punchIn) === '09:30' && hhmm(a.punchOut) === '18:30' && !a.lunchInTime && !a.lunchOutTime);
  ok('2 taps → device punchOut IS provisional', a.punchOutIsProvisional === true);
  // 8.5h, not the raw 9h span: Settings.minLunch defaults to 30 and a lunch
  // shorter than the configured minimum -- here, none punched at all -- still
  // costs that minimum. Reconciliation used to run its own gross-minus-break
  // sum and returned 9h, so an identical day graded differently depending on
  // whether the terminal or the app closed it. Both now go through
  // computeWorkedMs, which is the point of this assertion.
  ok('2 taps → totalWorkMs = 9h span less the 30m configured lunch',
     a.totalWorkMs === 8.5 * 3600e3, `got ${a.totalWorkMs}`);

  await reset();
  await tap('09:30'); await tap('13:00'); await tap('14:00'); await tap('18:30');
  a = await run();
  ok('4 taps → lunch inferred',
     hhmm(a.lunchInTime) === '13:00' && hhmm(a.lunchOutTime) === '14:00');
  ok('4 taps → totalWorkMs nets off the 1h break', a.totalWorkMs === 8 * 3600e3, `got ${a.totalWorkMs}`);

  await reset();
  const many = ['09:30','10:05','11:12','12:00','13:00','13:20','13:45','14:00','15:30','16:00','16:40','17:10','17:50','18:10','18:30'];
  for (const t of many) await tap(t);
  a = await run();
  ok('15 taps → first is punch-in', hhmm(a.punchIn) === '09:30', `got ${hhmm(a.punchIn)}`);
  ok('15 taps → last is punch-out', hhmm(a.punchOut) === '18:30', `got ${hhmm(a.punchOut)}`);
  ok('15 taps → no lunch guessed', !a.lunchInTime && !a.lunchOutTime);
  const labelled = await PunchLog.find({ adminId, employeeId, dayKey: DAY, derivedAction: { $ne: null } }).lean();
  ok('15 taps → exactly 2 taps carry a derivedAction', labelled.length === 2, `got ${labelled.length}`);

  console.log('\n— idempotency: re-running must not drift —');
  const before = { in: a.punchIn, out: a.punchOut, ms: a.totalWorkMs };
  await run(); const again = await run();
  ok('re-derivation is stable',
     +again.punchIn === +before.in && +again.punchOut === +before.out && again.totalWorkMs === before.ms);
  ok('no duplicate Attendance row created', (await Attendance.countDocuments({ adminId, employeeId })) === 1);

  console.log('\n— durable dedupe (the restart-safety guarantee) —');
  await reset();
  await tap('09:30');
  let dupErr = null;
  try { await tap('09:30'); } catch (e) { dupErr = e; }
  ok('same (serial, pin, deviceTime) rejected by the DB', dupErr && dupErr.code === 11000,
     dupErr ? `code ${dupErr.code}` : 'no error thrown');
  ok('only one tap stored', (await PunchLog.countDocuments({ adminId, employeeId })) === 1);
  const other = await tap('09:30', { serial: 'SN-TEST-2' });
  ok('a DIFFERENT serial at the same instant is allowed', !!other);

  console.log('\n— discarded taps are excluded from derivation —');
  await reset();
  await tap('09:30');
  await tap('09:31', { discarded: true });   // debounced double-press
  await tap('18:30');
  a = await run();
  ok('debounced tap ignored → still a 2-tap day',
     hhmm(a.punchIn) === '09:30' && hhmm(a.punchOut) === '18:30' && !a.lunchInTime,
     `in=${hhmm(a.punchIn)} lunchIn=${hhmm(a.lunchInTime)}`);

  console.log('\n— explicit app punches survive reconciliation (derivedFields) —');
  await reset();
  const dayStart = istStartOfDay(new Date(Date.UTC(2026, 8, 10, 12)));
  await Attendance.create({
    adminId, employeeId, date: dayStart, status: 'present', source: 'app',
    punchIn: parseDeviceTimestamp(`${DAY} 09:00`, NOW),   // set by the APP
    derivedFields: [],                                     // so: not ours
  });
  await tap('13:00'); await tap('18:30');
  a = await run();
  ok('app punchIn 09:00 NOT overwritten by tap 13:00', hhmm(a.punchIn) === '09:00', `got ${hhmm(a.punchIn)}`);
  ok('punchOut still derived from the last tap', hhmm(a.punchOut) === '18:30', `got ${hhmm(a.punchOut)}`);
  ok('derivedFields records only what we own',
     a.derivedFields.includes('punchOut') && !a.derivedFields.includes('punchIn'),
     JSON.stringify(a.derivedFields));

  console.log('\n— offline backlog flushed the NEXT day —');
  await reset();
  // Taps that happened yesterday, arriving now.
  const yest = '2026-09-09';
  for (const t of ['09:30', '18:30']) {
    const deviceTime = parseDeviceTimestamp(`${yest} ${t}`, NOW);
    await PunchLog.create({
      adminId, employeeId, dayKey: istDateKey(deviceTime), deviceTime,
      serialNumber: 'SN-TEST-1', pin: '42', source: 'biometric',
    });
  }
  const yA = await run(yest);
  ok('backlog files to YESTERDAY, not today', yA && hhmm(yA.punchIn) === '09:30');
  ok('yesterday Attendance.date is yesterday IST midnight',
     istDateKey(yA.date) === yest, `got ${istDateKey(yA.date)}`);
  ok('today has no Attendance row from it',
     (await Attendance.countDocuments({ adminId, employeeId, date: dayStart })) === 0);

  console.log('\n— empty day —');
  await reset();
  ok('no taps → returns null, writes nothing', (await run()) === null);
  ok('no Attendance created', (await Attendance.countDocuments({})) === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('\nTEST HARNESS ERROR:', err);
  process.exit(1);
});
