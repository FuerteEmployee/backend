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

module.exports = { DAY_LABELS, isWeeklyOff, toLocalDateKey };
