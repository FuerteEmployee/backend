const mongoose = require('mongoose');
const Tracking = require('../models/Tracking');
const User = require('../models/User');
const { istStartOfDay, istEndOfDay } = require('../utils/attendance_helpers');
const { evaluateEmployee } = require('../utils/geofence_engine');

// A device is only ever trusted to report its own position — employeeId
// comes from the authenticated token, never the request body (the body used
// to be trusted directly, which let any employee post tracking points under
// a co-worker's employeeId).
exports.updateLocation = async (req, res) => {
    try {
        const employeeId = req.userId;
        const { latitude, longitude, accuracy } = req.body;

        // The client has always sent `accuracy`; it was discarded because the
        // schema did not declare it. Stored now because nothing can judge
        // whether a fix is worth acting on without it.
        //
        // Normalised to null rather than kept as-is: the shipped app sends 0
        // for "unreported", and a 0 would otherwise read as a perfect fix. A
        // real GPS reading never reports 0 m uncertainty.
        const accN = Number(accuracy);
        const accuracyM = Number.isFinite(accN) && accN > 0 ? accN : null;

        const tracking = await Tracking.create({
            adminId: req.adminId,
            employeeId,
            latitude,
            longitude,
            accuracy: accuracyM,
            timestamp: new Date()
        });
        res.status(201).json(tracking);

        // Fire-and-forget, same as the batch endpoint. Without this, auto
        // punch-out only ever fires for the native Android tracker (which
        // posts to /update/batch) and never for anyone on the browser or PWA
        // uploader, which still posts single fixes here.
        evaluateEmployee({ adminId: req.adminId, employeeId })
            .catch((e) => console.error('[tracking] geofence evaluation failed:', e.message));
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

/**
 * POST /api/tracking/update/batch
 *
 * Bulk ingest from the native background tracker, which queues fixes in a local
 * Room database and flushes them when the network returns.
 *
 * Two properties matter more than throughput here:
 *
 *  - The CLIENT'S capture time wins. `trackedAt` is when the phone actually
 *    recorded the position. Stamping receive time would collapse a six-hour
 *    offline backlog onto the single instant the signal came back -- the exact
 *    failure the eSSL terminals had, and worse here, because the geofence
 *    engine would read that burst as a long stationary dwell.
 *
 *  - It is IDEMPOTENT. The syncer only deletes a row once the server has
 *    acknowledged it, so a response lost in flight makes it resend. Duplicate
 *    points would bias every geofence decision toward wherever the phone was
 *    when the network flapped, so duplicates are dropped on the unique index
 *    rather than merely discouraged.
 */
exports.updateLocationBatch = async (req, res) => {
    try {
        const employeeId = req.userId;
        const points = Array.isArray(req.body?.points) ? req.body.points : [];

        if (!points.length) return res.json({ accepted: 0, duplicates: 0, rejected: 0 });

        // Bounded so a malfunctioning client cannot post an unbounded array.
        const MAX_BATCH = 500;
        const slice = points.slice(0, MAX_BATCH);

        const now = new Date();
        const docs = [];
        let rejected = 0;

        for (const p of slice) {
            // Accept both naming conventions: the native syncer speaks lat/lng,
            // the existing web client speaks latitude/longitude.
            const lat = Number(p.latitude ?? p.lat);
            const lng = Number(p.longitude ?? p.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) { rejected++; continue; }
            if (lat < -90 || lat > 90 || lng < -180 || lng > 180) { rejected++; continue; }

            const t = p.trackedAt || p.timestamp;
            const captured = t ? new Date(t) : now;
            if (Number.isNaN(captured.getTime())) { rejected++; continue; }
            // A fix dated in the future, or older than the retention window, is
            // a broken device clock rather than history worth keeping.
            if (captured.getTime() > now.getTime() + 5 * 60 * 1000) { rejected++; continue; }
            if (now.getTime() - captured.getTime() > 90 * 24 * 60 * 60 * 1000) { rejected++; continue; }

            // 0 means "unreported" on every APK currently in the field, and a
            // real GPS fix never reports 0 m uncertainty.
            const accN = Number(p.accuracy);
            const accuracy = Number.isFinite(accN) && accN > 0 ? accN : null;

            const speedN = Number(p.speed);
            const battN = Number(p.batteryLevel);

            docs.push({
                adminId: req.adminId,
                employeeId,
                latitude: lat,
                longitude: lng,
                accuracy,
                timestamp: captured,
                receivedAt: now,
                speed: Number.isFinite(speedN) && speedN >= 0 ? speedN : null,
                batteryLevel: Number.isFinite(battN) ? Math.max(0, Math.min(100, battN)) : null,
                activityType: typeof p.activityType === 'string' ? p.activityType : null,
                sessionId: typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : null,
                source: p.source === 'ping' ? 'ping' : 'background',
            });
        }

        let accepted = 0;
        let duplicates = 0;

        if (docs.length) {
            try {
                const inserted = await Tracking.insertMany(docs, { ordered: false });
                accepted = inserted.length;
            } catch (err) {
                // ordered:false keeps going past duplicates; the error carries
                // what did land. A duplicate is a SUCCESS from the client's
                // point of view -- the point is stored -- so it must be
                // acknowledged, or the syncer retries it forever.
                accepted = err?.result?.nInserted ?? err?.insertedDocs?.length ?? 0;
                duplicates = docs.length - accepted;
                const dupOnly = (err?.writeErrors || []).every((e) => e?.err?.code === 11000 || e?.code === 11000);
                if (!dupOnly && !err?.writeErrors?.length) throw err;
            }
        }

        // Acknowledge FIRST, then decide. The employee's phone is waiting on
        // this response to clear its queue, and a slow geofence evaluation must
        // not hold that open or make a working upload look like a failure.
        res.json({ accepted, duplicates, rejected: rejected + (slice.length - docs.length - rejected) });

        // Fire-and-forget: a decision failure must never surface as an upload error.
        if (accepted > 0) {
            evaluateEmployee({ adminId: req.adminId, employeeId })
                .catch((e) => console.error('[tracking] geofence evaluation failed:', e.message));
        }
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
