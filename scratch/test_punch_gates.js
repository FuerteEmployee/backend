const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SRC = path.join(__dirname, '..', 'src');
const Tracking = require(path.join(SRC, 'models/Tracking'));
const Attendance = require(path.join(SRC, 'models/Attendance'));
const Branch = require(path.join(SRC, 'models/Branch'));

let pass = 0;
let fail = 0;

const display = (value) => {
    if (value instanceof Date) return value.toISOString();
    if (Number.isNaN(value)) return 'NaN';
    return JSON.stringify(value);
};

const ok = (name, actual, expected) => {
    if (actual === expected) {
        pass++;
        console.log(`  PASS  ${name}`);
    } else {
        fail++;
        console.log(`  FAIL  ${name}  expected ${display(expected)}, got ${display(actual)}`);
    }
};

const sameDate = (actual, expected) => actual instanceof Date && actual.getTime() === expected.getTime();

(async () => {
    const mongod = await MongoMemoryServer.create();

    try {
        await mongoose.connect(mongod.getUri(), { dbName: 'punch_gates_test' });
        console.log('connected to in-memory mongod\n');

        // Schema indexes must build against a real mongod before the round-trip checks.
        await Promise.all([Tracking.syncIndexes(), Attendance.syncIndexes(), Branch.syncIndexes()]);

        const adminId = new mongoose.Types.ObjectId();
        const employeeId = new mongoose.Types.ObjectId();

        console.log('— Tracking accuracy —');
        const reportedFix = await Tracking.create({
            adminId,
            employeeId,
            latitude: 12.9716,
            longitude: 77.5946,
            accuracy: 12.5,
        });
        const reportedFixFromDb = await Tracking.findById(reportedFix._id).lean();
        ok('reported accuracy round-trips', reportedFixFromDb.accuracy, 12.5);

        const unknownFix = await Tracking.create({
            adminId,
            employeeId,
            latitude: 12.9716,
            longitude: 77.5946,
            accuracy: null,
        });
        const unknownFixFromDb = await Tracking.findById(unknownFix._id).lean();
        ok('null accuracy stays null', unknownFixFromDb.accuracy, null);

        console.log('\n— Attendance punch metadata —');
        const punchInFixAt = new Date('2026-09-11T03:45:00.000Z');
        const punchOutFixAt = new Date('2026-09-11T12:15:00.000Z');
        const attendance = await Attendance.create({
            adminId,
            employeeId,
            date: new Date('2026-09-10T18:30:00.000Z'),
            status: 'present',
            source: 'app',
            punchInAccuracy: 8.75,
            punchOutAccuracy: 24.5,
            punchInFixAt,
            punchOutFixAt,
            derivedFields: ['punchIn', 'punchOut'],
        });
        const attendanceFromDb = await Attendance.findById(attendance._id).lean();
        ok('punchInAccuracy round-trips', attendanceFromDb.punchInAccuracy, 8.75);
        ok('punchOutAccuracy round-trips', attendanceFromDb.punchOutAccuracy, 24.5);
        ok('punchInFixAt round-trips', sameDate(attendanceFromDb.punchInFixAt, punchInFixAt), true);
        ok('punchOutFixAt round-trips', sameDate(attendanceFromDb.punchOutFixAt, punchOutFixAt), true);
        ok(
            'derivedFields round-trips as an array of strings',
            Array.isArray(attendanceFromDb.derivedFields) && attendanceFromDb.derivedFields.every((field) => typeof field === 'string'),
            true
        );
        ok('derivedFields retains its values', JSON.stringify(attendanceFromDb.derivedFields), JSON.stringify(['punchIn', 'punchOut']));

        console.log('\n— Branch geofence default —');
        const branch = await Branch.create({
            adminId,
            branchName: 'Default fence branch',
            branchLocation: 'Test location',
        });
        const branchFromDb = await Branch.findById(branch._id).lean();
        ok('geoFenceEnabled defaults to true', branchFromDb.geoFenceEnabled, true);
    } finally {
        await mongoose.disconnect();
        await mongod.stop();
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(async (err) => {
    fail++;
    console.error('\nTEST HARNESS ERROR:', err);
    console.log(`\n${pass} passed, ${fail} failed`);
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    process.exit(1);
});
