// Throwaway diagnostic: today's biometric taps + day state for one employee.
// READ ONLY. Run from backend/:  node scratch/diag_bharat_today.js
require('dotenv').config();
// Same DNS pin as src/index.js -- Atlas SRV lookups fail on some resolvers.
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');

const User = require('../src/models/User');
const PunchLog = require('../src/models/PunchLog');
const Attendance = require('../src/models/Attendance');
const AttendanceEvent = require('../src/models/AttendanceEvent');
const { istDateKey, istStartOfDay, istEndOfDay } = require('../src/utils/attendance_helpers');

const ist = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '—');

(async () => {
    await mongoose.connect(process.env.MONGO_URI);

    const user = await User.findOne({
        $or: [{ phone: '6353679318' }, { mobile: '6353679318' }, { name: /bharat fuerte/i }],
    }).select('name phone mobile role adminId deviceUserId branch shift');

    if (!user) {
        console.log('NO USER MATCHED');
        await mongoose.disconnect();
        return;
    }

    console.log('=== EMPLOYEE ===');
    console.log('  name        :', user.name);
    console.log('  phone       :', user.phone || user.mobile);
    console.log('  role        :', user.role);
    console.log('  _id         :', String(user._id));
    console.log('  adminId     :', String(user.adminId));
    console.log('  deviceUserId:', user.deviceUserId, '(PIN on the terminal)');

    const dayKey = istDateKey(new Date());
    console.log('\n=== IST DAY:', dayKey, '===');

    const taps = await PunchLog.find({ employeeId: user._id, dayKey }).sort({ deviceTime: 1 }).lean();
    console.log('\n--- RAW TAPS (PunchLog) — count:', taps.length, '---');
    for (const t of taps) {
        console.log(
            `  ${ist(t.deviceTime)}  pin=${t.pin}  sn=${t.serialNumber}` +
            `  action=${t.derivedAction || '(extra)'}` +
            (t.discarded ? `  DISCARDED:${t.discardReason}` : '') +
            `  received=${ist(t.receivedAt)}`
        );
    }

    const att = await Attendance.findOne({
        employeeId: user._id,
        date: { $gte: istStartOfDay(), $lte: istEndOfDay() },
    }).lean();

    console.log('\n--- DAY STATE (Attendance) ---');
    if (!att) {
        console.log('  (no attendance document for today)');
    } else {
        console.log('  date         :', ist(att.date));
        console.log('  status       :', att.status, att.wasLate ? '(wasLate)' : '');
        console.log('  source       :', att.source);
        console.log('  punchIn      :', ist(att.punchIn));
        console.log('  lunchInTime  :', ist(att.lunchInTime));
        console.log('  lunchOutTime :', ist(att.lunchOutTime));
        console.log('  punchOut     :', ist(att.punchOut), att.punchOutIsProvisional ? '(provisional)' : '');
        console.log('  totalWorkMs  :', att.totalWorkMs, `(${(att.totalWorkMs / 3600000).toFixed(2)} h)`);
        console.log('  derivedFields:', JSON.stringify(att.derivedFields));
        console.log('  sessions     :', (att.shifts || []).length);
        (att.shifts || []).forEach((s, i) => {
            console.log(`    s${i + 1}: in=${ist(s.punchIn)}  out=${ist(s.punchOut)}  close=${s.closeReason || '—'}`);
        });
    }

    const events = await AttendanceEvent.find({ employeeId: user._id, dayKey }).sort({ at: 1 }).lean();
    console.log('\n--- EVENT LOG (AttendanceEvent) — count:', events.length, '---');
    for (const e of events) {
        console.log(`  ${ist(e.at)}  ${e.type}  src=${e.source}  s${e.sessionNumber}  close=${e.closeReason || '—'}  acc=${e.accuracy ?? 'null'}`);
    }

    await mongoose.disconnect();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
