// One day, three channels -- the scenario this system exists to support:
//
//   punched in on the MOBILE app
//   lunch in / lunch out on the LENS camera
//   punched out on the BIOMETRIC terminal
//
// These paths do not share a code path by accident: the app calls the handlers
// directly, the camera calls them with isDevicePunch set, and the terminal does
// not call them at all -- it writes through reconcileDay(). So "it works in the
// app" proves nothing about the other two, and the failure mode is silent: a
// plausible-looking day with somebody's hours quietly wrong.
//
// Run from the backend directory:  node scratch/test_mixed_channel_day.js
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SRC = path.join(__dirname, '..', 'src');
const Attendance = require(path.join(SRC, 'models/Attendance'));
const PunchLog = require(path.join(SRC, 'models/PunchLog'));
const AttendanceEvent = require(path.join(SRC, 'models/AttendanceEvent'));
const User = require(path.join(SRC, 'models/User'));
const Shift = require(path.join(SRC, 'models/Shift'));
const Branch = require(path.join(SRC, 'models/Branch'));
const Settings = require(path.join(SRC, 'models/Settings'));
const ctrl = require(path.join(SRC, 'controllers/attendance_controller'));
const { reconcileDay } = require(path.join(SRC, 'utils/punch_reconcile'));
const { istDateKey, istStartOfDay } = require(path.join(SRC, 'utils/attendance_helpers'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

let adminId, employeeId, shiftId, branchId;

/** Mock res capturing the handler reply, mirroring iclock's callHandler. */
function mockRes() {
    const r = { statusCode: 200, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
}

/** Invoke a real handler the way one of the three channels would. */
async function call(handler, { source = 'app', body = {} } = {}) {
    const req = {
        adminId, userId: employeeId, body,
        isDevicePunch: source !== 'app',
        deviceSource: source === 'app' ? undefined : source,
    };
    const res = mockRes();
    await handler(req, res);
    return res;
}

const load = () => Attendance.findOne({ adminId, employeeId, date: istStartOfDay() });

async function reset() {
    await Promise.all([
        Attendance.deleteMany({}),
        PunchLog.deleteMany({}),
        AttendanceEvent.deleteMany({}),
    ]);
}

/** AttendanceEvent writes are fire-and-forget; give them a tick to land. */
const settle = () => new Promise((r) => setTimeout(r, 150));

(async () => {
    const mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { dbName: 'mixed_channel_test' });
    console.log('connected to in-memory mongod\n');
    await Promise.all([Attendance.syncIndexes(), PunchLog.syncIndexes(), AttendanceEvent.syncIndexes()]);

    const admin = await User.create({ name: 'Test Co', phone: '9000000001', role: 'admin', isActive: true });
    adminId = admin._id;
    const shift = await Shift.create({ adminId, name: 'General', startTime: '09:00', endTime: '19:00' });
    shiftId = shift._id;
    const branch = await Branch.create({
        adminId, branchName: 'HQ', branchLocation: 'Rajkot',
        latitude: 22.3039, longitude: 70.8022, radius: 200, geoFenceEnabled: true,
    });
    branchId = branch._id;
    const emp = await User.create({
        name: 'Ramesh', phone: '9000000002', role: 'employee', adminId,
        isActive: true, shiftId, branchId, deviceUserId: '42',
    });
    employeeId = emp._id;
    // Second and later sessions are opt-in per tenant; without this the
    // re-punch below is refused and part B would silently test nothing.
    await Settings.create({ adminId, attendance: { allowMultiplePunches: true } });

    const atHQ = { address: 'HQ Rajkot', location: { lat: 22.3039, lng: 70.8022 } };

    // -- A: mobile in, camera lunch, terminal out ---------------------------
    console.log('- one session across all three channels -');
    await reset();

    await call(ctrl.punchIn, { source: 'app', body: { ...atHQ, accuracy: 12 } });
    let a = await load();
    const appPunchIn = a.punchIn ? new Date(a.punchIn).getTime() : null;
    ok('mobile punch-in recorded', !!appPunchIn);
    ok('day source is app', a.source === 'app', `got ${a.source}`);
    ok('session 1 punchInSource = app', a.shifts[0] && a.shifts[0].punchInSource === 'app',
        `got ${a.shifts[0] && a.shifts[0].punchInSource}`);

    await call(ctrl.lunchIn, { source: 'lens', body: atHQ });
    await call(ctrl.lunchOut, { source: 'lens', body: atHQ });
    a = await load();
    ok('camera recorded lunch in + out', !!a.lunchInTime && !!a.lunchOutTime);
    ok('mobile punch-in survived the camera taps', new Date(a.punchIn).getTime() === appPunchIn);

    const outRes = await call(ctrl.punchOut, { source: 'biometric', body: { ...atHQ, accuracy: 18 } });
    ok('terminal punch-out accepted', outRes.statusCode === 200,
        `status ${outRes.statusCode}: ${JSON.stringify(outRes.body)}`);
    a = await load();
    const s = a.shifts[0] || {};
    ok('mobile punch-in STILL intact after the terminal closed the day',
        new Date(a.punchIn).getTime() === appPunchIn);
    ok('session 1 punchOutSource = biometric', s.punchOutSource === 'biometric', `got ${s.punchOutSource}`);
    ok('session 1 closeReason = device', s.closeReason === 'device', `got ${s.closeReason}`);
    ok('in and out sources both recorded, and differ',
        s.punchInSource === 'app' && s.punchOutSource === 'biometric');
    ok('session carries its own worked ms', typeof s.workMs === 'number', `got ${s.workMs}`);
    ok('per-session distance recorded', s.punchInDistance != null, `got ${s.punchInDistance}`);

    await settle();
    const events = await AttendanceEvent.find({ adminId, employeeId }).sort({ at: 1 }).lean();
    const types = events.map((e) => `${e.type}:${e.source}`);
    ok('all four punches left an evidence row', events.length === 4,
        `got ${events.length}: ${types.join(', ')}`);
    ok('evidence records the channel of each punch',
        types.join(',') === 'punch-in:app,lunch-in:lens,lunch-out:lens,punch-out:biometric',
        types.join(','));

    // -- B: a device tap must not delete app-created sessions ---------------
    console.log('\n- multi-session day closed by a terminal tap -');
    await reset();

    await call(ctrl.punchIn, { source: 'app', body: atHQ });
    await call(ctrl.punchOut, { source: 'app', body: atHQ });
    const reRes = await call(ctrl.punchIn, { source: 'app', body: atHQ });
    ok('re-punch-in accepted', reRes.statusCode === 201,
        `status ${reRes.statusCode}: ${JSON.stringify(reRes.body)}`);
    a = await load();
    ok('app opened a second session', a.shifts.length === 2, `got ${a.shifts.length}`);
    const s1In = new Date(a.shifts[0].punchIn).getTime();
    const s1Out = new Date(a.shifts[0].punchOut).getTime();

    // The terminal now reports its own taps for the same day.
    const dayKey = istDateKey(new Date());
    for (const t of [new Date(Date.now() - 3600e3), new Date()]) {
        await PunchLog.create({
            adminId, employeeId, dayKey, deviceTime: t,
            serialNumber: 'SN-MIX-1', pin: '42', source: 'biometric',
        });
    }
    await reconcileDay({ Attendance, PunchLog, User, Settings, adminId, employeeId, dayKey });
    a = await load();

    ok('BOTH sessions survived reconciliation', a.shifts.length === 2, `got ${a.shifts.length}`);
    ok('session 1 punch-in untouched', new Date(a.shifts[0].punchIn).getTime() === s1In);
    ok('session 1 punch-out untouched', new Date(a.shifts[0].punchOut).getTime() === s1Out);
    ok('session 2 was closed by the terminal',
        a.shifts[1] && a.shifts[1].closeReason === 'device' && a.shifts[1].punchOutSource === 'biometric',
        `got ${a.shifts[1] && a.shifts[1].closeReason}/${a.shifts[1] && a.shifts[1].punchOutSource}`);
    ok('app punch-in was not overwritten by the tap', new Date(a.punchIn).getTime() === s1In);

    console.log(`\n${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    await mongod.stop();
    process.exit(fail === 0 ? 0 : 1);
})().catch(async (err) => {
    console.error('\nTEST HARNESS ERROR:', err);
    process.exit(1);
});
