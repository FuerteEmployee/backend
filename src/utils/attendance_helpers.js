const DAY_LABELS = { 
  M: "Monday", T: "Tuesday", W: "Wednesday", 
  Th: "Thursday", F: "Friday", Sa: "Saturday", Su: "Sunday" 
};

/**
 * Determines if a given day is a weekly off for an employee.
 * Priority: employee's own weeklyHolidays override, then their shift's
 * per-shift workDays (e.g. a night-shift crew working Tue-Sat), then the
 * tenant-wide Settings.attendance.workDays default.
 */
const isWeeklyOff = (dayName, dateDay, weeklyHolidays, globalWorkDays, shiftWorkDays) => {
  const weekNum = Math.ceil(dateDay / 7);

  if (weeklyHolidays && weeklyHolidays.length > 0) {
    return weeklyHolidays.some(h =>
      h.day === dayName && (h.weeks.length === 0 || h.weeks.includes(weekNum))
    );
  }

  const activeWorkDays = (shiftWorkDays && shiftWorkDays.length > 0)
    ? shiftWorkDays
    : (globalWorkDays || ['M', 'T', 'W', 'Th', 'F']);
  const offDays = Object.keys(DAY_LABELS)
    .filter(k => !activeWorkDays.includes(k))
    .map(k => DAY_LABELS[k]);

  return offDays.includes(dayName);
};

/**
 * Local-time YYYY-MM-DD key. Using toISOString() keys days in UTC, which on an
 * IST (UTC+5:30) server rolls near-midnight timestamps to the wrong day and
 * misaligns attendance vs the day-by-day classification window. Always key days
 * with this helper when the payroll engine relies on day alignment.
 */
const toLocalDateKey = (date) => {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * IST midnight for the given instant, as a real UTC Date — independent of
 * the server process's own OS/system timezone. `new Date(); setHours(0,0,0,0)`
 * zeroes the hour in whatever timezone the process happens to be running in;
 * on a UTC-timezone server (common for cloud VMs) that's UTC midnight, not
 * IST midnight, and worse, it can silently disagree with itself across
 * restarts/deploys if that effective timezone ever changes — producing two
 * different "day" keys for what a human considers the same day (seen in
 * practice: duplicate Attendance docs for the same employee+day).
 */
const istStartOfDay = (date = new Date()) => {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
};

const istEndOfDay = (date = new Date()) => {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(23, 59, 59, 999);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
};

/**
 * 'YYYY-MM-DD' key for the IST calendar day a real timestamp falls on —
 * e.g. an Attendance record's `date`/`punchIn`, which is stored as an IST
 * midnight instant. Unlike `toLocalDateKey` (which reads Y/M/D via the
 * server process's own timezone), this always resolves to the IST day
 * regardless of server locale. Use this — not `toLocalDateKey` — whenever
 * you're deriving a day key from an actual stored timestamp; `toLocalDateKey`
 * remains correct for pure calendar-iteration placeholders (`new Date(y,m,d)`)
 * that were never meant to represent a specific real-world instant.
 */
const istDateKey = (date = new Date()) => {
  const shifted = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/**
 * A plain JS Date anchored at local noon for the IST calendar day a real
 * timestamp falls on — safe to feed into `.getDate()`/`.toLocaleDateString()`
 * for weekday/day-of-month lookups without re-hitting the same midnight-
 * boundary timezone bug `istDateKey` exists to avoid.
 */
const istCalendarDate = (date = new Date()) => {
  const [y, m, d] = istDateKey(date).split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};

/**
 * Resolve a shift's "HH:mm" wall-clock time (always IST — these deployments
 * are IST-only) to a real UTC instant, on the IST calendar day `referenceDate`
 * falls on. Built the same way `parseDeviceTimestamp` builds a device
 * timestamp: from IST parts via `Date.UTC` minus the IST offset, so the result
 * is independent of the server process's own OS/system timezone.
 *
 * This replaces the `new Date(referenceDate); d.setHours(hh, mm, 0, 0)` pattern
 * used to appear at every shift-boundary check in this codebase (late check,
 * half-day cutoffs, auto-close, day grading). `setHours` reads/writes the wall
 * clock in whatever timezone the *process* happens to be running in — correct
 * on an IST dev machine, silently wrong by ~5:30 (and often a whole calendar
 * day, near midnight) on a UTC cloud server. That mismatch graded real,
 * fully-worked days as Absent in production while looking fine locally.
 */
const shiftTimeOnDate = (hhmm, referenceDate) => {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = istDateKey(referenceDate).split('-').map(Number);
  const utcMs = Date.UTC(y, mo - 1, d, Number(m[1]), Number(m[2]), 0, 0) - IST_OFFSET_MS;
  return new Date(utcMs);
};

/**
 * "HH:mm" clock arithmetic for display only (e.g. "this cutoff was 09:00 plus
 * 30 minutes late-grace, i.e. 09:30") — pure minute math, no Date/timezone
 * involved at all, so there's nothing here for a server timezone to get wrong.
 */
const clockStringAfter = (hhmm, offsetMinutes) => {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return hhmm;
  const total = (((Number(m[1]) * 60 + Number(m[2]) + offsetMinutes) % 1440) + 1440) % 1440;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

/**
 * Rounds a punch timestamp to the nearest `intervalMinutes` boundary, per
 * settings.attendance.roundingInterval/roundingDirection — e.g. a 15-minute
 * "nearest" rule turns a 09:07 punch-in into 09:00 before it feeds into the
 * late-check/half-day/payroll math, so employees aren't penalised (or paid)
 * for minute-level punch noise. A 0/unset interval means rounding is off.
 */
const roundPunchTime = (date, intervalMinutes, direction = 'nearest') => {
  if (!date || !intervalMinutes) return date;
  const ms = intervalMinutes * 60 * 1000;
  const t = new Date(date).getTime();
  if (direction === 'up') return new Date(Math.ceil(t / ms) * ms);
  if (direction === 'down') return new Date(Math.floor(t / ms) * ms);
  return new Date(Math.round(t / ms) * ms);
};

/**
 * Applies settings.attendance's rounding config to a punch timestamp, but
 * only when `label` (e.g. 'Punch In') is in the admin's chosen
 * `roundingAppliedTo` list. Returns the original date untouched otherwise.
 */
const applyPunchRounding = (date, label, settings) => {
  const cfg = settings?.attendance;
  if (!cfg?.roundingInterval || !cfg?.roundingAppliedTo?.includes(label)) return date;
  return roundPunchTime(date, cfg.roundingInterval, cfg.roundingDirection);
};

/**
 * Was a punch-in late relative to the employee's shift + grace period?
 * Parameterized on punchInDate (not `now`) so it can also validate a
 * requested/corrected time during regularization approval.
 */
const isLatePunchIn = (punchInDate, shift, settings) => {
  if (!shift || !shift.startTime || !punchInDate) return false;
  const graceMinutes = settings?.attendance?.lateGrace ?? 15;

  const shiftStart = shiftTimeOnDate(shift.startTime, punchInDate);
  if (!shiftStart) return false;
  const shiftTime = new Date(shiftStart.getTime() + graceMinutes * 60 * 1000);

  return new Date(punchInDate) > shiftTime;
};

/**
 * Applies the configurable half-day rules (time-based / duration-based / both)
 * to decide the final attendance status for a completed day. Shared by the
 * live punch-out flow and regularization approval so both paths agree.
 */
const determineHalfDayStatus = ({ punchIn, punchOut, totalWorkMs, lunchInTime, lunchOutTime, isWFH, shift }, settings) => {
  const hdr = settings?.attendance?.halfDayRules || {};
  const hdDeductLunch = hdr.deductLunch !== false; // default true

  // Net worked time (ms). Falls back to a raw punchOut-punchIn diff if no totalWorkMs was tracked.
  let netWorkMs = totalWorkMs || (punchIn && punchOut ? (new Date(punchOut) - new Date(punchIn)) : 0);
  if (hdDeductLunch && lunchInTime && lunchOutTime) {
    const lunchMs = new Date(lunchOutTime) - new Date(lunchInTime);
    if (lunchMs > 0) netWorkMs = Math.max(0, netWorkMs - lunchMs);
  }
  const netWorkHours = netWorkMs / (1000 * 60 * 60);

  let isHalfDay = false;
  const remarkParts = [];

  let hasShiftRules = false;
  if (shift && (shift.halfDayLatePunchInMin || shift.halfDayEarlyPunchOutMin)) {
    hasShiftRules = true;

    if (shift.halfDayLatePunchInMin && punchIn) {
      const shiftStart = shiftTimeOnDate(shift.startTime, punchIn);
      const halfDayPunchInCutoff = new Date(shiftStart.getTime() + shift.halfDayLatePunchInMin * 60 * 1000);
      if (new Date(punchIn) > halfDayPunchInCutoff) {
        isHalfDay = true;
        const cutoffTimeStr = clockStringAfter(shift.startTime, shift.halfDayLatePunchInMin);
        remarkParts.push(`Late punch-in for shift (after ${cutoffTimeStr})`);
      }
    }

    if (shift.halfDayEarlyPunchOutMin && punchIn && punchOut) {
      const shiftStart = shiftTimeOnDate(shift.startTime, punchIn);
      let shiftEnd = shiftTimeOnDate(shift.endTime, punchIn);
      if (shiftEnd < shiftStart) {
        shiftEnd = new Date(shiftEnd.getTime() + 24 * 60 * 60 * 1000);
      }

      const halfDayPunchOutCutoff = new Date(shiftEnd.getTime() - shift.halfDayEarlyPunchOutMin * 60 * 1000);

      if (new Date(punchOut) < halfDayPunchOutCutoff) {
        isHalfDay = true;
        const cutoffTimeStr = clockStringAfter(shift.endTime, -shift.halfDayEarlyPunchOutMin);
        remarkParts.push(`Early punch-out for shift (before ${cutoffTimeStr})`);
      }
    }
  }

  if (!hasShiftRules) {
    const hdMethod = hdr.method || 'durationBased';
    const hdBothLogic = hdr.bothLogic || 'or';
    const hdCutoff = hdr.cutoffTime || '09:35';
    const hdMinHours = hdr.minHours != null ? hdr.minHours : (settings?.attendance?.halfDayHours ?? 4);

    // Time-based: punch-in strictly after cutoffTime = late arrival.
    // Grace rule: 09:35:00 is still on time; 09:35:01 is late.
    let isLateArrival = false;
    if (punchIn) {
      const [cutH, cutM] = hdCutoff.split(':').map(Number);
      const pi = new Date(punchIn);
      const piMins = pi.getHours() * 60 + pi.getMinutes();
      const piSecs = pi.getSeconds();
      const cutMins = cutH * 60 + cutM;
      isLateArrival = piMins > cutMins || (piMins === cutMins && piSecs > 0);
    }

    // Duration-based: net hours below minimum = short day.
    const isShortDay = netWorkHours < hdMinHours;

    if (hdMethod === 'timeBased') {
      isHalfDay = isLateArrival;
    } else if (hdMethod === 'durationBased') {
      isHalfDay = isShortDay;
    } else { // 'both'
      isHalfDay = hdBothLogic === 'or' ? (isLateArrival || isShortDay) : (isLateArrival && isShortDay);
    }

    if (isLateArrival && (hdMethod !== 'durationBased')) remarkParts.push(`Late arrival (after ${hdCutoff})`);
    if (isShortDay && (hdMethod !== 'timeBased')) remarkParts.push(`Short hours (${netWorkHours.toFixed(2)}h < ${hdMinHours}h)`);
  }

  let status;
  if (isHalfDay) {
    status = 'half-day';
  } else if (isWFH) {
    status = 'wfh'; // keep WFH bucket, don't collapse to 'present'
  } else {
    status = 'present';
  }

  return {
    status,
    netWorkHours,
    remarksAppend: remarkParts.length ? ` | ${remarkParts.join('; ')}` : '',
  };
};

/**
 * Parses a biometric terminal's own timestamp ("YYYY-MM-DD HH:MM:SS", as sent
 * in each tab-separated ATTLOG line) into a real Date.
 *
 * The device reports wall-clock time in its configured timezone — IST for these
 * deployments — with no offset marker. `new Date("2026-09-10 09:30:12")` would
 * interpret that in the *server* process's timezone, so the same string becomes
 * a different instant on a UTC cloud VM than on an IST laptop. Building it
 * explicitly from IST is what makes the parse independent of where the server
 * happens to run, exactly like istDateKey.
 *
 * Returns null for anything unparseable, and for timestamps absurdly far from
 * now (a terminal whose clock was never set reports years like 2000), so a bad
 * device clock degrades to "no tap time" rather than writing a punch into the
 * distant past.
 */
const MAX_TAP_DRIFT_MS = 7 * 24 * 60 * 60 * 1000;

const parseDeviceTimestamp = (raw, now = new Date(), offsetMinutes = 0) => {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;

  const [, y, mo, d, h, mi, s] = m;
  const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  if (Number.isNaN(utcMs)) return null;

  // Per-device correction for a terminal whose timezone is set wrong. Always an
  // explicit, stored value (Device.clockOffsetMinutes) -- never inferred here,
  // so that fixing the device on site does not start double-correcting.
  const correctionMs = (Number(offsetMinutes) || 0) * 60 * 1000;
  const parsed = new Date(utcMs - IST_OFFSET_MS + correctionMs);
  if (Math.abs(parsed.getTime() - now.getTime()) > MAX_TAP_DRIFT_MS) return null;

  return parsed;
};

module.exports = { DAY_LABELS, isWeeklyOff, toLocalDateKey, isLatePunchIn, determineHalfDayStatus, istStartOfDay, istEndOfDay, istDateKey, istCalendarDate, shiftTimeOnDate, clockStringAfter, roundPunchTime, applyPunchRounding, parseDeviceTimestamp, MAX_TAP_DRIFT_MS };
