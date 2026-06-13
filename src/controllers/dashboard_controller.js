const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Salary = require('../models/Salary');
const Expense = require('../models/Expense');
const Ticket = require('../models/Ticket');

exports.getSummary = async (req, res) => {
    try {
        const adminId = req.adminId;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

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
            Attendance.countDocuments({ adminId, date: { $gte: today }, status: 'present' }),
            Attendance.countDocuments({ adminId, date: { $gte: today }, status: 'late' }),
            Attendance.countDocuments({ adminId, date: { $gte: today }, status: 'half-day' }),
            Salary.find({ adminId }), // You might want to filter by current month
            Expense.find({ adminId }),
            User.find({ adminId, role: 'employee' }).sort({ createdAt: -1 }).limit(5).populate('departmentId'),
            Ticket.find({ adminId, status: 'pending' }).sort({ createdAt: -1 }).limit(4).populate('employeeId')
        ]);

        const totalSalary = monthlySalaryRecords.reduce((sum, r) => sum + (r.netSalary || 0), 0);
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
            Attendance.findOne({ employeeId, date: today }),
            Attendance.find({ employeeId, date: { $gte: startDate, $lte: endDate } }),
            Salary.findOne({ employeeId, month, year }),
            User.findById(employeeId).populate('shiftId branchId')
        ]);

        // 2. Calculate Monthly Stats
        let presentCount = 0;
        let halfDayCount = 0;
        let wfhCount = 0;
        let lateCount = 0;

        monthlyAttendance.forEach(rec => {
            if (rec.status === 'present') presentCount++;
            else if (rec.status === 'half-day') halfDayCount++;
            else if (rec.status === 'late') {
                presentCount++;
                lateCount++;
            }
            
            if (rec.remarks?.toLowerCase().includes('work from home') || rec.remarks?.toLowerCase().includes('wfh')) {
                wfhCount++;
            }
        });

        // 3. Calculate Absent Days
        // We need to know how many days have passed in the month so far (up to today or end of month)
        const currentMonth = new Date().getMonth() + 1;
        const currentYear = new Date().getFullYear();
        
        let lastDayToTrack;
        if (year < currentYear || (year === currentYear && month < currentMonth)) {
            lastDayToTrack = new Date(year, month, 0).getDate();
        } else if (year === currentYear && month === currentMonth) {
            lastDayToTrack = new Date().getDate();
        } else {
            lastDayToTrack = 0; // Future month
        }

        // Count expected working days (excluding weekly offs)
        let expectedWorkingDays = 0;
        const weeklyHolidays = user?.weeklyHolidays || [];
        
        for (let d = 1; d <= lastDayToTrack; d++) {
            const date = new Date(year, month - 1, d);
            const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
            
            const isOff = weeklyHolidays.some(h => h.day === dayName && (h.weeks.length === 0 || h.weeks.includes(Math.ceil(d / 7))));
            if (!isOff) expectedWorkingDays++;
        }

        // Simple Absent calculation: Expected - (Present + HalfDay + Late)
        // Note: Real world logic might include holiday checks too.
        const absentCount = Math.max(0, expectedWorkingDays - (presentCount + halfDayCount));

        res.json({
            today: {
                punchedIn: !!todayAttendance?.punchIn,
                punchedOut: !!todayAttendance?.punchOut,
                status: todayAttendance?.status || 'not punched in',
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
                year
            },
            salary: {
                amount: salary?.totalSalary || user?.salary || 0,
                status: salary?.status || 'pending',
                isGenerated: !!salary
            }
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
