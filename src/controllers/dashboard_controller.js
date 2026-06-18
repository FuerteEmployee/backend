const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Salary = require('../models/Salary');
const Expense = require('../models/Expense');
const Ticket = require('../models/Ticket');
const { computeSalary } = require('./salary_controller');

exports.getSummary = async (req, res) => {
    try {
        const adminId = req.adminId;
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
        const now = new Date();
        const currentMonth = now.getMonth() + 1;
        const currentYear = now.getFullYear();

        const [
            totalEmployees,
            activeEmployees,
            presentToday,
            lateToday,
            halfDayToday,
            monthlySalaryRecords,
            totalExpenses,
            recentEmployees,
            pendingTickets
        ] = await Promise.all([
            User.countDocuments({ adminId, role: 'employee' }),
            User.countDocuments({ adminId, role: 'employee', status: 'active' }),
            Attendance.countDocuments({ adminId, date: { $gte: todayStart, $lte: todayEnd }, status: { $in: ['present', 'wfh'] } }),
            Attendance.countDocuments({ adminId, date: { $gte: todayStart, $lte: todayEnd }, status: 'late' }),
            Attendance.countDocuments({ adminId, date: { $gte: todayStart, $lte: todayEnd }, status: 'half-day' }),
            Salary.find({ adminId, month: currentMonth, year: currentYear }),
            Expense.find({ adminId }),
            User.find({ adminId, role: 'employee' }).sort({ createdAt: -1 }).limit(5).populate('departmentId'),
            Ticket.find({ adminId, status: 'pending' }).sort({ createdAt: -1 }).limit(4).populate('employeeId')
        ]);

        const totalSalary = monthlySalaryRecords.reduce((sum, r) => sum + (r.netSalary || r.totalSalary || 0), 0);
        const totalExpenseAmount = totalExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);

        res.json({
            stats: {
                totalEmployees,
                activeEmployees,
                presentToday: presentToday + lateToday,
                absentToday: totalEmployees - (presentToday + lateToday + halfDayToday),
                halfDayToday,
                totalSalary,
                totalExpenses: totalExpenseAmount,
                totalLeads: 0 // Leads not yet implemented in backend
            },
            recentEmployees,
            pendingTickets
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
        const todayStr = new Date().toISOString().split('T')[0];
        const today = new Date(todayStr);

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
