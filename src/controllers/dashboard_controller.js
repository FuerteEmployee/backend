const mongoose = require('mongoose');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Salary = require('../models/Salary');
const Expense = require('../models/Expense');
const Ticket = require('../models/Ticket');
const Lead = require('../models/Lead');
const Leave = require('../models/Leave');
const Regularization = require('../models/Regularization');
const AdvanceSalaryRequest = require('../models/AdvanceSalaryRequest');
const { computeSalary } = require('./salary_controller');
const { istStartOfDay, istEndOfDay, istDateKey, istMonthRange } = require('../utils/attendance_helpers');
const { classifyDays, classifyCurrentDay } = require('../utils/day_classification');
const { getTenantFeatureToggles } = require('../utils/feature_toggles');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Longest custom range the cards will total up, and the most days the
// attendance chart draws.
const MAX_RANGE_DAYS = 92;
const MAX_TREND_DAYS = 31;

// Same cap the expense form enforces (expense_controller MAX_AMOUNT). Claims
// entered before that cap existed hold amounts like ₹10^114; one of those in a
// total makes the whole card meaningless, so they are left out and counted.
const MAX_EXPENSE_AMOUNT = 10000000;

// Every dashboard classification counts people from their joining date: a
// past month must not show someone who joined later as absent all month.
const CLASSIFY_OPTS = { fromJoiningDate: true };

// ── IST calendar keys ────────────────────────────────────────────────────────
// Everything below works on 'YYYY-MM-DD' IST keys and turns them into instants
// only through the IST helpers, so the host timezone never matters. This
// controller used `new Date(year, month - 1, 1)` and `setDate()`, which on a
// UTC host (production) put the month edges 5h30m off: a past month dropped
// its 1st day's attendance and took in the next month's 1st, and between
// midnight and 05:30 IST the chart labelled every bar with yesterday's weekday.
const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const noonOf = (key) => new Date(`${key}T12:00:00+05:30`);
const addDays = (key, n) => istDateKey(new Date(noonOf(key).getTime() + n * DAY_MS));
const weekdayOf = (key) => WEEKDAY_LABELS[new Date(`${key}T00:00:00Z`).getUTCDay()];
const isValidKey = (key) => typeof key === 'string' && KEY_RE.test(key) && istDateKey(noonOf(key)) === key;
function keysBetween(firstKey, lastKey) {
    const keys = [];
    for (let k = firstKey; k <= lastKey && keys.length <= 400; k = addDays(k, 1)) keys.push(k);
    return keys;
}
const monthKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;
const lastDayOfMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// ── What this viewer may see ─────────────────────────────────────────────────
// A widget is shown only when the plan includes its module, the super admin
// has not switched its feature off, and -- for a sub-admin -- they may view
// that page. The data is left out of the response, not just hidden, so a
// sub-admin without salary rights cannot read the payroll total from the
// network tab.
const LEGACY_MODULE_KEYS = { expenses: 'expensesAssets', leads: 'crmLeads' };
const readModule = (modules, key) => modules?.get?.(key) ?? modules?.[key];
// Mirrors checkModuleAccess: a module the plan does not mention is allowed.
function planAllows(subscription, key) {
    const modules = subscription?.planId?.modules;
    if (!modules) return true;
    let value = readModule(modules, key);
    if (value === undefined && LEGACY_MODULE_KEYS[key]) value = readModule(modules, LEGACY_MODULE_KEYS[key]);
    return value !== false && value !== 'none';
}

async function resolveVisibility(req) {
    const role = req.currentUser?.role || req.user?.role;
    const permissions = req.currentUser?.permissions || {};
    // Truthy, as checkPermission reads it.
    const may = (page) => role !== 'subadmin' || !!permissions?.[page]?.view;
    const toggles = role === 'superadmin' ? {} : await getTenantFeatureToggles(req.adminId);
    const on = (key) => toggles[key] !== false;
    const sub = req.subscription;
    return {
        attendance: planAllows(sub, 'attendance') && may('attendance'),
        leaves: planAllows(sub, 'attendance') && may('leaves'),
        employees: may('employees'),
        salary: planAllows(sub, 'salary') && may('salary'),
        expenses: planAllows(sub, 'expenses') && on('expenses') && may('expenses'),
        leads: planAllows(sub, 'leads') && on('leads') && may('leads'),
        tickets: planAllows(sub, 'tickets') && may('tickets'),
        advances: planAllows(sub, 'advance-salary') && on('advanceSalary') && may('advance-salary'),
    };
}

// ── Attendance ───────────────────────────────────────────────────────────────
// One day's classification (utils/day_classification.js, the same rules as
// the Attendance page) reduced to the numbers the cards show.
function tallyDay(day) {
    const o = day.out;
    return {
        // Same sum as the Attendance page's Present Today card.
        present: o.present.length + o.late.length + o.wfh.length,
        late: day.lateArrivals,
        halfDay: o.halfDay.length,
        needsReview: o.needsReview.length,
        onLeave: o.onLeave.length,
        weeklyOff: o.weeklyOff.length,
        holiday: o.holiday.length,
        absent: o.absent.length,
        onDuty: day.onDuty,
    };
}

function sumTallies(tallies) {
    const total = { present: 0, late: 0, halfDay: 0, needsReview: 0, onLeave: 0, weeklyOff: 0, holiday: 0, absent: 0, onDuty: 0 };
    for (const t of tallies) for (const k of Object.keys(total)) total[k] += t[k];
    return total;
}

// A bar of the 7-day chart. "Came to work" counts every graded day, half days
// and days awaiting review included; absent is only people who were expected
// and did not come -- leave, weekly offs and holidays are neither.
function trendPoint(key, t) {
    return {
        date: key,
        day: weekdayOf(key),
        label: `${weekdayOf(key)} ${Number(key.slice(8, 10))}`,
        present: t.present + t.halfDay + t.needsReview,
        absent: t.absent,
        onLeave: t.onLeave,
    };
}

// ── Money and people ─────────────────────────────────────────────────────────
// Payroll total per department, for the "Salary by department" chart. Sums
// `totalSalary`, the figure the Salary page lists and totals, so the chart
// adds up to the card. Payslips of employees since deleted are kept, under
// their own slice, for the same reason.
async function getSalaryByDepartment(adminId, monthYearPairs) {
    return Salary.aggregate([
        { $match: { adminId: new mongoose.Types.ObjectId(adminId), $or: monthYearPairs } },
        { $lookup: { from: 'users', localField: 'employeeId', foreignField: '_id', as: 'emp' } },
        { $unwind: { path: '$emp', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'departments', localField: 'emp.departmentId', foreignField: '_id', as: 'dept' } },
        { $unwind: { path: '$dept', preserveNullAndEmptyArrays: true } },
        {
            $group: {
                _id: {
                    $cond: [
                        { $eq: [{ $ifNull: ['$emp._id', null] }, null] },
                        'Former employees',
                        { $trim: { input: { $ifNull: ['$dept.name', 'No department'] } } },
                    ],
                },
                value: { $sum: { $ifNull: ['$totalSalary', 0] } },
            },
        },
        { $project: { _id: 0, name: '$_id', value: 1 } },
        { $sort: { value: -1 } },
    ]);
}

// Active employees per department, for "Staff by department". Names are
// trimmed: "Development" and "Development " are one department to a reader.
async function getDepartmentHeadcount(adminId) {
    return User.aggregate([
        { $match: { adminId: new mongoose.Types.ObjectId(adminId), role: 'employee', status: 'active' } },
        { $lookup: { from: 'departments', localField: 'departmentId', foreignField: '_id', as: 'dept' } },
        { $unwind: { path: '$dept', preserveNullAndEmptyArrays: true } },
        { $group: { _id: { $trim: { input: { $ifNull: ['$dept.name', 'No department'] } } }, value: { $sum: 1 } } },
        { $project: { _id: 0, name: '$_id', value: 1 } },
        { $sort: { value: -1, name: 1 } },
    ]);
}

// Approved and reimbursed claims dated inside [start, end]. Pending and
// rejected claims are not money spent; pending ones are counted separately.
async function getApprovedExpenses(adminId, start, end) {
    const rows = await Expense.aggregate([
        {
            $match: {
                adminId: new mongoose.Types.ObjectId(adminId),
                status: { $in: ['approved', 'reimbursed'] },
                date: { $gte: start, $lte: end },
            },
        },
        {
            $group: {
                _id: null,
                total: { $sum: { $cond: [{ $lte: ['$amount', MAX_EXPENSE_AMOUNT] }, '$amount', 0] } },
                count: { $sum: { $cond: [{ $lte: ['$amount', MAX_EXPENSE_AMOUNT] }, 1, 0] } },
                overCap: { $sum: { $cond: [{ $gt: ['$amount', MAX_EXPENSE_AMOUNT] }, 1, 0] } },
            },
        },
    ]);
    return { total: rows[0]?.total || 0, count: rows[0]?.count || 0, overCap: rows[0]?.overCap || 0 };
}

const skip = (value = null) => Promise.resolve(value);

// The fields the two lists render, and nothing else. These used to be whole
// User documents -- activeToken (a live login token), the encrypted BOTLens
// password, bank details, PAN and Aadhaar all went to the browser with them.
const toRecentEmployee = (e) => ({
    _id: e._id,
    name: e.name,
    status: e.status,
    department: e.departmentId?.name?.trim() || null,
    joiningDate: e.joiningDate || null,
    createdAt: e.createdAt,
});
const toPendingTicket = (t) => ({
    _id: t._id,
    type: t.type,
    status: t.status,
    createdAt: t.createdAt,
    employeeName: t.employeeId?.name || null,
});

/**
 * The admin dashboard.
 *
 * Periods:
 *   ?month=&year=             that month. The current month's cards mean TODAY
 *                             (night-shift aware); a past month's cards are
 *                             totals of person-days across it.
 *   ?startDate=&endDate=      IST dates (YYYY-MM-DD). The cards total that
 *                             range; one day gives that day's picture.
 *
 * Attendance is counted with utils/day_classification.js -- the rules the
 * Attendance page uses -- so the two pages show the same numbers for a day.
 */
exports.getSummary = async (req, res) => {
    try {
        const adminId = req.adminId;
        const now = new Date();
        const todayKey = istDateKey(now);
        const [nowY, nowM] = todayKey.split('-').map(Number);

        // ── Period ───────────────────────────────────────────────────────────
        const hasRange = req.query.startDate !== undefined || req.query.endDate !== undefined;
        let month, year, isCurrentMonth, isCustomRange, dayKeys, rangeStartKey, rangeEndKey;

        if (hasRange) {
            const startKey = String(req.query.startDate || '');
            const endKey = String(req.query.endDate || startKey);
            if (!isValidKey(startKey) || !isValidKey(endKey)) {
                return res.status(400).json({ message: 'Please choose a valid date.' });
            }
            if (startKey > endKey) {
                return res.status(400).json({ message: 'The start date must be on or before the end date.' });
            }
            if (startKey > todayKey) {
                return res.status(400).json({ message: 'That date is in the future. Please choose today or an earlier date.' });
            }
            rangeStartKey = startKey;
            rangeEndKey = endKey > todayKey ? todayKey : endKey;
            dayKeys = keysBetween(rangeStartKey, rangeEndKey);
            if (dayKeys.length > MAX_RANGE_DAYS) {
                return res.status(400).json({ message: 'Please choose a range of 3 months or less.' });
            }
            isCustomRange = true;
            isCurrentMonth = false;
            [year, month] = rangeEndKey.split('-').map(Number);
        } else {
            const requestedMonth = parseInt(req.query.month, 10);
            const requestedYear = parseInt(req.query.year, 10);
            month = requestedMonth >= 1 && requestedMonth <= 12 ? requestedMonth : nowM;
            year = requestedYear >= 2000 && requestedYear <= 2100 ? requestedYear : nowY;
            isCurrentMonth = month === nowM && year === nowY;
            isCustomRange = false;
            const first = `${monthKey(year, month)}-01`;
            const last = `${monthKey(year, month)}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}`;
            rangeStartKey = first;
            rangeEndKey = last > todayKey ? todayKey : last;
            // A future month has no days to count.
            dayKeys = rangeStartKey <= rangeEndKey ? keysBetween(rangeStartKey, rangeEndKey) : [];
        }

        // "Today" mode: the current month, or a single custom day that is today.
        const isTodayView = isCurrentMonth || (isCustomRange && dayKeys.length === 1 && dayKeys[0] === todayKey);
        const isSingleDay = isTodayView || (isCustomRange && dayKeys.length === 1);

        // Payroll is keyed by month, so a range pulls every month it touches.
        const monthYearPairs = [];
        if (isCustomRange) {
            for (let k = `${rangeStartKey.slice(0, 7)}-01`; k.slice(0, 7) <= rangeEndKey.slice(0, 7); k = `${addDays(`${k.slice(0, 7)}-28`, 5).slice(0, 7)}-01`) {
                const [y, m] = k.split('-').map(Number);
                monthYearPairs.push({ month: m, year: y });
            }
        } else {
            monthYearPairs.push({ month, year });
        }
        // Money is counted over the whole period (the whole month, not month to
        // date), as the Salary and Expenses pages do.
        const moneyStart = isCustomRange ? istStartOfDay(noonOf(rangeStartKey)) : istMonthRange(year, month).start;
        const moneyEnd = isCustomRange ? istEndOfDay(noonOf(rangeEndKey)) : istMonthRange(year, month).end;

        const visible = await resolveVisibility(req);

        // ── Attendance ───────────────────────────────────────────────────────
        // Trend: the 7 days (or the custom range, up to 31) ending on the
        // period's last counted day.
        const trendEndKey = isTodayView ? todayKey : (dayKeys[dayKeys.length - 1] || null);
        const trendCount = isCustomRange ? Math.min(MAX_TREND_DAYS, Math.max(1, dayKeys.length)) : 7;
        const trendKeys = trendEndKey ? keysBetween(addDays(trendEndKey, -(trendCount - 1)), trendEndKey) : [];

        let attendanceStats = null;
        let attendanceTrend = [];
        if (visible.attendance) {
            if (isTodayView) {
                const [current, trendDays] = await Promise.all([
                    classifyCurrentDay(adminId, now, CLASSIFY_OPTS),
                    classifyDays(adminId, trendKeys.map(noonOf), CLASSIFY_OPTS),
                ]);
                const t = tallyDay(current);
                attendanceStats = { ...t, holidayName: current.holiday, movedToShiftDay: current.movedToShiftDay };
                // Today's bar is the cards' own figure, so the two always agree.
                attendanceTrend = trendKeys.map((k, i) => trendPoint(k, k === todayKey ? t : tallyDay(trendDays[i])));
            } else {
                const allKeys = Array.from(new Set([...dayKeys, ...trendKeys])).sort();
                const days = await classifyDays(adminId, allKeys.map(noonOf), CLASSIFY_OPTS);
                const byKey = new Map(allKeys.map((k, i) => [k, tallyDay(days[i])]));
                const total = sumTallies(dayKeys.map((k) => byKey.get(k)));
                attendanceStats = {
                    ...total,
                    // On duty is a "right now" figure; it means nothing summed
                    // over past days.
                    onDuty: null,
                    holidayName: isSingleDay ? (days[allKeys.indexOf(dayKeys[0])]?.holiday || null) : null,
                    movedToShiftDay: 0,
                };
                attendanceTrend = trendKeys.map((k) => trendPoint(k, byKey.get(k)));
            }
        }

        // ── Everything else, in parallel ─────────────────────────────────────
        const oid = new mongoose.Types.ObjectId(adminId);
        const [
            totalEmployees,
            activeEmployees,
            salaryRows,
            salaryDistribution,
            expenses,
            totalLeads,
            pendingLeaves,
            pendingCorrections,
            pendingTicketCount,
            pendingAdvances,
            pendingExpenses,
            recentEmployees,
            pendingTickets,
            departmentHeadcount,
        ] = await Promise.all([
            User.countDocuments({ adminId, role: 'employee' }),
            User.countDocuments({ adminId, role: 'employee', status: 'active' }),
            visible.salary ? Salary.find({ adminId, $or: monthYearPairs }).select('totalSalary').lean() : skip([]),
            visible.salary ? getSalaryByDepartment(adminId, monthYearPairs) : skip([]),
            visible.expenses ? getApprovedExpenses(adminId, moneyStart, moneyEnd) : skip(null),
            visible.leads ? Lead.countDocuments({ adminId }) : skip(null),
            visible.leaves ? Leave.countDocuments({ adminId, status: 'pending' }) : skip(null),
            visible.attendance ? Regularization.countDocuments({ adminId, status: 'pending' }) : skip(null),
            // A "Forgot to punch" ticket is also a pending correction (counted just above),
            // so only plain tickets here: it was counted twice in the Waiting panel.
            visible.tickets ? Ticket.countDocuments({ adminId, status: 'pending', regularizationId: null }) : skip(null),
            visible.advances ? AdvanceSalaryRequest.countDocuments({ companyId: oid, status: 'pending' }) : skip(null),
            visible.expenses ? Expense.countDocuments({ adminId, status: 'pending' }) : skip(null),
            visible.employees
                ? User.find({ adminId, role: 'employee' })
                    .select('name status departmentId joiningDate createdAt')
                    .sort({ createdAt: -1 }).limit(5)
                    .populate('departmentId', 'name')
                    .lean()
                : skip([]),
            visible.tickets
                ? Ticket.find({ adminId, status: 'pending' })
                    .select('type status createdAt employeeId')
                    .sort({ createdAt: -1 }).limit(4)
                    .populate('employeeId', 'name')
                    .lean()
                : skip([]),
            getDepartmentHeadcount(adminId),
        ]);

        const totalSalary = visible.salary ? salaryRows.reduce((sum, r) => sum + (Number(r.totalSalary) || 0), 0) : null;

        res.json({
            month,
            year,
            isCurrentMonth,
            isCustomRange,
            ...(isCustomRange ? { startDate: rangeStartKey, endDate: rangeEndKey } : {}),
            today: todayKey,
            // Which kind of figure the attendance cards hold: 'today', one
            // chosen 'day', or a 'total' of person-days over a period.
            attendanceMode: isTodayView ? 'today' : isSingleDay ? 'day' : 'total',
            daysCounted: dayKeys.length,
            visible,
            stats: {
                totalEmployees,
                activeEmployees,
                inactiveEmployees: Math.max(0, totalEmployees - activeEmployees),
                presentToday: attendanceStats ? attendanceStats.present : null,
                lateToday: attendanceStats ? attendanceStats.late : null,
                halfDayToday: attendanceStats ? attendanceStats.halfDay : null,
                needsReviewToday: attendanceStats ? attendanceStats.needsReview : null,
                onLeaveToday: attendanceStats ? attendanceStats.onLeave : null,
                weeklyOffToday: attendanceStats ? attendanceStats.weeklyOff : null,
                holidayToday: attendanceStats ? attendanceStats.holiday : null,
                absentToday: attendanceStats ? attendanceStats.absent : null,
                onDutyNow: attendanceStats ? attendanceStats.onDuty : null,
                holidayName: attendanceStats ? attendanceStats.holidayName : null,
                nightShiftCounted: attendanceStats ? attendanceStats.movedToShiftDay : 0,
                totalSalary,
                payslipCount: visible.salary ? salaryRows.length : null,
                totalExpenses: expenses ? expenses.total : null,
                approvedExpenseCount: expenses ? expenses.count : null,
                expensesOverCapLeftOut: expenses ? expenses.overCap : null,
                totalLeads,
            },
            pending: {
                leaves: pendingLeaves,
                corrections: pendingCorrections,
                tickets: pendingTicketCount,
                advances: pendingAdvances,
                expenses: pendingExpenses,
            },
            recentEmployees: recentEmployees.map(toRecentEmployee),
            pendingTickets: pendingTickets.map(toPendingTicket),
            attendanceTrend,
            salaryDistribution,
            departmentHeadcount,
        });
    } catch (error) {
        console.error('Dashboard summary failed:', error);
        res.status(500).json({ message: 'Could not load the dashboard. Please try again.' });
    }
};

exports.getEmployeeDashboard = async (req, res) => {
    try {
        const employeeId = req.userId;
        const adminId = req.adminId;
        // IST, not host time -- see istMonthRange.
        const [nowY, nowM, nowD] = istDateKey().split('-').map(Number);
        const month = parseInt(req.query.month) || nowM;
        const year = parseInt(req.query.year) || nowY;

        const { start: startDate, end: endDate } = istMonthRange(year, month);
        const today = istStartOfDay();

        // 1. Fetch Data in Parallel
        const [todayAttendance, monthlyAttendance, salary, user] = await Promise.all([
            Attendance.findOne({ adminId, employeeId, date: today }),
            Attendance.find({ adminId, employeeId, date: { $gte: startDate, $lte: endDate } }),
            Salary.findOne({ adminId, employeeId, month, year }),
            User.findById(employeeId).populate('shiftId branchId')
        ]);

        // 2. Live salary estimate (runs in parallel with attendance counting)
        let estimatedEarnings = user?.salary || 0;
        let estimatedRemarks = '';
        let enginePayload = null;
        try {
            if (user) {
                const est = await computeSalary(adminId, user, month, year);
                estimatedEarnings = est.netSalary;
                estimatedRemarks = est.remarks;
                if (est._engineEnabled) {
                    enginePayload = {
                        buckets: est.buckets,
                        payableDays: est.payableDays,
                        totalDaysInWindow: est.totalDaysInWindow,
                        projectedFull: est.projectedFull,
                        isMTD: est.isMTD,
                        needsReview: est.needsReview,
                        dailyRateBasis: est.dailyRateBasisUsed,
                    };
                }
            }
        } catch (e) {
            console.error('Estimated earnings compute failed:', e.message);
        }

        // 3. Calculate Monthly Stats from raw attendance records (legacy fallback
        // or supplemental data when engine is not enabled)
        let presentCount = 0;
        let halfDayCount = 0;
        let wfhCount = 0;
        let lateCount = 0;

        monthlyAttendance.forEach(rec => {
            const isWfhRecord = rec.isWFH ||
                rec.status === 'wfh' ||
                rec.remarks?.toLowerCase().includes('work from home') ||
                rec.remarks?.toLowerCase().includes('wfh');

            if (rec.status === 'half-day') {
                halfDayCount++;
            } else if (rec.status === 'present' || rec.status === 'late' || rec.status === 'wfh') {
                presentCount++;
                if (isWfhRecord) wfhCount++;
                // Count late: explicit late status OR wasLate flag (survives punch-out normalisation)
                if (rec.status === 'late' || rec.wasLate) lateCount++;
            }
        });

        // 4. Absent count from the engine if available, else manual calculation
        let absentCount;
        if (enginePayload) {
            absentCount = enginePayload.buckets.absent;
        } else {
            const currentMonth = nowM;
            const currentYear = nowY;
            let lastDayToTrack;
            if (year < currentYear || (year === currentYear && month < currentMonth)) {
                lastDayToTrack = new Date(year, month, 0).getDate();
            } else if (year === currentYear && month === currentMonth) {
                lastDayToTrack = nowD;
            } else {
                lastDayToTrack = 0;
            }
            let expectedWorkingDays = 0;
            const weeklyHolidays = user?.weeklyHolidays || [];
            for (let d = 1; d <= lastDayToTrack; d++) {
                const date = new Date(year, month - 1, d);
                const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
                const isOff = weeklyHolidays.some(h => h.day === dayName && (h.weeks.length === 0 || h.weeks.includes(Math.ceil(d / 7))));
                if (!isOff) expectedWorkingDays++;
            }
            absentCount = Math.max(0, expectedWorkingDays - (presentCount + halfDayCount));
        }

        res.json({
            today: {
                punchedIn: !!todayAttendance?.punchIn,
                punchedOut: !!todayAttendance?.punchOut,
                status: todayAttendance?.status || 'not punched in',
                isWFH: todayAttendance?.isWFH || false,
                timings: {
                    punchIn: todayAttendance?.punchIn || null,
                    punchOut: todayAttendance?.punchOut || null,
                    lunchIn: todayAttendance?.lunchInTime || null,
                    lunchOut: todayAttendance?.lunchOutTime || null
                }
            },
            monthlyStats: {
                present: presentCount,
                absent: absentCount,
                wfh: wfhCount,
                halfDays: halfDayCount,
                late: lateCount,
                monthName: new Date(year, month - 1, 15).toLocaleString('default', { month: 'long' }),
                year,
                // Engine bucket breakdown (null when engine not enabled)
                buckets: enginePayload?.buckets || null,
            },
            salary: {
                amount: salary ? salary.totalSalary : estimatedEarnings,
                estimatedEarnings,
                baseSalary: user?.salary || 0,
                remarks: estimatedRemarks,
                status: salary?.status || 'pending',
                isGenerated: !!salary,
                // Engine enrichments
                projectedFull: enginePayload?.projectedFull ?? null,
                isMTD: enginePayload?.isMTD ?? null,
                needsReview: enginePayload?.needsReview ?? (salary?.needsReview || false),
                payableDays: enginePayload?.payableDays ?? null,
                totalDaysInWindow: enginePayload?.totalDaysInWindow ?? null,
                dailyRateBasis: enginePayload?.dailyRateBasis ?? null,
            }
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
