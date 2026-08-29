const Leave = require('../models/Leave');
const User = require('../models/User');
const Festival = require('../models/Festival');
const Settings = require('../models/Settings');
const mongoose = require('mongoose');
const { calculateAndSaveSalary } = require('./salary_controller');
const { isWeeklyOff, toLocalDateKey } = require('../utils/attendance_helpers');

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
        if (req.user && req.user.role === 'employee') {
            query.employeeId = new mongoose.Types.ObjectId(req.userId);
        } else if (req.query.employeeId) {
            query.employeeId = new mongoose.Types.ObjectId(req.query.employeeId);
        }

        if (req.query.status) {
            query.status = req.query.status;
        }
        if (req.query.leaveTypeId) {
            query.leaveTypeId = new mongoose.Types.ObjectId(req.query.leaveTypeId);
        }

        const leaves = await Leave.find(query)
            .populate('employeeId', 'name profileImage email phone')
            .populate('leaveTypeId', 'leaveName code colorCode iconStyle')
            .sort({ createdAt: -1 });

        res.json(leaves);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Create a new leave request
exports.addLeave = async (req, res) => {
    try {
        let employeeId;
        if (req.user && req.user.role === 'employee') {
            employeeId = req.userId;
        } else {
            employeeId = req.body.employeeId;
        }

        if (!employeeId) {
            return res.status(400).json({ message: 'Employee ID is required' });
        }
        if (!req.body.leaveTypeId) {
            return res.status(400).json({ message: 'Leave type is required' });
        }

        const startDate = new Date(req.body.startDate);
        const endDate = new Date(req.body.endDate || req.body.startDate);
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate < startDate) {
            return res.status(400).json({ message: 'Invalid date range' });
        }

        const employee = await User.findOne({ _id: employeeId, adminId: req.adminId }).populate('shiftId');
        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        // Reject overlapping requests up front rather than silently double-booking
        // the same days across two pending/approved leave records.
        const overlap = await Leave.findOne({
            adminId: req.adminId,
            employeeId,
            status: { $in: ['pending', 'approved'] },
            startDate: { $lte: endDate },
            endDate: { $gte: startDate },
        });
        if (overlap) {
            return res.status(400).json({ message: 'This overlaps with an existing leave request for the same period.' });
        }

        const duration = await countBusinessDays(req.adminId, employee, startDate, endDate);
        if (duration <= 0) {
            return res.status(400).json({ message: 'The selected date range has no working days to charge against leave — check weekends/holidays.' });
        }

        const leave = await Leave.create({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            leaveTypeId: new mongoose.Types.ObjectId(req.body.leaveTypeId),
            startDate,
            endDate,
            duration,
            reason: req.body.reason,
        });

        res.status(201).json(leave);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// Update leave request details (e.g. status by Admin)
exports.updateLeaveStatus = async (req, res) => {
    try {
        const { status, adminRemark } = req.body;

        if (status && !['pending', 'approved', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status value' });
        }

        const updateData = {};
        if (status) updateData.status = status;
        if (adminRemark !== undefined) updateData.adminRemark = adminRemark;

        const leave = await Leave.findOneAndUpdate(
            { _id: new mongoose.Types.ObjectId(req.params.id), adminId: new mongoose.Types.ObjectId(req.adminId) },
            updateData,
            { new: true }
        ).populate('employeeId', 'name email phone')
         .populate('leaveTypeId', 'leaveName code colorCode iconStyle');

        if (!leave) {
            return res.status(404).json({ message: 'Leave request not found' });
        }

        res.json(leave);

        // Background salary recompute when leave is approved or rejected (status changed).
        // Recomputes every month the leave span touches so the payroll stays accurate.
        if (status && status !== 'pending') {
            (async () => {
                try {
                    const emp = await User.findById(leave.employeeId._id || leave.employeeId);
                    if (!emp) return;
                    // Collect unique year+month pairs covered by the leave span.
                    // Jump to 1st of each month before incrementing so day-overflow
                    // (e.g. Jan 31 + 1 month = Mar 3) can never skip a month.
                    const months = new Set();
                    let cur = new Date(leave.startDate);
                    const last = new Date(leave.endDate || leave.startDate);
                    while (cur <= last) {
                        months.add(`${cur.getFullYear()}-${cur.getMonth() + 1}`);
                        cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
                    }
                    for (const key of months) {
                        const [y, m] = key.split('-').map(Number);
                        await calculateAndSaveSalary(leave.adminId, emp, m, y);
                    }
                } catch (err) {
                    console.error('Leave approval salary sync error:', err);
                }
            })();
        }
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// Delete a leave request
exports.deleteLeave = async (req, res) => {
    try {
        const leave = await Leave.findOneAndDelete({
            _id: new mongoose.Types.ObjectId(req.params.id),
            adminId: new mongoose.Types.ObjectId(req.adminId)
        });

        if (!leave) {
            return res.status(404).json({ message: 'Leave request not found' });
        }

        res.json({ message: 'Leave request deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
