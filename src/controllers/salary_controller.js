const Salary = require('../models/Salary');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Festival = require('../models/Festival');
const Settings = require('../models/Settings');
const Leave = require('../models/Leave');
const LeaveType = require('../models/LeaveType');
const { isWeeklyOff } = require('../utils/attendance_helpers');
const { runEngine, applyRounding, validateSalary } = require('../utils/payroll_engine');

// Pure computation — returns the salary figures WITHOUT persisting. Used both by
// calculateAndSaveSalary (payroll generation) and the employee dashboard's live
// "earned so far" estimate, so the two never diverge.
//
// When settings.payroll.enabled === true the deterministic engine runs and
// returns an enriched payload (buckets, payableDays, needsReview, etc.).
// When false the legacy calculation path runs verbatim — no surprise changes.
exports.computeSalary = async (adminId, emp, month, year) => {
    const totalDaysInMonth = new Date(year, month, 0).getDate();

    const now = new Date();
    const isCurrentMonth = (now.getFullYear() === year && now.getMonth() + 1 === month);
    const calcUpToDay = isCurrentMonth ? now.getDate() : totalDaysInMonth;

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    // Fetch base data (always needed)
    const [attendanceRecords, festivals, settings] = await Promise.all([
        Attendance.find({ adminId, employeeId: emp._id, date: { $gte: startDate, $lte: endDate } }),
        Festival.find({
            adminId,
            $or: [
                { startDate: { $gte: startDate.toISOString().split('T')[0], $lte: endDate.toISOString().split('T')[0] } },
                { endDate: { $gte: startDate.toISOString().split('T')[0], $lte: endDate.toISOString().split('T')[0] } },
            ]
        }),
        Settings.findOne({ adminId }),
    ]);

    // ── DETERMINISTIC ENGINE PATH ────────────────────────────────────────────
    if (settings && settings.payroll && settings.payroll.enabled === true &&
        (emp.employmentType || 'monthly') === 'monthly') {

        // Fetch leaves + leave-type metadata (engine requires these)
        const [leaves, leaveTypes] = await Promise.all([
            Leave.find({ adminId, employeeId: emp._id, status: 'approved',
                startDate: { $lte: endDate }, endDate: { $gte: startDate } }),
            LeaveType.find({ adminId }),
        ]);
        const leaveTypesById = Object.fromEntries(leaveTypes.map(lt => [String(lt._id), lt]));

        const engineResult = runEngine({
            emp, settings, year, month,
            attendanceRecords, festivals, leaves, leaveTypesById,
            asOfDate: now,
        });

        const {
            config, counts, payableDays, earnedBase, projectedBase,
            projectedPayableDays, totalDaysInWindow, totalDaysInMonth: tdm,
            isMTD, needsReview, dailyRate, dailyRateBasis,
        } = engineResult;

        // Apply salary components (same logic as legacy — components computed on earnedBase)
        const earnings = [];
        const deductions = [];
        let remainingBase = earnedBase;
        let addedOnTop = 0;
        let totalDeductions = 0;
        const c = emp.salaryComponents || {};

        const addComp = (key, label, type) => {
            if (c[key] && c[key].enabled) {
                const amt = c[key].type === 'amount'
                    ? (c[key].amount || 0)
                    : Math.round((earnedBase * (c[key].percentage || 0)) / 100);
                const isInclusive = c[key].includeInTotal !== false;
                if (type === 'earning') {
                    earnings.push({ name: label, amount: amt, included: isInclusive });
                    if (isInclusive) remainingBase -= amt;
                    else addedOnTop += amt;
                } else {
                    deductions.push({ name: label, amount: amt, included: isInclusive });
                    if (isInclusive) totalDeductions += amt;
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
        if (remainingBase !== 0) earnings.push({ name: 'Remaining Balance (Special)', amount: remainingBase, included: true });

        const grossSalary = earnedBase + addedOnTop;
        // Round NET exactly once (SOP §6 — rounding applied once at the end)
        const netSalary = applyRounding(grossSalary - totalDeductions, config.rounding);

        const payTypeRemark = `Engine | ${dailyRateBasis} | Payable: ${payableDays}/${totalDaysInWindow} days${isMTD ? ' (MTD)' : ''}${needsReview ? ' ⚠ review' : ''}`;

        return {
            baseSalary: emp.salary,
            totalSalary: netSalary,
            employmentType: emp.employmentType || 'monthly',
            breakdown: { earnings, deductions },
            remarks: payTypeRemark,
            // Enriched engine fields
            payableDays,
            grossSalary,
            netSalary,
            buckets: counts,
            totalDaysInWindow,
            totalDaysInMonth: tdm,
            earnedSoFar: netSalary,
            projectedFull: applyRounding(projectedBase - totalDeductions, config.rounding),
            isMTD,
            needsReview,
            dailyRateBasisUsed: dailyRateBasis,
            _engineEnabled: true,
        };
    }

    // ── LEGACY PATH (verbatim — no changes) ──────────────────────────────────
    const calcUpToDay_legacy = calcUpToDay; // alias for clarity
    const festivalDates = new Set();
    festivals.forEach(f => {
        let current = new Date(f.startDate);
        let last = new Date(f.endDate || f.startDate);
        while (current <= last) {
            festivalDates.add(current.toISOString().split('T')[0]);
            current.setDate(current.getDate() + 1);
        }
    });

    const attendanceMap = new Map();
    attendanceRecords.forEach(rec => {
        const dateStr = rec.date.toISOString().split('T')[0];
        attendanceMap.set(dateStr, rec);
    });

    let holidayWorkDays = 0;
    let weeklyOffCount = 0;
    let festivalCount = 0;
    const weeklyHolidays = emp.weeklyHolidays || [];

    for (let d = 1; d <= calcUpToDay_legacy; d++) {
        const date = new Date(year, month - 1, d);
        const dateStr = date.toISOString().split('T')[0];
        const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
        const isFestival = festivalDates.has(dateStr);
        const isOff = isWeeklyOff(dayName, d, weeklyHolidays, settings?.attendance?.workDays);
        const attendance = attendanceMap.get(dateStr);
        if (isFestival || isOff) {
            if (attendance && (attendance.status === 'present' || attendance.status === 'late')) {
                holidayWorkDays += 1;
            } else if (attendance && attendance.status === 'half-day') {
                holidayWorkDays += 0.5;
            }
            if (isFestival) festivalCount++;
            else if (isOff) weeklyOffCount++;
        }
    }

    const normalWorkingAttendance = attendanceRecords.reduce((sum, rec) => {
        const dateStr = rec.date.toISOString().split('T')[0];
        if (festivalDates.has(dateStr)) return sum;
        const dayName = rec.date.toLocaleDateString('en-US', { weekday: 'long' });
        const isOff = isWeeklyOff(dayName, rec.date.getDate(), weeklyHolidays, settings?.attendance?.workDays);
        if (isOff) return sum;
        if (rec.status === 'present' || rec.status === 'late') return sum + 1;
        if (rec.status === 'half-day') return sum + 0.5;
        return sum;
    }, 0);

    const payableDays = normalWorkingAttendance + festivalCount + weeklyOffCount + (holidayWorkDays * 2);
    const employmentType = emp.employmentType || 'monthly';
    let earnedBase = 0;
    let payTypeRemark = '';

    if (employmentType === 'monthly') {
        const perDaySalary = (emp.salary || 0) / totalDaysInMonth;
        earnedBase = Math.round(perDaySalary * payableDays);
        payTypeRemark = `Monthly | Payable: ${payableDays}/${totalDaysInMonth} days`;
    } else if (employmentType === 'daily') {
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
        let totalHoursWorked = 0;
        attendanceRecords.forEach(rec => {
            if (rec.punchIn && rec.punchOut) {
                totalHoursWorked += (rec.punchOut - rec.punchIn) / (1000 * 60 * 60);
            }
        });
        earnedBase = Math.round((emp.salary || 0) * totalHoursWorked);
        payTypeRemark = `Hourly | Hours Worked: ${totalHoursWorked.toFixed(2)}`;
    }

    const earnings = [];
    const deductions = [];
    let remainingBase = earnedBase;
    let addedOnTop = 0;
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
            const isInclusive = c[key].includeInTotal !== false;
            if (type === 'earning') {
                earnings.push({ name: label, amount: amt, included: isInclusive });
                if (isInclusive) remainingBase -= amt;
                else addedOnTop += amt;
            } else {
                const isDeducted = c[key].includeInTotal !== false;
                deductions.push({ name: label, amount: amt, included: isDeducted });
                if (isDeducted) totalDeductions += amt;
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

    if (remainingBase !== 0) {
        earnings.push({ name: 'Remaining Balance (Special)', amount: remainingBase, included: true });
    }

    const grossSalary = earnedBase + addedOnTop;
    const netSalary = grossSalary - totalDeductions;

    return {
        baseSalary: emp.salary,
        totalSalary: netSalary,
        employmentType,
        breakdown: { earnings, deductions },
        remarks: payTypeRemark,
        payableDays,
        grossSalary,
        netSalary,
    };
};

// Compute + persist a Salary record (payroll generation).
exports.calculateAndSaveSalary = async (adminId, emp, month, year) => {
    const r = await exports.computeSalary(adminId, emp, month, year);

    const now = new Date();
    const isCurrentMonth = now.getFullYear() === year && now.getMonth() + 1 === month;

    let status = isCurrentMonth ? 'pending' : 'final';
    let remarks = r.remarks;

    const update = {
        baseSalary: r.baseSalary,
        totalSalary: r.totalSalary,
        employmentType: r.employmentType,
        breakdown: r.breakdown,
        remarks,
        status,
        grossSalary: r.grossSalary,
        netSalary: r.netSalary,
    };

    if (r._engineEnabled) {
        // Validate before persisting — flag bad records rather than silently paying wrong amounts
        const validation = validateSalary({
            counts: r.buckets,
            windowEnd: r.totalDaysInWindow,
            baseSalary: r.baseSalary,
            netSalary: r.netSalary,
        });
        const needsReview = r.needsReview || !validation.ok;
        if (needsReview && validation.errors.length) {
            update.remarks = `${remarks} | Validation: ${validation.errors.join('; ')}`;
        }

        Object.assign(update, {
            buckets: r.buckets,
            payableDays: r.payableDays,
            totalDaysInWindow: r.totalDaysInWindow,
            dailyRateBasis: r.dailyRateBasisUsed,
            needsReview,
            status: needsReview ? 'review' : status,
        });
    }

    return await Salary.findOneAndUpdate(
        { adminId, employeeId: emp._id, month, year },
        update,
        { upsert: true, new: true }
    );
};

exports.generateSalaries = async (req, res) => {
    try {
        const { month, year } = req.body;
        if (!month || !year) return res.status(400).json({ message: 'Month and Year are required' });

        const adminId = req.adminId;

        const employees = await User.find({ adminId, role: 'employee', status: 'active' });

        const results = [];
        const needsReview = [];
        const errors = [];

        for (const emp of employees) {
            try {
                const salaryRecord = await exports.calculateAndSaveSalary(adminId, emp, month, year);
                results.push(salaryRecord);
                if (salaryRecord.needsReview || salaryRecord.status === 'review') {
                    needsReview.push({ employeeId: emp._id, name: emp.name, remarks: salaryRecord.remarks });
                }
            } catch (err) {
                errors.push({ employeeId: emp._id, name: emp.name, error: err.message });
            }
        }

        res.status(201).json({
            message: `Generated ${results.length} salary records`,
            count: results.length,
            needsReview,
            errors,
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

