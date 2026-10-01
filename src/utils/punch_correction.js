const { istStartOfDay, istEndOfDay, istDateKey, istTimeOnDate, parseIstWallClock } = require('./attendance_helpers');

// ─────────────────────────────────────────────────────────────────────────────
// "Forgot to punch in / Forgot to punch out" -- the rules for what an EMPLOYEE
// may ask for. Pure: no database, no clock of its own (`now` is passed in), so
// every rule is testable against fabricated days in test/attendance_review.
//
// The product owner's words: "Shift is 9:30. I remember at 10, punch in at 10,
// and raise a ticket 'forgot punch in' with time 9:30." So a punch-in request
// moves the arrival EARLIER, never later, and never before the shift started.
// A punch-out request ends the day after it began and not after the shift
// ended. Nothing here grades or pays -- approval goes through the one
// approveRegularization path, which is the only thing allowed to write.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Minutes since midnight for "H:MM" / "HH:MM", or null. */
function hhmmToMinutes(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
}

/** "9:30 AM" in IST -- the only way a time is ever shown to an employee. */
function fmt12(date) {
    if (!date) return '';
    const s = new Date(new Date(date).getTime() + IST_OFFSET_MS);
    const h = s.getUTCHours();
    const m = s.getUTCMinutes();
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** "26 Sep" in IST. */
function fmtDay(date) {
    return new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}

/** IST midnight of a "YYYY-MM-DD" key, or null for anything that is not a real date. */
function dayFromKey(dayKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey || ''))) return null;
    const d = parseIstWallClock(`${dayKey}T00:00`);
    // Round-trip, so 2026-02-31 is refused rather than rolled into March.
    if (!d || istDateKey(d) !== dayKey) return null;
    return d;
}

/**
 * The shift occurrence FILED UNDER `day` -- the one that starts on that IST
 * day. For a night shift this is how working_day.js files a punch: the 22:00
 * start on the 10th and the 06:00 end on the 11th are both the 10th's row.
 */
function occurrenceOnDay(shift, day) {
    if (!shift || !shift.startTime || !shift.endTime) return null;
    const d = istStartOfDay(day);
    const start = istTimeOnDate(shift.startTime, d);
    let end = istTimeOnDate(shift.endTime, d);
    if (!start || !end) return null;
    const overnight = end.getTime() <= start.getTime();
    if (overnight) end = new Date(end.getTime() + DAY_MS);
    return { start, end, overnight };
}

/**
 * The instant a wall-clock time picked for `dayKey` means.
 *
 * A day shift: that clock time on that day. A night shift (22:00-06:00): the
 * employee picks the shift's DAY and a clock time, and "05:30" means the
 * morning after -- they cannot be expected to pick tomorrow's date for the
 * second half of tonight's shift. The split is the middle of the off-duty gap
 * (14:00 for 22:00-06:00), so a time just before the start still lands on the
 * day and is refused as "before your shift starts" instead of silently
 * becoming tomorrow.
 */
function correctionInstant(dayKey, hhmm, shift) {
    const day = dayFromKey(dayKey);
    const min = hhmmToMinutes(hhmm);
    if (!day || min == null) return null;
    let t = day.getTime() + min * 60 * 1000;
    const occ = occurrenceOnDay(shift, day);
    if (occ && occ.overnight) {
        const startMin = hhmmToMinutes(shift.startTime);
        const endMin = hhmmToMinutes(shift.endTime);
        const offMiddle = endMin + (startMin - endMin) / 2;
        if (min < offMiddle) t += DAY_MS;
    }
    return new Date(t);
}

/**
 * The session a punch-OUT correction is about: the one the system closed at
 * shift end, else the day's latest. Never by array index -- shifts[] is not
 * stored in chronological order. Shared with approveRegularization so the rule
 * checked when the request is made is the rule applied when it is approved.
 * Returns the real element (not a copy), so the caller may mutate it.
 */
function punchOutTarget(attendance) {
    const sessions = (attendance && attendance.shifts) || [];
    return sessions.filter((s) => s && s.punchIn).sort((a, b) => {
        const aSys = a.closeReason === 'shift_end' ? 1 : 0;
        const bSys = b.closeReason === 'shift_end' ? 1 : 0;
        if (aSys !== bSys) return bSys - aSys;
        return new Date(b.punchOut || b.punchIn) - new Date(a.punchOut || a.punchIn);
    })[0] || null;
}

/** What the day's punch-out currently says (the target session's, else the root's). */
function recordedPunchOut(attendance) {
    const t = punchOutTarget(attendance);
    return (t && t.punchOut) || (attendance && attendance.punchOut) || null;
}

/** Oldest and newest day an employee may ask about. Null when `day` is allowed. */
function windowProblem(day, now, windowDays) {
    const days = Number(windowDays) > 0 ? Number(windowDays) : 7;
    const earliest = istStartOfDay(new Date(now.getTime() - (days - 1) * DAY_MS));
    if (day.getTime() > istEndOfDay(now).getTime()) return 'You cannot pick a day in the future.';
    if (day.getTime() < earliest.getTime()) {
        return `You can only fix the last ${days} days. For an older day, please ask your admin.`;
    }
    return null;
}

/**
 * Is this request allowed? Returns a plain-language reason when it is not,
 * or null when it is.
 *
 * @param {'punchIn'|'punchOut'} field
 * @param {Date} requested   the instant asked for (see correctionInstant)
 * @param {object} attendance the day's row (punchIn, punchOut, shifts, lunch*, date)
 * @param {object|null} shift the employee's shift; none means no shift bound
 * @param {Date} now
 */
function correctionProblem({ field, requested, attendance, shift, now }) {
    if (!(requested instanceof Date) || Number.isNaN(requested.getTime())) return 'Please pick a time.';
    if (!attendance) return 'There is no attendance on this day to correct. Please ask your admin to add it.';
    if (requested.getTime() > now.getTime() + 60 * 1000) {
        return 'That time has not come yet. Please pick a time that has already passed.';
    }

    const occ = occurrenceOnDay(shift, attendance.date);
    const recordedIn = attendance.punchIn ? new Date(attendance.punchIn) : null;

    if (field === 'punchIn') {
        if (!recordedIn) return 'There is no punch-in on this day to correct. Please ask your admin to add it.';
        if (requested.getTime() >= recordedIn.getTime()) {
            return `Please pick a time before your punch-in (${fmt12(recordedIn)}).`;
        }
        if (occ && requested.getTime() < occ.start.getTime()) {
            return `Your shift starts at ${fmt12(occ.start)}. You cannot ask for a punch-in before that.`;
        }
        if (!occ && requested.getTime() < istStartOfDay(attendance.date).getTime()) {
            return 'Please pick a time on the same day.';
        }
        return null;
    }

    if (field === 'punchOut') {
        if (!recordedIn) return 'There is no punch-in on this day, so a punch-out cannot be added. Please ask your admin.';
        const target = punchOutTarget(attendance);
        const after = target && target.punchIn ? new Date(target.punchIn) : recordedIn;
        if (requested.getTime() <= after.getTime()) {
            return `Please pick a time after you punched in (${fmt12(after)}).`;
        }
        const lunchBack = attendance.lunchOutTime ? new Date(attendance.lunchOutTime) : null;
        if (lunchBack && lunchBack.getTime() > after.getTime() && requested.getTime() <= lunchBack.getTime()) {
            return `Please pick a time after your lunch break ended (${fmt12(lunchBack)}).`;
        }
        if (occ && requested.getTime() > occ.end.getTime()) {
            return `Your shift ends at ${fmt12(occ.end)}. You cannot ask for a punch-out after that.`;
        }
        if (!occ && requested.getTime() > istEndOfDay(attendance.date).getTime()) {
            return 'Please pick a time on the same day.';
        }
        const recOut = recordedPunchOut(attendance);
        if (recOut && Math.abs(new Date(recOut).getTime() - requested.getTime()) < 60 * 1000) {
            return `Your punch-out is already ${fmt12(recOut)}.`;
        }
        return null;
    }

    return 'Please choose what you forgot.';
}

/**
 * The latest instant a correction on `day` may land on. The day itself, or for
 * a night shift the end of the occurrence plus the late punch-out margin, so a
 * 05:30 punch-out for the 10th's 22:00-06:00 shift (which is on the 11th) is
 * not refused as "not on the 10th".
 */
function correctionDayEnd(day, shift, lateMarginMs = 0) {
    const dayEnd = istEndOfDay(day);
    const occ = occurrenceOnDay(shift, day);
    if (!occ || !occ.overnight) return dayEnd;
    return new Date(Math.max(dayEnd.getTime(), occ.end.getTime() + lateMarginMs));
}

module.exports = {
    hhmmToMinutes,
    fmt12,
    fmtDay,
    dayFromKey,
    occurrenceOnDay,
    correctionInstant,
    punchOutTarget,
    recordedPunchOut,
    windowProblem,
    correctionProblem,
    correctionDayEnd,
};
