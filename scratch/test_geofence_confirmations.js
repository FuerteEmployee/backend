// Plain-Node integration tests for persisted geofence confirmation state.
//
// Run from backend:
//   node scratch/test_geofence_confirmations.js
//
// Uses mongodb-memory-server only. It never reads MONGO_URI or production data.
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SRC = path.join(__dirname, '..', 'src');
const Attendance = require(path.join(SRC, 'models/Attendance'));
const Branch = require(path.join(SRC, 'models/Branch'));
const GeofenceAudit = require(path.join(SRC, 'models/GeofenceAudit'));
const GeofencePendingExit = require(path.join(SRC, 'models/GeofencePendingExit'));
const Settings = require(path.join(SRC, 'models/Settings'));
const Tracking = require(path.join(SRC, 'models/Tracking'));
const User = require(path.join(SRC, 'models/User'));
const { evaluateEmployee } = require(path.join(SRC, 'utils/geofence_engine'));
const { GEOFENCE_PENDING_STALE_MS } = require(path.join(SRC, 'utils/geofence_window'));
const { istStartOfDay } = require(path.join(SRC, 'utils/attendance_helpers'));

let pass = 0;
let fail = 0;
const ok = (name, condition, extra = '') => {
    if (condition) {
        pass += 1;
        console.log(`  PASS  ${name}`);
    } else {
        fail += 1;
        console.log(`  FAIL  ${name}  ${extra}`);
    }
};

const OFFICE = { latitude: 22.3039, longitude: 70.8022 };
const BASE = new Date('2026-09-12T04:30:00.000Z');
const point = (metres) => ({
    latitude: OFFICE.latitude,
    longitude: OFFICE.longitude + metres / (111320 * Math.cos(OFFICE.latitude * Math.PI / 180)),
});

async function withClock(now, fn) {
    const realNow = Date.now;
    Date.now = () => new Date(now).getTime();
    try {
        return await fn();
    } finally {
        Date.now = realNow;
    }
}

async function reset() {
    await Promise.all([
        Attendance.deleteMany({}), Branch.deleteMany({}), GeofenceAudit.deleteMany({}), GeofencePendingExit.deleteMany({}),
        Settings.deleteMany({}), Tracking.deleteMany({}), User.deleteMany({}),
    ]);
}

async function seed() {
    const admin = await User.create({ name: 'Fence Test Admin', phone: '9000300001', role: 'admin' });
    const branch = await Branch.create({
        adminId: admin._id, branchName: 'HQ', branchLocation: 'Test city',
        ...OFFICE, radius: 100, geoFenceEnabled: true,
    });
    const employee = await User.create({
        name: 'Fence Test Employee', phone: '9000300002', role: 'employee', adminId: admin._id,
        branchId: branch._id,
    });
    // A direct collection insert is deliberate: the schema has a legacy field
    // named autoPunchOut; this is the exact nested configuration the engine reads.
    await Settings.collection.insertOne({
        adminId: admin._id,
        attendance: { officeRadius: 100, geofenceAutoPunchOut: { enabled: false, shadowMode: true }, minLunch: 0 },
    });
    const punchIn = new Date(BASE.getTime() - 60 * 60 * 1000);
    await Attendance.create({
        adminId: admin._id, employeeId: employee._id, date: istStartOfDay(BASE),
        punchIn, status: 'present', shifts: [{ punchIn, punchOut: null }],
    });
    return { admin, employee, punchIn };
}

async function addFixes({ admin, employee }, distances, firstAt, stepMs = 25 * 1000) {
    const docs = distances.map((metres, i) => ({
        adminId: admin._id,
        employeeId: employee._id,
        ...point(metres),
        accuracy: 10,
        timestamp: new Date(firstAt.getTime() + i * stepMs),
    }));
    await Tracking.insertMany(docs);
    return docs;
}

async function evaluate(ctx, now) {
    return withClock(now, () => evaluateEmployee({ adminId: ctx.admin._id, employeeId: ctx.employee._id, now }));
}

(async () => {
    const mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { dbName: 'geofence_confirmation_test' });
    console.log('connected to in-memory mongod\n');

    console.log('— marginal and unambiguous exits —');
    await reset();
    let ctx = await seed();
    await addFixes(ctx, [200, 220, 240, 260, 280, 300], new Date(BASE.getTime() - 300 * 1000));
    let result = await evaluate(ctx, BASE);
    ok('a marginal exit starts at round 1 and does not close',
        result.reason === 'confirming' && result.rounds === 1, JSON.stringify(result));
    await addFixes(ctx, [320], new Date(BASE.getTime() + 20 * 1000));
    result = await evaluate(ctx, new Date(BASE.getTime() + 60 * 1000));
    ok('a marginal exit still needs a second independent round',
        result.reason === 'confirming' && result.rounds === 2, JSON.stringify(result));
    await addFixes(ctx, [340], new Date(BASE.getTime() + 90 * 1000));
    result = await evaluate(ctx, new Date(BASE.getTime() + 121 * 1000));
    ok('a marginal exit closes only on round 3 after the confirmation span',
        result.decision === 'punched_out' && result.shadow === true, JSON.stringify(result));

    await reset();
    ctx = await seed();
    await addFixes(ctx, [800, 830, 860, 890, 920], new Date(BASE.getTime() - 120 * 1000));
    result = await evaluate(ctx, BASE);
    ok('an exit beyond 3x the threshold is the documented one-round shadow decision',
        result.decision === 'punched_out' && result.shadow === true, JSON.stringify(result));
    ok('a one-round unambiguous decision consumes its pending state',
        await GeofencePendingExit.countDocuments({ adminId: ctx.admin._id, employeeId: ctx.employee._id }) === 0);

    await reset();
    ctx = await seed();
    const overnightPunchIn = new Date('2026-09-11T16:30:00.000Z'); // 22:00 IST on the preceding day
    const overnightAttendance = await Attendance.findOne({ adminId: ctx.admin._id, employeeId: ctx.employee._id });
    overnightAttendance.date = istStartOfDay(overnightPunchIn);
    overnightAttendance.punchIn = overnightPunchIn;
    overnightAttendance.shifts = [{ punchIn: overnightPunchIn, punchOut: null }];
    await overnightAttendance.save();
    await addFixes(ctx, [800, 830, 860, 890, 920], new Date(BASE.getTime() - 120 * 1000));
    result = await evaluate(ctx, BASE);
    ok('post-midnight tracking still evaluates an open previous-IST-day overnight session',
        result.decision === 'punched_out' && result.shadow === true, JSON.stringify(result));

    await reset();
    ctx = await seed();
    await addFixes(ctx, [200, 220, 240, 260, 280], new Date(BASE.getTime() - 100 * 1000));
    result = await evaluate(ctx, BASE);
    const shortMarginalAudit = await GeofenceAudit.findOne({
        adminId: ctx.admin._id, employeeId: ctx.employee._id, reason: 'marginal_window_too_short',
    }).lean();
    ok('a marginal window that fails closed is still recorded in the audit trail',
        result.reason === 'marginal_window_too_short' && !!shortMarginalAudit,
        JSON.stringify({ result, shortMarginalAudit }));

    console.log('\n— pending state expires or belongs to exactly one session —');
    await reset();
    ctx = await seed();
    await addFixes(ctx, [200, 220, 240, 260, 280, 300], new Date(BASE.getTime() - 300 * 1000));
    await evaluate(ctx, BASE);
    await addFixes(ctx, [320], new Date(BASE.getTime() + 110 * 1000));
    result = await evaluate(ctx, new Date(BASE.getTime() + GEOFENCE_PENDING_STALE_MS + 1));
    ok('a quiet pending exit ages out and restarts at round 1',
        result.reason === 'confirming' && result.rounds === 1, JSON.stringify(result));

    await reset();
    ctx = await seed();
    await addFixes(ctx, [200, 220, 240, 260, 280, 300], new Date(BASE.getTime() - 300 * 1000));
    await evaluate(ctx, BASE);
    const attendance = await Attendance.findOne({ adminId: ctx.admin._id, employeeId: ctx.employee._id });
    const repunchAt = new Date(BASE.getTime() + 30 * 1000);
    attendance.shifts = [
        { punchIn: ctx.punchIn, punchOut: new Date(BASE.getTime() + 1), closeReason: 'manual' },
        { punchIn: repunchAt, punchOut: null },
    ];
    await attendance.save();
    await addFixes(ctx, [320, 340, 360, 380, 400], new Date(BASE.getTime() + 40 * 1000), 30 * 1000);
    result = await evaluate(ctx, new Date(BASE.getTime() + 180 * 1000));
    const pending = await GeofencePendingExit.findOne({ adminId: ctx.admin._id, employeeId: ctx.employee._id }).lean();
    ok('a re-punch starts a fresh confirmation sequence rather than inheriting prior rounds',
        result.reason === 'confirming' && result.rounds === 1 && pending?.rounds === 1,
        JSON.stringify({ result, pending }));

    console.log('\n— existing Tracking rows without cached still participate —');
    await Tracking.collection.insertOne({
        adminId: ctx.admin._id, employeeId: ctx.employee._id,
        latitude: OFFICE.latitude, longitude: OFFICE.longitude, timestamp: BASE,
    });
    const missingCached = await Tracking.find({
        adminId: ctx.admin._id, employeeId: ctx.employee._id, cached: { $ne: true },
    }).lean();
    ok('MongoDB $ne:true matches a document where cached is absent',
        missingCached.some((fix) => !Object.prototype.hasOwnProperty.call(fix, 'cached')),
        JSON.stringify(missingCached));

    console.log(`\n${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    await mongod.stop();
    process.exit(fail === 0 ? 0 : 1);
})().catch(async (err) => {
    console.error('\nTEST HARNESS ERROR:', err);
    try { await mongoose.disconnect(); } catch (_) {}
    process.exit(1);
});
