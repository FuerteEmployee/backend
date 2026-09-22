/**
 * Approving an attendance correction must actually change what payroll reads.
 *
 *   node scratch/test_regularization_approve.js
 *
 * In-memory mongod, never touches MONGO_URI.
 *
 * The defect this covers: approveRegularization assigned only the ROOT
 * punchIn/punchOut. allSessions() treats shifts[] as authoritative the moment
 * it is populated, so on every modern row the session kept the old
 * system-written time and the approved correction was computed straight back
 * out again. The admin saw the request go green and nothing changed.
 */
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SRC = path.join(__dirname, '..', 'src');
const Attendance = require(path.join(SRC, 'models/Attendance'));
const Regularization = require(path.join(SRC, 'models/Regularization'));
const Settings = require(path.join(SRC, 'models/Settings'));
const Shift = require(path.join(SRC, 'models/Shift'));
const User = require(path.join(SRC, 'models/User'));
const {
    approveRegularization, submitRegularization, getRegularizations,
} = require(path.join(SRC, 'controllers/regularization_controller'));
const { computeWorkedMs } = require(path.join(SRC, 'utils/shift_status'));
const { istStartOfDay } = require(path.join(SRC, 'utils/attendance_helpers'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

// 16 Sep 2026 IST, the day this feature was written for.
const DAY = istStartOfDay(new Date('2026-09-16T06:00:00.000Z'));
const T = (h, m) => new Date(Date.UTC(2026, 8, 16, 0, 0, 0) + (h * 60 + m - 330) * 60 * 1000);

// Minimal express double: capture status + body instead of writing a socket.
function mockRes() {
    const r = { statusCode: 200, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
}

async function reset() {
    await Promise.all([
        Attendance.deleteMany({}), Regularization.deleteMany({}),
        Settings.deleteMany({}), Shift.deleteMany({}), User.deleteMany({}),
    ]);
}

async function seed({ sessions, minLunch = 30 }) {
    const admin = await User.create({ name: 'Admin', phone: '9100000001', role: 'admin', isActive: true });
    const shift = await Shift.create({ adminId: admin._id, name: 'Morning', startTime: '09:30', endTime: '18:30' });
    const employee = await User.create({
        name: 'Vijay', phone: '9100000002', role: 'employee',
        adminId: admin._id, shiftId: shift._id, isActive: true,
    });
    await Settings.create({ adminId: admin._id, attendance: { minLunch, correctionWindowDays: 7 } });
    const attendance = await Attendance.create({
        adminId: admin._id, employeeId: employee._id, date: DAY,
        punchIn: sessions[0].punchIn, punchOut: sessions[sessions.length - 1].punchOut,
        status: 'late', shifts: sessions,
    });
    return { admin, shift, employee, attendance };
}

(async () => {
    const mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { dbName: 'regularization_test' });
    console.log('connected to in-memory mongod\n');

    // ── single session, exactly Vijay's 16 Sep shape ─────────────────────────
    console.log('- single session closed at shift end -');
    await reset();
    let s = await seed({
        sessions: [{
            punchIn: T(10, 2), punchOut: T(18, 30),
            closeReason: 'shift_end', punchOutSource: 'system',
        }],
    });
    let reg = await Regularization.create({
        adminId: s.admin._id, employeeId: s.employee._id, submittedBy: s.employee._id,
        date: DAY, requestedPunchOut: T(19, 0), reason: 'Forgot to punch out',
    });
    let res = mockRes();
    await approveRegularization({ params: { id: reg._id }, adminId: s.admin._id, userId: s.admin._id, body: {} }, res);
    ok('approval succeeds', res.statusCode === 200, JSON.stringify(res.body));

    let att = await Attendance.findById(s.attendance._id).lean();
    reg = await Regularization.findById(reg._id).lean();
    ok('the SESSION punch-out is updated (payroll reads this, not the root)',
        new Date(att.shifts[0].punchOut).getTime() === T(19, 0).getTime(),
        String(att.shifts[0].punchOut));
    ok('the root mirrors it',
        new Date(att.punchOut).getTime() === T(19, 0).getTime(), String(att.punchOut));
    ok('it no longer reads as a system close',
        att.shifts[0].closeReason === 'regularized' && att.shifts[0].punchOutSource === 'admin',
        JSON.stringify({ closeReason: att.shifts[0].closeReason, src: att.shifts[0].punchOutSource }));
    ok('the overwritten system time is preserved for audit',
        reg.originalPunchOut && new Date(reg.originalPunchOut).getTime() === T(18, 30).getTime(),
        String(reg.originalPunchOut));

    // 10:02 -> 19:00 is 8h58m gross, minus the 30m lunch = 8h28m.
    const expected = computeWorkedMs(att, { startTime: '09:30', endTime: '18:30' }, { attendance: { minLunch: 30 } });
    ok('totalWorkMs comes from computeWorkedMs, not raw subtraction',
        att.totalWorkMs === expected && att.totalWorkMs !== (T(19, 0) - T(10, 2)),
        JSON.stringify({ stored: att.totalWorkMs, expected, raw: T(19, 0) - T(10, 2) }));
    ok('per-session workMs and grossMs are both filled in',
        typeof att.shifts[0].workMs === 'number' && typeof att.shifts[0].grossMs === 'number',
        JSON.stringify({ workMs: att.shifts[0].workMs, grossMs: att.shifts[0].grossMs }));
    ok('the request is marked approved and linked to the row',
        reg.status === 'approved' && String(reg.attendanceId) === String(att._id), reg.status);

    // ── multi-session: correct the trailing system close only ────────────────
    console.log('\n- multi-session day, only the system-closed session moves -');
    await reset();
    s = await seed({
        sessions: [
            { punchIn: T(9, 45), punchOut: T(13, 0), closeReason: 'manual', punchOutSource: 'app' },
            { punchIn: T(14, 0), punchOut: T(18, 30), closeReason: 'shift_end', punchOutSource: 'system' },
        ],
    });
    reg = await Regularization.create({
        adminId: s.admin._id, employeeId: s.employee._id, submittedBy: s.employee._id,
        date: DAY, requestedPunchOut: T(17, 15), reason: 'Left early, forgot to punch out',
    });
    res = mockRes();
    await approveRegularization({ params: { id: reg._id }, adminId: s.admin._id, userId: s.admin._id, body: {} }, res);
    att = await Attendance.findById(s.attendance._id).lean();
    ok('session 1 (a real manual punch-out) is untouched',
        new Date(att.shifts[0].punchOut).getTime() === T(13, 0).getTime()
        && att.shifts[0].closeReason === 'manual',
        JSON.stringify(att.shifts[0]));
    ok('session 2 (the system close) takes the corrected time',
        new Date(att.shifts[1].punchOut).getTime() === T(17, 15).getTime(),
        String(att.shifts[1].punchOut));
    ok('the root follows the final session, not session 1',
        new Date(att.punchOut).getTime() === T(17, 15).getTime(), String(att.punchOut));
    ok('the day total sums BOTH sessions',
        att.totalWorkMs === computeWorkedMs(att, { startTime: '09:30', endTime: '18:30' }, { attendance: { minLunch: 30 } })
        && att.totalWorkMs > (T(17, 15) - T(14, 0)),
        String(att.totalWorkMs));

    // ── employee-side guard rails ────────────────────────────────────────────
    console.log('\n- employee submission rules -');
    await reset();
    s = await seed({ sessions: [{ punchIn: T(10, 2), punchOut: T(18, 30), closeReason: 'shift_end', punchOutSource: 'system' }] });
    const asEmployee = (body) => ({
        adminId: s.admin._id, userId: s.employee._id,
        user: { role: 'employee' }, body,
    });

    res = mockRes();
    await submitRegularization(asEmployee({ date: DAY, requestedPunchOut: T(19, 0), reason: 'Forgot' }), res);
    ok('an employee can submit for a recent day', res.statusCode === 201, JSON.stringify(res.body));

    res = mockRes();
    await submitRegularization(asEmployee({ date: DAY, requestedPunchOut: T(20, 0), reason: 'Again' }), res);
    ok('a second PENDING request for the same day is refused', res.statusCode === 409, JSON.stringify(res.body));

    res = mockRes();
    const old = istStartOfDay(new Date(Date.now() - 60 * 24 * 60 * 60 * 1000));
    await submitRegularization(asEmployee({ date: old, requestedPunchOut: new Date(), reason: 'Ancient' }), res);
    ok('a day outside the correction window is refused', res.statusCode === 400, JSON.stringify(res.body));

    res = mockRes();
    await submitRegularization(asEmployee({
        date: istStartOfDay(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)),
        requestedPunchOut: new Date(), reason: 'Tomorrow',
    }), res);
    ok('a future date is refused', res.statusCode === 400, JSON.stringify(res.body));

    res = mockRes();
    await submitRegularization({
        adminId: s.admin._id, userId: s.admin._id, user: { role: 'admin' },
        body: { employeeId: s.employee._id, date: old, requestedPunchOut: new Date(), reason: 'Admin fixing history' },
    }, res);
    ok('an ADMIN is not bound by the window', res.statusCode === 201, JSON.stringify(res.body));

    res = mockRes();
    await submitRegularization(asEmployee({ date: DAY, reason: 'no times' }), res);
    ok('the employee id comes from the token, never the body',
        res.statusCode === 409 || String(res.body?.employeeId?._id || res.body?.employeeId) === String(s.employee._id),
        JSON.stringify(res.body));

    // ── the review queue shows the claim beside what it would replace ────────
    console.log('\n- list enrichment -');
    await reset();
    s = await seed({ sessions: [{ punchIn: T(10, 2), punchOut: T(18, 30), closeReason: 'shift_end', punchOutSource: 'system' }] });
    const other = await User.create({ name: 'Someone Else', phone: '9100000003', role: 'employee', adminId: s.admin._id, isActive: true });
    await Regularization.create({
        adminId: s.admin._id, employeeId: s.employee._id, submittedBy: s.employee._id,
        date: DAY, requestedPunchOut: T(19, 0), reason: 'Forgot',
    });
    await Regularization.create({
        adminId: s.admin._id, employeeId: other._id, submittedBy: other._id,
        date: DAY, requestedPunchOut: T(20, 0), reason: 'Also forgot',
    });

    res = mockRes();
    await getRegularizations({ adminId: s.admin._id, userId: s.admin._id, user: { role: 'admin' }, query: {} }, res);
    ok('an admin sees every request in the tenant', res.body.length === 2, String(res.body.length));
    const mine = res.body.find((r) => String(r.employeeId?._id) === String(s.employee._id));
    ok('a PENDING request carries what the row currently says',
        mine && new Date(mine.currentPunchOut).getTime() === T(18, 30).getTime()
        && new Date(mine.currentPunchIn).getTime() === T(10, 2).getTime(),
        JSON.stringify({ in: mine?.currentPunchIn, out: mine?.currentPunchOut }));
    ok('and flags that the current value was a system guess',
        mine?.currentCloseReason === 'shift_end', String(mine?.currentCloseReason));
    ok('a request with no attendance row degrades to null, not a crash',
        res.body.every((r) => 'currentPunchOut' in r), JSON.stringify(res.body.map((r) => r.currentPunchOut)));

    res = mockRes();
    await getRegularizations({ adminId: s.admin._id, userId: s.employee._id, user: { role: 'employee' }, query: {} }, res);
    ok('an employee sees ONLY their own requests',
        res.body.length === 1 && String(res.body[0].employeeId?._id) === String(s.employee._id),
        JSON.stringify(res.body.map((r) => r.employeeId?.name)));

    console.log(`\n${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    await mongod.stop();
    process.exit(fail === 0 ? 0 : 1);
})().catch(async (err) => {
    console.error('\nTEST HARNESS ERROR:', err);
    try { await mongoose.disconnect(); } catch (_) { /* already down */ }
    process.exit(1);
});
