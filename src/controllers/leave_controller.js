const Leave = require('../models/Leave');
const User = require('../models/User');
const mongoose = require('mongoose');
const { calculateAndSaveSalary } = require('./salary_controller');

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

        const leave = await Leave.create({
            ...req.body,
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            leaveTypeId: new mongoose.Types.ObjectId(req.body.leaveTypeId)
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
