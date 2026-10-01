const Salary = require('../models/Salary');
const AdvanceSalaryRequest = require('../models/AdvanceSalaryRequest');
const Expense = require('../models/Expense');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Festival = require('../models/Festival');
const Settings = require('../models/Settings');
const Leave = require('../models/Leave');
const LeaveType = require('../models/LeaveType');
const mongoose = require('mongoose');
const { isWeeklyOff, istDateKey, istCalendarDate, istMonthRange, toLocalDateKey } = require('../utils/attendance_helpers');
const { runEngine, applyRounding, validateSalary, buildLeaveMap } = require('../utils/payroll_engine');
const { withEmployeeLock } = require('../utils/employee_lock');

const pad2 = (n) => String(n).padStart(2, '0');

// Today's IST calendar day as { y, m, d }, whatever timezone the host runs in.
// `new Date().getDate()` on a UTC server is still yesterday until 05:30 IST.
function istToday() {
    const t = istCalendarDate(new Date());
    return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), date: t };
}

// An employee's joining date as a 'YYYY-MM-DD' IST calendar key, or null.
// Joining dates are stored at UTC midnight (from a date input) and sometimes
// at IST midnight; istDateKey reads both as the same calendar day.
function joinKeyOf(emp) {
    return emp && emp.joiningDate ? istDateKey(emp.joiningDate) : null;
}

// Matches the ₹1,00,00,000 cap used for advances and expenses.
const MAX_SALARY_AMOUNT = 10000000;

// Pure computation — returns the salary figures WITHOUT persisting. Used both by
// calculateAndSaveSalary (payroll generation) and the employee dashboard's live
// "earned so far" estimate, so the two never diverge.
//
// When settings.payroll.enabled === true the deterministic engine runs and
// returns an enriched payload (buckets, payableDays, needsReview, etc.).
// When false the legacy calculation path runs verbatim — no surprise changes.
exports.computeSalary = async (adminId, emp, month, year, advanceDeductionAmount = 0, reimbursementAmount = 0) => {
    month = Number(month);
    year = Number(year);
    const totalDaysInMonth = new Date(year, month, 0).getDate();

    // "Today" is the IST calendar day, independent of the host timezone.
    const today = istToday();
    const now = today.date;
    const isCurrentMonth = (today.y === year && today.m === month);
    const calcUpToDay = isCurrentMonth ? today.d : totalDaysInMonth;

    // IST month boundaries. `new Date(year, month - 1, 1)` is HOST midnight:
    // on a UTC server the 1st's IST-midnight attendance row fell outside the
    // range (the day read as absent) and the NEXT month's 1st fell inside it.
    const { start: startDate, end: endDate } = istMonthRange(year, month);
    const firstKey = `${year}-${pad2(month)}-01`;
    const lastKey = `${year}-${pad2(month)}-${pad2(totalDaysInMonth)}`;

    // Fetch base data (always needed)
    const [attendanceRecords, festivals, settings] = await Promise.all([
        Attendance.find({ adminId, employeeId: emp._id, date: { $gte: startDate, $lte: endDate } }),
        // Festival dates are 'YYYY-MM-DD' strings. Any festival that overlaps
        // the month, including one that starts before it and ends after it.
        Festival.find({ adminId, startDate: { $lte: lastKey }, endDate: { $gte: firstKey } }),
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
    // The joining date is compared as an IST calendar key. Comparing the
    // stored instant with attendance instants dropped the joining day itself:
    // a joining date saved at UTC midnight is 05:30 IST, and that day's
    // attendance row sits at IST midnight, five and a half hours earlier.
    const joinKey = joinKeyOf(emp);
    const joinsThisMonth = !!joinKey && joinKey.slice(0, 7) === firstKey.slice(0, 7);
    const startDay = joinsThisMonth ? Number(joinKey.slice(8, 10)) : 1;

    // Guard if joined after the requested month
    if (joinKey && joinKey > lastKey) {
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
        const dateStr = istDateKey(rec.date);
        if (joinKey && dateStr < joinKey) return sum;
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

    // Days the attendance system could not grade. The legacy formula pays
    // them nothing (they are not present/late/half-day/wfh); the count is
    // returned so the run is held for review rather than paid silently.
    const needsReviewDays = attendanceRecords.filter((rec) => {
        if (rec.status !== 'needs_review') return false;
        const key = istDateKey(rec.date);
        return (!joinKey || key >= joinKey) && Number(key.slice(8, 10)) <= calcUpToDay_legacy;
    }).length;

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
        needsReviewDays,
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
        // `status paidAt paidBy` ride along on the read this function already
        // does -- see the paid-record guard at the findOneAndUpdate below.
        .select('deductedAdvanceRequestIds reimbursedExpenseIds status paidAt paidBy')
        .lean();
    const existingIds = (existing?.deductedAdvanceRequestIds || []).map(String);
    const validId = (id) => mongoose.Types.ObjectId.isValid(String(id));
    const newAdvanceIds = advanceRequestIds.map(String).filter((id) => validId(id) && !existingIds.includes(id));

    let advances = [];
    if (existingIds.length || newAdvanceIds.length) {
        // 'repaid' is accepted only for advances ALREADY linked to this month's
        // record, so an advance recovered by an earlier run of this same month
        // keeps being reflected on every recompute. A newly picked advance
        // must still be 'approved': accepting 'repaid' for it let an advance
        // that another month had already recovered be deducted a second time.
        advances = await AdvanceSalaryRequest.find({
            employeeId: emp._id,
            companyId: adminId,
            $or: [
                { _id: { $in: existingIds }, status: { $in: ['approved', 'repaid'] } },
                { _id: { $in: newAdvanceIds }, status: 'approved' },
            ],
        });
    }
    // Never deduct an advance above the ₹1,00,00,000 request cap. Approval now
    // refuses these, but a row approved before the cap existed could still be
    // ticked in the deduction picker and would wipe out the whole payslip.
    // Skipped, not deducted, and named in the remarks so someone sorts it out.
    const ADVANCE_CAP = 10000000;
    const overCapAdvances = advances.filter((a) => !((a.approvedAmount ?? a.amount) <= ADVANCE_CAP));
    advances = advances.filter((a) => (a.approvedAmount ?? a.amount) <= ADVANCE_CAP);
    const advanceDeductionAmount = advances.reduce((sum, a) => sum + (a.approvedAmount ?? a.amount), 0);

    const existingExpenseIds = (existing?.reimbursedExpenseIds || []).map(String);
    const newExpenseIds = expenseIds.map(String).filter((id) => validId(id) && !existingExpenseIds.includes(id));

    let expenses = [];
    if (existingExpenseIds.length || newExpenseIds.length) {
        // 'reimbursed' is accepted only for expenses already linked to this
        // month's record (see the advances above): a claim reimbursed in
        // another month must not be paid out again.
        expenses = await Expense.find({
            employeeId: emp._id,
            adminId,
            $or: [
                { _id: { $in: existingExpenseIds }, status: { $in: ['approved', 'reimbursed'] } },
                { _id: { $in: newExpenseIds }, status: 'approved' },
            ],
        });
    }
    // Same ceiling as advances. A claim is capped at ₹1,00,00,000 when filed
    // and when approved, but rows approved before the cap existed (the test
    // DB holds some near ₹1e114) would otherwise be paid out in full.
    const overCapExpenses = expenses.filter((e) => !(e.amount <= ADVANCE_CAP));
    expenses = expenses.filter((e) => e.amount <= ADVANCE_CAP);
    const reimbursementAmount = expenses.reduce((sum, e) => sum + e.amount, 0);

    const r = await exports.computeSalary(adminId, emp, month, year, advanceDeductionAmount, reimbursementAmount);

    const now = new Date();
    const today = istToday();
    const isCurrentMonth = today.y === Number(year) && today.m === Number(month);

    let status = isCurrentMonth ? 'pending' : 'final';
    let remarks = r.remarks;
    if (overCapAdvances.length) {
        remarks = `${remarks ? remarks + ' | ' : ''}Skipped ${overCapAdvances.length} advance(s) over ₹1,00,00,000 — reject or correct them`;
    }
    if (overCapExpenses.length) {
        remarks = `${remarks ? remarks + ' | ' : ''}Skipped ${overCapExpenses.length} expense claim(s) over ₹1,00,00,000 — reject or correct them`;
    }

    const update = {
        baseSalary: r.baseSalary,
        totalSalary: r.totalSalary,
        employmentType: r.employmentType,
        breakdown: r.breakdown,
        // Only deductions that were actually taken off the pay. A component
        // marked "not included in total" is listed on the slip but not
        // deducted; counting it here made Deductions bigger than gross − net.
        deductions: (r.breakdown.deductions || []).reduce((s, d) => s + (d.included === false ? 0 : (d.amount || 0)), 0),
        deductedAdvanceRequestIds: advances.map(a => a._id),
        reimbursedExpenseIds: r.payableDays > 0 ? expenses.map(e => e._id) : [],
        remarks,
        status,
        grossSalary: r.grossSalary,
        netSalary: r.netSalary,
        payableDays: r.payableDays,
        totalDaysInWindow: r.totalDaysInWindow,
    };

    // Legacy path: a day the attendance system could not grade is paid
    // nothing by the legacy formula. Hold the run for review, the same way
    // the engine path does, instead of letting it reach a payslip silently.
    // The amount itself is unchanged.
    if (!r._engineEnabled && r.needsReviewDays > 0) {
        update.needsReview = true;
        update.status = 'review';
        update.remarks = `${remarks || ''} | ${r.needsReviewDays} attendance day(s) need checking before this salary can be paid`;
    } else if (!r._engineEnabled) {
        update.needsReview = false;
    }

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

    // ── A paid record keeps its payment ──────────────────────────────────────
    //
    // Everything above recomputes this month from scratch, INCLUDING `status`
    // (derived at the top from "is this the current month?", and again from
    // needsReview). Left alone, one click of "Generate Payroll" -- which loops
    // every active employee with no filter -- rewrote every 'paid' row to
    // 'pending'/'final'/'review'. The money had left the company and the system
    // no longer said so.
    //
    // This is the same care already taken two fields up for
    // deductedAdvanceRequestIds and reimbursedExpenseIds, which are merged from
    // `existing` precisely so a bulk regenerate cannot silently drop a recovery
    // an earlier run already applied. Payment simply never got it.
    //
    // Note this guards the PAYMENT only. Every computed figure -- gross, net,
    // buckets, deductions, payable days -- is still rewritten, so regenerating
    // a paid month still corrects its arithmetic and still surfaces a
    // needsReview problem in `remarks`. What it will not do is forget that
    // somebody was paid.
    if (existing?.status === 'paid') {
        delete update.status;
        update.remarks = `${update.remarks || ''} | Recomputed after payment; payment status preserved`.trim();
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

// One salary computation per employee-month at a time. The save above is an
// upsert with no unique index behind it (Salary.js), and it is reached from
// Generate, Generate-one, and every punch-out / leave / correction recalc, all
// fire-and-forget: two arriving together each found no row and each created one,
// and both read the same approved advances and expenses. Queued, the second run
// finds the first one's row and updates it.
{
    const calculateUnlocked = exports.calculateAndSaveSalary;
    exports.calculateAndSaveSalary = (adminId, emp, month, year, ...rest) =>
        withEmployeeLock(`salary:${String(emp?._id || emp)}:${year}-${month}`, () => calculateUnlocked(adminId, emp, month, year, ...rest));
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m, y) => `${MONTH_NAMES[m - 1]} ${y}`;
const formatJoinKey = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return `${d} ${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`;
};

// Reads and checks the month/year a salary request is for. Returns
// { month, year } or { error } with a message an admin can act on.
//
// The body used to go straight into the calculation, uncast. A month sent as
// the string "9" compared unequal to the number 9 everywhere the code asked
// "is this the current month?" or "did they join this month?" -- so the
// current month was treated as complete and a mid-month joiner was paid
// from the 1st.
function parseMonthYear(src, { allowFuture = false } = {}) {
    const month = Number(src && src.month);
    const year = Number(src && src.year);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2000 || year > 2100) {
        return { error: 'Choose a valid month and year.' };
    }
    if (!allowFuture) {
        const t = istToday();
        if (year * 12 + month > t.y * 12 + t.m) {
            return { error: `${monthLabel(month, year)} has not started yet, so there is no salary to work out for it.` };
        }
    }
    return { month, year };
}

// Why an employee has no salary for a month, or null when they do.
function notEmployedReason(emp, month, year) {
    const joinKey = joinKeyOf(emp);
    const lastKey = `${year}-${pad2(month)}-${pad2(new Date(year, month, 0).getDate())}`;
    if (joinKey && joinKey > lastKey) {
        return `${emp.name || 'This employee'} joined on ${formatJoinKey(joinKey)}, so there is no salary for ${monthLabel(month, year)}.`;
    }
    return null;
}

// Recompute + save salary for a single employee, optionally recovering one
// or more of their approved advance-salary/loan requests in this run. Used by the
// payroll UI's per-employee "apply advance deduction" action.
exports.generateSalaryForEmployee = async (req, res) => {
    try {
        const { employeeId, advanceRequestIds, expenseIds } = req.body || {};
        if (!employeeId) {
            return res.status(400).json({ message: 'Choose an employee.' });
        }
        if (!mongoose.Types.ObjectId.isValid(String(employeeId))) {
            return res.status(404).json({ message: 'Employee not found' });
        }
        const period = parseMonthYear(req.body);
        if (period.error) return res.status(400).json({ message: period.error });

        const adminId = req.adminId;
        const emp = await User.findOne({ _id: employeeId, adminId, role: 'employee' }).populate('shiftId');
        if (!emp) return res.status(404).json({ message: 'Employee not found' });

        const notEmployed = notEmployedReason(emp, period.month, period.year);
        if (notEmployed) return res.status(400).json({ message: notEmployed });

        const salaryRecord = await exports.calculateAndSaveSalary(
            adminId, emp, period.month, period.year,
            Array.isArray(advanceRequestIds) ? advanceRequestIds : [],
            Array.isArray(expenseIds) ? expenseIds : []
        );
        res.status(200).json(salaryRecord);
    } catch (error) {
        console.error('generateSalaryForEmployee error:', error);
        res.status(500).json({ message: 'Could not work out this salary. Please try again.' });
    }
};

exports.generateSalaries = async (req, res) => {
    try {
        const period = parseMonthYear(req.body);
        if (period.error) return res.status(400).json({ message: period.error });
        const { month, year } = period;

        const adminId = req.adminId;

        const employees = await User.find({ adminId, role: 'employee', status: 'active' }).populate('shiftId');

        const results = [];
        const needsReview = [];
        const errors = [];
        const skipped = [];

        for (const emp of employees) {
            // Someone who joined after this month has no salary for it; a ₹0
            // record for them only clutters the month.
            const notEmployed = notEmployedReason(emp, month, year);
            if (notEmployed) {
                skipped.push({ employeeId: emp._id, name: emp.name, reason: notEmployed });
                continue;
            }
            try {
                const salaryRecord = await exports.calculateAndSaveSalary(adminId, emp, month, year);
                results.push(salaryRecord);
                if (salaryRecord.needsReview || salaryRecord.status === 'review') {
                    needsReview.push({ employeeId: emp._id, name: emp.name, remarks: salaryRecord.remarks });
                }
            } catch (err) {
                console.error(`generateSalaries: ${emp._id}:`, err);
                errors.push({ employeeId: emp._id, name: emp.name, error: 'Could not work out this salary' });
            }
        }

        const parts = [`Salary worked out for ${results.length} employee${results.length === 1 ? '' : 's'} for ${monthLabel(month, year)}`];
        if (needsReview.length) parts.push(`${needsReview.length} need${needsReview.length === 1 ? 's' : ''} checking before payment`);
        if (errors.length) parts.push(`${errors.length} could not be worked out`);
        if (skipped.length) parts.push(`${skipped.length} skipped (joined later)`);

        res.status(201).json({
            message: parts.join('. ') + '.',
            count: results.length,
            needsReview,
            errors,
            skipped,
        });
    } catch (error) {
        console.error('generateSalaries error:', error);
        res.status(500).json({ message: 'Could not generate payroll. Please try again.' });
    }
};

exports.getSalaryByEmployee = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(String(req.params.employeeId))) {
            return res.status(404).json({ message: 'Employee not found' });
        }
        // An employee may read only their own salary history. The id comes
        // from the URL, so without this any employee could read a co-worker's
        // pay by swapping it in. The panel roles keep full access.
        const role = req.currentUser?.role || req.user?.role;
        if (role === 'employee' && String(req.params.employeeId) !== String(req.userId)) {
            return res.status(403).json({ message: 'You can only see your own salary.' });
        }
        const salaries = await Salary.find({
            adminId: req.adminId,
            employeeId: req.params.employeeId
        }).sort({ year: -1, month: -1 });
        res.json(salaries);
    } catch (error) {
        console.error('getSalaryByEmployee error:', error);
        res.status(500).json({ message: 'Could not load salary history.' });
    }
};

exports.getMonthlyReport = async (req, res) => {
    try {
        // Month and year are required: with either missing, the filter
        // dropped the undefined key and returned every salary of the company.
        const period = parseMonthYear(req.query, { allowFuture: true });
        if (period.error) return res.status(400).json({ message: period.error });
        const salaries = await Salary.find({
            adminId: req.adminId,
            month: period.month,
            year: period.year,
        }).populate({
            path: 'employeeId',
            // Department and branch names drive the page's two filters, which
            // matched nothing while only name/phone were populated.
            select: 'name phone departmentId branchId',
            populate: [
                { path: 'departmentId', select: 'name' },
                { path: 'branchId', select: 'branchName' },
            ],
        });
        res.json(salaries);
    } catch (error) {
        console.error('getMonthlyReport error:', error);
        res.status(500).json({ message: 'Could not load salaries for this month.' });
    }
};

// Fields an admin is allowed to change by hand on a generated payslip.
//
// A whitelist rather than `req.body`, because this handler used to pass the
// request body straight into findOneAndUpdate: anything the caller sent was
// written, including the engine's own audit fields (buckets, payableDays,
// needsReview, dailyRateBasis) and the tenant key itself. Those are outputs of
// the payroll engine and the only thing that should ever write them is a run of
// it -- an edit that quietly rewrites `buckets` makes the day-sum invariant
// unverifiable after the fact, which is the one property the engine exists to
// guarantee.
const SALARY_EDITABLE_FIELDS = ['status', 'bonus', 'deductions', 'remarks', 'totalSalary', 'netSalary'];
const SALARY_AMOUNT_FIELDS = ['bonus', 'deductions', 'totalSalary', 'netSalary'];
const SALARY_STATUSES = ['paid', 'pending', 'final', 'review'];

exports.updateSalary = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
            return res.status(404).json({ message: 'Salary record not found' });
        }
        const body = req.body || {};
        const update = {};
        for (const key of SALARY_EDITABLE_FIELDS) {
            if (body[key] !== undefined) update[key] = body[key];
        }

        // Amounts: plain numbers from ₹0 to ₹1,00,00,000. A negative or absurd
        // figure used to be saved as typed.
        for (const key of SALARY_AMOUNT_FIELDS) {
            if (update[key] === undefined) continue;
            const n = typeof update[key] === 'string' && update[key].trim() !== '' ? Number(update[key]) : update[key];
            if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_SALARY_AMOUNT) {
                return res.status(400).json({ message: 'Enter an amount between ₹0 and ₹1,00,00,000.' });
            }
            update[key] = Math.round(n * 100) / 100;
        }
        // Net pay is stored twice (totalSalary for the salary list, netSalary
        // for payslips). Editing one left the other showing the old figure.
        if (update.totalSalary !== undefined && update.netSalary === undefined) update.netSalary = update.totalSalary;
        if (update.netSalary !== undefined && update.totalSalary === undefined) update.totalSalary = update.netSalary;

        if (update.remarks !== undefined) {
            if (typeof update.remarks !== 'string' || update.remarks.length > 500) {
                return res.status(400).json({ message: 'Remarks must be text of up to 500 characters.' });
            }
        }
        if (update.status !== undefined && !SALARY_STATUSES.includes(update.status)) {
            return res.status(400).json({ message: 'Choose a valid status.' });
        }

        const existing = await Salary.findOne({ _id: req.params.id, adminId: req.adminId })
            .select('status paidAt needsReview')
            .lean();
        if (!existing) return res.status(404).json({ message: 'Salary record not found' });

        // Marking a row paid is the one transition that has to leave a trace.
        // `status` alone cannot be that trace -- payroll generation recomputes
        // it -- so stamp who paid it and when, and let those outlive any later
        // regenerate. See the paid-record guard in calculateAndSaveSalary.
        if (update.status === 'paid') {
            // A salary held for review has attendance days nobody has checked;
            // paying it is paying a guess. The page hides the button, and this
            // closes the same door for a direct call.
            if (existing.status === 'review' || existing.needsReview) {
                return res.status(409).json({
                    message: 'This salary has attendance days that still need checking. Correct those days, recalculate, and then mark it paid.',
                });
            }
            // Only on the transition INTO paid, so re-saving an already-paid row
            // keeps the original payment date rather than moving it to today.
            if (!existing.paidAt) {
                update.paidAt = new Date();
                update.paidBy = req.userId;
            }
        } else if (update.status !== undefined && (existing.status === 'paid' || existing.paidAt)) {
            // Undoing a payment recorded in error. This is the step the delete
            // refusal tells the admin to take; leaving paidAt behind meant the
            // record could still never be deleted.
            update.paidAt = null;
            update.paidBy = null;
        }

        const salary = await Salary.findOneAndUpdate(
            { _id: req.params.id, adminId: req.adminId },
            { $set: update },
            { new: true, runValidators: true }
        );
        if (!salary) return res.status(404).json({ message: 'Salary record not found' });
        res.json(salary);
    } catch (error) {
        console.error('updateSalary error:', error);
        res.status(400).json({ message: 'Could not save this salary. Check the values and try again.' });
    }
};

exports.deleteSalary = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(String(id))) {
            return res.status(404).json({ message: 'Salary record not found' });
        }

        // Deleting a paid payslip destroys the only record that the payment
        // happened, and there is no undo anywhere in this flow. Refuse it and
        // make the caller undo the payment first -- that way the decision to
        // discard a payment record is explicit and separately auditable,
        // instead of a side effect of tidying up a salary list.
        const existing = await Salary.findOne({ _id: id, adminId: req.adminId })
            .select('status paidAt employeeId deductedAdvanceRequestIds reimbursedExpenseIds')
            .lean();
        if (!existing) return res.status(404).json({ message: 'Salary record not found' });
        if (existing.status === 'paid' || existing.paidAt) {
            return res.status(409).json({
                message: 'This payslip is marked paid and cannot be deleted. Change its status first if the payment was recorded in error.',
            });
        }

        await Salary.findOneAndDelete({
            _id: id,
            adminId: req.adminId
        });

        // Hand back what this record had taken. Generating it marked its
        // advances 'repaid' and its expenses 'reimbursed'; with the record
        // gone that recovery/payout never happens, yet both stayed closed --
        // the advance was never recovered and the claim never paid. They go
        // back to 'approved' so a later payroll can pick them up.
        if (existing.deductedAdvanceRequestIds?.length) {
            await AdvanceSalaryRequest.updateMany(
                { _id: { $in: existing.deductedAdvanceRequestIds }, companyId: req.adminId, employeeId: existing.employeeId, status: 'repaid' },
                { $set: { status: 'approved' }, $unset: { repaidAt: 1, deductedInMonth: 1 } }
            );
        }
        if (existing.reimbursedExpenseIds?.length) {
            await Expense.updateMany(
                { _id: { $in: existing.reimbursedExpenseIds }, adminId: req.adminId, employeeId: existing.employeeId, status: 'reimbursed' },
                { $set: { status: 'approved' }, $unset: { reimbursedInMonth: 1 } }
            );
        }
        res.json({ message: 'Salary record deleted' });
    } catch (error) {
        console.error('deleteSalary error:', error);
        res.status(500).json({ message: 'Could not delete this salary record. Please try again.' });
    }
};
