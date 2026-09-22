const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Settings = require('../models/Settings');
const { istStartOfDay, istEndOfDay, istDateKey, istShiftOccurrence } = require('../utils/attendance_helpers');
const { computeWorkedMs, computeSessionWorkMs, computeSessionGrossMs, gradeDay, openSessionIndex, shiftTimeOnDate, syncRootPunchOut } = require('../utils/shift_status');
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

/**
 * How many days back to sweep. One means yesterday only.
 *
 * "Yesterday only" is correct for a job that never misses a night, and this
 * one missed most of them: 488 days were left open because a run that does not
 * happen leaves its day permanently unreachable -- the next run looks at the
 * NEXT yesterday and the gap is gone forever. A lookback makes a missed night
 * recoverable instead of fatal. Closing an already-closed day is a no-op, so
 * widening this is safe.
 */
const CLOSE_LOOKBACK_DAYS = Math.max(1, Number(process.env.CLOSE_LOOKBACK_DAYS) || 1);

/**
 * Resolve "HH:mm" against a given day, plus the grace period.
 *
 * Delegates to shiftTimeOnDate rather than doing its own arithmetic. It used
 * to call `d.setHours(...)`, which resolves in the HOST timezone -- and
 * production runs on a UTC box, so a shift ending "20:00" was written as
 * 20:00 UTC, i.e. 01:30 IST the next morning. That is the exact instant nine
 * real days were closed at, each then computing zero worked time and grading
 * absent. One resolver, defined once, in IST.
 */
function shiftEndOn(date, hhmm) {
    const ms = shiftTimeOnDate(hhmm, date);
    if (ms === null) return null;
    return new Date(ms + CLOSE_GRACE_MIN * 60 * 1000);
}

/**
 * Close time for a shift OCCURRENCE, so an overnight shift ends on the right
 * day. A 22:00-06:00 session closed with shiftEndOn alone resolved 06:00 on the
 * SAME day as the 22:00 punch-in — before the session opened — and the
 * never-close-before-open guard then collapsed it to a zero-length session.
 */
function occurrenceEnd(shift, refDate) {
    const occ = istShiftOccurrence(shift, refDate);
    if (!occ) return null;
    return new Date(occ.end.getTime() + CLOSE_GRACE_MIN * 60 * 1000);
}

/**
 * Close every session still open from a previous day.
 *
 * @param {Object} [opts]
 * @param {Date}   [opts.now]     Evaluation instant (tests pass a fixed one).
 * @param {boolean}[opts.dryRun]  Report what would close, change nothing.
 */
async function closeForgottenPunches({ now = new Date(), dryRun = false } = {}) {
    // Yesterday, in IST. Anything still open from TODAY is someone at work,
    // so the window always ends there. It begins CLOSE_LOOKBACK_DAYS earlier so
    // a night the job did not run is picked up on the next one.
    const yesterday = new Date(istStartOfDay(now).getTime() - 1);
    const dayEnd = istEndOfDay(yesterday);
    const dayStart = istStartOfDay(
        new Date(yesterday.getTime() - (CLOSE_LOOKBACK_DAYS - 1) * 24 * 60 * 60 * 1000),
    );

    const open = await Attendance.find({
        date: { $gte: dayStart, $lte: dayEnd },
        punchIn: { $ne: null },
        $or: [{ punchOut: null }, { 'shifts.punchOut': null }],
    });

    const result = {
        examined: open.length,
        closed: 0,
        skipped: 0,
        needsReview: 0,
        from: istDateKey(dayStart),
        to: istDateKey(yesterday),
        details: [],
    };

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

        // The row's own date, not `yesterday`: with a lookback the batch spans
        // several days, and resolving every one of them against yesterday's
        // date would close a Tuesday session at Thursday's shift end.
        const onDay = attendance.date || yesterday;
        // Anchor on the punch itself where we have one: for an overnight shift
        // the occurrence may have started the previous IST day, and the row's
        // date alone cannot distinguish that.
        const anchor = latestIn || onDay;
        const shiftEnd = occurrenceEnd(user.shiftId, anchor)
            || shiftEndOn(onDay, user.shiftId?.endTime)
            || shiftEndOn(onDay, '18:00');

        let closeAt = shiftEnd;
        if (!closeAt || (latestIn && closeAt < latestIn)) {
            // Shift ended before the employee even punched in -- an overnight
            // or misconfigured shift. Close at the punch-in itself, producing a
            // zero-length session rather than a negative one.
            closeAt = latestIn;
        }
        if (!closeAt) { result.skipped++; continue; }

        // Never close a shift that has not ended yet.
        //
        // This job runs at 04:00 IST and sweeps YESTERDAY, which is safe for a
        // day shift but not for a night one: a 22:00-06:00 session opened
        // yesterday is still being worked at 04:00, and closing it would stamp
        // a punch-out two hours in the future on somebody who is at their post.
        // Leave it; the next run, after 06:00 has passed, will close it properly.
        if (closeAt.getTime() > new Date(now).getTime()) { result.skipped++; continue; }

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
        // The root mirrors the day's FINAL punch-out, whichever session that
        // is. Keying on index 0 left the root null whenever a later session was
        // the one being closed -- and this job's own open-row query above
        // matches on a null root, so those rows came back every single night.
        if (!sessions.length) {
            attendance.punchOut = closeAt;
        } else {
            syncRootPunchOut(attendance);
        }
        attendance.punchOutIsProvisional = false;

        attendance.totalWorkMs = computeWorkedMs(attendance, user.shiftId, settings);
        for (const s of sessions) {
            s.workMs = computeSessionWorkMs(s, attendance, user.shiftId);
            s.grossMs = computeSessionGrossMs(s);
        }

        // Grade it now that it is closed. Only ever downgrades, same as the
        // manual and geofence paths.
        const grade = gradeDay(attendance, user.shiftId, settings);
        if (grade === 'half-day' && attendance.status === 'present') attendance.status = 'half-day';
        if (grade === 'absent') attendance.status = 'absent';

        // A day this job closed that still measures as nothing is OUR failure
        // to reconstruct, not the employee's absence -- they have a punch-in on
        // record. Flag it for a person rather than deducting a day's pay on the
        // strength of a number we could not compute.
        if (grade === 'needs_review') {
            attendance.status = 'needs_review';
            result.needsReview++;
        }

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
        `[attendance-close] ${result.from}..${result.to}: examined ${result.examined}, ` +
        `closed ${result.closed}, skipped ${result.skipped}${dryRun ? ' (DRY RUN)' : ''}`,
    );
    return result;
}

module.exports = { closeForgottenPunches, shiftEndOn, CLOSE_GRACE_MIN };
