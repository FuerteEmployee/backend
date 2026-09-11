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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Maximum sessions in one day: session 1 plus four more. */
const MAX_SESSIONS = Number(process.env.MAX_DAILY_SESSIONS) || 5;

/**
 * Resolve an "HH:mm" shift time against the day a punch happened on.
 *
 * Anchored to the punch's own date rather than "today", so re-grading an old
 * day (an admin correction, a late offline flush) resolves the shift window on
 * the correct date instead of silently comparing against the current one.
 */
function shiftTimeOnDate(hhmm, referenceDate) {
    if (!hhmm || typeof hhmm !== 'string') return null;
    const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const d = new Date(referenceDate);
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d.getTime();
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
function computeWorkedMs(attendance, shift, settings) {
    const sessions = allSessions(attendance);
    if (sessions.length === 0) return 0;

    const ref = attendance?.date ? new Date(attendance.date) : new Date(sessions[0].punchIn);

    const shiftStartMs = shiftTimeOnDate(shift?.startTime, ref);
    let shiftEndMs = shiftTimeOnDate(shift?.endTime, ref);
    // Overnight shift (22:00–06:00): the end belongs to the next day.
    if (shiftStartMs !== null && shiftEndMs !== null && shiftEndMs <= shiftStartMs) {
        shiftEndMs += DAY_MS;
    }

    let totalMs = 0;
    for (const s of sessions) {
        if (!s.punchIn || !s.punchOut) continue;
        let inMs = new Date(s.punchIn).getTime();
        let outMs = new Date(s.punchOut).getTime();
        if (Number.isNaN(inMs) || Number.isNaN(outMs)) continue;
        if (outMs < inMs) outMs += DAY_MS; // ran past midnight
        if (shiftStartMs !== null) inMs = Math.max(inMs, shiftStartMs);
        if (shiftEndMs !== null) outMs = Math.min(outMs, shiftEndMs);
        totalMs += Math.max(0, outMs - inMs);
    }

    return Math.max(0, totalMs - lunchDeductionMs(attendance, settings));
}

/**
 * Lunch to subtract, per `settings.attendance.halfDayRules.deductLunch`.
 *
 * A shorter-than-configured lunch still costs the configured minimum — that is
 * the reference's rule and it is deliberate: the break is scheduled whether or
 * not it is taken in full. A longer one costs its full actual length.
 */
function lunchDeductionMs(attendance, settings) {
    const cfg = settings?.attendance || {};
    if (cfg.halfDayRules && cfg.halfDayRules.deductLunch === false) return 0;

    const lIn = attendance?.lunchInTime ? new Date(attendance.lunchInTime).getTime() : null;
    const lOut = attendance?.lunchOutTime ? new Date(attendance.lunchOutTime).getTime() : null;
    const punchedMs = lIn !== null && lOut !== null && lOut > lIn ? lOut - lIn : 0;

    const configuredMs = Number(cfg.minLunch) > 0 ? Number(cfg.minLunch) * 60 * 1000 : 0;
    if (!configuredMs) return punchedMs;
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
    lunchDeductionMs,
    requiredWorkMs,
    gradeDay,
};
