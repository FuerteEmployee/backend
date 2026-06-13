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

module.exports = { DAY_LABELS, isWeeklyOff };
