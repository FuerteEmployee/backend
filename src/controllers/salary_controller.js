const Salary = require('../models/Salary');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Festival = require('../models/Festival');
const Settings = require('../models/Settings');
const { isWeeklyOff } = require('../utils/attendance_helpers');

exports.calculateAndSaveSalary = async (adminId, emp, month, year) => {
    const totalDaysInMonth = new Date(year, month, 0).getDate();

    // Cap calculation to today if we're in the current month, else use full month
    const now = new Date();
    const isCurrentMonth = (now.getFullYear() === year && now.getMonth() + 1 === month);
    const calcUpToDay = isCurrentMonth ? now.getDate() : totalDaysInMonth;

    // 2. Fetch Data (Attendance, Festivals, and Settings)
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    const [attendanceRecords, festivals, settings] = await Promise.all([
        Attendance.find({
            adminId: adminId,
            employeeId: emp._id,
            date: { $gte: startDate, $lte: endDate }
        }),
        Festival.find({
            adminId: adminId,
            $or: [
                { startDate: { $gte: startDate.toISOString().split('T')[0], $lte: endDate.toISOString().split('T')[0] } },
                { endDate: { $gte: startDate.toISOString().split('T')[0], $lte: endDate.toISOString().split('T')[0] } }
            ]
        }),
        Settings.findOne({ adminId: adminId })
    ]);

    const festivalDates = new Set();
    festivals.forEach(f => {
        let current = new Date(f.startDate);
        let last = new Date(f.endDate || f.startDate);
        while (current <= last) {
            festivalDates.add(current.toISOString().split('T')[0]);
            current.setDate(current.getDate() + 1);
        }
    });

    // 3. Map Attendance for quick access
    const attendanceMap = new Map();
    attendanceRecords.forEach(rec => {
        const dateStr = rec.date.toISOString().split('T')[0];
        attendanceMap.set(dateStr, rec);
    });

    let holidayWorkDays = 0; // Days worked on a festival/weekly-off
    let weeklyOffCount = 0;
    let festivalCount = 0;
    const weeklyHolidays = emp.weeklyHolidays || [];

    // Only count days up to today (mid-month) to avoid counting future holidays
    for (let d = 1; d <= calcUpToDay; d++) {
        const date = new Date(year, month - 1, d);
        const dateStr = date.toISOString().split('T')[0];
        const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });

        const isFestival = festivalDates.has(dateStr);
        const isOff = isWeeklyOff(dayName, d, weeklyHolidays, settings?.attendance?.workDays);

        const attendance = attendanceMap.get(dateStr);

        if (isFestival || isOff) {
            // It's a non-working day. If they worked, it's an "Increase" (Bonus)
            if (attendance && (attendance.status === 'present' || attendance.status === 'late')) {
                holidayWorkDays += 1;
            } else if (attendance && attendance.status === 'half-day') {
                holidayWorkDays += 0.5;
            }

            // Count as a paid day regardless (Salary Increases Automatically)
            if (isFestival) festivalCount++;
            else if (isOff) weeklyOffCount++;
        }
    }

    // 6. Calculate Total Payable Days
    // Base = Present + (HalfDay * 0.5) [On normal days]
    const normalWorkingAttendance = attendanceRecords.reduce((sum, rec) => {
        const dateStr = rec.date.toISOString().split('T')[0];
        if (festivalDates.has(dateStr)) return sum; // Handled in holidayWorkDays
        
        const dayName = rec.date.toLocaleDateString('en-US', { weekday: 'long' });
        const isOff = isWeeklyOff(dayName, rec.date.getDate(), weeklyHolidays, settings?.attendance?.workDays);
        
        if (isOff) return sum; // Handled in holidayWorkDays

        if (rec.status === 'present' || rec.status === 'late') return sum + 1;
        if (rec.status === 'half-day') return sum + 0.5;
        return sum;
    }, 0);

    // Payable Days = Normal Attendance + Festivals + WeeklyOffs + (Holiday Work * 2 Bonus)
    const payableDays = normalWorkingAttendance + festivalCount + weeklyOffCount + (holidayWorkDays * 2);
    const employmentType = emp.employmentType || 'monthly';
    let earnedBase = 0;
    let payTypeRemark = '';

    if (employmentType === 'monthly') {
        // Pro-rata: (Monthly Salary / Total Days) * Payable Days
        const perDaySalary = (emp.salary || 0) / totalDaysInMonth;
        earnedBase = Math.round(perDaySalary * payableDays);
        payTypeRemark = `Monthly | Payable: ${payableDays}/${totalDaysInMonth} days`;

    } else if (employmentType === 'daily') {
        // Daily: calculate based on total hours / reqHours if applicable, otherwise fallback to standard day count
        const reqHours = settings?.attendance?.reqHours || 8;
        
        let totalHoursWorked = 0;
        attendanceRecords.forEach(rec => {
            if (rec.punchIn && rec.punchOut) {
                totalHoursWorked += (rec.punchOut - rec.punchIn) / (1000 * 60 * 60);
            } else if (rec.status === 'present' || rec.status === 'late') {
                totalHoursWorked += reqHours;
            } else if (rec.status === 'half-day') {
                totalHoursWorked += (settings?.attendance?.halfDayHours || 4);
            }
        });
        
        const actualDaysWorkedByHours = parseFloat((totalHoursWorked / reqHours).toFixed(2));
        earnedBase = Math.round((emp.salary || 0) * actualDaysWorkedByHours);
        payTypeRemark = `Daily | Days Worked: ${actualDaysWorkedByHours} (${totalHoursWorked.toFixed(1)} hrs / ${reqHours} req)`;

    } else if (employmentType === 'hourly') {
        // Hourly: salary is per-hour rate × total hours worked from punch records
        let totalHoursWorked = 0;
        attendanceRecords.forEach(rec => {
            if (rec.punchIn && rec.punchOut) {
                const hours = (rec.punchOut - rec.punchIn) / (1000 * 60 * 60);
                totalHoursWorked += hours;
            }
        });
        earnedBase = Math.round((emp.salary || 0) * totalHoursWorked);
        payTypeRemark = `Hourly | Hours Worked: ${totalHoursWorked.toFixed(2)}`;
    }

    // 7. Calculate Components (Earnings & Deductions)
    const earnings = [];
    const deductions = [];
    let remainingBase = earnedBase; // For Inclusive components (carved out of base)
    let addedOnTop = 0;             // For Exclusive components (added on top of base)
    let totalDeductions = 0;

    const c = emp.salaryComponents || {};

    const addComp = (key, label, type) => {
        if (c[key] && c[key].enabled) {
            let amt = 0;
            if (c[key].type === 'amount') {
                amt = c[key].amount || 0;
            } else {
                amt = Math.round((earnedBase * (c[key].percentage || 0)) / 100);
            }

            const isInclusive = c[key].includeInTotal !== false; // Default to true

            if (type === 'earning') {
                earnings.push({ name: label, amount: amt, included: isInclusive });
                if (isInclusive) {
                    remainingBase -= amt; // Consume from base salary
                } else {
                    addedOnTop += amt;    // Add on top of base salary
                }
            } else {
                const isDeducted = c[key].includeInTotal !== false;
                deductions.push({ name: label, amount: amt, included: isDeducted });
                if (isDeducted) {
                    totalDeductions += amt;
                }
            }
        }
    };

    addComp('basic', 'Basic Salary', 'earning');
    addComp('da', 'DA', 'earning');
    addComp('hra', 'HRA', 'earning');
    addComp('ca', 'Conveyance Allowance', 'earning');
    addComp('bonus', 'Bonus', 'earning');
    addComp('tds', 'TDS', 'deduction');
    addComp('pf', 'PF', 'deduction');
    addComp('esic', 'ESIC', 'deduction');
    addComp('epf', 'EPF', 'deduction');
    addComp('pt', 'Professional Tax', 'deduction');
    addComp('retention', 'Retention', 'deduction');
    addComp('adminCharge', 'Admin Charges', 'deduction');

    // Push the remaining base salary as "Special Allowance" if any remains
    if (remainingBase !== 0) {
        earnings.push({ name: 'Remaining Balance (Special)', amount: remainingBase, included: true });
    }

    const grossSalary = earnedBase + addedOnTop;
    const netSalary = grossSalary - totalDeductions;

    return await Salary.findOneAndUpdate(
        { adminId, employeeId: emp._id, month, year },
        {
            baseSalary: emp.salary,
            totalSalary: netSalary,
            status: 'pending',
            employmentType,
            breakdown: {
                earnings: earnings, // Completely represents the gross salary now
                deductions
            },
            remarks: payTypeRemark
        },
        { upsert: true, new: true }
    );
};

exports.generateSalaries = async (req, res) => {
    try {
        const { month, year } = req.body;
        if (!month || !year) return res.status(400).json({ message: 'Month and Year are required' });

        const adminId = req.adminId;

        // 1. Fetch all active employees
        const employees = await User.find({
            adminId: adminId,
            role: 'employee',
            status: 'active'
        });

        const results = [];
        for (const emp of employees) {
            const salaryRecord = await exports.calculateAndSaveSalary(adminId, emp, month, year);
            results.push(salaryRecord);
        }


        res.status(201).json({
            message: `Generated ${results.length} salary records`,
            count: results.length
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.getSalaryByEmployee = async (req, res) => {
    try {
        const salaries = await Salary.find({
            adminId: req.adminId,
            employeeId: req.params.employeeId
        }).sort({ year: -1, month: -1 });
        res.json(salaries);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.getMonthlyReport = async (req, res) => {
    try {
        const { month, year } = req.query;
        const salaries = await Salary.find({
            adminId: req.adminId,
            month,
            year
        }).populate('employeeId', 'name phone');
        res.json(salaries);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateSalary = async (req, res) => {
    try {
        const salary = await Salary.findOneAndUpdate(
            { _id: req.params.id, adminId: req.adminId },
            req.body,
            { new: true }
        );
        if (!salary) return res.status(404).json({ message: 'Salary record not found' });
        res.json(salary);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.deleteSalary = async (req, res) => {
    try {
        const { id } = req.params;
        await Salary.findOneAndDelete({
            _id: id,
            adminId: req.adminId
        });
        res.json({ message: 'Salary record deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

