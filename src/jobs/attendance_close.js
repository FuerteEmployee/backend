const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Settings = require('../models/Settings');
const { istStartOfDay, istEndOfDay, istDateKey } = require('../utils/attendance_helpers');
const { computeWorkedMs, computeSessionWorkMs, gradeDay, openSessionIndex } = require('../utils/shift_status');
const { logAttendanceEvent } = require('../utils/attendance_event_logger');

// ─────────────────────────────────────────────────────────────────────────────
// Close sessions nobody ever punched out of.
//
// Without this, a forgotten punch-out leaves the day permanently open: the
// employee shows as On Duty forever, `gradeDay` correctly refuses to grade an
// open day, and payroll has nothing to pay. The employee then has to ask an
// admin to fix it, every time.
//
// The dangerous part is choosing the close time, and the reference's incident
// log is specific about how it goes wrong: a late shift that ENDS at 17:10 but
// where somebody punched in at 18:40 produced a session closing BEFORE it
// opened, i.e. negative worked time. It recurred across April, July and August
// 2026. Hence the invariant below:
//
//        THE CLOSE TIME IS NEVER EARLIER THAN THE LATEST PUNCH-IN.
//
// Runs at 04:00 IST, deliberately fixed rather than admin-configurable: it is a
// safety net, not a policy, and 04:00 comfortably clears any realistic
// overnight shift. It closes YESTERDAY, never today -- closing today would
// punch out the entire night shift mid-shift.
// ─────────────────────────────────────────────────────────────────────────────

/** Minutes of grace past shift end before a forgotten day is closed. */
const CLOSE_GRACE_MIN = Number(process.env.CLOSE_GRACE_MINUTES) || 0;

/** Resolve "HH:mm" against a given day. */
function shiftEndOn(date, hhmm) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const d = new Date(date);
    d.setHours(Number(m[1]), Number(m[2]) + CLOSE_GRACE_MIN, 0, 0);
    return d;
}

/**
 * Close every session still open from a previous day.
 *
 * @param {Object} [opts]
 * @param {Date}   [opts.now]     Evaluation instant (tests pass a fixed one).
 * @param {boolean}[opts.dryRun]  Report what would close, change nothing.
 */
async function closeForgottenPunches({ now = new Date(), dryRun = false } = {}) {
    // Yesterday, in IST. Anything still open from today is someone at work.
    const yesterday = new Date(istStartOfDay(now).getTime() - 1);
    const dayStart = istStartOfDay(yesterday);
    const dayEnd = istEndOfDay(yesterday);

    const open = await Attendance.find({
        date: { $gte: dayStart, $lte: dayEnd },
        punchIn: { $ne: null },
        $or: [{ punchOut: null }, { 'shifts.punchOut': null }],
    });

    const result = { examined: open.length, closed: 0, skipped: 0, dayKey: istDateKey(yesterday), details: [] };

    for (const attendance of open) {
        const idx = openSessionIndex(attendance);
        if (idx === -1) { result.skipped++; continue; }

        const [user, settings] = await Promise.all([
            User.findById(attendance.employeeId).populate('shiftId').lean(),
            Settings.findOne({ adminId: attendance.adminId }).lean(),
        ]);
        if (!user) { result.skipped++; continue; }

        const sessions = attendance.shifts || [];
        const session = sessions[idx];

        // The latest punch-in ACROSS the root punch and every session -- not
        // just the open one. This is the guard that keeps a close from
        // preceding its own open.
        let latestIn = attendance.punchIn ? new Date(attendance.punchIn) : null;
        for (const s of sessions) {
            if (s.punchIn && (!latestIn || new Date(s.punchIn) > latestIn)) latestIn = new Date(s.punchIn);
        }

        const shiftEnd = shiftEndOn(yesterday, user.shiftId?.endTime) || shiftEndOn(yesterday, '18:00');

        let closeAt = shiftEnd;
        if (!closeAt || (latestIn && closeAt < latestIn)) {
            // Shift ended before the employee even punched in -- an overnight
            // or misconfigured shift. Close at the punch-in itself, producing a
            // zero-length session rather than a negative one.
            closeAt = latestIn;
        }
        if (!closeAt) { result.skipped++; continue; }

        if (dryRun) {
            result.details.push({
                employee: user.name,
                openedAt: session?.punchIn || attendance.punchIn,
                wouldCloseAt: closeAt,
            });
            result.closed++;
            continue;
        }

        if (session) {
            session.punchOut = closeAt;
            session.closeReason = 'shift_end';
            session.punchOutSource = 'system';
        }
        if (idx === 0 || !sessions.length) {
            attendance.punchOut = closeAt;
        }
        attendance.punchOutIsProvisional = false;

        attendance.totalWorkMs = computeWorkedMs(attendance, user.shiftId, settings);
        for (const s of sessions) s.workMs = computeSessionWorkMs(s, attendance, user.shiftId);

        // Grade it now that it is closed. Only ever downgrades, same as the
        // manual and geofence paths.
        const grade = gradeDay(attendance, user.shiftId, settings);
        if (grade === 'half-day' && attendance.status === 'present') attendance.status = 'half-day';
        if (grade === 'absent') attendance.status = 'absent';

        const note = ' | Auto-closed at shift end (no punch-out recorded)';
        if (!String(attendance.remarks || '').includes(note.trim())) {
            attendance.remarks = (attendance.remarks || '') + note;
        }

        await attendance.save();

        logAttendanceEvent({
            adminId: attendance.adminId,
            employeeId: attendance.employeeId,
            type: 'punch-out',
            at: closeAt,
            source: 'system',
            sessionNumber: idx + 1,
            closeReason: 'shift_end',
        });

        result.closed++;
        result.details.push({ employee: user.name, closedAt: closeAt });
    }

    console.log(
        `[attendance-close] ${result.dayKey}: examined ${result.examined}, ` +
        `closed ${result.closed}, skipped ${result.skipped}${dryRun ? ' (DRY RUN)' : ''}`,
    );
    return result;
}

module.exports = { closeForgottenPunches, shiftEndOn, CLOSE_GRACE_MIN };
