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
 * The instant of "HH:mm" IST on the IST calendar day containing `refDate`,
 * optionally offset by extra minutes.
 *
 * Every shift boundary in this file used to be built with `d.setHours(h, m)`,
 * which resolves in the HOST timezone. Production runs on a UTC box, so a
 * shift starting "07:45" resolved to 07:45 UTC = 13:15 IST -- five and a half
 * hours after everyone had already arrived. The consequence was silent and
 * total: `isLatePunchIn` compared a real 07:50 IST arrival against a 13:15 IST
 * cutoff and said "on time", so NOBODY could ever be marked late, and the
 * half-day arrival and early-departure cutoffs were wrong by the same offset.
 *
 * Nothing here reads the host clock.
 */
const istTimeOnDate = (hhmm, refDate, extraMinutes = 0) => {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const ref = new Date(refDate);
  if (Number.isNaN(ref.getTime())) return null;

  const shifted = new Date(ref.getTime() + IST_OFFSET_MS);
  const istMidnightMs = Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(),
  ) - IST_OFFSET_MS;

  return new Date(istMidnightMs + (Number(m[1]) * 60 + Number(m[2]) + Number(extraMinutes || 0)) * 60 * 1000);
};

/** Minutes since IST midnight for an instant. */
const istMinutesOfDay = (date) => {
  const s = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return s.getUTCHours() * 60 + s.getUTCMinutes();
};

/** Seconds-within-the-minute of an instant, in IST. */
const istSecondsOfMinute = (date) => new Date(new Date(date).getTime() + IST_OFFSET_MS).getUTCSeconds();

/**
 * The start and end instants of the shift OCCURRENCE that `refDate` belongs to.
 *
 * For a day shift this is simply start and end on refDate's own IST day. An
 * OVERNIGHT shift (end <= start) is the interesting case: the occurrence may
 * have begun the PREVIOUS day. Somebody punching in at 01:00 against a
 * 22:00-06:00 shift is three hours late for last night's shift, not twenty-one
 * hours early for tonight's — and every rule built on that boundary (late
 * arrival, half-day cutoffs, the close time for a forgotten punch-out) gets the
 * wrong answer if it anchors to the punch's own calendar day.
 *
 * Returns null when the shift has no usable times.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

const istShiftOccurrence = (shift, refDate) => {
  if (!shift || !shift.startTime || !shift.endTime) return null;
  const start = istTimeOnDate(shift.startTime, refDate);
  let end = istTimeOnDate(shift.endTime, refDate);
  if (!start || !end) return null;

  const overnight = end.getTime() <= start.getTime();
  if (!overnight) return { start, end, overnight: false };

  end = new Date(end.getTime() + DAY_MS);

  // If the reference instant falls before the end of the occurrence that
  // started YESTERDAY, it belongs to that one.
  const prevEnd = new Date(end.getTime() - DAY_MS);
  if (new Date(refDate).getTime() < prevEnd.getTime()) {
    return { start: new Date(start.getTime() - DAY_MS), end: prevEnd, overnight: true };
  }
  return { start, end, overnight: true };
};

/** "HH:MM" in IST, for displaying a cutoff back to the employee. */
const istHHMM = (date) => {
  const s = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return `${String(s.getUTCHours()).padStart(2, '0')}:${String(s.getUTCMinutes()).padStart(2, '0')}`;
};

/**
 * Was a punch-in late relative to the employee's shift + grace period?
 * Parameterized on punchInDate (not `now`) so it can also validate a
 * requested/corrected time during regularization approval.
 */
const isLatePunchIn = (punchInDate, shift, settings) => {
  if (!shift || !shift.startTime || !punchInDate) return false;

  // The SHIFT's own grace decides, and the tenant value applies only where the
  // shift sets none. Same resolver, and therefore the same number, the Full Day
  // bar is built from.
  //
  // This read `settings.attendance.lateGrace` unconditionally. With a 5-minute
  // shift grace and a 15-minute tenant grace, a 09:40 arrival was 5 minutes
  // short of a Full Day and simultaneously "on time" -- the badge an admin
  // reads disagreed with the maths that set the pay, between 09:35 and 09:45.
  //
  // Lazy require: shift_status requires this file, so a top-level require back
  // would be a load-time cycle. See determineHalfDayStatus for the same note.
  const { resolveGraceMs } = require('./shift_status');
  const graceMinutes = resolveGraceMs(shift, settings).inMs / 60000;

  // Overnight-aware: a 01:00 arrival against a 22:00-06:00 shift is late for
  // LAST NIGHT'S occurrence, which began at 22:00 yesterday.
  const occ = istShiftOccurrence(shift, punchInDate);
  const shiftTime = occ
    ? new Date(occ.start.getTime() + graceMinutes * 60 * 1000)
    : istTimeOnDate(shift.startTime, punchInDate, graceMinutes);
  if (!shiftTime) return false;

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

  // Lazy, to keep the static require graph acyclic: shift_status requires THIS
  // file, so a top-level require back would be a load-time cycle. Resolved at
  // call time, which is after both modules are fully loaded.
  const { requiredWorkMs } = require('./shift_status');

  // Net worked time (ms).
  //
  // `totalWorkMs` arrives ALREADY net of lunch -- computeWorkedMs subtracted it
  // under the day's resolved policy before this was ever called. Deducting the
  // punched break again here charged it twice: one real day carried 7.74h in
  // the record and reported 7.61h out of this function, and the 7.61h was what
  // the punch-out response showed the employee and what the half-day test then
  // measured. The second deduction only ever belonged to the FALLBACK below,
  // which is a raw out-minus-in with no policy applied at all.
  let netWorkMs = totalWorkMs;
  if (!netWorkMs) {
    netWorkMs = punchIn && punchOut ? (new Date(punchOut) - new Date(punchIn)) : 0;
    if (hdDeductLunch && lunchInTime && lunchOutTime) {
      const lunchMs = new Date(lunchOutTime) - new Date(lunchInTime);
      if (lunchMs > 0) netWorkMs = Math.max(0, netWorkMs - lunchMs);
    }
  }
  const netWorkHours = netWorkMs / (1000 * 60 * 60);

  let isHalfDay = false;
  const remarkParts = [];

  // A shift carrying grace figures is graded on HOURS, against a bar built
  // from its own schedule.
  //
  //     required = shift span - scheduled lunch - grace in - grace out
  //     09:30-18:30, 1h lunch, 5m + 5m  ->  7h50m for a Full Day
  //
  // These two fields used to trip an automatic half-day on their own: a punch
  // at 09:35:01 was half a day's pay however long the employee then stayed.
  // One employee worked 09:44 to 19:21 -- 7.76 net hours against a shift worth
  // 8.00 -- and was paid half. Across one week, fifty attendance rows produced
  // three Full Days and no way for anyone to earn a fourth.
  //
  // The times still MATTER; they set how wide the bar is. What they no longer
  // do is decide the day by themselves, so arriving five minutes late and
  // staying five minutes longer now costs nothing, which is what an admin
  // setting "5 minutes' grace" believes they have configured.
  let hasShiftRules = false;
  if (shift && (shift.halfDayLatePunchInMin || shift.halfDayEarlyPunchOutMin)) {
    hasShiftRules = true;

    const requiredMs = requiredWorkMs(shift, settings, punchIn ? new Date(punchIn) : new Date());
    if (requiredMs === null) {
      // Grace figures set on a shift with no usable start/end. Nothing to
      // measure against, so fall through to the company rules below rather
      // than passing or failing the day on a bar that does not exist.
      hasShiftRules = false;
    } else {
      isHalfDay = netWorkMs < requiredMs;
      if (isHalfDay) {
        const fmt = (ms) => `${Math.floor(ms / 3600000)}h ${String(Math.round((ms % 3600000) / 60000)).padStart(2, '0')}m`;
        remarkParts.push(`Short hours for shift (${fmt(netWorkMs)} of ${fmt(requiredMs)})`);
      }

      // Kept as context, never as a verdict. An admin looking at a half-day
      // still wants to see that it began with a late arrival.
      if (shift.halfDayLatePunchInMin && punchIn) {
        const inOcc = istShiftOccurrence(shift, punchIn);
        const lateCutoff = inOcc
          ? new Date(inOcc.start.getTime() + shift.halfDayLatePunchInMin * 60 * 1000)
          : istTimeOnDate(shift.startTime, punchIn, shift.halfDayLatePunchInMin);
        if (lateCutoff && new Date(punchIn) > lateCutoff) {
          remarkParts.push(`Late punch-in for shift (after ${istHHMM(lateCutoff)})`);
        }
      }

      if (shift.halfDayEarlyPunchOutMin && punchIn && punchOut) {
        // Resolved as one occurrence so an overnight shift's end lands on the
        // correct day relative to the punch that is being judged.
        const outOcc = istShiftOccurrence(shift, punchIn);
        const earlyCutoff = outOcc
          ? new Date(outOcc.end.getTime() - shift.halfDayEarlyPunchOutMin * 60 * 1000)
          : null;
        if (earlyCutoff && new Date(punchOut) < earlyCutoff) {
          remarkParts.push(`Early punch-out for shift (before ${istHHMM(earlyCutoff)})`);
        }
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
      const piMins = istMinutesOfDay(punchIn);
      const piSecs = istSecondsOfMinute(punchIn);
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
 * Fragments this module generates, so a re-grade can replace them.
 *
 * Every one describes the day AS MEASURED AT THE MOMENT IT WAS WRITTEN, and a
 * day gets measured several times -- once per session close, again when the
 * 04:00 job or the geofence engine closes a forgotten punch, again on a
 * regularization. The appenders only guarded against writing the SAME sentence
 * twice, so a superseded one simply stayed.
 *
 * Observed 2026-09-18: an employee closed a session at 17:15, earning
 * "Early punch-out for shift (before 18:25)", then punched straight back in and
 * worked to 18:30. The day was no longer an early finish, the status was
 * re-derived correctly -- and the remark still said it was, which is the line
 * an admin reads when deciding whether to trust the row.
 */
const GRADING_REMARK_PATTERNS = [
  /^Short hours for shift \(/i,
  /^Late punch-in for shift \(/i,
  /^Early punch-out for shift \(/i,
  /^Late arrival \(after /i,
  /^Short hours \(/i,
  /^Short hours across sessions$/i,
];

/**
 * Drop every previously-generated grading fragment, keeping everything a human
 * or another subsystem wrote ('Work From Home', 'Auto punch-out (left branch
 * geo-fence)', an admin's note). Order of the survivors is preserved, because
 * the fragments read as a narrative of the day.
 */
const stripGradingRemarks = (remarks) => {
  if (typeof remarks !== 'string' || !remarks) return '';
  return remarks
    .split('|')
    .map((frag) => frag.trim())
    .filter((frag) => frag && !GRADING_REMARK_PATTERNS.some((re) => re.test(frag)))
    .join(' | ');
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
/**
 * Parse a wall-clock string from a client as IST.
 *
 * An `<input type="datetime-local">` submits "2026-09-16T00:00" -- a wall clock
 * with NO timezone. ECMAScript resolves that form against the *host's* local
 * time, so handing it to `new Date()` (or letting Mongoose cast it) means the
 * stored instant depends on the server's timezone. Production runs with TZ
 * unset, i.e. UTC, so "18:30" from a user in India was stored as 18:30Z --
 * 00:00 IST the next morning. Three regularization requests pending on
 * 2026-09-17 carried a punch-out on the day AFTER the day they corrected.
 *
 * Every user of this product is in IST, so a bare wall clock means IST and
 * nothing else. A value that already carries an offset or a trailing Z is a
 * real instant and is passed through untouched.
 *
 * Returns null for anything unparseable, so callers can reject explicitly
 * rather than storing an Invalid Date.
 */
const parseIstWallClock = (value) => {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value !== 'string' || !value.trim()) return null;

    const raw = value.trim();
    // Already an instant: ...Z, +05:30, -0800.
    if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) {
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    const [, y, mo, da, h, mi, se] = m;
    // Build the instant via UTC then shift back by the IST offset, so the
    // result is independent of the host timezone.
    const asUtc = Date.UTC(+y, +mo - 1, +da, +h, +mi, se ? +se : 0, 0);
    return new Date(asUtc - IST_OFFSET_MS);
};

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

module.exports = { DAY_LABELS, isWeeklyOff, toLocalDateKey, parseIstWallClock, isLatePunchIn, determineHalfDayStatus, stripGradingRemarks, istStartOfDay, istEndOfDay, istDateKey, istCalendarDate, istTimeOnDate, istShiftOccurrence, istMinutesOfDay, istSecondsOfMinute, istHHMM, roundPunchTime, applyPunchRounding, parseDeviceTimestamp, MAX_TAP_DRIFT_MS };
