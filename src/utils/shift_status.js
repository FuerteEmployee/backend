// ─────────────────────────────────────────────────────────────────────────────
// Worked hours and day grading across multiple sessions.
//
// Ported from the ScreenTime reference (`utils/shiftStatus.js`), adapted to
// this schema. The reference's own note is worth repeating: this logic had been
// duplicated between two controllers and had already DIVERGED before being
// centralised. Keep it in this one file — every punch path, the reconciliation
// engine and any end-of-day job must grade a day identically or the same
// attendance produces different pay depending on which code closed it.
//
// Config differences from the reference, deliberate:
//   • Lunch and grace live in `Settings.attendance` here, not on the Shift.
//     This project already has lunchIn/lunchOut/minLunch/lateGrace/halfDayRules
//     there, and adding a parallel copy on Shift would create two sources of
//     truth for the same number.
//   • Sessions live in `attendance.shifts[]`, and session 1 is ALSO the root
//     punchIn/punchOut. The reference warns about exactly this layout: any
//     "is the day closed?" test must check both. `openSessionIndex()` below is
//     the single place that knows it.
// ─────────────────────────────────────────────────────────────────────────────

const { shiftTimeOnDate: istShiftTimeOnDate } = require('./attendance_helpers');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Maximum sessions in one day: session 1 plus four more. */
const MAX_SESSIONS = Number(process.env.MAX_DAILY_SESSIONS) || 5;

/**
 * Resolve an "HH:mm" shift time (IST) against the IST day a punch happened
 * on, as epoch ms. Anchored to the punch's own date rather than "today", so
 * re-grading an old day (an admin correction, a late offline flush) resolves
 * the shift window on the correct date instead of silently comparing against
 * the current one. Delegates to the shared IST-anchored helper — see its own
 * comment for why this can't be `new Date(referenceDate); d.setHours(...)`.
 */
function shiftTimeOnDate(hhmm, referenceDate) {
    const d = istShiftTimeOnDate(hhmm, referenceDate);
    return d ? d.getTime() : null;
}

/**
 * Every session of the day as {punchIn, punchOut} pairs.
 *
 * Session 1 is the root punchIn/punchOut for backward compatibility with the
 * original single-session schema; `shifts[]` carries it too on newer records.
 * Reading both would double-count, so when `shifts[]` is populated it is
 * treated as authoritative and the root is ignored.
 */
function allSessions(attendance) {
    const arr = Array.isArray(attendance?.shifts) ? attendance.shifts.filter(Boolean) : [];
    if (arr.length > 0) return arr;
    if (attendance?.punchIn) return [{ punchIn: attendance.punchIn, punchOut: attendance.punchOut }];
    return [];
}

/**
 * Index of the session still open, or -1.
 *
 * The reference calls out that forgetting to check BOTH the root punch and the
 * array is "an entire class of bug" — a freshly punched-in employee reading as
 * already punched out, or a day that can never be closed. This is the only
 * function allowed to know the layout.
 */
function openSessionIndex(attendance) {
    const sessions = allSessions(attendance);
    for (let i = sessions.length - 1; i >= 0; i--) {
        if (sessions[i].punchIn && !sessions[i].punchOut) return i;
    }
    return -1;
}

function isDayOpen(attendance) {
    return openSessionIndex(attendance) !== -1;
}

/**
 * Net worked milliseconds for the day, summed across every session and clamped
 * to the shift window, minus lunch.
 *
 * Clamping matters: a keen employee punching in an hour early earns nothing for
 * it, and time after shift end is overtime rather than worked hours (graded
 * separately). Without the clamp, an early punch-in inflates a day to Full Day
 * on time nobody asked them to work.
 */
function shiftWindow(attendance, shift, sessions) {
    const ref = attendance?.date
        ? new Date(attendance.date)
        : new Date(sessions?.[0]?.punchIn || Date.now());

    const startMs = shiftTimeOnDate(shift?.startTime, ref);
    let endMs = shiftTimeOnDate(shift?.endTime, ref);
    // Overnight shift (22:00–06:00): the end belongs to the next day.
    if (startMs !== null && endMs !== null && endMs <= startMs) endMs += DAY_MS;
    return { startMs, endMs };
}

/**
 * Gross worked ms for ONE session, clamped to the shift window.
 *
 * Lunch is deliberately NOT deducted here. It is a day-level deduction, and
 * charging it to one arbitrary session would make the per-session figures stop
 * summing to anything an admin could check. So sessions read gross and the day
 * total reads net -- and the gap between them is exactly the lunch line shown
 * beside them.
 */
function computeSessionWorkMs(session, attendance, shift) {
    if (!session?.punchIn || !session?.punchOut) return null;
    const { startMs, endMs } = shiftWindow(attendance, shift, allSessions(attendance));

    let inMs = new Date(session.punchIn).getTime();
    let outMs = new Date(session.punchOut).getTime();
    if (Number.isNaN(inMs) || Number.isNaN(outMs)) return null;
    if (outMs < inMs) outMs += DAY_MS; // ran past midnight
    if (startMs !== null) inMs = Math.max(inMs, startMs);
    if (endMs !== null) outMs = Math.min(outMs, endMs);
    return Math.max(0, outMs - inMs);
}

function computeWorkedMs(attendance, shift, settings) {
    const sessions = allSessions(attendance);
    if (sessions.length === 0) return 0;

    let totalMs = 0;
    for (const s of sessions) {
        totalMs += computeSessionWorkMs(s, attendance, shift) || 0;
    }

    return Math.max(0, totalMs - lunchDeductionMs(attendance, settings, shift));
}

/**
 * Lunch to subtract, per `settings.attendance.halfDayRules.deductLunch`.
 *
 * A shorter-than-configured lunch still costs the configured minimum — that is
 * the reference's rule and it is deliberate: the break is scheduled whether or
 * not it is taken in full. A longer one costs its full actual length.
 */
function lunchDeductionMs(attendance, settings, shift) {
    const cfg = settings?.attendance || {};
    if (cfg.halfDayRules && cfg.halfDayRules.deductLunch === false) return 0;

    const lIn = attendance?.lunchInTime ? new Date(attendance.lunchInTime).getTime() : null;
    const lOut = attendance?.lunchOutTime ? new Date(attendance.lunchOutTime).getTime() : null;
    const punchedMs = lIn !== null && lOut !== null && lOut > lIn ? lOut - lIn : 0;

    const configuredMs = Number(cfg.minLunch) > 0 ? Number(cfg.minLunch) * 60 * 1000 : 0;
    if (!configuredMs) return punchedMs;

    // The tenant-wide minimum cannot apply to a shift too short to contain it.
    //
    // Without this, a 20-minute relief shift under a company-wide 60-minute
    // lunch deducted the full hour from a 20-minute day: worked time came out
    // as zero and the employee was graded ABSENT having worked their entire
    // shift, every time, with nothing in the record explaining why.
    //
    // requiredWorkMs() already recognises this misconfiguration and floors the
    // bar; the deduction has to recognise it too, or the two disagree and the
    // bar becomes unreachable by construction. A break longer than the shift
    // that contains it is not a break -- fall back to whatever was actually
    // punched, which is normally nothing.
    const ref = attendance?.date ? new Date(attendance.date) : new Date();
    const startMs = shiftTimeOnDate(shift?.startTime, ref);
    let endMs = shiftTimeOnDate(shift?.endTime, ref);
    if (startMs !== null && endMs !== null) {
        if (endMs <= startMs) endMs += DAY_MS;
        if (configuredMs >= endMs - startMs) return punchedMs;
    }

    return Math.max(punchedMs, configuredMs);
}

/**
 * Hours an employee must work to earn a Full Day.
 *
 * Two calibration traps the reference paid for, both reproduced here:
 *
 * (1) Compare against `span − lunch`, never the raw span. With lunch deducted
 *     from worked time, an employee present for the entire shift lands at
 *     8/9 ≈ 89% of the span and Full Day becomes literally unreachable.
 *
 * (2) The half-hour floor applies ONLY to a misconfigured shift (lunch ≥ span).
 *     Applied blanket-wide it stops a genuinely short shift — a 30-minute
 *     relief shift — from ever reaching Full Day no matter what is worked.
 */
function requiredWorkMs(shift, settings) {
    const ref = new Date();
    const startMs = shiftTimeOnDate(shift?.startTime, ref);
    let endMs = shiftTimeOnDate(shift?.endTime, ref);
    if (startMs === null || endMs === null) return null; // no shift: cannot grade on hours
    if (endMs <= startMs) endMs += DAY_MS;

    const spanMs = endMs - startMs;
    const cfg = settings?.attendance || {};
    const lunchMs = Number(cfg.minLunch) > 0 ? Number(cfg.minLunch) * 60 * 1000 : 0;
    const graceMs = Number(cfg.lateGrace) > 0 ? Number(cfg.lateGrace) * 60 * 1000 : 0;

    const required = spanMs - lunchMs - graceMs;
    // Misconfigured shift only — lunch longer than the shift itself.
    if (required <= 0) return Math.min(spanMs, 30 * 60 * 1000);
    return required;
}

/**
 * Grade a completed day.
 *
 * Returns null while the day is still open: a day in progress has no status,
 * and writing a guess is how "Absent" ends up stored against someone who is
 * standing at their desk. The read side derives the display state instead.
 */
function gradeDay(attendance, shift, settings) {
    if (isDayOpen(attendance)) return null;

    const workedMs = computeWorkedMs(attendance, shift, settings);
    if (workedMs <= 0) return 'absent';

    const required = requiredWorkMs(shift, settings);
    if (required === null) return 'present'; // no shift to grade against

    return workedMs >= required ? 'present' : 'half-day';
}

module.exports = {
    MAX_SESSIONS,
    DAY_MS,
    shiftTimeOnDate,
    allSessions,
    openSessionIndex,
    isDayOpen,
    computeWorkedMs,
    computeSessionWorkMs,
    shiftWindow,
    lunchDeductionMs,
    requiredWorkMs,
    gradeDay,
};
