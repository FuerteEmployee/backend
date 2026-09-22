const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SRC = path.join(__dirname, '..', 'src');
const Attendance = require(path.join(SRC, 'models/Attendance'));
const Settings = require(path.join(SRC, 'models/Settings'));
const Shift = require(path.join(SRC, 'models/Shift'));
const User = require(path.join(SRC, 'models/User'));
const { closeForgottenPunches, shiftEndOn } = require(path.join(SRC, 'jobs/attendance_close'));
const { istStartOfDay } = require(path.join(SRC, 'utils/attendance_helpers'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

const NOW = new Date('2026-09-11T12:00:00.000Z');
const YESTERDAY = istStartOfDay(new Date('2026-09-10T12:00:00.000Z'));
const TODAY = istStartOfDay(NOW);
const localAt = (date, hhmm) => shiftEndOn(date, hhmm);

async function reset() {
    await Promise.all([Attendance.deleteMany({}), Settings.deleteMany({}), Shift.deleteMany({}), User.deleteMany({})]);
}

async function seed({
    date = YESTERDAY, endTime = '17:10', punchIn = localAt(YESTERDAY, '09:00'), withShift = true,
    sessions = null,
} = {}) {
    const admin = await User.create({ name: 'Close Admin', phone: '9000200001', role: 'admin', isActive: true });
    const shift = withShift ? await Shift.create({ adminId: admin._id, name: 'Day', startTime: '09:00', endTime }) : null;
    const employee = await User.create({
        name: 'Closer', phone: '9000200002', role: 'employee', adminId: admin._id,
        shiftId: shift ? shift._id : undefined, isActive: true,
    });
    await Settings.create({ adminId: admin._id, attendance: { minLunch: 0 } });
    const attendance = await Attendance.create({
        adminId: admin._id, employeeId: employee._id, date, punchIn, status: 'present',
        shifts: sessions || [{ punchIn, punchOut: null }],
    });
    return { admin, employee, attendance, punchIn };
}

(async () => {
    const mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { dbName: 'attendance_close_test' });
    console.log('connected to in-memory mongod\n');

    console.log('- previous-day safety net -');
    await reset();
    let s = await seed();
    let result = await closeForgottenPunches({ now: NOW });
    let attendance = await Attendance.findById(s.attendance._id).lean();
    const expectedEnd = localAt(YESTERDAY, '17:10');
    ok('open yesterday session closes at its shift end', result.closed === 1 && new Date(attendance.shifts[0].punchOut).getTime() === expectedEnd.getTime(), String(attendance.shifts[0].punchOut));
    ok('system close records reason and source', attendance.shifts[0].closeReason === 'shift_end' && attendance.shifts[0].punchOutSource === 'system', JSON.stringify(attendance.shifts[0]));
    ok('single-session close mirrors the root punchOut',
        attendance.punchOut !== null && new Date(attendance.punchOut).getTime() === expectedEnd.getTime(),
        String(attendance.punchOut));

    // A day whose LAST session is the open one. The root punchOut is null
    // because punch-in clears it for every new session; the close has to put it
    // back or this row matches the job's own open-row query forever and is
    // re-examined every night. Three real rows on 2026-09-16 were stuck here.
    console.log('\n- multi-session day mirrors the root -');
    await reset();
    s = await seed({
        sessions: [
            { punchIn: localAt(YESTERDAY, '09:00'), punchOut: localAt(YESTERDAY, '12:00'), closeReason: 'manual' },
            { punchIn: localAt(YESTERDAY, '13:00'), punchOut: null },
        ],
    });
    result = await closeForgottenPunches({ now: NOW });
    attendance = await Attendance.findById(s.attendance._id).lean();
    ok('the trailing open session is the one closed',
        result.closed === 1 && attendance.shifts[1].closeReason === 'shift_end',
        JSON.stringify(attendance.shifts));
    ok('closing session 2 mirrors the root punchOut (not left null)',
        attendance.punchOut !== null
        && new Date(attendance.punchOut).getTime() === new Date(attendance.shifts[1].punchOut).getTime(),
        JSON.stringify({ root: attendance.punchOut, session2: attendance.shifts[1].punchOut }));
    ok('the row no longer matches the job as open on a second run',
        (await closeForgottenPunches({ now: NOW })).examined === 0,
        'row still looks open to the nightly job');

    await reset();
    s = await seed({ date: TODAY, punchIn: localAt(TODAY, '22:00') });
    result = await closeForgottenPunches({ now: NOW });
    attendance = await Attendance.findById(s.attendance._id).lean();
    ok('open session from today is not touched', result.examined === 0 && attendance.shifts[0].punchOut === null, JSON.stringify(result));

    console.log('\n- never create negative work -');
    await reset();
    const lateIn = localAt(YESTERDAY, '18:40');
    s = await seed({ endTime: '17:10', punchIn: lateIn });
    result = await closeForgottenPunches({ now: NOW });
    attendance = await Attendance.findById(s.attendance._id).lean();
    ok('17:10 shift end never closes before an 18:40 punch-in',
        new Date(attendance.shifts[0].punchOut).getTime() >= new Date(attendance.shifts[0].punchIn).getTime(),
        JSON.stringify(attendance.shifts[0]));
    ok('late punch-in close has non-negative total work', attendance.totalWorkMs >= 0, String(attendance.totalWorkMs));

    console.log('\n- overnight shift end belongs to the next IST day -');
    await reset();
    const overnightIn = localAt(YESTERDAY, '22:00');
    s = await seed({ endTime: '06:00', punchIn: overnightIn });
    result = await closeForgottenPunches({ now: NOW });
    attendance = await Attendance.findById(s.attendance._id).lean();
    const overnightEnd = new Date(localAt(YESTERDAY, '06:00').getTime() + 24 * 60 * 60 * 1000);
    ok('a 22:00–06:00 forgotten session closes at 06:00 on the following IST day',
        result.closed === 1 && new Date(attendance.shifts[0].punchOut).getTime() === overnightEnd.getTime(),
        JSON.stringify({ punchIn: attendance.shifts[0].punchIn, punchOut: attendance.shifts[0].punchOut, expected: overnightEnd }));

    await reset();
    s = await seed({ endTime: '06:00', punchIn: overnightIn });
    const fourAmIst = new Date('2026-09-10T22:30:00.000Z');
    result = await closeForgottenPunches({ now: fourAmIst });
    attendance = await Attendance.findById(s.attendance._id).lean();
    ok('the 04:00 IST job leaves a 22:00–06:00 session open until its end has actually passed',
        result.closed === 0 && attendance.shifts[0].punchOut === null,
        JSON.stringify({ result, punchOut: attendance.shifts[0].punchOut }));

    console.log('\n- dry run and fallback -');
    await reset();
    s = await seed();
    result = await closeForgottenPunches({ now: NOW, dryRun: true });
    attendance = await Attendance.findById(s.attendance._id).lean();
    ok('dry run reports the close count', result.closed === 1 && result.details.length === 1, JSON.stringify(result));
    ok('dry run does not change the database', attendance.shifts[0].punchOut === null && attendance.totalWorkMs === 0, JSON.stringify(attendance));

    await reset();
    s = await seed({ withShift: false, punchIn: localAt(YESTERDAY, '09:00') });
    result = await closeForgottenPunches({ now: NOW });
    attendance = await Attendance.findById(s.attendance._id).lean();
    const fallbackEnd = localAt(YESTERDAY, '18:00');
    ok('employee without shift falls back to 18:00',
        result.closed === 1 && new Date(attendance.shifts[0].punchOut).getTime() === fallbackEnd.getTime(),
        String(attendance.shifts[0].punchOut));

    console.log(`\n${pass} passed, ${fail} failed`);
    // attendance_close deliberately writes its evidence rows fire-and-forget.
    // Let those writes settle before stopping the in-memory server so the
    // harness never turns an intentional asynchronous write into noisy output.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await mongoose.disconnect();
    await mongod.stop();
    process.exit(fail === 0 ? 0 : 1);
})().catch(async (err) => {
    console.error('\nTEST HARNESS ERROR:', err);
    try { await mongoose.disconnect(); } catch (_) {}
    process.exit(1);
});
