// Records an IP-based approximate location for an employee whose GPS is
// unavailable. The lookup and its limits are in ip_location.js.
//
// Called fire-and-forget from two places the phone keeps reaching while GPS is
// off: the native tracker's 30 s GET /attendance/today poll, and its POST
// /client/events report of `gps_off`. Never awaited by them and never throws,
// so a slow lookup or a database hiccup cannot delay or fail either request.
const mongoose = require('mongoose');
const Tracking = require('../models/Tracking');
const ApproxLocation = require('../models/ApproxLocation');
const { clientIp } = require('./client_ip');
const { lookupIp, isPlausible, shouldRecord, IP_ACCURACY_M } = require('./ip_location');

// employeeId -> { at, ip } of the last reading, so the 30 s poll costs nothing
// on the 19 polls out of 20 that are inside the throttle window. Per process;
// a second process just records its own reading, which is harmless.
const lastReading = new Map();

async function recordIpLocation(req, trigger) {
    try {
        if (req.currentUser?.role !== 'employee') return;
        const ip = clientIp(req);
        if (!ip) return;
        const employeeId = String(req.userId);
        const now = Date.now();

        // The cheap in-memory gate first, before any database read.
        const last = lastReading.get(employeeId);
        if (!shouldRecord({ last, ip, trigger, lastGpsAt: null, now })) return;

        // Same consent rule as GPS fixes: switching someone's tracking off in
        // the admin UI stops this too. Required lazily: the controller is
        // where that rule lives.
        const { isTrackingAllowed } = require('../controllers/tracking_controller');
        if (!(await isTrackingAllowed(employeeId))) return;

        const lastGps = await Tracking.findOne({
            adminId: req.adminId,
            employeeId: new mongoose.Types.ObjectId(employeeId),
        }).sort({ timestamp: -1 }).select('latitude longitude timestamp').lean();
        if (!shouldRecord({ last, ip, trigger, lastGpsAt: lastGps?.timestamp, now })) return;

        // Claimed before the lookup, so a burst of polls does one lookup.
        lastReading.set(employeeId, { at: now, ip });

        const place = await lookupIp(ip);
        if (!place) return;
        const reading = { ...place, timestamp: new Date(now) };

        await ApproxLocation.create({
            adminId: req.adminId,
            employeeId,
            ...reading,
            accuracyM: IP_ACCURACY_M,
            ip,
            trigger,
            plausible: isPlausible(reading, lastGps),
        });
    } catch (err) {
        console.error('[ip-location] record failed:', err.message);
    }
}

module.exports = { recordIpLocation };
