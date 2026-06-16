const Branch = require('../models/Branch');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const mongoose = require('mongoose');

exports.getBranches = async (req, res) => {
    try {
        const branches = await Branch.aggregate([
            { $match: { adminId: new mongoose.Types.ObjectId(req.adminId) } },
            {
                // Count employees whose primary branch OR any of their multiple branches is this branch
                $lookup: {
                    from: 'users',
                    let: { branchId: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $or: [
                                        { $eq: ['$branchId', '$$branchId'] },
                                        { $in: ['$$branchId', { $ifNull: ['$branchIds', []] }] }
                                    ]
                                }
                            }
                        }
                    ],
                    as: 'employees'
                }
            },
            {
                $project: {
                    _id: 1,
                    branchName: 1,
                    branchLocation: 1,
                    latitude: 1,
                    longitude: 1,
                    createdAt: 1,
                    employees: { $size: '$employees' }
                }
            }
        ]);
        res.json(branches);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.createBranch = async (req, res) => {
    try {
        // Check branch count limit
        if (req.adminId) {
            const subscription = await Subscription.findOne({ adminId: req.adminId }).populate('planId');
            if (subscription && subscription.planId) {
                const limitVal = subscription.planId.modules?.get('branchesDepts') || subscription.planId.modules?.['branchesDepts'];
                if (limitVal && limitVal !== 'unlimited' && limitVal !== 'none') {
                    const limitNum = Number(limitVal);
                    if (!isNaN(limitNum)) {
                        const currentCount = await Branch.countDocuments({ adminId: req.adminId });
                        if (currentCount >= limitNum) {
                            return res.status(400).json({
                                message: `Branch limit reached (maximum ${limitNum} branch locations allowed on your plan). Please upgrade your plan to add more.`
                            });
                        }
                    }
                }
            }
        }

        const branch = await Branch.create({ 
            ...req.body, 
            adminId: new mongoose.Types.ObjectId(req.adminId) 
        });
        res.status(201).json(branch);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.updateBranch = async (req, res) => {
    try {
        const branch = await Branch.findOneAndUpdate(
            { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) },
            req.body,
            { new: true }
        );
        if (!branch) return res.status(404).json({ message: 'Branch not found' });
        res.json(branch);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.deleteBranch = async (req, res) => {
    try {
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const branch = await Branch.findOneAndDelete({ _id: req.params.id, adminId });
        if (!branch) return res.status(404).json({ message: 'Branch not found' });

        // Clean up references on employees so no one points to a deleted branch.
        // 1. Remove it from everyone's multi-branch list.
        await User.updateMany(
            { adminId, branchIds: branch._id },
            { $pull: { branchIds: branch._id } }
        );
        // 2. Re-point anyone whose PRIMARY branch was this one to their first
        //    remaining branch (or null if they have none left).
        const affected = await User.find({ adminId, branchId: branch._id });
        for (const u of affected) {
            u.branchId = (u.branchIds && u.branchIds.length > 0) ? u.branchIds[0] : null;
            await u.save();
        }

        res.json({ message: 'Branch removed' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
