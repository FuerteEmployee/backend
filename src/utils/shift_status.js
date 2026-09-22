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
//   • Grace lives in `Settings.attendance` here, not on the Shift.
//   • Lunch STARTED tenant-wide in `Settings.attendance.minLunch` and now has
//     a per-shift override in `Shift.lunch`, because a break is a shift-level
//     policy: a night crew and a front desk legitimately differ. There is
//     still ONE source of truth per day, because the precedence is absolute
//     and lives in exactly one function -- `resolveLunchPolicy()` below.
//     `Shift.lunch.mode === 'inherit'` (the default) means the tenant setting
//     applies unchanged, so shifts created before this existed behave as they
//     always did. Every consumer must go through that resolver; reading
//     `settings.attendance.minLunch` directly is what would create the second
//     source of truth this note originally warned about.
//   • Sessions live in `attendance.shifts[]`, and session 1 is ALSO the root
//     punchIn/punchOut. The reference warns about exactly this layout: any
//     "is the day closed?" test must check both. `openSessionIndex()` below is
//     the single place that knows it.
// ─────────────────────────────────────────────────────────────────────────────

// attendance_helpers has no requires of its own, so this stays acyclic.
const { istShiftOccurrence } = require('./attendance_helpers');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * IST is the only timezone this product operates in, and it is fixed: +05:30,
 * no daylight saving. Every time calculation here resolves against it
 * explicitly rather than through the host clock.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Maximum sessions in one day.
 *
 * Raised from 5 to 12 on 2026-09-18. Five was calibrated when a session could
 * only be opened and closed by hand; it is a different number now that the
 * geofence engine closes a session every time an employee leaves the fence, so
 * an ordinary day of stepping out and back burns sessions at a rate nobody was
 * budgeting for. Three days had already hit the cap and seven punch-ins were
 * refused outright -- an employee standing at the door, unable to record that
 * they had arrived, which is far worse than a long shifts[] array.
 *
 * The cap still exists, and still does its original job: it bounds the array
 * against a device toggling in a pocket or somebody tapping repeatedly. It is
 * a backstop against runaway growth, not a policy about how many times a person
 * may legitimately come and go.
 */
const MAX_SESSIONS = Number(process.env.MAX_DAILY_SESSIONS) || 12;

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

    // Resolved in IST, NOT in the host timezone.
    //
    // This used to be `d.setHours(h, m, 0, 0)`, which resolves against whatever
    // timezone the Node process happens to run in. Production runs on a UTC
    // box with TZ unset, so a shift ending at "20:00" became 20:00 UTC --
    // 01:30 IST the following morning. The forgotten-punch-out job then closed
    // days at that instant, worked time computed to zero, and gradeDay graded
    // the day absent. Nine real days were lost that way before anyone noticed,
    // and the punch-out times looked like the employee had worked past
    // midnight.
    //
    // Same defect the date helpers already carry a warning about: setHours is
    // never safe here. Note that requiredWorkMs survived it, because it is
    // (end - start) and both ends shifted equally -- which is exactly why this
    // stayed invisible in the grading totals while corrupting the timestamps.
    const shifted = new Date(d.getTime() + IST_OFFSET_MS);
    const istMidnightMs = Date.UTC(
        shifted.getUTCFullYear(),
        shifted.getUTCMonth(),
        shifted.getUTCDate(),
    ) - IST_OFFSET_MS;

    return istMidnightMs + (Number(m[1]) * 60 + Number(m[2])) * 60 * 1000;
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
 * Mirror the day's final punch-out back onto the root punchOut fields.
 *
 * `shifts[]` is authoritative once populated, but the ROOT fields are still
 * what several readers use to ask "is this day finished": the nightly close
 * job's open-row query, the expectedButSilent stat, and the punch-in guard that
 * refuses a new session while one is open. Punch-in clears the root punchOut
 * for EVERY new session, so unless a close puts it back the day reads as
 * permanently open.
 *
 * The rule this replaces was "only mirror when closing session index 0" -- a
 * leftover from the single-session schema. It left the root null whenever a
 * later session was the one being closed; three of nine rows on 2026-09-16 were
 * stuck that way, re-examined by the close job every night and counted as
 * on-duty indefinitely.
 *
 * Index is the wrong key regardless: `shifts[]` is NOT stored in chronological
 * order (one real row carries 15:30 sessions ahead of 11:37 ones), so the final
 * session is found by timestamp and never by position.
 */
function syncRootPunchOut(attendance) {
    const arr = Array.isArray(attendance?.shifts) ? attendance.shifts.filter(Boolean) : [];
    if (arr.length === 0) return; // no array: the root IS the session already

    // A day with a session still open must keep a null root punchOut, or it
    // looks finished while somebody is still on the clock. Leave it untouched
    // rather than writing null -- the provisional device punch-out deliberately
    // parks a value there and owns its own clearing.
    if (openSessionIndex(attendance) !== -1) return;

    let latest = null;
    for (const s of arr) {
        if (!s.punchOut) continue;
        const t = new Date(s.punchOut).getTime();
        if (Number.isNaN(t)) continue;
        if (!latest || t > latest.t) latest = { t, session: s };
    }
    if (!latest) return;

    const s = latest.session;
    attendance.punchOut = s.punchOut;
    attendance.punchOutLocation = s.punchOutLocation ?? null;
    attendance.punchOutCoordinates = s.punchOutCoordinates ?? null;
    attendance.punchOutDistance = s.punchOutDistance ?? null;
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
    // Anchor on the actual PUNCH where we have one, not the row's date.
    //
    // For a day shift the two agree. For an overnight shift they do not: a row
    // dated the 11th holding a 01:00 punch belongs to the occurrence that began
    // at 22:00 on the 10th, and anchoring on the row date resolves the whole
    // window twenty-four hours late. The punch is a real instant and identifies
    // the occurrence unambiguously; the date alone cannot.
    const ref = sessions?.[0]?.punchIn
        ? new Date(sessions[0].punchIn)
        : (attendance?.punchIn ? new Date(attendance.punchIn)
            : (attendance?.date ? new Date(attendance.date) : null));
    if (!ref || Number.isNaN(ref.getTime())) return { startMs: null, endMs: null };

    const occ = istShiftOccurrence(shift, ref);
    if (occ) return { startMs: occ.start.getTime(), endMs: occ.end.getTime() };

    const startMs = shiftTimeOnDate(shift?.startTime, ref);
    let endMs = shiftTimeOnDate(shift?.endTime, ref);
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

/**
 * Real, UNCLAMPED duration of one session.
 *
 * `computeSessionWorkMs` clamps to the shift window, which is what pay should
 * be built on. But a session lying entirely outside that window then measures
 * exactly zero, and the time vanishes from the record altogether: somebody who
 * punched in at 18:31 against a 09:30-18:30 shift worked 52 real minutes and
 * the row showed nothing at all -- not a zero-credit session, just a zero.
 *
 * This is deliberately NOT fed into pay. It exists so the credited figure and
 * the measured figure sit side by side, which turns an invisible discrepancy
 * into a reviewable one. Whether such time SHOULD be paid is a policy question
 * about overtime, and is not decided here.
 */
function computeSessionGrossMs(session) {
    if (!session?.punchIn || !session?.punchOut) return null;
    const inMs = new Date(session.punchIn).getTime();
    let outMs = new Date(session.punchOut).getTime();
    if (Number.isNaN(inMs) || Number.isNaN(outMs)) return null;
    if (outMs < inMs) outMs += DAY_MS; // ran past midnight
    return Math.max(0, outMs - inMs);
}

function computeWorkedMs(attendance, shift, settings) {
    const sessions = allSessions(attendance);
    if (sessions.length === 0) return 0;

    let totalMs = 0;
    for (const s of sessions) {
        totalMs += computeSessionWorkMs(s, attendance, shift) || 0;
    }

    return Math.max(0, totalMs - lunchDeductionMs(attendance, settings, shift, totalMs));
}

/**
 * The day's lunch policy, resolved once.
 *
 * Precedence: the SHIFT's own `lunch` block wins, except when its mode is
 * `inherit` (the default), in which case the tenant-wide
 * `Settings.attendance.minLunch` applies under the original rule. This is the
 * only function allowed to decide that, so the deduction and the Full-Day bar
 * can never disagree about how long lunch is -- they did once, and the bar
 * became unreachable by construction.
 *
 * Returns a normalised shape, never null:
 *   { mode, windowStart, windowEnd, durationMs, minMs, maxMs }
 */
function resolveLunchPolicy(shift, settings) {
    const cfg = settings?.attendance || {};

    // An explicit tenant-level switch still overrides everything: if lunch is
    // not deducted at all, no shift may reintroduce it.
    if (cfg.halfDayRules && cfg.halfDayRules.deductLunch === false) {
        return { mode: 'none', windowStart: null, windowEnd: null, durationMs: 0, minMs: 0, maxMs: null };
    }

    const L = shift?.lunch || {};
    const mode = L.mode || 'inherit';
    const mins = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) * 60 * 1000 : null);

    if (mode === 'none') {
        return { mode: 'none', windowStart: null, windowEnd: null, durationMs: 0, minMs: 0, maxMs: null };
    }

    if (mode === 'fixed_window') {
        // A window with no times is a half-finished configuration, not a
        // policy. Falling through to `inherit` keeps the day payable rather
        // than silently deducting nothing (or everything).
        if (!L.startTime || !L.endTime) {
            return { mode: 'inherit', windowStart: null, windowEnd: null, durationMs: mins(cfg.minLunch) || 0, minMs: 0, maxMs: null };
        }
        return {
            mode: 'fixed_window',
            windowStart: L.startTime,
            windowEnd: L.endTime,
            durationMs: null,
            minMs: 0,
            maxMs: null,
        };
    }

    if (mode === 'fixed_duration') {
        const d = mins(L.durationMins);
        if (d === null) {
            return { mode: 'inherit', windowStart: null, windowEnd: null, durationMs: mins(cfg.minLunch) || 0, minMs: 0, maxMs: null };
        }
        return { mode: 'fixed_duration', windowStart: null, windowEnd: null, durationMs: d, minMs: 0, maxMs: null };
    }

    if (mode === 'from_punches') {
        return {
            mode: 'from_punches',
            windowStart: null,
            windowEnd: null,
            durationMs: null,
            minMs: mins(L.minMins) || 0,
            maxMs: mins(L.maxMins),
        };
    }

    return {
        mode: 'inherit',
        windowStart: null,
        windowEnd: null,
        durationMs: mins(cfg.minLunch) || 0,
        minMs: 0,
        maxMs: null,
    };
}

/** Milliseconds of `[fromMs,toMs)` that fall inside any worked session. */
function presenceOverlapMs(attendance, shift, fromMs, toMs) {
    if (fromMs === null || toMs === null || toMs <= fromMs) return 0;
    let overlap = 0;
    for (const sess of allSessions(attendance)) {
        if (!sess?.punchIn || !sess?.punchOut) continue;
        let a = new Date(sess.punchIn).getTime();
        let b = new Date(sess.punchOut).getTime();
        if (Number.isNaN(a) || Number.isNaN(b)) continue;
        if (b < a) b += DAY_MS;
        overlap += Math.max(0, Math.min(b, toMs) - Math.max(a, fromMs));
    }
    return overlap;
}

/**
 * The lunch a SCHEDULE implies, independent of what anyone punched.
 *
 * This is what the Full-Day bar must subtract from the shift span: an employee
 * present for the whole shift has to be able to reach Full Day, so the bar and
 * the deduction have to be computed from the same policy.
 */
function scheduledLunchMs(shift, settings, referenceDate = new Date()) {
    const p = resolveLunchPolicy(shift, settings);
    if (p.mode === 'none') return 0;
    // Derived from actual punches, so a schedule implies nothing. The floor is
    // conditional on a break being taken, which a schedule cannot know.
    if (p.mode === 'from_punches') return 0;
    if (p.mode === 'fixed_window') {
        const a = shiftTimeOnDate(p.windowStart, referenceDate);
        let b = shiftTimeOnDate(p.windowEnd, referenceDate);
        if (a === null || b === null) return 0;
        if (b <= a) b += DAY_MS;
        return Math.max(0, b - a);
    }
    return p.durationMs || 0;
}

/**
 * Lunch to subtract from a day's worked time.
 *
 * Each mode is a different answer to "was a break taken, and how long":
 *
 *   none           0, always.
 *   from_punches   exactly what was punched; 0 when nothing was. `minMs` lifts
 *                  a mis-tap (a 1-second double press) to a sensible floor but
 *                  ONLY when a lunch was genuinely punched -- the whole point
 *                  of this mode is that it cannot invent a break.
 *   fixed_window   the part of the scheduled window that overlaps real
 *                  presence. Someone who worked 18:00-18:30 against a
 *                  13:00-14:00 window loses nothing, because they were not
 *                  there to take it.
 *   fixed_duration the configured length, punched or not.
 *   inherit        the original tenant rule, `max(punched, minLunch)`: the
 *                  break is scheduled whether or not it is taken in full, and
 *                  a longer one costs its real length.
 *
 * The two degenerate-case guards at the end apply to every mode that deducts
 * without looking at punches, and each was paid for by a real incident.
 */
function lunchDeductionMs(attendance, settings, shift, grossMs = null) {
    const p = resolveLunchPolicy(shift, settings);
    if (p.mode === 'none') return 0;

    const lIn = attendance?.lunchInTime ? new Date(attendance.lunchInTime).getTime() : null;
    const lOut = attendance?.lunchOutTime ? new Date(attendance.lunchOutTime).getTime() : null;
    const punchedMs = lIn !== null && lOut !== null && lOut > lIn ? lOut - lIn : 0;

    if (p.mode === 'from_punches') {
        if (punchedMs <= 0) return 0; // no break punched, nothing to dock
        let ms = Math.max(punchedMs, p.minMs || 0);
        if (p.maxMs !== null) ms = Math.min(ms, p.maxMs);
        return clampLunchToPresence(ms, punchedMs, attendance, shift, grossMs);
    }

    const ref = attendance?.date ? new Date(attendance.date) : new Date();

    if (p.mode === 'fixed_window') {
        const a = shiftTimeOnDate(p.windowStart, ref);
        let b = shiftTimeOnDate(p.windowEnd, ref);
        if (a === null || b === null) return punchedMs;
        if (b <= a) b += DAY_MS;
        // Only what was actually worked through gets taken away. No presence in
        // the window means no break was possible, so nothing is deducted.
        const overlap = presenceOverlapMs(attendance, shift, a, b);
        return clampLunchToPresence(Math.max(overlap, punchedMs), punchedMs, attendance, shift, grossMs);
    }

    // fixed_duration and inherit both deduct a configured length.
    const configuredMs = p.durationMs || 0;
    if (!configuredMs) return punchedMs;
    const base = p.mode === 'fixed_duration' ? configuredMs : Math.max(punchedMs, configuredMs);
    return clampLunchToPresence(base, punchedMs, attendance, shift, grossMs);
}

/**
 * Two guards that stop a scheduled break from exceeding the day it sits in.
 * Both are real incidents, not hypotheticals.
 */
function clampLunchToPresence(candidateMs, punchedMs, attendance, shift, grossMs) {
    if (candidateMs <= 0) return 0;

    // A scheduled break cannot exceed the presence that contains it.
    //
    // Observed 2026-09-15: an employee punched in at 18:16 against a
    // 09:30-18:30 shift, so only 13m31s fell inside the window. The tenant
    // minimum is 30 minutes, so 30 minutes were deducted from 13 -- worked time
    // went negative, clamped to zero, and the day read as though he had done
    // nothing. He was present for every minute the window allowed.
    //
    // Nobody takes a thirty-minute lunch inside a thirteen-minute presence.
    // Fall back to whatever was actually punched, which is normally nothing.
    if (grossMs !== null && Number.isFinite(grossMs) && candidateMs >= grossMs) {
        return Math.min(punchedMs, Math.max(0, grossMs));
    }

    // The configured break cannot apply to a shift too short to contain it.
    //
    // Without this, a 20-minute relief shift under a company-wide 60-minute
    // lunch deducted the full hour from a 20-minute day: worked time came out
    // as zero and the employee was graded ABSENT having worked their entire
    // shift, every time, with nothing in the record explaining why.
    //
    // requiredWorkMs() already recognises this misconfiguration and floors the
    // bar; the deduction has to recognise it too, or the two disagree and the
    // bar becomes unreachable by construction.
    const ref = attendance?.date ? new Date(attendance.date) : new Date();
    const startMs = shiftTimeOnDate(shift?.startTime, ref);
    let endMs = shiftTimeOnDate(shift?.endTime, ref);
    if (startMs !== null && endMs !== null) {
        if (endMs <= startMs) endMs += DAY_MS;
        if (candidateMs >= endMs - startMs) return punchedMs;
    }

    return candidateMs;
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
/**
 * The two grace allowances that widen the Full-Day bar, in ms.
 *
 * Precedence mirrors every other shift-vs-tenant setting here: the SHIFT's own
 * numbers win where it has them, the tenant defaults apply otherwise. The two
 * shift fields are named after what they used to do -- trip an automatic
 * half-day -- and now mean what their values always described: how late an
 * arrival, and how early a departure, the company is willing to absorb.
 *
 * Resolved in one place so the bar cannot disagree with the remarks written
 * beside it. They did disagree: the bar subtracted the tenant's 15-minute
 * `lateGrace` while the half-day trigger used the shift's 5 minutes, so a day
 * could be told it was late and still be measured as though it had 15 minutes
 * in hand.
 */
function resolveGraceMs(shift, settings) {
    const cfg = settings?.attendance || {};
    const mins = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) * 60 * 1000 : 0);

    return {
        inMs: mins(shift?.halfDayLatePunchInMin) || mins(cfg.lateGrace),
        outMs: mins(shift?.halfDayEarlyPunchOutMin) || mins(cfg.earlyGrace),
    };
}

function requiredWorkMs(shift, settings, referenceDate = new Date()) {
    const ref = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
        ? referenceDate
        : new Date();
    const startMs = shiftTimeOnDate(shift?.startTime, ref);
    let endMs = shiftTimeOnDate(shift?.endTime, ref);
    if (startMs === null || endMs === null) return null; // no shift: cannot grade on hours
    if (endMs <= startMs) endMs += DAY_MS;

    const spanMs = endMs - startMs;
    // Same resolver the deduction uses. Reading settings.attendance.minLunch
    // here directly is what let the bar and the deduction disagree.
    const lunchMs = scheduledLunchMs(shift, settings, ref);
    // BOTH ends are forgiven, not just the arrival.
    //
    // A bar of span - lunch - lateGrace says "you may arrive a little late",
    // and then silently requires the employee to stay to the very last second
    // of the shift to make up for it. For a 09:30-18:30 shift with an hour's
    // lunch and 5 minutes either side, Full Day is 7h50m: late by up to five
    // minutes, away up to five minutes early, and the day still counts.
    //
    // Without the second term the bar was 7h55m against a maximum attainable
    // 8h00m, so a 5-minute-late arrival cost half a day's pay no matter how
    // long the employee stayed. Fifty attendance rows across one week produced
    // three Full Days.
    const { inMs, outMs } = resolveGraceMs(shift, settings);

    const required = spanMs - lunchMs - inMs - outMs;
    // Misconfigured shift only — lunch and grace together exceed the shift.
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

    if (workedMs <= 0) {
        // "Nobody came in" and "we could not work out what they did" are
        // different facts, and only the first one is about the employee.
        //
        // A closed day that carries a real punch-in but computes to zero is a
        // MEASUREMENT failure -- a shift window resolved wrongly, a close
        // written at a bad instant, a punch-out that never arrived. Returning
        // 'absent' there books a defect in this code as a day of the
        // employee's pay, silently, with a real punch-in still sitting in the
        // record. Twelve people were marked absent that way.
        //
        // So absence requires the absence of a PUNCH, not the absence of a
        // duration. Anything else goes to a human.
        const punched = allSessions(attendance).some((sess) => sess && sess.punchIn);
        return punched ? 'needs_review' : 'absent';
    }

    // Anchored on the day being graded, not on today. Only the span matters to
    // the bar, so this was invisible for a day shift -- but an overnight shift
    // re-graded on the wrong date resolves its occurrence a day out.
    const sessions = allSessions(attendance);
    const ref = sessions[0]?.punchIn
        ? new Date(sessions[0].punchIn)
        : (attendance?.punchIn ? new Date(attendance.punchIn)
            : (attendance?.date ? new Date(attendance.date) : new Date()));
    const required = requiredWorkMs(shift, settings, ref);

    // No shift means there is nothing to measure against. Grading such a day
    // 'present' regardless of hours is a silent free pass -- 17 active
    // employees currently have no shift -- so say plainly that it could not be
    // graded instead of pretending it passed.
    if (required === null) return 'needs_review';

    return workedMs >= required ? 'present' : 'half-day';
}

/**
 * Has `at` passed the end of the shift occurrence it belongs to?
 *
 * Only ever used to refuse a NEW punch-in. A punch-OUT must always be allowed
 * through: somebody still on the clock at shift end has to be able to close
 * their day, and a guard that blocked them would strand the session for the
 * 04:00 job to clean up -- which is the exact zero-length, `needs_review` row
 * this rule exists to prevent.
 *
 * Returns false when there is no usable shift, so a tenant with no shift
 * configured is never locked out of punching.
 */
function isAfterShiftEnd(shift, at, graceMs = 0) {
    if (!shift?.startTime || !shift?.endTime) return false;
    const when = at ? new Date(at) : new Date();
    if (Number.isNaN(when.getTime())) return false;

    const occ = istShiftOccurrence(shift, when);
    let endMs = occ ? occ.end.getTime() : shiftTimeOnDate(shift.endTime, when);
    if (endMs === null) return false;
    if (!occ) {
        const startMs = shiftTimeOnDate(shift.startTime, when);
        if (startMs !== null && endMs <= startMs) endMs += DAY_MS;
    }
    return when.getTime() > endMs + Math.max(0, graceMs);
}

module.exports = {
    MAX_SESSIONS,
    DAY_MS,
    shiftTimeOnDate,
    allSessions,
    openSessionIndex,
    isDayOpen,
    syncRootPunchOut,
    computeWorkedMs,
    computeSessionWorkMs,
    computeSessionGrossMs,
    shiftWindow,
    lunchDeductionMs,
    resolveLunchPolicy,
    scheduledLunchMs,
    resolveGraceMs,
    requiredWorkMs,
    isAfterShiftEnd,
    gradeDay,
};
