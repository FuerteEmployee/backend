const Leave = require('../models/Leave');
const LeaveType = require('../models/LeaveType');
const User = require('../models/User');
const Festival = require('../models/Festival');
const Settings = require('../models/Settings');
const Salary = require('../models/Salary');
const mongoose = require('mongoose');
const { calculateAndSaveSalary } = require('./salary_controller');
const { isWeeklyOff, toLocalDateKey, istStartOfDay, istEndOfDay, istDateKey } = require('../utils/attendance_helpers');
const { resolveBalancePeriod, computeLeaveBalances } = require('../utils/leave_balance');

// The role on the live user record, not the one baked into a 30-day JWT: someone
// demoted from sub-admin to employee since they logged in must be treated as an
// employee now. Same precedence as checkPermission and the regularization gate.
const isEmployee = (req) => (req.currentUser?.role || req.user?.role) === 'employee';

// `new mongoose.Types.ObjectId(x)` THROWS on anything that is not 24 hex chars,
// and the catch blocks below used to hand that BSON error text straight to the
// phone. Checking first lets each field fail with a sentence a person can act on.
const isObjectId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));

// Upper bounds on free input. Nothing legitimate comes near either; they stop a
// pasted wall of text or a mistyped year (2027 for 2026) from being stored as a
// request nobody can read or approve.
const MAX_REASON_LENGTH = 1000;
const MAX_RANGE_DAYS = 366;
// The admin's note on a decision -- in practice the reason a leave was
// rejected, which the employee reads on their phone. Short on purpose.
const MAX_REMARK_LENGTH = 300;
// How far from today a leave may be dated. The range cap above does not catch
// a single mistyped year (2062 for 2026, 1926 for 2026), which was stored as a
// real request and, once approved, sent payroll off to recompute that year.
const MAX_DAYS_FROM_TODAY = 366;
const DAY_MS = 86400000;

/**
 * Recompute the salary of every month a leave touches, after a change that
 * moves pay: approving it, or an admin deleting an approved one.
 *
 * Months are read in IST, so a leave stored at IST midnight on the 1st is not
 * filed under the previous month on a UTC host. A month AFTER the current one
 * is only recomputed when it already has a salary row: approving leave for
 * next month used to create next month's payslip on the spot, marked final and
 * holding nothing but that leave (rejecting did the same), long before any
 * payroll run. The employee is loaded with their shift, as the salary screen
 * loads them, so a shift's own work days count the same way here as there.
 *
 * Runs after the response has gone; a failure is logged, never shown.
 */
function resyncSalaryForLeave(adminId, employeeId, leave) {
    (async () => {
        try {
            const emp = await User.findOne({ _id: employeeId, adminId }).populate('shiftId');
            if (!emp) return;
            const [nowY, nowM] = istDateKey().split('-').map(Number);
            const nowIndex = nowY * 12 + nowM;
            const [sy, sm] = istDateKey(leave.startDate).split('-').map(Number);
            const [ey, em] = istDateKey(leave.endDate || leave.startDate).split('-').map(Number);
            for (let i = sy * 12 + sm, last = ey * 12 + em, guard = 0; i <= last && guard < 24; i++, guard++) {
                const y = Math.floor((i - 1) / 12);
                const m = i - y * 12;
                if (i > nowIndex && !(await Salary.exists({ adminId, employeeId: emp._id, month: m, year: y }))) continue;
                await calculateAndSaveSalary(adminId, emp, m, y);
            }
        } catch (err) {
            console.error('Leave salary sync error:', err);
        }
    })();
}

// Counts the business days between startDate/endDate inclusive — excludes the
// employee's weekly-offs (weeklyHolidays override → shift workDays → tenant
// default) and tenant festivals/holidays — so a leave request spanning a
// weekend isn't charged against balance for the weekend days.
async function countBusinessDays(adminId, employee, startDate, endDate) {
    const startKey = toLocalDateKey(startDate);
    const endKey = toLocalDateKey(endDate);
    const festivals = await Festival.find({
        adminId,
        startDate: { $lte: endKey },
        endDate: { $gte: startKey },
    });
    const festivalDates = new Set();
    festivals.forEach(f => {
        let cur = new Date(f.startDate);
        const last = new Date(f.endDate || f.startDate);
        let guard = 0;
        while (cur <= last && guard < 400) {
            festivalDates.add(toLocalDateKey(cur));
            cur.setDate(cur.getDate() + 1);
            guard++;
        }
    });

    const settings = await Settings.findOne({ adminId }).select('attendance');
    const weeklyHolidays = employee.weeklyHolidays || [];
    const shiftWorkDays = employee.shiftId?.workDays;

    let count = 0;
    let cur = new Date(startDate);
    const last = new Date(endDate);
    let guard = 0;
    while (cur <= last && guard < 400) {
        const dateKey = toLocalDateKey(cur);
        const dayName = cur.toLocaleDateString('en-US', { weekday: 'long' });
        const isFestival = festivalDates.has(dateKey);
        const isOff = isWeeklyOff(dayName, cur.getDate(), weeklyHolidays, settings?.attendance?.workDays, shiftWorkDays);
        if (!isFestival && !isOff) count++;
        cur.setDate(cur.getDate() + 1);
        guard++;
    }
    return count;
}

// Fetch all leaves for the tenant (filtered by employee, status, leave type)
exports.getLeaves = async (req, res) => {
    try {
        let query = { adminId: new mongoose.Types.ObjectId(req.adminId) };

        // If employee, they can only view their own leave requests
        if (isEmployee(req)) {
            query.employeeId = new mongoose.Types.ObjectId(req.userId);
        } else if (req.query.employeeId) {
            if (!isObjectId(req.query.employeeId)) return res.status(400).json({ message: 'Invalid employee filter' });
            query.employeeId = new mongoose.Types.ObjectId(req.query.employeeId);
        }

        if (req.query.status) {
            query.status = String(req.query.status);
        }
        if (req.query.leaveTypeId) {
            if (!isObjectId(req.query.leaveTypeId)) return res.status(400).json({ message: 'Invalid leave type filter' });
            query.leaveTypeId = new mongoose.Types.ObjectId(req.query.leaveTypeId);
        }

        const leaves = await Leave.find(query)
            .populate('employeeId', 'name profileImage email phone')
            .populate('leaveTypeId', 'leaveName code colorCode iconStyle')
            .sort({ createdAt: -1 });

        res.json(leaves);
    } catch (error) {
        console.error('getLeaves error:', error);
        res.status(500).json({ message: 'Could not load leave requests. Please try again.' });
    }
};

// 'YYYY-MM-DD' -> a local-noon Date, the form countBusinessDays iterates in
// (it reads days with toLocalDateKey / getDate, i.e. host-local calendar days).
const keyToCalendarDate = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d, 12);
};

// GET /leaves/balances[?employeeId=] -- used / waiting / left per leave type,
// for the tenant's current balance period (Settings.leave.balancePeriod).
//
// Computed here, once, so the employee's Leaves page and any admin view read
// the same numbers. An employee always gets their own; a panel user must say
// whose. Balances are advisory: addLeave does not refuse a request that goes
// over, the apply form only warns, and the admin decides.
exports.getLeaveBalances = async (req, res) => {
    try {
        let employeeId = req.userId;
        if (!isEmployee(req)) {
            if (!isObjectId(req.query.employeeId)) {
                return res.status(400).json({ message: 'Please choose an employee.' });
            }
            employeeId = req.query.employeeId;
        }

        const employee = await User.findOne({ _id: employeeId, adminId: req.adminId, role: 'employee' }).populate('shiftId');
        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const [settings, leaveTypes, leaves] = await Promise.all([
            Settings.findOne({ adminId: req.adminId }).select('leave'),
            LeaveType.find({ adminId: req.adminId }),
            Leave.find({
                adminId: req.adminId,
                employeeId: employee._id,
                status: { $in: ['approved', 'pending'] },
            }).select('leaveTypeId startDate endDate duration dayPortion status'),
        ]);

        const period = resolveBalancePeriod(settings?.leave?.balancePeriod);
        const balances = await computeLeaveBalances({
            leaveTypes,
            leaves,
            period,
            // Only for a leave crossing a period edge: its working days inside.
            countPart: (leave, fromKey, toKey) =>
                countBusinessDays(req.adminId, employee, keyToCalendarDate(fromKey), keyToCalendarDate(toKey)),
        });

        res.json({ period, balances });
    } catch (error) {
        console.error('getLeaveBalances error:', error);
        res.status(500).json({ message: 'Could not load the leave balance. Please try again.' });
    }
};

// Create a new leave request
exports.addLeave = async (req, res) => {
    try {
        // An employee always applies for themselves -- the id comes from the
        // token, never the body, or anyone could file leave under a co-worker.
        const employeeId = isEmployee(req) ? req.userId : req.body.employeeId;

        // Every message below can reach an employee's phone as a toast, so each
        // one says what to do next in plain words rather than naming a field.
        if (!isObjectId(employeeId)) {
            return res.status(400).json({ message: 'Please choose an employee.' });
        }
        if (!isObjectId(req.body.leaveTypeId)) {
            return res.status(400).json({ message: 'Please choose a leave type.' });
        }
        const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
        if (!reason) {
            // `reason` is required by the schema, so without this the request
            // failed anyway -- with "Leave validation failed: reason: Path
            // `reason` is required." shown to the employee.
            return res.status(400).json({ message: 'Please write a short reason for your leave.' });
        }
        if (reason.length > MAX_REASON_LENGTH) {
            return res.status(400).json({ message: `The reason is too long. Please keep it under ${MAX_REASON_LENGTH} letters.` });
        }

        const startDate = new Date(req.body.startDate);
        const endDate = new Date(req.body.endDate || req.body.startDate);
        if (!req.body.startDate || isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            return res.status(400).json({ message: 'Please pick a valid date.' });
        }
        if (endDate < startDate) {
            return res.status(400).json({ message: 'The end date is before the start date. Please check the dates.' });
        }
        if ((endDate - startDate) / 86400000 >= MAX_RANGE_DAYS) {
            // countBusinessDays stops counting after 400 days, so an over-long
            // range would also be charged a wrong duration, not just a big one.
            return res.status(400).json({ message: 'That date range is too long. Please check the dates.' });
        }
        const today = istStartOfDay();
        if (startDate < new Date(today.getTime() - MAX_DAYS_FROM_TODAY * DAY_MS)) {
            return res.status(400).json({ message: 'That date is more than a year ago. Please check the year.' });
        }
        if (endDate > new Date(today.getTime() + (MAX_DAYS_FROM_TODAY + 1) * DAY_MS)) {
            return res.status(400).json({ message: 'That date is more than a year away. Please check the year.' });
        }

        // An employee of THIS company. Without the role, an admin could file
        // (and approve, and pay) leave for a sub-admin's account.
        const employee = await User.findOne({ _id: employeeId, adminId: req.adminId, role: 'employee' }).populate('shiftId');
        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        // The type must be one of THIS company's. An id from another tenant (or
        // a deleted type) used to be stored as-is, and payroll treats a type it
        // cannot find as paid -- so an unknown id silently became paid leave.
        const leaveType = await LeaveType.exists({ _id: req.body.leaveTypeId, adminId: req.adminId });
        if (!leaveType) {
            return res.status(400).json({ message: 'This leave type is no longer available. Please choose another one.' });
        }

        // Reject overlapping requests up front rather than silently double-booking
        // the same days across two pending/approved leave records.
        //
        // Matched on the whole IST day either side, not the exact instants: a
        // date-only 'YYYY-MM-DD' is stored at UTC midnight, but rows written by
        // older clients sit at IST midnight (18:30 UTC the day before), and an
        // exact comparison misses those and books the same day twice.
        const overlap = await Leave.findOne({
            adminId: req.adminId,
            employeeId,
            status: { $in: ['pending', 'approved'] },
            startDate: { $lte: istEndOfDay(endDate) },
            endDate: { $gte: istStartOfDay(startDate) },
        });
        if (overlap) {
            return res.status(400).json({ message: 'A leave request already exists for one or more of these days. Please check the list of requests.' });
        }

        // Half day, and which half. Anything unrecognised is a full day rather
        // than an error: an older client that knows nothing of this field sends
        // nothing, and must keep booking whole days exactly as it always did.
        const dayPortion = ['first_half', 'second_half'].includes(req.body.dayPortion)
            ? req.body.dayPortion
            : 'full';

        // A half day is a single day by definition. Allowing a range would make
        // `duration` ambiguous (half of the first day? of every day?) and there
        // is no answer an approver could act on.
        if (dayPortion !== 'full' && toLocalDateKey(startDate) !== toLocalDateKey(endDate)) {
            return res.status(400).json({ message: 'A half-day leave must be for a single date.' });
        }

        const workingDays = await countBusinessDays(req.adminId, employee, startDate, endDate);
        if (workingDays <= 0) {
            const single = toLocalDateKey(startDate) === toLocalDateKey(endDate);
            return res.status(400).json({
                message: single
                    ? 'That day is a weekly off or a holiday, so no leave is needed. Please pick a working day.'
                    : 'All the days you picked are weekly offs or holidays, so no leave is needed.',
            });
        }
        // countBusinessDays still has to run for a half day: it is what proves
        // the chosen date is a working day at all, so a half day cannot be
        // booked onto a Sunday or a festival.
        const duration = dayPortion === 'full' ? workingDays : 0.5;

        const leave = await Leave.create({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            leaveTypeId: new mongoose.Types.ObjectId(req.body.leaveTypeId),
            startDate,
            endDate,
            duration,
            dayPortion,
            reason,
        });

        res.status(201).json(leave);
    } catch (error) {
        // Everything a person can fix is answered above; reaching here means
        // something broke on our side, and its raw text (a Mongo or BSON error)
        // means nothing to the employee reading the toast.
        console.error('addLeave error:', error);
        res.status(500).json({ message: 'Could not save the leave request. Please try again.' });
    }
};

// Update leave request details (e.g. status by Admin)
exports.updateLeaveStatus = async (req, res) => {
    try {
        const { status, adminRemark } = req.body || {};

        if (!isObjectId(req.params.id)) {
            return res.status(404).json({ message: 'Leave request not found' });
        }
        if (status !== undefined && !['pending', 'approved', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Please choose Approve or Reject.' });
        }

        const updateData = {};
        if (status) updateData.status = status;
        // The reason for a rejection (or any note on a decision). The employee
        // sees it on their Leaves page, so it is trimmed and kept short; blank
        // or null clears it.
        if (adminRemark !== undefined) {
            if (adminRemark !== null && typeof adminRemark !== 'string') {
                return res.status(400).json({ message: 'The reason must be text.' });
            }
            const remark = (adminRemark || '').trim();
            if (remark.length > MAX_REMARK_LENGTH) {
                return res.status(400).json({ message: `Please keep the reason under ${MAX_REMARK_LENGTH} letters.` });
            }
            updateData.adminRemark = remark;
        }

        // Only `status` and `adminRemark` are ever read from the body, so an
        // operator such as {"$set": {...}} is simply not an instruction here.
        if (!Object.keys(updateData).length) {
            return res.status(400).json({ message: 'Please choose Approve or Reject.' });
        }

        const filter = { _id: new mongoose.Types.ObjectId(req.params.id), adminId: new mongoose.Types.ObjectId(req.adminId) };
        const current = await Leave.findOne(filter).select('status');
        if (!current) {
            return res.status(404).json({ message: 'This leave request no longer exists. The employee may have cancelled it.' });
        }

        // Only a WAITING request can be decided. The page only ever offers
        // Approve/Reject on pending rows, but the server took any status on any
        // row: a bulk "Approve All" over a selection that included rejected
        // rows turned them into approved (and paid) leave, and a double tap
        // re-ran the salary sync. An approved leave is undone by deleting it,
        // which recalculates the salary; a rejected one by applying again.
        if (status && current.status !== 'pending') {
            return res.status(409).json({
                message: current.status === status
                    ? `This leave request is already ${status}.`
                    : `This leave request was already ${current.status}, so it cannot be changed now.`,
                status: current.status,
            });
        }
        // And atomically: two admins deciding at once, or a decision racing the
        // employee's cancel, leaves exactly one winner.
        if (status) filter.status = 'pending';

        const leave = await Leave.findOneAndUpdate(filter, { $set: updateData }, { new: true })
            .populate('employeeId', 'name email phone')
            .populate('leaveTypeId', 'leaveName code colorCode iconStyle');

        if (!leave) {
            const now = await Leave.findOne({ _id: filter._id, adminId: filter.adminId }).select('status');
            if (!now) return res.status(404).json({ message: 'This leave request no longer exists. The employee may have cancelled it.' });
            return res.status(409).json({ message: `This leave request was already ${now.status}, so it cannot be changed now.`, status: now.status });
        }

        res.json(leave);

        // Only approving moves pay. A pending request never reached payroll
        // (it reads approved leave only), so rejecting one changes no salary;
        // recomputing on reject merely created payslips for future months.
        if (status === 'approved') {
            resyncSalaryForLeave(leave.adminId, leave.employeeId?._id || leave.employeeId, leave);
        }
    } catch (error) {
        console.error('updateLeaveStatus error:', error);
        res.status(500).json({ message: 'Could not update the leave request. Please try again.' });
    }
};

// Delete a leave request -- or, for an employee, take back their own.
exports.deleteLeave = async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) {
            return res.status(404).json({ message: 'Leave request not found' });
        }
        const filter = {
            _id: new mongoose.Types.ObjectId(req.params.id),
            adminId: new mongoose.Types.ObjectId(req.adminId),
        };

        // An employee may cancel only their OWN request, and only while it is
        // still waiting. This route used to delete any leave in the company for
        // any caller, approved ones included. Pending requests never reach
        // payroll (it reads approved leave only), so taking one back changes no
        // salary; an approved or rejected one is the admin's to undo. Both
        // conditions sit in the delete filter itself, so an approval landing a
        // moment earlier makes this a no-op rather than a race.
        const employee = isEmployee(req);
        if (employee) {
            filter.employeeId = new mongoose.Types.ObjectId(req.userId);
            filter.status = 'pending';
        }

        const leave = await Leave.findOneAndDelete(filter);

        if (!leave) {
            if (employee) {
                const decided = await Leave.exists({ _id: filter._id, adminId: filter.adminId, employeeId: filter.employeeId });
                if (decided) {
                    return res.status(409).json({ message: 'This request has already been approved or rejected, so it cannot be cancelled now. Please talk to your admin.' });
                }
            }
            return res.status(404).json({ message: 'Leave request not found' });
        }

        res.json({ message: employee ? 'Leave request cancelled' : 'Leave request deleted successfully' });

        // An admin deleting an APPROVED leave takes paid (or unpaid) days back
        // out of that month. The payslip used to keep the deleted leave until
        // something else happened to recompute it.
        if (!employee && leave.status === 'approved') {
            resyncSalaryForLeave(leave.adminId, leave.employeeId, leave);
        }
    } catch (error) {
        console.error('deleteLeave error:', error);
        res.status(500).json({ message: 'Could not delete the leave request. Please try again.' });
    }
};
const { serialisePerUser } = require('../utils/employee_lock');

// The overlap check reads then writes; two requests together both passed it.
exports.addLeave = serialisePerUser(exports.addLeave, 'create');
