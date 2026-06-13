require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');

// --- CONFIG ---
const ADMIN_ID  = '69eb6482c45321cbc83981bb';
const EMP_ID    = '69f87c578c10f77ee13376fc';
const MONTH     = 4;  // April
const YEAR      = 2026;

/**
 * Build a UTC Date for a given day in April 2026 at a specific hour:minute (IST = UTC-5.5h)
 * IST 09:00 = UTC 03:30, IST 18:00 = UTC 12:30
 */
function makeDate(day, hour, minute) {
    // Store as UTC, but represents IST time
    const d = new Date(Date.UTC(YEAR, MONTH - 1, day, hour - 5, minute - 30, 0));
    return d;
}

function dayOnly(day) {
    return new Date(Date.UTC(YEAR, MONTH - 1, day));
}

/**
 * Attendance plan for April 2026 (30 days)
 * Sat=6, Sun=0  → weekends absent
 * Types: present | late | half-day | (no entry = absent)
 */
const plan = [
    // Day,  type,        punchInH, punchInM, punchOutH, punchOutM
    [1,  'present',   9,  0,  18, 0],   // Tue
    [2,  'present',   9, 10,  18, 15],  // Wed
    [3,  'late',     10, 20,  18, 30],  // Thu – late arrival
    // Apr 4 Sat, Apr 5 Sun – no entry (weekend)
    [6,  'present',   9,  5,  18, 0],   // Mon
    [7,  'half-day',  9,  0,  13, 0],   // Tue – half day
    [8,  'late',     10,  5,  18, 10],  // Wed – late
    [9,  'present',   9, 15,  18, 20],  // Thu
    // Apr 10 Fri – absent (no entry)
    // Apr 11 Sat, Apr 12 Sun – no entry
    [13, 'present',   9,  0,  18, 0],   // Mon
    [14, 'present',   9,  0,  18, 0],   // Tue
    [15, 'present',   9,  5,  18, 5],   // Wed
    [16, 'half-day',  9,  0,  13, 10],  // Thu – half day
    [17, 'late',     10, 30,  18, 30],  // Fri – late
    // Apr 18 Sat, Apr 19 Sun – no entry
    [20, 'present',   9,  0,  18, 0],   // Mon
    [21, 'present',   8, 55,  18, 5],   // Tue – early bird
    // Apr 22 Wed – absent
    [23, 'present',   9, 10,  18, 0],   // Thu
    [24, 'present',   9,  0,  17, 55],  // Fri
    // Apr 25 Sat, Apr 26 Sun – no entry
    [27, 'present',   9,  5,  18, 10],  // Mon
    [28, 'half-day',  9,  0,  13, 5],   // Tue – half day
    [29, 'present',   9,  0,  18, 0],   // Wed
    [30, 'late',     10, 15,  18, 25],  // Thu – late
];

async function seed() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // Clear existing April 2026 attendance for this employee
    const startDate = new Date(Date.UTC(YEAR, MONTH - 1, 1));
    const endDate   = new Date(Date.UTC(YEAR, MONTH, 0, 23, 59, 59));

    const deleted = await Attendance.deleteMany({
        adminId: new mongoose.Types.ObjectId(ADMIN_ID),
        employeeId: new mongoose.Types.ObjectId(EMP_ID),
        date: { $gte: startDate, $lte: endDate }
    });
    console.log(`🗑️  Cleared ${deleted.deletedCount} existing records for Apr ${YEAR}`);

    const docs = plan.map(([day, type, piH, piM, poH, poM]) => {
        const punchIn  = makeDate(day, piH, piM);
        const punchOut = makeDate(day, poH, poM);
        const workHours = (punchOut - punchIn) / (1000 * 60 * 60);

        let status = type;
        let remarks = '';

        if (type === 'late') {
            remarks = 'Late Arrival';
        } else if (type === 'half-day') {
            remarks = `Short Work Day (${workHours.toFixed(2)} hrs)`;
        }

        return {
            adminId:          new mongoose.Types.ObjectId(ADMIN_ID),
            employeeId:       new mongoose.Types.ObjectId(EMP_ID),
            date:             dayOnly(day),
            punchIn,
            punchInLocation:  'Office - Seeded',
            punchInPhoto:     null,
            punchOut,
            punchOutLocation: 'Office - Seeded',
            punchOutPhoto:    null,
            lunchInTime:      null,
            lunchInLocation:  null,
            lunchOutTime:     null,
            lunchOutLocation: null,
            status,
            remarks
        };
    });

    await Attendance.insertMany(docs);
    console.log(`✅ Inserted ${docs.length} attendance records for Apr ${YEAR}`);

    // Summary
    const present  = docs.filter(d => d.status === 'present').length;
    const late     = docs.filter(d => d.status === 'late').length;
    const halfDay  = docs.filter(d => d.status === 'half-day').length;
    const absent   = 30 - docs.length; // remaining days have no entry
    console.log(`\n📊 Summary:`);
    console.log(`   Present  : ${present}`);
    console.log(`   Late     : ${late}`);
    console.log(`   Half-Day : ${halfDay}`);
    console.log(`   Absent   : ${absent} (weekends + no-shows)`);
    console.log(`   Total    : 30 days in April`);

    await mongoose.disconnect();
    console.log('\n🔌 Disconnected. Done!');
}

seed().catch(err => {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
});
