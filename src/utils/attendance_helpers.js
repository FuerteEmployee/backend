const DAY_LABELS = { 
  M: "Monday", T: "Tuesday", W: "Wednesday", 
  Th: "Thursday", F: "Friday", Sa: "Saturday", Su: "Sunday" 
};

/**
 * Determines if a given day is a weekly off for an employee.
 * Logic: Priority to User's weeklyHolidays, fallback to Settings' workDays.
 */
const isWeeklyOff = (dayName, dateDay, weeklyHolidays, globalWorkDays) => {
  const weekNum = Math.ceil(dateDay / 7);
  
  if (weeklyHolidays && weeklyHolidays.length > 0) {
    return weeklyHolidays.some(h => 
      h.day === dayName && (h.weeks.length === 0 || h.weeks.includes(weekNum))
    );
  }
  
  // Fallback to global settings
  const activeWorkDays = globalWorkDays || ['M', 'T', 'W', 'Th', 'F'];
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

/**
 * Was a punch-in late relative to the employee's shift + grace period?
 * Parameterized on punchInDate (not `now`) so it can also validate a
 * requested/corrected time during regularization approval.
 */
const isLatePunchIn = (punchInDate, shift, settings) => {
  if (!shift || !shift.startTime || !punchInDate) return false;
  const [sHour, sMinute] = shift.startTime.split(':').map(Number);
  const graceMinutes = settings?.attendance?.lateGrace ?? 15;

  const shiftTime = new Date(punchInDate);
  shiftTime.setHours(sHour, sMinute + graceMinutes, 0, 0);

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
      const [sHour, sMinute] = shift.startTime.split(':').map(Number);
      const halfDayPunchInCutoff = new Date(punchIn);
      halfDayPunchInCutoff.setHours(sHour, sMinute + shift.halfDayLatePunchInMin, 0, 0);
      if (new Date(punchIn) > halfDayPunchInCutoff) {
        isHalfDay = true;
        const cutoffTimeStr = `${String(halfDayPunchInCutoff.getHours()).padStart(2, '0')}:${String(halfDayPunchInCutoff.getMinutes()).padStart(2, '0')}`;
        remarkParts.push(`Late punch-in for shift (after ${cutoffTimeStr})`);
      }
    }

    if (shift.halfDayEarlyPunchOutMin && punchIn && punchOut) {
      const [sHour, sMin] = shift.startTime.split(':').map(Number);
      const [eHour, eMin] = shift.endTime.split(':').map(Number);

      const shiftStart = new Date(punchIn);
      shiftStart.setHours(sHour, sMin, 0, 0);

      const shiftEnd = new Date(punchIn);
      shiftEnd.setHours(eHour, eMin, 0, 0);
      if (shiftEnd < shiftStart) {
        shiftEnd.setDate(shiftEnd.getDate() + 1);
      }

      const halfDayPunchOutCutoff = new Date(shiftEnd);
      halfDayPunchOutCutoff.setMinutes(halfDayPunchOutCutoff.getMinutes() - shift.halfDayEarlyPunchOutMin);

      if (new Date(punchOut) < halfDayPunchOutCutoff) {
        isHalfDay = true;
        const cutoffTimeStr = `${String(halfDayPunchOutCutoff.getHours()).padStart(2, '0')}:${String(halfDayPunchOutCutoff.getMinutes()).padStart(2, '0')}`;
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

module.exports = { DAY_LABELS, isWeeklyOff, toLocalDateKey, isLatePunchIn, determineHalfDayStatus };
