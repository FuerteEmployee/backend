const Shift = require('../models/Shift');
const Subscription = require('../models/Subscription');
const mongoose = require('mongoose');

exports.getShifts = async (req, res) => {
    try {
        const shifts = await Shift.find({ adminId: new mongoose.Types.ObjectId(req.adminId) });
        res.json(shifts);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.createShift = async (req, res) => {
    try {
        // Check shift count limit
        if (req.adminId) {
            const subscription = await Subscription.findOne({ adminId: req.adminId }).populate('planId');
            if (subscription && subscription.planId) {
                const limitVal = subscription.planId.modules?.get('shifts') || subscription.planId.modules?.['shifts'];
                if (limitVal && limitVal.includes('2')) {
                    const currentCount = await Shift.countDocuments({ adminId: req.adminId });
                    if (currentCount >= 2) {
                        return res.status(400).json({
                            message: `Shift limit reached (maximum 2 shift profiles allowed on your plan). Please upgrade your plan to add more.`
                        });
                    }
                }
            }
        }

        const shift = await Shift.create({ ...req.body, adminId: new mongoose.Types.ObjectId(req.adminId) });
        res.status(201).json(shift);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.updateShift = async (req, res) => {
    try {
        const shift = await Shift.findOneAndUpdate(
            { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) },
            req.body,
            { new: true }
        );
        if (!shift) return res.status(404).json({ message: 'Shift not found' });
        res.json(shift);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.deleteShift = async (req, res) => {
    try {
        const shift = await Shift.findOneAndDelete({ _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) });
        if (!shift) return res.status(404).json({ message: 'Shift not found' });
        res.json({ message: 'Shift removed' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
