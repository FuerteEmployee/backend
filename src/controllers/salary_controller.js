const Salary = require('../models/Salary');
const AdvanceSalaryRequest = require('../models/AdvanceSalaryRequest');
const Expense = require('../models/Expense');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Festival = require('../models/Festival');
const Settings = require('../models/Settings');
const Leave = require('../models/Leave');
const LeaveType = require('../models/LeaveType');
const { isWeeklyOff, istDateKey, istCalendarDate, toLocalDateKey } = require('../utils/attendance_helpers');
const { runEngine, applyRounding, validateSalary, buildLeaveMap } = require('../utils/payroll_engine');

// Pure computation — returns the salary figures WITHOUT persisting. Used both by
// calculateAndSaveSalary (payroll generation) and the employee dashboard's live
// "earned so far" estimate, so the two never diverge.
//
// When settings.payroll.enabled === true the deterministic engine runs and
// returns an enriched payload (buckets, payableDays, needsReview, etc.).
// When false the legacy calculation path runs verbatim — no surprise changes.
exports.computeSalary = async (adminId, emp, month, year, advanceDeductionAmount = 0, reimbursementAmount = 0) => {
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

    // Approved leaves overlapping the window — needed by both paths so a
    // legacy-path tenant's approved leave actually affects payroll too,
    // not just engine-path tenants.
    const [leaves, leaveTypes] = await Promise.all([
        Leave.find({ adminId, employeeId: emp._id, status: 'approved',
            startDate: { $lte: endDate }, endDate: { $gte: startDate } }),
        LeaveType.find({ adminId }),
    ]);
    const leaveTypesById = Object.fromEntries(leaveTypes.map(lt => [String(lt._id), lt]));
    const leaveByKeyLegacy = buildLeaveMap(leaves, leaveTypesById, year, month);

    // ── Overtime (shared by both the legacy and engine paths below) ─────────
    // Extra worked time beyond `otThreshold` hours on a given day, paid at
    // `otMultiplier` × an hourly rate derived from the monthly salary, capped
    // at `weeklyOT` hours per ~7-day slice of the payable window. Only applies
    // to monthly employees — daily/hourly pay already prices actual hours.
    const otThreshold = settings?.attendance?.otThreshold || 9;
    const otMultiplier = settings?.attendance?.otMultiplier ?? 1.5;
    const weeklyOTCap = settings?.attendance?.weeklyOT || 45;
    let overtimeHours = 0;
    if ((emp.employmentType || 'monthly') === 'monthly') {
        attendanceRecords.forEach(rec => {
            if (!rec.totalWorkMs) return;
            const hoursWorked = rec.totalWorkMs / (1000 * 60 * 60);
            if (hoursWorked > otThreshold) overtimeHours += (hoursWorked - otThreshold);
        });
        const otCap = weeklyOTCap * Math.max(1, Math.ceil(calcUpToDay / 7));
        overtimeHours = Math.min(overtimeHours, otCap);
    }
    const hourlyRateForOT = (emp.salary || 0) / totalDaysInMonth / (settings?.attendance?.reqHours || 8);
    const overtimeAmount = (overtimeHours > 0 && otMultiplier > 0)
        ? Math.round(hourlyRateForOT * otMultiplier * overtimeHours)
        : 0;
    const overtimeLabel = `Overtime (${overtimeHours.toFixed(1)}h @ ${otMultiplier}x)`;

    // ── DETERMINISTIC ENGINE PATH ────────────────────────────────────────────
    if (settings && settings.payroll && settings.payroll.enabled === true &&
        (emp.employmentType || 'monthly') === 'monthly') {

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
        // Zero payable days means no attendance, no paid leave, and no paid
        // weekly-off/holiday credit this window — nothing was earned, so no
        // salary component (including flat "add on top" ones like Bonus)
        // should apply either. Without this, an employee who never punched
        // in could still show a non-zero salary from a flat allowance.
        const hasPayableDays = payableDays > 0;

        const addComp = (key, label, type) => {
            if (!hasPayableDays) return;
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

        if (advanceDeductionAmount > 0) {
            deductions.push({ name: 'Advance Salary Recovery', amount: advanceDeductionAmount, included: true });
            totalDeductions += advanceDeductionAmount;
        }

        if (reimbursementAmount > 0 && payableDays > 0) {
            earnings.push({ name: 'Expense Reimbursement', amount: reimbursementAmount, included: true });
            addedOnTop += reimbursementAmount;
        }

        if (overtimeAmount > 0 && payableDays > 0) {
            earnings.push({ name: overtimeLabel, amount: overtimeAmount, included: true });
            addedOnTop += overtimeAmount;
        }

        const grossSalary = earnedBase + addedOnTop;
        // Round NET exactly once (SOP §6 — rounding applied once at the end)
        const netSalary = applyRounding(grossSalary - totalDeductions, config.rounding);

        const payTypeRemark = !hasPayableDays
            ? `Engine | ${dailyRateBasis} | No attendance recorded — nothing payable (${totalDaysInWindow}-day window)`
            : `Engine | ${dailyRateBasis} | Payable: ${payableDays}/${totalDaysInWindow} days${isMTD ? ' (MTD)' : ''}${needsReview ? ' ⚠ review' : ''}`;

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

    // ── LEGACY PATH ──────────────────────────────────────────────────────────
    const joinDate = emp.joiningDate ? new Date(emp.joiningDate) : null;
    const joinsThisMonth = joinDate && joinDate.getFullYear() === year && joinDate.getMonth() + 1 === month;
    const startDay = joinsThisMonth ? joinDate.getDate() : 1;

    // Guard if joined after the requested month
    if (joinDate && joinDate > endDate) {
        return {
            baseSalary: emp.salary,
            totalSalary: 0,
            employmentType: emp.employmentType || 'monthly',
            breakdown: { earnings: [], deductions: [] },
            remarks: 'Joined after this pay period',
            payableDays: 0,
            grossSalary: 0,
            netSalary: 0,
            earnedSoFar: 0,
        };
    }

    const calcUpToDay_legacy = calcUpToDay; // alias for clarity
    const festivalDates = new Set();
    festivals.forEach(f => {
        let current = new Date(f.startDate);
        let last = new Date(f.endDate || f.startDate);
        while (current <= last) {
            festivalDates.add(toLocalDateKey(current));
            current.setDate(current.getDate() + 1);
        }
    });

    const attendanceMap = new Map();
    attendanceRecords.forEach(rec => {
        attendanceMap.set(istDateKey(rec.date), rec);
    });

    let holidayWorkDays = 0;
    let weeklyOffCount = 0;
    let festivalCount = 0;
    let leavePaidDays = 0;
    const weeklyHolidays = emp.weeklyHolidays || [];

    const isAbsentLikeLegacy = (dayNum) => {
        const date = new Date(year, month - 1, dayNum);
        const dateStr = toLocalDateKey(date);
        const rec = attendanceMap.get(dateStr);
        if (rec && ['present', 'late', 'half-day', 'wfh'].includes(rec.status)) return false;
        // An approved PAID leave is authorised time off, not an unexcused
        // absence — don't let it "sandwich-condemn" an adjacent holiday/weekly-off.
        const leave = leaveByKeyLegacy.get(dateStr);
        if (leave && leave.isPaid) return false;
        return true;
    };

    const isWorkingDayLegacy = (dayNum) => {
        const date = new Date(year, month - 1, dayNum);
        const dateStr = toLocalDateKey(date);
        const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
        const isFestival = festivalDates.has(dateStr);
        const isOff = isWeeklyOff(dayName, dayNum, weeklyHolidays, settings?.attendance?.workDays, emp?.shiftId?.workDays);
        return !isFestival && !isOff;
    };

    for (let d = startDay; d <= calcUpToDay_legacy; d++) {
        const date = new Date(year, month - 1, d);
        const dateStr = toLocalDateKey(date);
        const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
        const isFestival = festivalDates.has(dateStr);
        const isOff = isWeeklyOff(dayName, d, weeklyHolidays, settings?.attendance?.workDays, emp?.shiftId?.workDays);
        const attendance = attendanceMap.get(dateStr);
        if (isFestival || isOff) {
            if (attendance && (attendance.status === 'present' || attendance.status === 'late')) {
                holidayWorkDays += 1;
            } else if (attendance && attendance.status === 'half-day') {
                holidayWorkDays += 0.5;
            }

            let isSandwiched = false;
            if (settings?.payroll?.sandwichRuleEnabled !== false) {
                let prevWorkingDay = null;
                for (let j = d - 1; j >= startDay; j--) {
                    if (isWorkingDayLegacy(j)) {
                        prevWorkingDay = j;
                        break;
                    }
                }
                let nextWorkingDay = null;
                for (let j = d + 1; j <= calcUpToDay_legacy; j++) {
                    if (isWorkingDayLegacy(j)) {
                        nextWorkingDay = j;
                        break;
                    }
                }

                if (prevWorkingDay !== null && nextWorkingDay !== null) {
                    isSandwiched = isAbsentLikeLegacy(prevWorkingDay) && isAbsentLikeLegacy(nextWorkingDay);
                } else if (prevWorkingDay !== null) {
                    isSandwiched = isAbsentLikeLegacy(prevWorkingDay);
                } else if (nextWorkingDay !== null) {
                    isSandwiched = isAbsentLikeLegacy(nextWorkingDay);
                }
            }

            if (!isSandwiched || (attendance && ['present', 'late', 'half-day', 'wfh'].includes(attendance.status))) {
                if (isFestival) festivalCount++;
                else if (isOff) weeklyOffCount++;
            }
        } else if (!(attendance && ['present', 'late', 'half-day', 'wfh'].includes(attendance.status))) {
            // Ordinary working day, nobody physically attended — if there's an
            // approved leave for this exact day, charge it against leave
            // (paid or not) instead of silently counting it as an unexcused
            // absence. This is the legacy path's equivalent of the engine's
            // per-day leave bucket.
            const leave = leaveByKeyLegacy.get(dateStr);
            if (leave && leave.isPaid) leavePaidDays += 1;
        }
    }

    const normalWorkingAttendance = attendanceRecords.reduce((sum, rec) => {
        if (joinDate && rec.date < joinDate) return sum;
        const dateStr = istDateKey(rec.date);
        if (festivalDates.has(dateStr)) return sum;
        const recDay = istCalendarDate(rec.date);
        const dayName = recDay.toLocaleDateString('en-US', { weekday: 'long' });
        const isOff = isWeeklyOff(dayName, recDay.getDate(), weeklyHolidays, settings?.attendance?.workDays, emp?.shiftId?.workDays);
        if (isOff) return sum;
        if (rec.status === 'present' || rec.status === 'late' || rec.status === 'wfh') return sum + 1;
        if (rec.status === 'half-day') return sum + 0.5;
        return sum;
    }, 0);

    // The sandwich rule already unpays a weekly-off/festival flanked by
    // absence on both sides, but it can't do that at a window edge with no
    // neighbour on one side to check (e.g. payroll run on/right after the
    // very day someone joined). If there's literally zero actual attendance
    // in the whole window, don't credit any weekly-off/festival day either —
    // there's no work pattern here to be compensating rest days for.
    if (normalWorkingAttendance === 0) {
        festivalCount = 0;
        weeklyOffCount = 0;
    }

    const totalDaysInWindow = calcUpToDay_legacy - startDay + 1;
    const payableDays = normalWorkingAttendance + festivalCount + weeklyOffCount + (holidayWorkDays * 2) + leavePaidDays;
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
    // Zero payable days means no attendance, no paid leave, and no paid
    // weekly-off/holiday credit this window — nothing was earned, so no
    // salary component (including flat "add on top" ones like Bonus)
    // should apply either. Without this, an employee who never punched in
    // could still show a non-zero salary from a flat allowance.
    const hasPayableDays = payableDays > 0;

    const addComp = (key, label, type) => {
        if (!hasPayableDays) return;
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

    if (advanceDeductionAmount > 0) {
        deductions.push({ name: 'Advance Salary Recovery', amount: advanceDeductionAmount, included: true });
        totalDeductions += advanceDeductionAmount;
    }

    if (reimbursementAmount > 0 && payableDays > 0) {
        earnings.push({ name: 'Expense Reimbursement', amount: reimbursementAmount, included: true });
        addedOnTop += reimbursementAmount;
    }

    if (overtimeAmount > 0 && payableDays > 0) {
        earnings.push({ name: overtimeLabel, amount: overtimeAmount, included: true });
        addedOnTop += overtimeAmount;
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
        totalDaysInWindow,
    };
};

// Compute + persist a Salary record (payroll generation).
//
// advanceRequestIds: approved advance-salary/loan request ids to recover as a
// deduction in this run (from the targeted per-employee "apply advance
// deduction" flow). Any advances already linked to this employee's record for
// this month/year (from an earlier run) are automatically re-applied too, so a
// later bulk regenerate can't silently drop an already-included recovery.
exports.calculateAndSaveSalary = async (adminId, emp, month, year, advanceRequestIds = [], expenseIds = []) => {
    const existing = await Salary.findOne({ adminId, employeeId: emp._id, month, year })
        .select('deductedAdvanceRequestIds reimbursedExpenseIds')
        .lean();
    const existingIds = (existing?.deductedAdvanceRequestIds || []).map(String);
    const allAdvanceIds = Array.from(new Set([...existingIds, ...advanceRequestIds.map(String)]));

    let advances = [];
    if (allAdvanceIds.length) {
        // 'repaid' is included so an advance already recovered by an earlier run
        // of this same month keeps being reflected on every recompute.
        advances = await AdvanceSalaryRequest.find({
            _id: { $in: allAdvanceIds },
            employeeId: emp._id,
            companyId: adminId,
            status: { $in: ['approved', 'repaid'] },
        });
    }
    const advanceDeductionAmount = advances.reduce((sum, a) => sum + (a.approvedAmount ?? a.amount), 0);

    const existingExpenseIds = (existing?.reimbursedExpenseIds || []).map(String);
    const allExpenseIds = Array.from(new Set([...existingExpenseIds, ...expenseIds.map(String)]));

    let expenses = [];
    if (allExpenseIds.length) {
        // 'reimbursed' is included so an expense already reimbursed by an earlier
        // run of this same month keeps being reflected on every recompute.
        expenses = await Expense.find({
            _id: { $in: allExpenseIds },
            employeeId: emp._id,
            adminId,
            status: { $in: ['approved', 'reimbursed'] },
        });
    }
    const reimbursementAmount = expenses.reduce((sum, e) => sum + e.amount, 0);

    const r = await exports.computeSalary(adminId, emp, month, year, advanceDeductionAmount, reimbursementAmount);

    const now = new Date();
    const isCurrentMonth = now.getFullYear() === year && now.getMonth() + 1 === month;

    let status = isCurrentMonth ? 'pending' : 'final';
    let remarks = r.remarks;

    const update = {
        baseSalary: r.baseSalary,
        totalSalary: r.totalSalary,
        employmentType: r.employmentType,
        breakdown: r.breakdown,
        deductions: (r.breakdown.deductions || []).reduce((s, d) => s + (d.amount || 0), 0),
        deductedAdvanceRequestIds: advances.map(a => a._id),
        reimbursedExpenseIds: r.payableDays > 0 ? expenses.map(e => e._id) : [],
        remarks,
        status,
        grossSalary: r.grossSalary,
        netSalary: r.netSalary,
        payableDays: r.payableDays,
        totalDaysInWindow: r.totalDaysInWindow,
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
            dailyRateBasis: r.dailyRateBasisUsed,
            needsReview,
            status: needsReview ? 'review' : status,
        });
    }

    const saved = await Salary.findOneAndUpdate(
        { adminId, employeeId: emp._id, month, year },
        update,
        { upsert: true, new: true }
    );

    // Only newly-included advances need the status flip — ones already 'repaid'
    // from a prior run of this same month are left untouched.
    const newlyDeducted = advances.filter(a => a.status === 'approved');
    if (newlyDeducted.length) {
        await AdvanceSalaryRequest.updateMany(
            { _id: { $in: newlyDeducted.map(a => a._id) } },
            { status: 'repaid', repaidAt: now, deductedInMonth: new Date(year, month - 1, 1) }
        );
    }

    // Only newly-included expenses need the status flip — ones already
    // 'reimbursed' from a prior run of this same month are left untouched.
    // If payableDays is 0, expenses are held back for a month with payable days.
    const newlyReimbursed = r.payableDays > 0 ? expenses.filter(e => e.status === 'approved') : [];
    if (newlyReimbursed.length) {
        await Expense.updateMany(
            { _id: { $in: newlyReimbursed.map(e => e._id) } },
            { status: 'reimbursed', reimbursedInMonth: new Date(year, month - 1, 1) }
        );
    }

    return saved;
};

// Recompute + save salary for a single employee, optionally recovering one or
// more of their approved advance-salary/loan requests in this run. Used by the
// payroll UI's per-employee "apply advance deduction" action.
exports.generateSalaryForEmployee = async (req, res) => {
    try {
        const { employeeId, month, year, advanceRequestIds, expenseIds } = req.body;
        if (!employeeId || !month || !year) {
            return res.status(400).json({ message: 'employeeId, month and year are required' });
        }

        const adminId = req.adminId;
        const emp = await User.findOne({ _id: employeeId, adminId, role: 'employee' }).populate('shiftId');
        if (!emp) return res.status(404).json({ message: 'Employee not found' });

        const salaryRecord = await exports.calculateAndSaveSalary(
            adminId, emp, Number(month), Number(year),
            Array.isArray(advanceRequestIds) ? advanceRequestIds : [],
            Array.isArray(expenseIds) ? expenseIds : []
        );
        res.status(200).json(salaryRecord);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.generateSalaries = async (req, res) => {
    try {
        const { month, year } = req.body;
        if (!month || !year) return res.status(400).json({ message: 'Month and Year are required' });

        const adminId = req.adminId;

        const employees = await User.find({ adminId, role: 'employee', status: 'active' }).populate('shiftId');

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

