// ─────────────────────────────────────────────────────────────────────────────
// Deterministic, configurable payroll engine (Be On Time SOP).
//
// Core principle: every calendar day in the pay window is classified into
// EXACTLY ONE bucket. Salary = sum of (per-day pay weight) × daily rate. The
// day-sum invariant (Σ bucket counts === days in window) must hold or payroll
// is flagged needsReview.
//
// All functions are pure and unit-testable. The orchestrator runEngine() takes
// already-fetched data (attendance, festivals, leaves) and returns the full
// classification + totals. Components/deductions and final rounding of NET are
// applied by the caller (salary_controller.computeSalary).
// ─────────────────────────────────────────────────────────────────────────────

const { isWeeklyOff, toLocalDateKey } = require('./attendance_helpers');

const BUCKETS = ['present', 'wfh', 'halfDay', 'paidLeave', 'weeklyOff', 'holiday', 'absent', 'unpaidLeave'];

// Defaults that reproduce TODAY's pay weighting for buckets that exist today.
const LEGACY_DEFAULT_WEIGHTS = {
    present: 1, wfh: 1, halfDay: 0.5, paidLeave: 1,
    weeklyOff: 1, holiday: 1, absent: 0, unpaidLeave: 0,
};

// Parse a 'YYYY-MM-DD' string (or Date) as a LOCAL date (no UTC shift).
function parseLocalDate(s) {
    if (s instanceof Date) return new Date(s.getFullYear(), s.getMonth(), s.getDate());
    const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
}

// ── Config resolution: tenant Settings.payroll merged with per-employee override ──
function resolvePayrollConfig(settings, emp) {
    const tenant = (settings && settings.payroll) || {};
    const ov = (emp && emp.payrollOverride) || {};
    const useOv = ov.overrideGlobal === true;

    const pick = (key, def) => {
        if (useOv && ov[key] != null) return ov[key];
        if (tenant[key] != null) return tenant[key];
        return def;
    };

    const tenantWeights = tenant.bucketWeights || {};
    const ovWeights = (useOv && ov.bucketWeights) || {};
    const bucketWeights = {};
    for (const b of BUCKETS) {
        if (useOv && ovWeights[b] != null) bucketWeights[b] = ovWeights[b];
        else if (tenantWeights[b] != null) bucketWeights[b] = tenantWeights[b];
        else bucketWeights[b] = LEGACY_DEFAULT_WEIGHTS[b];
    }

    return {
        enabled: tenant.enabled === true,
        dailyRateBasis: pick('dailyRateBasis', 'fixed30'),
        sandwichRuleEnabled: pick('sandwichRuleEnabled', true),
        rounding: tenant.rounding || { mode: 'nearest', precision: 0 },
        holidayWorkBonusMultiplier: tenant.holidayWorkBonusMultiplier != null ? tenant.holidayWorkBonusMultiplier : 1,
        bucketWeights,
    };
}

// ── Daily rate per the configured basis ──
function getDailyRate(salary, basis, { totalDaysInMonth, workingDaysInMonth }) {
    const s = salary || 0;
    switch (basis) {
        case 'fixed30': return s / 30;
        case 'fixed26': return s / 26;
        case 'workingDay': return workingDaysInMonth > 0 ? s / workingDaysInMonth : 0;
        case 'calendar':
        default: return totalDaysInMonth > 0 ? s / totalDaysInMonth : 0;
    }
}

// ── Rounding (applied ONCE to the final net) ──
function applyRounding(value, rounding) {
    const mode = (rounding && rounding.mode) || 'nearest';
    const precision = (rounding && rounding.precision) || 0;
    const f = Math.pow(10, precision);
    switch (mode) {
        case 'none': return value;
        case 'floor': return Math.floor(value * f) / f;
        case 'ceil': return Math.ceil(value * f) / f;
        case 'nearest':
        default: return Math.round(value * f) / f;
    }
}

// Which worked-bucket (if any) does an attendance record represent?
function workedBucketFromAttendance(rec) {
    if (!rec) return null;
    const isWfh = rec.isWFH === true || rec.status === 'wfh' || /wfh|work from home/i.test(rec.remarks || '');
    if (rec.status === 'present' || rec.status === 'late' || rec.status === 'wfh') {
        return isWfh ? 'wfh' : 'present';
    }
    if (rec.status === 'half-day') return 'halfDay';
    return null; // explicit 'absent' or no meaningful work
}

function buildFestivalSet(festivals) {
    const set = new Set();
    for (const f of festivals || []) {
        let cur = parseLocalDate(f.startDate);
        const last = parseLocalDate(f.endDate || f.startDate);
        let guard = 0;
        while (cur <= last && guard < 1000) {
            set.add(toLocalDateKey(cur));
            cur.setDate(cur.getDate() + 1);
            guard++;
        }
    }
    return set;
}

// Expand approved leaves into a per-day map within the month.
function buildLeaveMap(leaves, leaveTypesById, year, month) {
    const map = new Map();
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0);
    for (const lv of leaves || []) {
        if (lv.status !== 'approved') continue;
        const lt = leaveTypesById ? leaveTypesById[String(lv.leaveTypeId)] : null;
        const isPaid = lt ? lt.isPaid !== false : true; // unknown type → treat as paid
        const payWeight = lt && lt.payWeight != null ? lt.payWeight : null;
        let cur = parseLocalDate(lv.startDate);
        const last = parseLocalDate(lv.endDate || lv.startDate);
        let guard = 0;
        while (cur <= last && guard < 400) {
            if (cur >= monthStart && cur <= monthEnd) {
                map.set(toLocalDateKey(cur), { isPaid, payWeight, leaveTypeId: lv.leaveTypeId });
            }
            cur.setDate(cur.getDate() + 1);
            guard++;
        }
    }
    return map;
}

// Classify every calendar day of the month into exactly one bucket.
// Precedence: Holiday > WeeklyOff > worked(attendance) > Leave > Absent.
// (Holiday/WeeklyOff win over leave so paid off-days inside a leave span stay
// paid off-days; a day actually worked wins over a leave record.)
function classifyMonth({ emp, year, month, asOfDate, attendanceByKey, festivalSet, leaveByKey, workDays }) {
    const totalDaysInMonth = new Date(year, month, 0).getDate();
    const now = asOfDate ? new Date(asOfDate) : new Date();
    const isCurrentMonth = now.getFullYear() === year && now.getMonth() + 1 === month;
    const isFuture = year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1);
    const windowEnd = isFuture ? 0 : (isCurrentMonth ? now.getDate() : totalDaysInMonth);

    const weeklyHolidays = emp.weeklyHolidays || [];
    const days = [];
    let workingDaysInMonth = 0;

    for (let d = 1; d <= totalDaysInMonth; d++) {
        const date = new Date(year, month - 1, d);
        const dateKey = toLocalDateKey(date);
        const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
        const isHoliday = festivalSet.has(dateKey);
        const isOff = isWeeklyOff(dayName, d, weeklyHolidays, workDays);
        const isWorkingDay = !isHoliday && !isOff;
        if (isWorkingDay) workingDaysInMonth++;

        const rec = attendanceByKey.get(dateKey) || null;
        const worked = workedBucketFromAttendance(rec);
        const leave = leaveByKey.get(dateKey) || null;

        let bucket;
        if (isHoliday) bucket = 'holiday';
        else if (isOff) bucket = 'weeklyOff';
        else if (worked) bucket = worked;
        else if (leave) bucket = leave.isPaid ? 'paidLeave' : 'unpaidLeave';
        else bucket = 'absent';

        days.push({
            d, dateKey, isHoliday, isOff, isWorkingDay, bucket, leave,
            workedOnOff: (isHoliday || isOff) && !!worked,
            inWindow: d <= windowEnd,
        });
    }

    return { days, totalDaysInMonth, workingDaysInMonth, windowEnd, isCurrentMonth, isFuture };
}

// Sandwich rule: a weekly-off/holiday flanked by unexcused absence on BOTH the
// nearest prior AND next working day (within the window) becomes unpaid (LOP).
// At a window edge with only one neighbour, that single neighbour decides.
// Days actually worked on the off-day are never stripped.
function applySandwich(days, windowEnd) {
    const inWin = days.filter((x) => x.d <= windowEnd);
    const isAbsentLike = (x) => x && (x.bucket === 'absent' || x.bucket === 'unpaidLeave');

    for (let i = 0; i < inWin.length; i++) {
        const day = inWin[i];
        if (day.bucket !== 'weeklyOff' && day.bucket !== 'holiday') continue;
        if (day.workedOnOff) continue;

        let prev = null;
        for (let j = i - 1; j >= 0; j--) {
            if (inWin[j].isWorkingDay) { prev = inWin[j]; break; }
        }
        let next = null;
        for (let j = i + 1; j < inWin.length; j++) {
            if (inWin[j].isWorkingDay) { next = inWin[j]; break; }
        }

        let trigger;
        if (prev && next) trigger = isAbsentLike(prev) && isAbsentLike(next);
        else if (prev) trigger = isAbsentLike(prev);
        else if (next) trigger = isAbsentLike(next);
        else trigger = false;

        if (trigger) day.bucket = 'unpaidLeave';
    }
}

// Tally bucket counts and the weighted payable-days for the window.
function computeTotals(days, config, windowEnd) {
    const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    let payableDays = 0;
    let holidayWorkedDays = 0;

    for (const day of days) {
        if (day.d > windowEnd) continue;
        counts[day.bucket] = (counts[day.bucket] || 0) + 1;

        let w;
        if (day.bucket === 'paidLeave' && day.leave && day.leave.payWeight != null) {
            w = day.leave.payWeight; // per-leave-type override
        } else {
            w = config.bucketWeights[day.bucket] != null ? config.bucketWeights[day.bucket] : 0;
        }
        payableDays += w;
        if (day.workedOnOff) holidayWorkedDays += 1;
    }

    const bonusDays = holidayWorkedDays * Math.max(0, (config.holidayWorkBonusMultiplier || 1) - 1);
    payableDays = Math.round((payableDays + bonusDays) * 1000) / 1000;
    return { counts, payableDays, holidayWorkedDays, bonusDays };
}

// §9 validation gate — run before persisting/paying.
function validateSalary({ counts, windowEnd, baseSalary, netSalary }) {
    const errors = [];
    const sum = BUCKETS.reduce((a, b) => a + (counts[b] || 0), 0);
    if (sum !== windowEnd) errors.push(`Day-sum invariant failed: ${sum} classified vs ${windowEnd} days in window`);
    if (!(baseSalary > 0)) errors.push('Base salary missing or non-positive');
    if (netSalary < 0) errors.push('Net salary is negative');
    return { ok: errors.length === 0, errors };
}

// Orchestrator: classify → sandwich → totals → rate → projection → invariant.
// Returns earnedBase (UNROUNDED gross-before-components); caller applies
// components/deductions and rounds NET once.
function runEngine({ emp, settings, year, month, attendanceRecords, festivals, leaves, leaveTypesById, asOfDate }) {
    const config = resolvePayrollConfig(settings, emp);

    const festivalSet = buildFestivalSet(festivals);
    const attendanceByKey = new Map();
    for (const rec of attendanceRecords || []) attendanceByKey.set(toLocalDateKey(rec.date), rec);
    const leaveByKey = buildLeaveMap(leaves, leaveTypesById, year, month);
    const workDays = settings && settings.attendance ? settings.attendance.workDays : undefined;

    const cls = classifyMonth({ emp, year, month, asOfDate, attendanceByKey, festivalSet, leaveByKey, workDays });
    const { days, totalDaysInMonth, workingDaysInMonth, windowEnd, isCurrentMonth, isFuture } = cls;

    if (config.sandwichRuleEnabled) applySandwich(days, windowEnd);

    const { counts, payableDays, holidayWorkedDays, bonusDays } = computeTotals(days, config, windowEnd);

    const dailyRate = getDailyRate(emp.salary, config.dailyRateBasis, { totalDaysInMonth, workingDaysInMonth });
    const earnedBase = dailyRate * payableDays;

    // Projection (current month): assume remaining working days are Present and
    // remaining paid off-days/holidays stay paid.
    let projectedPayableDays = payableDays;
    if (isCurrentMonth && !isFuture) {
        for (const day of days) {
            if (day.d <= windowEnd) continue;
            if (day.isWorkingDay) projectedPayableDays += config.bucketWeights.present || 1;
            else projectedPayableDays += config.bucketWeights[day.bucket] || 0;
        }
        projectedPayableDays = Math.round(projectedPayableDays * 1000) / 1000;
    }
    const projectedBase = dailyRate * projectedPayableDays;

    const invariantSum = BUCKETS.reduce((a, b) => a + (counts[b] || 0), 0);
    const needsReview = invariantSum !== windowEnd;

    return {
        config, counts, payableDays, holidayWorkedDays, bonusDays,
        dailyRate, dailyRateBasis: config.dailyRateBasis,
        earnedBase, projectedBase, projectedPayableDays,
        totalDaysInWindow: windowEnd, totalDaysInMonth, workingDaysInMonth,
        isMTD: isCurrentMonth, isFuture, needsReview, invariantSum, days,
    };
}

module.exports = {
    BUCKETS,
    LEGACY_DEFAULT_WEIGHTS,
    resolvePayrollConfig,
    getDailyRate,
    applyRounding,
    workedBucketFromAttendance,
    buildFestivalSet,
    buildLeaveMap,
    classifyMonth,
    applySandwich,
    computeTotals,
    validateSalary,
    runEngine,
};
