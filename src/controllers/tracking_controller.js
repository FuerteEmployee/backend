const mongoose = require('mongoose');
const Tracking = require('../models/Tracking');
const User = require('../models/User');
const { istStartOfDay, istEndOfDay } = require('../utils/attendance_helpers');

// A device is only ever trusted to report its own position — employeeId
// comes from the authenticated token, never the request body (the body used
// to be trusted directly, which let any employee post tracking points under
// a co-worker's employeeId).
exports.updateLocation = async (req, res) => {
    try {
        const employeeId = req.userId;
        const { latitude, longitude } = req.body;
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

// Haversine distance (km) between two lat/lng points.
function distanceKm(a, b) {
    const R = 6371;
    const dLat = (b.latitude - a.latitude) * Math.PI / 180;
    const dLng = (b.longitude - a.longitude) * Math.PI / 180;
    const s = Math.sin(dLat / 2) ** 2 +
        Math.cos(a.latitude * Math.PI / 180) * Math.cos(b.latitude * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// One employee's full route for a day — every recorded point, oldest first,
// so the map can draw it as a polyline with Start/End markers.
exports.getHistory = async (req, res) => {
    try {
        const { employeeId, date } = req.query;
        if (!employeeId) {
            return res.status(400).json({ message: 'employeeId is required' });
        }
        const day = date ? new Date(date) : new Date();
        const dayStart = istStartOfDay(day);
        const dayEnd = istEndOfDay(day);

        const points = await Tracking.find({
            adminId: req.adminId,
            employeeId,
            timestamp: { $gte: dayStart, $lte: dayEnd }
        }).sort({ timestamp: 1 }).lean();

        let totalDistanceKm = 0;
        for (let i = 1; i < points.length; i++) {
            totalDistanceKm += distanceKm(points[i - 1], points[i]);
        }

        res.json({ points, distanceKm: Math.round(totalDistanceKm * 100) / 100 });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Bundled counts for the Tracking page's stat cards.
exports.getStats = async (req, res) => {
    try {
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const dayStart = istStartOfDay();
        const dayEnd = istEndOfDay();
        const LIVE_WINDOW_MS = 2 * 60 * 1000; // matches the 15s report interval with margin
        const liveSince = new Date(Date.now() - LIVE_WINDOW_MS);

        const [fieldStaff, trackingPoints, liveEmployeeIds] = await Promise.all([
            User.countDocuments({ adminId, role: 'employee', trackingEnabled: true }),
            Tracking.countDocuments({ adminId, timestamp: { $gte: dayStart, $lte: dayEnd } }),
            Tracking.distinct('employeeId', { adminId, timestamp: { $gte: liveSince } }),
        ]);

        const liveNow = liveEmployeeIds.length;
        res.json({
            liveNow,
            offline: Math.max(0, fieldStaff - liveNow),
            trackingPoints,
            fieldStaff,
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Admin asks a specific employee's device for a fresh fix right now.
exports.requestPing = async (req, res) => {
    try {
        const employee = await User.findOneAndUpdate(
            { _id: req.params.employeeId, adminId: req.adminId },
            { lastPingRequestedAt: new Date() },
            { new: true }
        ).select('_id lastPingRequestedAt');
        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }
        res.json({ pingRequestedAt: employee.lastPingRequestedAt });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// The employee's own running tracker polls this to notice a pending ping.
exports.checkPing = async (req, res) => {
    try {
        const user = await User.findById(req.userId).select('lastPingRequestedAt');
        res.json({ pingRequestedAt: user?.lastPingRequestedAt || null });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
