const { istStartOfDay, istEndOfDay, istDateKey, istShiftOccurrence } = require('./attendance_helpers');
const { isDayOpen, DAY_MS } = require('./shift_status');

// ─────────────────────────────────────────────────────────────────────────────
// Which attendance day a punch belongs to.
//
// Every punch handler used to find its row by `date == today`. That is right
// for a day shift and wrong for a night one: somebody on 22:00-06:00 punches in
// on the 10th, and at 02:00 on the 11th "today" is the 11th, so their punch-out
// got a 404 ("No punch-in record found for today"), the Home screen offered
// Punch In instead of Punch Out, and a punch-in was accepted as a new, late day.
//
// The rule is the one the grading code already follows (shiftWindow,
// isLatePunchIn): a punch belongs to the shift OCCURRENCE it falls in, and an
// occurrence is filed under the IST day it STARTED on. For a day shift that is
// always today, so nothing changes for them.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long after a night shift ends its day still takes a punch-out.
 *
 * Staying past 06:00 must not strand the session: without this the 06:30
 * punch-out resolves to the NEXT occurrence (which starts at 22:00) and 404s.
 * Capped below at the next occurrence's start, so it can never swallow the
 * following night. Six hours matches what a day shift already gets: a 09:30-
 * 18:30 worker can punch out until midnight, 5.5 hours later.
 */
const LATE_OUT_MARGIN_MS = Math.max(0, Number(process.env.NIGHT_SHIFT_LATE_OUT_HOURS) || 6) * 60 * 60 * 1000;

/** IST midnight of the day a punch at `at` is filed under. */
function workDayStart(shift, at = new Date()) {
    const occ = istShiftOccurrence(shift, at);
    return istStartOfDay(occ?.overnight ? occ.start : at);
}

/** `YYYY-MM-DD` of that day, for the biometric tap log. */
function workDayKey(shift, at = new Date()) {
    return istDateKey(workDayStart(shift, at));
}

/**
 * The day of the night shift that ended shortly before `at`, or null.
 *
 * Only ever non-null for an overnight shift, and only inside the late
 * punch-out margin -- the caller must still check that the day has something
 * open (app) or has taps (device) before using it.
 */
function lateOutDayStart(shift, at = new Date()) {
    const occ = istShiftOccurrence(shift, at);
    if (!occ?.overnight) return null;
    // `at` is past the end of the occurrence that began the previous day
    // (otherwise istShiftOccurrence would have returned that one).
    const prevStart = occ.start.getTime() - DAY_MS;
    const prevEnd = occ.end.getTime() - DAY_MS;
    const t = new Date(at).getTime();
    if (t <= prevEnd) return null;
    if (t > Math.min(prevEnd + LATE_OUT_MARGIN_MS, occ.start.getTime())) return null;
    return istStartOfDay(new Date(prevStart));
}

function sameDay(a, b) {
    return !!a && !!b && istDateKey(a) === istDateKey(b);
}

/**
 * The employee's row on one IST day. A range, not an exact match, so a row
 * written at a non-IST midnight by older code is still found. When there are
 * two (the duplicate the IST fix was about), the open one wins.
 */
async function rowOn(Attendance, adminId, employeeId, dayStart, { select, lean } = {}) {
    let q = Attendance.find({
        adminId,
        employeeId,
        date: { $gte: istStartOfDay(dayStart), $lte: istEndOfDay(dayStart) },
    }).sort({ date: 1 });
    if (select) q = q.select(select);
    if (lean) q = q.lean();
    const rows = await q;
    if (rows.length === 0) return null;
    return rows.find((r) => isDayOpen(r) || r.punchOutIsProvisional) || rows[0];
}

const stillOpen = (row) => !!row && (isDayOpen(row) || !!row.punchOutIsProvisional);

/**
 * The row a punch at `now` acts on.
 *
 * @returns {{ row, primary, dayStart }}
 *   dayStart -- the day a NEW punch-in at `now` is filed under
 *   primary  -- the row already on that day, or null
 *   row      -- what punch-out / lunch / "am I punched in?" should use: the
 *               primary row, or an earlier day still open for a night shift.
 *               Differs from `primary` only when carried over.
 *
 * `select` must include date, punchIn, punchOut, shifts, punchOutIsProvisional.
 */
async function findWorkingDay({ Attendance, adminId, employeeId, shift, now = new Date(), select, lean }) {
    const opts = { select, lean };
    const dayStart = workDayStart(shift, now);
    const primary = await rowOn(Attendance, adminId, employeeId, dayStart, opts);
    if (stillOpen(primary)) return { row: primary, primary, dayStart };

    // Just after a night shift ends: that night's row, while still open.
    const carry = lateOutDayStart(shift, now);
    if (carry) {
        const prev = await rowOn(Attendance, adminId, employeeId, carry, opts);
        if (stillOpen(prev)) return { row: prev, primary, dayStart };
    }

    // A night-shift row opened after midnight by the code before this fix is
    // dated the calendar day rather than the night it belongs to. Honour it
    // while it is open, so nobody is stranded mid-shift across the deploy.
    const calendarDay = istStartOfDay(now);
    if (!sameDay(calendarDay, dayStart)) {
        const legacy = await rowOn(Attendance, adminId, employeeId, calendarDay, opts);
        if (stillOpen(legacy)) return { row: legacy, primary, dayStart };
    }

    return { row: primary, primary, dayStart };
}

module.exports = { findWorkingDay, workDayStart, workDayKey, lateOutDayStart, LATE_OUT_MARGIN_MS };
