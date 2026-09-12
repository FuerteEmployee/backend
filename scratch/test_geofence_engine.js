const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SRC = path.join(__dirname, '..', 'src');
const Attendance = require(path.join(SRC, 'models/Attendance'));
const AttendanceEvent = require(path.join(SRC, 'models/AttendanceEvent'));
const Branch = require(path.join(SRC, 'models/Branch'));
const GeofenceAudit = require(path.join(SRC, 'models/GeofenceAudit'));
const Settings = require(path.join(SRC, 'models/Settings'));
const Shift = require(path.join(SRC, 'models/Shift'));
const Tracking = require(path.join(SRC, 'models/Tracking'));
const User = require(path.join(SRC, 'models/User'));
const { evaluateEmployee } = require(path.join(SRC, 'utils/geofence_engine'));
const GeofencePendingExit = require(path.join(SRC, 'models/GeofencePendingExit'));
const { istStartOfDay } = require(path.join(SRC, 'utils/attendance_helpers'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

const NOW = new Date('2026-09-12T04:30:00.000Z');
const DAY = istStartOfDay(NOW);
const OFFICE = { latitude: 22.3039, longitude: 70.8022 };
const at = (secondsAgo) => new Date(NOW.getTime() - secondsAgo * 1000);
const point = (metres) => ({
    latitude: OFFICE.latitude,
    longitude: OFFICE.longitude + metres / (111320 * Math.cos(OFFICE.latitude * Math.PI / 180)),
});

async function reset() {
    await Promise.all([
        Attendance.deleteMany({}), AttendanceEvent.deleteMany({}), Branch.deleteMany({}),
        GeofenceAudit.deleteMany({}), GeofencePendingExit.deleteMany({}), Settings.deleteMany({}),
        Shift.deleteMany({}), Tracking.deleteMany({}), User.deleteMany({}),
    ]);
}

async function seed({ enabled = true, shadowMode = false, geofenceExempt = false, sessions = null, closed = false } = {}) {
    const admin = await User.create({ name: 'Test Admin', phone: '9000100001', role: 'admin', isActive: true });
    const branch = await Branch.create({
        adminId: admin._id, branchName: 'HQ', branchLocation: 'Test city',
        ...OFFICE, radius: 100, geoFenceEnabled: true,
    });
    const shift = await Shift.create({ adminId: admin._id, name: 'Day', startTime: '09:00', endTime: '18:00' });
    const employee = await User.create({
        name: 'Employee', phone: '9000100002', role: 'employee', adminId: admin._id,
        // `designation` does not exist on the User schema and is dropped by
        // strict mode, so exemption is driven by the explicit flag.
        branchId: branch._id, shiftId: shift._id, geofenceExempt, isActive: true,
    });
    // Settings has legacy fields with the same name in its schema. Insert the
    // actual nested engine configuration directly so this test exercises what
    // evaluateEmployee reads, rather than letting Mongoose cast it away.
    await Settings.collection.insertOne({
        adminId: admin._id,
        // `geofenceAutoPunchOut`, NOT `autoPunchOut`: Settings.attendance already
        // has an `autoPunchOut` Boolean (close at the latest allowed time), and
        // the two collided as a duplicate key in the schema literal.
        attendance: { officeRadius: 100, geofenceAutoPunchOut: { enabled, shadowMode }, minLunch: 0 },
    });
    const openAt = at(4 * 3600);
    const daySessions = sessions || [{ punchIn: openAt, punchOut: closed ? at(60) : null, closeReason: closed ? 'manual' : null, punchOutSource: closed ? 'app' : null }];
    const attendance = await Attendance.create({
        adminId: admin._id, employeeId: employee._id, date: DAY, punchIn: openAt,
        punchOut: closed ? at(60) : null, status: 'present', shifts: daySessions,
    });
    return { admin, branch, shift, employee, attendance };
}

async function seedClearExit({ admin, employee }) {
    const rows = [];
    for (const [i, metres] of [20, 40, 60].entries()) {
        rows.push({ ...point(metres), accuracy: 10, timestamp: at(600 - i * 60) });
    }
    for (const [i, metres] of [2000, 2030, 2060, 2090, 2120, 2150].entries()) {
        rows.push({ ...point(metres), accuracy: 10, timestamp: at(300 - i * 50) });
    }
    await Tracking.insertMany(rows.map((row) => ({ adminId: admin._id, employeeId: employee._id, ...row })));
    return rows[2].timestamp;
}

/**
 * Drive a full GEOFENCE_CONFIRMATIONS-round exit sequence and return the
 * final (third) evaluateEmployee() result.
 *
 * A single evaluation can no longer close anything -- see advanceConfirmation
 * in geofence_engine.js. Round 1 is the original clear-exit batch (3 inside
 * fixes, 6 outside); rounds 2 and 3 each add ONE new, more distant outside fix
 * with a later timestamp and re-evaluate at a later `now`, so each round is
 * backed by genuinely new evidence and the sequence spans >=120s overall --
 * exactly what a real confirmed exit looks like.
 */
async function driveToConfirmedExit({ admin, employee }, { baseNow = NOW } = {}) {
    const rows = [];
    for (const [i, metres] of [20, 40, 60].entries()) {
        rows.push({ ...point(metres), accuracy: 10, timestamp: new Date(baseNow.getTime() - (600 - i * 60) * 1000) });
    }
    for (const [i, metres] of [2000, 2030, 2060, 2090, 2120, 2150].entries()) {
        rows.push({ ...point(metres), accuracy: 10, timestamp: new Date(baseNow.getTime() - (300 - i * 50) * 1000) });
    }
    await Tracking.insertMany(rows.map((row) => ({ adminId: admin._id, employeeId: employee._id, ...row })));
    const lastInside = rows[2].timestamp; // latest of the three inside fixes

    const round1 = await evaluateEmployee({ adminId: admin._id, employeeId: employee._id, now: baseNow });

    await Tracking.create({
        adminId: admin._id, employeeId: employee._id,
        ...point(2180), accuracy: 10, timestamp: new Date(baseNow.getTime() + 20 * 1000),
    });
    const round2Now = new Date(baseNow.getTime() + 70 * 1000);
    const round2 = await evaluateEmployee({ adminId: admin._id, employeeId: employee._id, now: round2Now });

    await Tracking.create({
        adminId: admin._id, employeeId: employee._id,
        ...point(2210), accuracy: 10, timestamp: new Date(baseNow.getTime() + 90 * 1000),
    });
    const round3Now = new Date(baseNow.getTime() + 130 * 1000); // >=120s since round 1
    const round3 = await evaluateEmployee({ adminId: admin._id, employeeId: employee._id, now: round3Now });

    return { round1, round2, round3, lastInside, finalNow: round3Now };
}

async function eventFor(query) {
    for (let i = 0; i < 30; i++) {
        const event = await AttendanceEvent.findOne(query).lean();
        if (event) return event;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
}

(async () => {
    const mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { dbName: 'geofence_engine_test' });
    console.log('connected to in-memory mongod\n');

    // P0 FIX: `enabled: false` is the field's own DEFAULT, so this used to be
    // the state almost every tenant sits in. The engine used to return here
    // before evaluating anything, which meant a tenant who had never touched
    // the setting produced ZERO shadow data -- and the promotion gate (7 days
    // / 3 employees / 50 decisions) could never be satisfied without first
    // blindly flipping `enabled` to true, exactly the leap of faith shadow
    // mode exists to avoid. `enabled` must gate only the ACT, never the
    // evaluation.
    console.log('- the field default (enabled:false) must still evaluate in shadow -');
    await reset();
    let s = await seed({ enabled: false });
    let driven = await driveToConfirmedExit(s);
    let result = driven.round3;
    ok('a never-opted-in tenant still gets a REAL decision, not a skip',
        result.skipped !== true && result.decision === 'punched_out',
        JSON.stringify(result));
    ok('and it is tagged shadow -- so shadow data accumulates from the field default onward',
        result.shadow === true, JSON.stringify(result));
    let disabledAttendance = await Attendance.findById(s.attendance._id).lean();
    ok('nothing is actually closed while unarmed',
        disabledAttendance.punchOut === null && disabledAttendance.autoPunchOut === false,
        JSON.stringify(disabledAttendance));
    ok('at least one audit row was written across the sequence -- this is the P0 bug, fixed',
        await GeofenceAudit.countDocuments({}) >= 1);

    console.log('\n- shadow mode -');
    await reset();
    s = await seed({ enabled: true, shadowMode: true });
    driven = await driveToConfirmedExit(s);
    result = driven.round3;
    let audit = await GeofenceAudit.findOne({ decision: 'punched_out' }).lean();
    let attendance = await Attendance.findById(s.attendance._id).lean();
    ok('shadow mode reaches punched-out decision after 3 confirmed rounds',
        result.decision === 'punched_out' && result.shadow === true, JSON.stringify(result));
    ok('shadow audit says shadow punched_out', audit && audit.shadow === true && audit.decision === 'punched_out', JSON.stringify(audit));
    ok('shadow mode leaves attendance open', attendance.punchOut === null && attendance.autoPunchOut === false, JSON.stringify(attendance));

    console.log('\n- live close -');
    await reset();
    s = await seed({ enabled: true, shadowMode: false });
    driven = await driveToConfirmedExit(s);
    result = driven.round3;
    attendance = await Attendance.findById(s.attendance._id).lean();
    audit = await GeofenceAudit.findOne({ decision: 'punched_out' }).lean();
    const event = await eventFor({ adminId: s.admin._id, employeeId: s.employee._id, type: 'auto-punch-out' });
    const liveSession = attendance.shifts[0];
    ok('round 1 (single evaluation) only confirms, never closes',
        driven.round1.decision === 'suppressed' && driven.round1.reason === 'confirming' && driven.round1.rounds === 1,
        JSON.stringify(driven.round1));
    ok('round 2 (second independent evaluation) still only confirms',
        driven.round2.decision === 'suppressed' && driven.round2.reason === 'confirming' && driven.round2.rounds === 2,
        JSON.stringify(driven.round2));
    ok('only round 3 -- the third round, at least 120s after round 1 -- actually closes',
        result.closed === true && liveSession.closeReason === 'auto_geofence' && liveSession.punchOutSource === 'system',
        JSON.stringify(result));
    ok('live exit records day-level geofence outcome', attendance.autoPunchOut === true && attendance.geoStatus === 'auto_exit' && attendance.calculatedDistance > 1000, JSON.stringify(attendance));
    ok('live exit writes an auto-punch-out event', event && event.source === 'system' && event.closeReason === 'auto_geofence', JSON.stringify(event));
    ok('live close time is the FIRST round last-inside fix, not the confirming rounds now',
        new Date(liveSession.punchOut).getTime() === driven.lastInside.getTime(), String(liveSession.punchOut));
    ok('live audit links the closure', audit && audit.attendanceId && audit.closedAt && audit.shadow === false, JSON.stringify(audit));
    ok('the pending-exit sequence is cleared once confirmed and closed',
        await GeofencePendingExit.countDocuments({}) === 0);

    console.log('\n- re-evaluating the SAME evidence must not advance a round -');
    await reset();
    s = await seed({ enabled: true, shadowMode: false });
    // Round 1, same as driveToConfirmedExit's first step.
    {
        const rows = [];
        for (const [i, metres] of [20, 40, 60].entries()) {
            rows.push({ ...point(metres), accuracy: 10, timestamp: at(600 - i * 60) });
        }
        for (const [i, metres] of [2000, 2030, 2060, 2090, 2120, 2150].entries()) {
            rows.push({ ...point(metres), accuracy: 10, timestamp: at(300 - i * 50) });
        }
        await Tracking.insertMany(rows.map((row) => ({ adminId: s.admin._id, employeeId: s.employee._id, ...row })));
    }
    const first = await evaluateEmployee({ adminId: s.admin._id, employeeId: s.employee._id, now: NOW });
    ok('first evaluation is round 1', first.reason === 'confirming' && first.rounds === 1, JSON.stringify(first));
    // Re-evaluate again a little later, but WITHOUT any new fix arriving --
    // this is what a second automatic trigger firing moments apart looks
    // like (the 45s native sync tick, or a manual re-check).
    const repeat = await evaluateEmployee({
        adminId: s.admin._id, employeeId: s.employee._id, now: new Date(NOW.getTime() + 10 * 1000),
    });
    ok('re-evaluating the identical evidence does NOT advance the round',
        repeat.reason === 'confirming' && repeat.rounds === 1, JSON.stringify(repeat));
    const pendingAfterRepeat = await GeofencePendingExit.findOne({ adminId: s.admin._id, employeeId: s.employee._id }).lean();
    ok('the pending-exit round count itself stayed at 1', pendingAfterRepeat.rounds === 1, JSON.stringify(pendingAfterRepeat));

    console.log('\n- coming back inside clears the pending sequence -');
    await reset();
    s = await seed({ enabled: true, shadowMode: false });
    {
        const rows = [];
        for (const [i, metres] of [20, 40, 60].entries()) {
            rows.push({ ...point(metres), accuracy: 10, timestamp: at(600 - i * 60) });
        }
        for (const [i, metres] of [2000, 2030, 2060, 2090, 2120, 2150].entries()) {
            rows.push({ ...point(metres), accuracy: 10, timestamp: at(300 - i * 50) });
        }
        await Tracking.insertMany(rows.map((row) => ({ adminId: s.admin._id, employeeId: s.employee._id, ...row })));
    }
    const outsideRound = await evaluateEmployee({ adminId: s.admin._id, employeeId: s.employee._id, now: NOW });
    ok('an outside round starts a pending sequence', outsideRound.reason === 'confirming' && outsideRound.rounds === 1, JSON.stringify(outsideRound));
    let pendingBeforeReturn = await GeofencePendingExit.countDocuments({ adminId: s.admin._id, employeeId: s.employee._id });
    ok('the pending-exit document exists mid-sequence', pendingBeforeReturn === 1);

    // The employee comes back: five fresh, distinct, accurate fixes INSIDE
    // the fence, newer than everything above.
    // 20m apart -- clear of the 15m distinctness epsilon (the previous 15m
    // spacing sat exactly on that boundary and was itself abstaining as a
    // repeated coordinate, which is a fixture bug, not an engine one).
    const backInside = [10, 30, 50, 70, 90].map((metres, i) => ({
        ...point(metres), accuracy: 10, timestamp: new Date(NOW.getTime() + (10 + i * 20) * 1000),
    }));
    await Tracking.insertMany(backInside.map((row) => ({ adminId: s.admin._id, employeeId: s.employee._id, ...row })));
    const insideAgain = await evaluateEmployee({
        adminId: s.admin._id, employeeId: s.employee._id, now: new Date(NOW.getTime() + 130 * 1000),
    });
    ok('back inside is recognised as such', insideAgain.decision === 'inside', JSON.stringify(insideAgain));
    const pendingAfterReturn = await GeofencePendingExit.countDocuments({ adminId: s.admin._id, employeeId: s.employee._id });
    ok('returning inside CLEARS the pending sequence -- a later exit must start fresh at round 1',
        pendingAfterReturn === 0);

    console.log('\n- suppressions and auditable inaction -');
    await reset();
    s = await seed({ geofenceExempt: true });
    await seedClearExit(s);
    result = await evaluateEmployee({ adminId: s.admin._id, employeeId: s.employee._id, now: NOW });
    audit = await GeofenceAudit.findOne({}).lean();
    attendance = await Attendance.findById(s.attendance._id).lean();
    ok('an exempt employee is never auto punched out, and it is audited', result.reason === 'role_exempt' && audit && audit.reason === 'role_exempt', JSON.stringify(result));
    ok('role exemption leaves attendance untouched', attendance.punchOut === null && attendance.autoPunchOut === false, JSON.stringify(attendance));

    await reset();
    s = await seed({ closed: true });
    result = await evaluateEmployee({ adminId: s.admin._id, employeeId: s.employee._id, now: NOW });
    ok('already closed day returns already_closed', result.reason === 'already_closed' && result.skipped === true, JSON.stringify(result));
    ok('already closed day writes no audit', await GeofenceAudit.countDocuments({}) === 0);

    await reset();
    s = await seed();
    await Tracking.create({ adminId: s.admin._id, employeeId: s.employee._id, ...point(2000), accuracy: 10, timestamp: at(30) });
    result = await evaluateEmployee({ adminId: s.admin._id, employeeId: s.employee._id, now: NOW });
    ok('abstention is written to the audit trail', result.reason === 'too_few_fixes' && await GeofenceAudit.countDocuments({}) > 0, JSON.stringify(result));

    console.log('\n- multi-session day -');
    await reset();
    const multi = [
        { punchIn: at(8 * 3600), punchOut: at(7 * 3600), closeReason: 'manual', punchOutSource: 'app' },
        { punchIn: at(6 * 3600), punchOut: at(5 * 3600), closeReason: 'manual', punchOutSource: 'app' },
        { punchIn: at(4 * 3600), punchOut: null },
    ];
    s = await seed({ sessions: multi });
    // Compare the PUNCH DATA only. workMs is derived and is deliberately
    // recomputed for every session on each close, so previously-closed sessions
    // get a figure backfilled -- that is the recompute healing old rows, not a
    // session being rewritten. What must never change is when each session
    // started and ended, which channel reported it, and why it closed.
    const punchData = (shifts) => JSON.stringify(shifts.map((x) => ({
        punchIn: x.punchIn, punchOut: x.punchOut,
        closeReason: x.closeReason, punchInSource: x.punchInSource, punchOutSource: x.punchOutSource,
    })));
    const before = punchData((await Attendance.findById(s.attendance._id).lean()).shifts.slice(0, 2));
    driven = await driveToConfirmedExit(s);
    result = driven.round3;
    attendance = await Attendance.findById(s.attendance._id).lean();
    ok('multi-session close targets only session 3', result.closed === true && attendance.shifts[2].closeReason === 'auto_geofence', JSON.stringify(attendance.shifts));
    ok('multi-session sessions 1 and 2 keep their punch data untouched',
        punchData(attendance.shifts.slice(0, 2)) === before,
        punchData(attendance.shifts.slice(0, 2)));
    ok('closing session 3 backfills worked-time on the earlier sessions',
        attendance.shifts.every((x) => typeof x.workMs === 'number'),
        JSON.stringify(attendance.shifts.map((x) => x.workMs)));

    console.log(`\n${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    await mongod.stop();
    process.exit(fail === 0 ? 0 : 1);
})().catch(async (err) => {
    console.error('\nTEST HARNESS ERROR:', err);
    try { await mongoose.disconnect(); } catch (_) {}
    process.exit(1);
});
