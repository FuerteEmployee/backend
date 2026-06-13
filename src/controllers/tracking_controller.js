const mongoose = require('mongoose');
const Tracking = require('../models/Tracking');

exports.updateLocation = async (req, res) => {
    try {
        const { employeeId, latitude, longitude } = req.body;
        const tracking = await Tracking.create({
            adminId: req.adminId,
            employeeId,
            latitude,
            longitude,
            timestamp: new Date()
        });
        res.status(201).json(tracking);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.getLatestLocations = async (req, res) => {
    try {
        const locations = await Tracking.aggregate([
            { $match: { adminId: new mongoose.Types.ObjectId(req.adminId) } },
            { $sort: { timestamp: -1 } },
            {
                $group: {
                    _id: '$employeeId',
                    latestLocation: { $first: '$$ROOT' }
                }
            }
        ]);
        res.json(locations.map(l => l.latestLocation));
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
