// Re-grade days the geofence engine auto-closed, using the same rules the
// manual punch-out applies (see closeSession in utils/geofence_engine.js).
//
// DRY RUN by default: prints what would change and writes nothing.
//   node scratch/regrade_auto_exit.js                       # dry run, all tenants
//   node scratch/regrade_auto_exit.js --from 2026-09-01     # only days on/after
//   node scratch/regrade_auto_exit.js --admin <adminId>     # one tenant
//   node scratch/regrade_auto_exit.js --apply               # write
//   node scratch/regrade_auto_exit.js --apply --salary      # write + re-sync salary
//
// Skipped on purpose: days an admin edited or regularized (a person already
// decided them), days still open, and days with no shift (cannot be graded).
// Only status / wasLate / remarks / hours fields change; punch times never do.
// Connects to the live MONGO_URI -- take a backup before --apply.
process.chdir(require('path').join(__dirname, '..'));
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const mongoose = require('mongoose');
const Attendance = require('../src/models/Attendance');
const Settings = require('../src/models/Settings');
const User = require('../src/models/User');
const { isLatePunchIn, determineHalfDayStatus, stripGradingRemarks, istDateKey, istCalendarDate } = require('../src/utils/attendance_helpers');
const { computeWorkedMs, computeSessionWorkMs, computeSessionGrossMs, gradeDay, isDayOpen } = require('../src/utils/shift_status');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const SALARY = process.argv.includes('--salary');

(async () => {
    await mongoose.connect(process.env.MONGO_URI);
    const q = { autoPunchOut: true, punchIn: { $ne: null } };
    if (arg('--admin')) q.adminId = arg('--admin');
    if (arg('--from')) q.date = { $gte: new Date(arg('--from') + 'T00:00:00+05:30') };

    const rows = await Attendance.find(q).sort({ date: 1 });
    console.log(`${rows.length} auto-closed days found. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

    const settingsCache = new Map();
    const userCache = new Map();
    const months = new Map(); // key -> {adminId, employeeId, month, year}
    let changed = 0, skipped = 0;

    for (const att of rows) {
        const remarks = String(att.remarks || '');
        const regularized = (att.shifts || []).some((s) => s.closeReason === 'regularized');
        if (remarks.includes('Edited by admin') || regularized) { skipped++; continue; }
        if (isDayOpen(att)) { skipped++; continue; }

        const uKey = String(att.employeeId);
        if (!userCache.has(uKey)) userCache.set(uKey, await User.findById(att.employeeId).populate('shiftId'));
        const user = userCache.get(uKey);
        const shift = user?.shiftId;
        if (!shift) { skipped++; continue; }

        const aKey = String(att.adminId);
        if (!settingsCache.has(aKey)) settingsCache.set(aKey, await Settings.findOne({ adminId: att.adminId }));
        const settings = settingsCache.get(aKey);

        const before = { status: att.status, wasLate: att.wasLate, remarks: att.remarks };

        att.totalWorkMs = computeWorkedMs(att, shift, settings);
        for (const s of (att.shifts || [])) {
            s.workMs = computeSessionWorkMs(s, att, shift);
            s.grossMs = computeSessionGrossMs(s);
        }
        if (att.status === 'late' || att.status === 'half-day' || isLatePunchIn(att.punchIn, shift, settings)) att.wasLate = true;

        const { status: finalStatus, remarksAppend } = determineHalfDayStatus({
            punchIn: att.punchIn, punchOut: att.punchOut, totalWorkMs: att.totalWorkMs,
            lunchInTime: att.lunchInTime, lunchOutTime: att.lunchOutTime, isWFH: att.isWFH, shift,
        }, settings);
        att.status = finalStatus;
        att.remarks = stripGradingRemarks(att.remarks);
        if (finalStatus === 'half-day' && remarksAppend) att.remarks = (att.remarks || '') + remarksAppend;

        const grade = gradeDay(att, shift, settings);
        if (grade === 'half-day' && att.status === 'present') {
            att.status = 'half-day';
            const note = ' | Short hours across sessions';
            if (!String(att.remarks || '').includes(note.trim())) att.remarks = (att.remarks || '') + note;
        }
        if (grade === 'absent') att.status = 'absent';
        if (grade === 'needs_review') att.status = 'needs_review';

        const note = ' | Auto punch-out (left branch geo-fence)';
        if (!String(att.remarks || '').includes(note.trim())) att.remarks = (att.remarks || '') + note;

        if (before.status === att.status && before.wasLate === att.wasLate) { skipped++; continue; }

        changed++;
        console.log(`${istDateKey(att.date)} ${user.name}: ${before.status}${before.wasLate ? '+late' : ''} -> ${att.status}${att.wasLate ? '+late' : ''}`);
        if (APPLY) {
            await att.save();
            const pm = istCalendarDate(att.date);
            months.set(`${att.employeeId}-${pm.getMonth() + 1}-${pm.getFullYear()}`,
                { adminId: att.adminId, user, month: pm.getMonth() + 1, year: pm.getFullYear() });
        }
    }

    console.log(`\n${changed} ${APPLY ? 'updated' : 'would change'}, ${skipped} skipped/unchanged.`);
    if (APPLY && SALARY) {
        const { calculateAndSaveSalary } = require('../src/controllers/salary_controller');
        for (const m of months.values()) {
            try { await calculateAndSaveSalary(m.adminId, m.user, m.month, m.year); } catch (e) { console.error('salary', m.user.name, e.message); }
        }
        console.log(`Salary re-synced for ${months.size} employee-months.`);
    } else if (APPLY && months.size) {
        console.log(`Salary NOT re-synced (${months.size} employee-months affected). Re-run with --salary.`);
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
