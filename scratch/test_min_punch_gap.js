// ─────────────────────────────────────────────────────────────────────────────
// Minimum gap between consecutive punches.
//
//   node scratch/test_min_punch_gap.js
//
// Drives the REAL exported handlers against an in-memory mongod, with the same
// shape of synthetic req/res that iclock_controller's callHandler builds. The
// gates live in the handlers, so testing the helper in isolation would prove
// nothing about the thing that actually runs.
//
// Covers all three adjacent pairs:
//   punch-in  -> lunch-in    (workMinGapSeconds)
//   lunch-in  -> lunch-out   (lunchMinGapSeconds, pre-existing)
//   lunch-out -> punch-out   (workMinGapSeconds)
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SRC = path.join(__dirname, '..', 'src');
const Attendance = require(path.join(SRC, 'models/Attendance'));
const Settings = require(path.join(SRC, 'models/Settings'));
const User = require(path.join(SRC, 'models/User'));
const { istStartOfDay } = require(path.join(SRC, 'utils/attendance_helpers'));
const attendance = require(path.join(SRC, 'controllers/attendance_controller'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

/** The synthetic req/res pair, mirroring iclock_controller.callHandler. */
function call(handler, { adminId, employeeId, body = {}, isDevicePunch = false }) {
    // `isDevicePunch` skips resolvePunchPhoto, which otherwise demands a photo
    // and would upload it to Cloudinary. The gates under test apply to both
    // channels, so a device punch exercises them just as well -- and keeps the
    // test offline.
    const req = { adminId: String(adminId), userId: String(employeeId), body, isDevicePunch, deviceSource: 'biometric' };
    return new Promise((resolve) => {
        let statusCode = 200;
        const res = {
            status(code) { statusCode = code; return res; },
            json(payload) { resolve({ status: statusCode, body: payload }); return res; },
        };
        Promise.resolve(handler(req, res)).catch((err) => resolve({ status: 500, body: { message: err.message } }));
    });
}

const MIN = 60 * 1000;

(async () => {
    const mongod = await MongoMemoryServer.create();
    try {
        await mongoose.connect(mongod.getUri(), { dbName: 'min_gap_test' });
        console.log('connected to in-memory mongod\n');

        const adminId = new mongoose.Types.ObjectId();
        const employee = await User.create({
            name: 'Gap Tester', email: 'gap@test.local', password: 'x', phone: '9000000000',
            role: 'employee', adminId,
            // Take location out of the picture: these gates are about time, and
            // a geofence rejection would mask the thing under test.
            attendanceExceptions: { overrideGlobal: true, requireLocation: false, remotePunch: true },
        });
        const employeeId = employee._id;
        await Settings.create({ adminId });

        // Rebuild the day from scratch before each case.
        const seed = async (fields) => {
            await Attendance.deleteMany({});
            return Attendance.create({
                adminId, employeeId, date: istStartOfDay(), status: 'present', ...fields,
            });
        };
        const now = () => new Date();
        const ago = (ms) => new Date(Date.now() - ms);

        console.log('— punch-in -> lunch-in —');
        await seed({ punchIn: now(), shifts: [{ punchIn: now() }] });
        let r = await call(attendance.lunchIn, { adminId, employeeId });
        ok('lunch-in seconds after punch-in is refused', r.status === 400, `got ${r.status}`);
        ok('  and says why', /punched in .*Wait at least 60s/s.test(r.body.message || ''), JSON.stringify(r.body));
        ok('  and is marked retryable', r.body.retryable === true);

        await seed({ punchIn: ago(5 * MIN), shifts: [{ punchIn: ago(5 * MIN) }] });
        r = await call(attendance.lunchIn, { adminId, employeeId });
        ok('lunch-in 5 min after punch-in is allowed', r.status === 200, JSON.stringify(r.body?.message));

        console.log('\n— lunch-in -> lunch-out (pre-existing gate) —');
        await seed({ punchIn: ago(5 * MIN), lunchInTime: now(), shifts: [{ punchIn: ago(5 * MIN) }] });
        r = await call(attendance.lunchOut, { adminId, employeeId });
        ok('lunch-out seconds after lunch-in is refused', r.status === 400, `got ${r.status}`);
        ok('  message unchanged from before the refactor',
            /^Lunch started \d+s ago\. Wait at least 60s before ending it\.$/.test(r.body.message || ''),
            JSON.stringify(r.body));

        console.log('\n— lunch-out -> punch-out —');
        await seed({
            punchIn: ago(30 * MIN), lunchInTime: ago(20 * MIN), lunchOutTime: now(),
            shifts: [{ punchIn: ago(30 * MIN) }],
        });
        r = await call(attendance.punchOut, { adminId, employeeId });
        ok('punch-out seconds after lunch-out is refused', r.status === 400, `got ${r.status}`);
        ok('  and says why', /Lunch ended .*Wait at least 60s/s.test(r.body.message || ''), JSON.stringify(r.body));

        await seed({
            punchIn: ago(30 * MIN), lunchInTime: ago(20 * MIN), lunchOutTime: ago(5 * MIN),
            shifts: [{ punchIn: ago(30 * MIN) }],
        });
        r = await call(attendance.punchOut, { adminId, employeeId, isDevicePunch: true });
        ok('punch-out 5 min after lunch-out is allowed', r.status === 200, JSON.stringify(r.body?.message));

        console.log('\n— a day with no break is never gated on punch-in —');
        await seed({ punchIn: now(), shifts: [{ punchIn: now() }] });
        r = await call(attendance.punchOut, { adminId, employeeId, isDevicePunch: true });
        ok('punch-out right after punch-in still closes the day', r.status === 200, JSON.stringify(r.body?.message));

        console.log('\n— second session is gated on ITS own punch-in, not the root —');
        // Root punchIn is this morning; session 2 opened seconds ago. Gating on
        // the root would let this through.
        await seed({
            punchIn: ago(480 * MIN),
            shifts: [{ punchIn: ago(480 * MIN), punchOut: ago(60 * MIN) }, { punchIn: now() }],
        });
        r = await call(attendance.lunchIn, { adminId, employeeId });
        ok('lunch-in seconds into session 2 is refused', r.status === 400, `got ${r.status}`);

        console.log('\n— configuration —');
        await Settings.updateOne({ adminId }, { $set: { 'attendance.workMinGapSeconds': 0 } });
        await seed({ punchIn: now(), shifts: [{ punchIn: now() }] });
        r = await call(attendance.lunchIn, { adminId, employeeId });
        ok('workMinGapSeconds=0 disables the gate', r.status === 200, JSON.stringify(r.body?.message));

        await Settings.updateOne({ adminId }, { $set: { 'attendance.workMinGapSeconds': 300 } });
        const stored = await Settings.findOne({ adminId }).lean();
        ok('workMinGapSeconds survives a write (schema declares it)',
            stored.attendance.workMinGapSeconds === 300, JSON.stringify(stored.attendance?.workMinGapSeconds));
        const storedLunch = await Settings.findOneAndUpdate(
            { adminId }, { $set: { 'attendance.lunchMinGapSeconds': 90 } }, { new: true },
        ).lean();
        ok('lunchMinGapSeconds survives a write (was silently dropped before)',
            storedLunch.attendance.lunchMinGapSeconds === 90, JSON.stringify(storedLunch.attendance?.lunchMinGapSeconds));

        await seed({ punchIn: ago(2 * MIN), shifts: [{ punchIn: ago(2 * MIN) }] });
        r = await call(attendance.lunchIn, { adminId, employeeId });
        ok('a 300s gap refuses what 60s would have allowed', r.status === 400, `got ${r.status}`);
        ok('  and quotes the configured figure', /Wait at least 300s/.test(r.body.message || ''), JSON.stringify(r.body));
    } finally {
        await mongoose.disconnect();
        await mongod.stop();
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
