const LeaveType = require('../models/LeaveType');
const mongoose = require('mongoose');

exports.getLeaveTypes = async (req, res) => {
    try {
        const leaveTypes = await LeaveType.find({ adminId: new mongoose.Types.ObjectId(req.adminId) });
        res.json(leaveTypes);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.createLeaveType = async (req, res) => {
    try {
        const leaveType = await LeaveType.create({ ...req.body, adminId: new mongoose.Types.ObjectId(req.adminId) });
        res.status(201).json(leaveType);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.updateLeaveType = async (req, res) => {
    try {
        const leaveType = await LeaveType.findOneAndUpdate(
            { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) },
            req.body,
            { new: true }
        );
        if (!leaveType) return res.status(404).json({ message: 'Leave Type not found' });
        res.json(leaveType);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.deleteLeaveType = async (req, res) => {
    try {
        const leaveType = await LeaveType.findOneAndDelete({ _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) });
        if (!leaveType) return res.status(404).json({ message: 'Leave Type not found' });
        res.json({ message: 'Leave Type removed' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
