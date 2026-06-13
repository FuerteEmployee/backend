const Department = require('../models/Department');
const Subscription = require('../models/Subscription');
const mongoose = require('mongoose');

exports.getDepartments = async (req, res) => {
    try {
        const departments = await Department.aggregate([
            { $match: { adminId: new mongoose.Types.ObjectId(req.adminId) } },
            {
                $lookup: {
                    from: 'users',
                    localField: '_id',
                    foreignField: 'departmentId',
                    as: 'employees'
                }
            },
            {
                $project: {
                    _id: 1,
                    name: 1,
                    colorCode: 1,
                    createdAt: 1,
                    employees: { $size: '$employees' }
                }
            }
        ]);
        res.json(departments);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.createDepartment = async (req, res) => {
    try {
        // Check department count limit
        if (req.adminId) {
            const subscription = await Subscription.findOne({ adminId: req.adminId }).populate('planId');
            if (subscription && subscription.planId) {
                const limitVal = subscription.planId.modules?.get('branchesDepts') || subscription.planId.modules?.['branchesDepts'];
                if (limitVal && limitVal !== 'unlimited' && limitVal !== 'none') {
                    const limitNum = Number(limitVal);
                    if (!isNaN(limitNum)) {
                        const currentCount = await Department.countDocuments({ adminId: req.adminId });
                        if (currentCount >= limitNum) {
                            return res.status(400).json({
                                message: `Department limit reached (maximum ${limitNum} departments allowed on your plan). Please upgrade your plan to add more.`
                            });
                        }
                    }
                }
            }
        }

        const department = await Department.create({ 
            ...req.body, 
            adminId: new mongoose.Types.ObjectId(req.adminId) 
        });
        res.status(201).json(department);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.updateDepartment = async (req, res) => {
    try {
        const department = await Department.findOneAndUpdate(
            { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) },
            req.body,
            { new: true }
        );
        if (!department) return res.status(404).json({ message: 'Department not found' });
        res.json(department);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.deleteDepartment = async (req, res) => {
    try {
        const department = await Department.findOneAndDelete({ 
            _id: req.params.id, 
            adminId: new mongoose.Types.ObjectId(req.adminId) 
        });
        if (!department) return res.status(404).json({ message: 'Department not found' });
        res.json({ message: 'Department removed' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
