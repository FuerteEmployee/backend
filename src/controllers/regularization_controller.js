const mongoose = require('mongoose');
const Regularization = require('../models/Regularization');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Settings = require('../models/Settings');
const { calculateAndSaveSalary } = require('./salary_controller');
const { isLatePunchIn, determineHalfDayStatus } = require('../utils/attendance_helpers');

exports.getRegularizations = async (req, res) => {
    try {
        const query = { adminId: new mongoose.Types.ObjectId(req.adminId) };

        if (req.user && req.user.role === 'employee') {
            query.employeeId = new mongoose.Types.ObjectId(req.userId);
        } else if (req.query.employeeId) {
            query.employeeId = new mongoose.Types.ObjectId(req.query.employeeId);
        }
        if (req.query.status) query.status = req.query.status;

        const regularizations = await Regularization.find(query)
            .populate('employeeId', 'name phone')
            .sort({ createdAt: -1 });

        res.json(regularizations);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.submitRegularization = async (req, res) => {
    try {
        const employeeId = (req.user && req.user.role === 'employee') ? req.userId : req.body.employeeId;
        if (!employeeId) {
            return res.status(400).json({ message: 'Employee ID is required' });
        }
        if (!req.body.date) {
            return res.status(400).json({ message: 'Date is required' });
        }
        if (!req.body.reason) {
            return res.status(400).json({ message: 'Reason is required' });
        }

        const day = new Date(req.body.date);
        day.setHours(0, 0, 0, 0);

        const regularization = await Regularization.create({
            adminId: req.adminId,
            employeeId,
            submittedBy: req.userId,
            date: day,
            requestedPunchIn: req.body.requestedPunchIn || null,
            requestedPunchOut: req.body.requestedPunchOut || null,
            requestedLunchInTime: req.body.requestedLunchInTime || null,
            requestedLunchOutTime: req.body.requestedLunchOutTime || null,
            requestedStatus: req.body.requestedStatus || null,
            reason: req.body.reason,
        });

        const populated = await regularization.populate('employeeId', 'name phone');
        res.status(201).json(populated);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.approveRegularization = async (req, res) => {
    try {
        const regularization = await Regularization.findOne({
            _id: req.params.id,
            adminId: req.adminId,
        });
        if (!regularization) return res.status(404).json({ message: 'Regularization request not found' });
        if (regularization.status !== 'pending') {
            return res.status(400).json({ message: `Cannot approve request with status: ${regularization.status}` });
        }

        const [user, settings] = await Promise.all([
            User.findById(regularization.employeeId).populate('shiftId'),
            Settings.findOne({ adminId: req.adminId }),
        ]);

        let attendance = await Attendance.findOne({
            adminId: req.adminId,
            employeeId: regularization.employeeId,
            date: regularization.date,
        });
        if (!attendance) {
            attendance = new Attendance({
                adminId: req.adminId,
                employeeId: regularization.employeeId,
                date: regularization.date,
            });
        }

        if (regularization.requestedPunchIn) attendance.punchIn = regularization.requestedPunchIn;
        if (regularization.requestedPunchOut) attendance.punchOut = regularization.requestedPunchOut;
        if (regularization.requestedLunchInTime) attendance.lunchInTime = regularization.requestedLunchInTime;
        if (regularization.requestedLunchOutTime) attendance.lunchOutTime = regularization.requestedLunchOutTime;

        if (attendance.punchIn && attendance.punchOut) {
            attendance.totalWorkMs = Math.max(0, new Date(attendance.punchOut) - new Date(attendance.punchIn));
        }

        if (regularization.requestedStatus) {
            // Explicit admin intent always wins over the derived calculation.
            attendance.status = regularization.requestedStatus;
        } else if (attendance.punchIn) {
            const wasLate = user?.shiftId ? isLatePunchIn(attendance.punchIn, user.shiftId, settings) : false;
            if (wasLate) attendance.wasLate = true;

            if (attendance.punchOut) {
                const { status, remarksAppend } = determineHalfDayStatus({
                    punchIn: attendance.punchIn,
                    punchOut: attendance.punchOut,
                    totalWorkMs: attendance.totalWorkMs,
                    lunchInTime: attendance.lunchInTime,
                    lunchOutTime: attendance.lunchOutTime,
                    isWFH: attendance.isWFH,
                    shift: user?.shiftId,
                }, settings);
                attendance.status = status;
                if (status === 'half-day' && remarksAppend) attendance.remarks = (attendance.remarks || '') + remarksAppend;
            } else {
                let defaultStatus = wasLate ? 'late' : 'present';
                if (user?.shiftId && user.shiftId.halfDayLatePunchInMin) {
                    const [sHour, sMinute] = user.shiftId.startTime.split(':').map(Number);
                    const halfDayPunchInCutoff = new Date(attendance.punchIn);
                    halfDayPunchInCutoff.setHours(sHour, sMinute + user.shiftId.halfDayLatePunchInMin, 0, 0);
                    if (new Date(attendance.punchIn) > halfDayPunchInCutoff) {
                        defaultStatus = 'half-day';
                    }
                }
                attendance.status = defaultStatus;
            }
        }

        attendance.remarks = (attendance.remarks ? attendance.remarks + ' | ' : '') + `Regularized: ${regularization.reason}`;
        await attendance.save();

        regularization.status = 'approved';
        regularization.adminRemark = req.body.adminRemark || regularization.adminRemark;
        regularization.reviewedBy = req.userId;
        regularization.reviewedAt = new Date();
        regularization.attendanceId = attendance._id;
        await regularization.save();

        const populated = await regularization.populate('employeeId', 'name phone');
        res.json(populated);

        if (user) {
            calculateAndSaveSalary(req.adminId, user, regularization.date.getMonth() + 1, regularization.date.getFullYear()).catch(err => {
                console.error('Regularization approval salary sync error:', err);
            });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.rejectRegularization = async (req, res) => {
    try {
        const regularization = await Regularization.findOne({
            _id: req.params.id,
            adminId: req.adminId,
        });
        if (!regularization) return res.status(404).json({ message: 'Regularization request not found' });
        if (regularization.status !== 'pending') {
            return res.status(400).json({ message: `Cannot reject request with status: ${regularization.status}` });
        }

        regularization.status = 'rejected';
        regularization.adminRemark = req.body.adminRemark || regularization.adminRemark;
        regularization.reviewedBy = req.userId;
        regularization.reviewedAt = new Date();
        await regularization.save();

        const populated = await regularization.populate('employeeId', 'name phone');
        res.json(populated);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
