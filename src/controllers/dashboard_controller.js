const mongoose = require('mongoose');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Salary = require('../models/Salary');
const Expense = require('../models/Expense');
const Ticket = require('../models/Ticket');
const Lead = require('../models/Lead');
const { computeSalary } = require('./salary_controller');
const { istStartOfDay, istEndOfDay, istDateKey } = require('../utils/attendance_helpers');

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// 7 calendar days (oldest first) ending at `endDate`, of present-vs-absent
// counts, for the dashboard's "Attendance Performance" trend chart.
// `activeEmployees` is CURRENT headcount used as a stand-in for each day's —
// historical daily headcount isn't tracked, and headcount rarely swings much
// day to day. When viewing a past month, `endDate` anchors the window to the
// end of that month instead of today.
async function getAttendanceTrend(adminId, activeEmployees, endDate) {
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(endDate);
        d.setDate(d.getDate() - i);
        days.push(d);
    }
    const start = istStartOfDay(days[0]);
    const end = istEndOfDay(days[days.length - 1]);

    const records = await Attendance.find({
        adminId, date: { $gte: start, $lte: end },
        status: { $in: ['present', 'late', 'half-day', 'wfh'] },
    }).select('date');

    const presentByDay = new Map();
    records.forEach(r => {
        const key = istDateKey(r.date);
        presentByDay.set(key, (presentByDay.get(key) || 0) + 1);
    });

    return days.map(d => {
        const key = istDateKey(d);
        const present = presentByDay.get(key) || 0;
        return {
            day: WEEKDAY_LABELS[d.getDay()],
            present,
            absent: Math.max(0, activeEmployees - present),
        };
    });
}

// Current-month payroll total per department, for the "Budget Allocation" pie.
async function getSalaryByDepartment(adminId, month, year) {
    const rows = await Salary.aggregate([
        { $match: { adminId: new mongoose.Types.ObjectId(adminId), month, year } },
        { $lookup: { from: 'users', localField: 'employeeId', foreignField: '_id', as: 'emp' } },
        { $unwind: '$emp' },
        { $lookup: { from: 'departments', localField: 'emp.departmentId', foreignField: '_id', as: 'dept' } },
        { $unwind: { path: '$dept', preserveNullAndEmptyArrays: true } },
        {
            $group: {
                _id: { $ifNull: ['$dept.name', 'Unassigned'] },
                value: { $sum: { $ifNull: ['$netSalary', '$totalSalary'] } },
            },
        },
        { $project: { _id: 0, name: '$_id', value: 1 } },
        { $sort: { value: -1 } },
    ]);
    return rows;
}

// Current active-employee headcount per department, for "Team Strength".
async function getDepartmentHeadcount(adminId) {
    const rows = await User.aggregate([
        { $match: { adminId: new mongoose.Types.ObjectId(adminId), role: 'employee', status: 'active' } },
        { $lookup: { from: 'departments', localField: 'departmentId', foreignField: '_id', as: 'dept' } },
        { $unwind: { path: '$dept', preserveNullAndEmptyArrays: true } },
        { $group: { _id: { $ifNull: ['$dept.name', 'Unassigned'] }, value: { $sum: 1 } } },
        { $project: { _id: 0, name: '$_id', value: 1 } },
        { $sort: { value: -1 } },
    ]);
    return rows;
}

exports.getSummary = async (req, res) => {
    try {
        const adminId = req.adminId;
        const now = new Date();
        const requestedMonth = parseInt(req.query.month, 10);
        const requestedYear = parseInt(req.query.year, 10);
        const month = requestedMonth >= 1 && requestedMonth <= 12 ? requestedMonth : now.getMonth() + 1;
        const year = requestedYear >= 2000 ? requestedYear : now.getFullYear();
        const isCurrentMonth = month === now.getMonth() + 1 && year === now.getFullYear();

        const monthStart = new Date(year, month - 1, 1);
        const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);
        // For the current month, the day-level cards mean "today"; for a past
        // month there's no "today" to speak of, so they fall back to counting
        // whatever was actually recorded across that whole month.
        const dayWindowStart = isCurrentMonth ? istStartOfDay() : monthStart;
        const dayWindowEnd = isCurrentMonth ? istEndOfDay() : monthEnd;
        const trendEndDate = isCurrentMonth ? now : monthEnd;

        const [
            totalEmployees,
            activeEmployees,
            presentCount,
            lateCount,
            halfDayCount,
            absentExplicitCount,
            monthlySalaryRecords,
            monthlyExpenses,
            recentEmployees,
            pendingTickets,
            totalLeads
        ] = await Promise.all([
            User.countDocuments({ adminId, role: 'employee' }),
            User.countDocuments({ adminId, role: 'employee', status: 'active' }),
            Attendance.countDocuments({ adminId, date: { $gte: dayWindowStart, $lte: dayWindowEnd }, status: { $in: ['present', 'wfh'] } }),
            Attendance.countDocuments({ adminId, date: { $gte: dayWindowStart, $lte: dayWindowEnd }, status: 'late' }),
            Attendance.countDocuments({ adminId, date: { $gte: dayWindowStart, $lte: dayWindowEnd }, status: 'half-day' }),
            Attendance.countDocuments({ adminId, date: { $gte: dayWindowStart, $lte: dayWindowEnd }, status: 'absent' }),
            Salary.find({ adminId, month, year }),
            Expense.find({ adminId, date: { $gte: monthStart, $lte: monthEnd } }),
            User.find({ adminId, role: 'employee' }).sort({ createdAt: -1 }).limit(5).populate('departmentId'),
            Ticket.find({ adminId, status: 'pending' }).sort({ createdAt: -1 }).limit(4).populate('employeeId'),
            Lead.countDocuments({ adminId })
        ]);

        const totalSalary = monthlySalaryRecords.reduce((sum, r) => sum + (r.netSalary || r.totalSalary || 0), 0);
        const totalExpenseAmount = monthlyExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);

        const [attendanceTrend, salaryDistribution, departmentHeadcount] = await Promise.all([
            getAttendanceTrend(adminId, activeEmployees, trendEndDate),
            getSalaryByDepartment(adminId, month, year),
            getDepartmentHeadcount(adminId),
        ]);

        res.json({
            month,
            year,
            isCurrentMonth,
            stats: {
                totalEmployees,
                activeEmployees,
                presentToday: presentCount + lateCount,
                // Current month: based on activeEmployees, not totalEmployees —
                // a deactivated/terminated employee never punches in and was
                // previously permanently counted as "absent" forever. Past
                // month: whatever was explicitly recorded as absent that month
                // (extrapolating a full-month absence count would need the
                // same working-day/holiday logic payroll uses — out of scope
                // for a dashboard card).
                absentToday: isCurrentMonth
                    ? Math.max(0, activeEmployees - (presentCount + lateCount + halfDayCount))
                    : absentExplicitCount,
                halfDayToday: halfDayCount,
                totalSalary,
                totalExpenses: totalExpenseAmount,
                totalLeads
            },
            recentEmployees,
            pendingTickets,
            attendanceTrend,
            salaryDistribution,
            departmentHeadcount,
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.getEmployeeDashboard = async (req, res) => {
    try {
        const employeeId = req.userId;
        const adminId = req.adminId;
        const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59);
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
            const currentMonth = new Date().getMonth() + 1;
            const currentYear = new Date().getFullYear();
            let lastDayToTrack;
            if (year < currentYear || (year === currentYear && month < currentMonth)) {
                lastDayToTrack = new Date(year, month, 0).getDate();
            } else if (year === currentYear && month === currentMonth) {
                lastDayToTrack = new Date().getDate();
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
                monthName: startDate.toLocaleString('default', { month: 'long' }),
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
