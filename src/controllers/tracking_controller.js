const mongoose = require('mongoose');
const Tracking = require('../models/Tracking');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const { istStartOfDay, istEndOfDay } = require('../utils/attendance_helpers');
const { evaluateEmployee, replayEmployee } = require('../utils/geofence_engine');
const { MAX_FIX_AGE_MS } = require('../utils/geofence_window');
const { smoothTrack } = require('../utils/track_smoothing');

// A device is only ever trusted to report its own position — employeeId
// comes from the authenticated token, never the request body (the body used
// to be trusted directly, which let any employee post tracking points under
// a co-worker's employeeId).
/**
 * Is this employee's location allowed to be stored at all?
 *
 * `trackingEnabled` was enforced NOWHERE on the write path. `/tracking/ping-check`
 * tells the client whether it should be tracking, but a client that ignores the
 * answer -- or was never told, because it is an older build -- could keep
 * posting, and the server stored every fix. Observed 2026-09-18: an employee
 * with the toggle OFF had 1153 fixes recorded that day and was still reporting.
 *
 * That is a consent problem, not an untidiness one: switching tracking off in
 * the admin UI has to actually stop collection, or the switch is a lie.
 *
 * Mirrors the ping-check rule exactly (own flag OR department flag), so the
 * answer the client is given and the rule the server enforces cannot diverge.
 *
 * Cached briefly because this now runs on every fix, and the native tracker
 * posts roughly every 45s per employee. Same 30s window the device registry
 * uses, so flipping the toggle in the UI takes effect without a restart.
 */
const TRACKING_CACHE_MS = 30 * 1000;
const trackingAllowedCache = new Map();

async function isTrackingAllowed(employeeId) {
    const key = String(employeeId);
    const hit = trackingAllowedCache.get(key);
    if (hit && Date.now() - hit.at < TRACKING_CACHE_MS) return hit.allowed;

    const u = await User.findById(employeeId)
        .populate('departmentId', 'trackingEnabled')
        .select('trackingEnabled departmentId')
        .lean();

    // An employee who cannot be loaded is not tracked. Failing closed is the
    // safe direction for a consent check.
    const allowed = !!u && (u.trackingEnabled === true || u.departmentId?.trackingEnabled === true);
    trackingAllowedCache.set(key, { allowed, at: Date.now() });
    return allowed;
}

exports.updateLocation = async (req, res) => {
    try {
        const employeeId = req.userId;
        const { latitude, longitude, accuracy } = req.body;

        // 202, not 403: a client that treats a refusal as an error retries it,
        // which is exactly the loop this is meant to end. `tracking: false`
        // tells the app to stop, the same answer /tracking/ping-check gives.
        if (!(await isTrackingAllowed(employeeId))) {
            return res.status(202).json({ stored: false, tracking: false });
        }

        // The client has always sent `accuracy`; it was discarded because the
        // schema did not declare it. Stored now because nothing can judge
        // whether a fix is worth acting on without it.
        //
        // Normalised to null rather than kept as-is: the shipped app sends 0
        // for "unreported", and a 0 would otherwise read as a perfect fix. A
        // real GPS reading never reports 0 m uncertainty.
        const accN = Number(accuracy);
        const accuracyM = Number.isFinite(accN) && accN > 0 ? accN : null;

        // WHEN THE DEVICE CAPTURED THE FIX, not when we heard about it.
        //
        // This endpoint stamped `new Date()` and ignored whatever the client
        // sent, which is the exact failure the Tracking schema warns about:
        // a queued offline backlog flushes and every fix lands at the instant
        // the network returned, collapsing a route onto one point and handing
        // the geofence engine a burst of identical timestamps that reads as a
        // long stationary dwell. updateLocationBatch was fixed; this was not,
        // so the browser/PWA uploader kept producing receive-time history.
        //
        // Same guards as the batch path, deliberately identical: a fix dated
        // in the future or older than the retention window is a broken device
        // clock, not history worth keeping.
        const now = new Date();
        const rawAt = req.body.trackedAt || req.body.timestamp;
        let captured = rawAt ? new Date(rawAt) : now;
        if (Number.isNaN(captured.getTime())) captured = now;
        if (captured.getTime() > now.getTime() + 5 * 60 * 1000) captured = now;
        if (now.getTime() - captured.getTime() > 90 * 24 * 60 * 60 * 1000) captured = now;

        const speedN = Number(req.body.speed);
        const battN = Number(req.body.batteryLevel);

        const tracking = await Tracking.create({
            adminId: req.adminId,
            employeeId,
            latitude,
            longitude,
            accuracy: accuracyM,
            timestamp: captured,
            receivedAt: now,
            speed: Number.isFinite(speedN) && speedN >= 0 ? speedN : null,
            batteryLevel: Number.isFinite(battN) ? Math.max(0, Math.min(100, battN)) : null,
            activityType: typeof req.body.activityType === 'string' ? req.body.activityType : null,
            activitySource: req.body.activitySource === 'sensor' || req.body.activitySource === 'speed'
                ? req.body.activitySource : null,
            activityConfidence: Number.isFinite(Number(req.body.activityConfidence))
                ? Math.max(0, Math.min(100, Number(req.body.activityConfidence)))
                : null,
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

        // Same consent gate as the single-fix endpoint. This is the path the
        // native tracker uses, so without it the toggle stops nothing at all.
        if (!(await isTrackingAllowed(employeeId))) {
            return res.json({ accepted: 0, duplicates: 0, rejected: points.length, tracking: false });
        }

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
                // Only 'sensor' and 'speed' are meaningful; anything else is a
                // client we do not recognise and is stored as unknown rather
                // than trusted.
                activitySource: p.activitySource === 'sensor' || p.activitySource === 'speed' ? p.activitySource : null,
                activityConfidence: Number.isFinite(Number(p.activityConfidence))
                    ? Math.max(0, Math.min(100, Number(p.activityConfidence)))
                    : null,
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
            // Was this a LIVE batch, or a backlog from a phone that was offline?
            //
            // A live batch is evaluated once at `now`, exactly as before. A
            // backlog is different in kind: its fixes describe a period that has
            // already passed, and evaluating them at arrival time is how a real
            // 12-minute absence went completely unrecorded — every fix proving
            // it was older than MAX_FIX_AGE_MS by the time it landed, and the
            // employee was already back at their desk.
            //
            // Replaying at the instants the evidence is about is the only way to
            // judge it on what was actually knowable then. The staleness gate
            // stays exactly as it is for live traffic, where it belongs.
            // From the candidate docs rather than the insert result: a duplicate
            // is still a real observation from that period, and the window this
            // batch describes is what decides whether it is a backlog.
            const stamps = docs.map((d) => d.timestamp.getTime());
            const oldest = stamps.length ? Math.min(...stamps) : null;
            const newest = stamps.length ? Math.max(...stamps) : null;
            const isBacklog = oldest != null && now.getTime() - oldest > MAX_FIX_AGE_MS;

            const work = isBacklog
                ? replayEmployee({ adminId: req.adminId, employeeId, from: oldest, to: newest })
                : evaluateEmployee({ adminId: req.adminId, employeeId });

            work.catch((e) => console.error('[tracking] geofence evaluation failed:', e.message));
        }
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// A fix older than this is history, not a live position.
//
// Defined once and shared by getLatestLocations and getStats so the map and
// the stat cards cannot disagree about who is live. They did once: the stats
// applied this window while the map returned every employee's newest fix with
// no age at all, so a pin from forty days ago in another city rendered
// identically to one from twelve seconds ago. The summary said "1 live", the
// map showed five, and the map is what people believe.
//
// Two minutes, against a native sync interval of ~45s: long enough that one
// missed flush does not blink somebody offline, short enough that a phone
// which has genuinely stopped reporting shows as stale within a shift.
const LIVE_WINDOW_MS = 2 * 60 * 1000;

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

        // Age travels with the row. The client could subtract timestamps
        // itself, but then the threshold would live in two places and drift;
        // sending liveWindowSeconds lets the UI re-evaluate freshness between
        // polls without owning a second copy of the number.
        const now = Date.now();
        res.json(locations.map(({ latestLocation }) => {
            const ageMs = now - new Date(latestLocation.timestamp).getTime();
            return {
                ...latestLocation,
                ageSeconds: Math.max(0, Math.round(ageMs / 1000)),
                isLive: ageMs <= LIVE_WINDOW_MS,
                liveWindowSeconds: Math.round(LIVE_WINDOW_MS / 1000),
            };
        }));
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

        // Smoothed for DISPLAY. The raw fixes are returned untouched as
        // `rawPoints` and are what the geofence engine keeps reading -- this
        // only changes what a human is shown, never what a decision is made on.
        //
        // Summing every raw hop reported a phone that sat on a desk all morning
        // as having travelled 11.62 km, and drew its route as a scribble. See
        // utils/track_smoothing.js for the calibration.
        const { path, distanceM, rawDistanceM, rawCount } = smoothTrack(points);

        res.json({
            points: path,
            distanceKm: Math.round((distanceM / 1000) * 100) / 100,
            // Kept visible rather than quietly dropped: an admin comparing this
            // screen with an older screenshot needs to see that the number
            // changed because the maths changed, not because someone moved.
            rawDistanceKm: Math.round((rawDistanceM / 1000) * 100) / 100,
            rawCount,
            smoothed: path.length !== rawCount,
            rawPoints: points,
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * Fixes that reached us LATER than they were taken — the offline backlog,
 * after the fact.
 *
 * Every fix carries both when the phone recorded it (`timestamp`) and when the
 * server received it (`receivedAt`). A meaningful gap between the two means the
 * fix sat in the device's queue while it had no network and was delivered on
 * reconnect. That is the difference between "we lost his afternoon" and "his
 * afternoon arrived at 6pm", and it is the single most useful thing to be able
 * to show a client who thinks tracking is broken. Live data has 266 such fixes,
 * the worst delivered 18 hours late.
 *
 * Returns the lag per fix rather than a total, so the caller can attribute each
 * one to the outage it belongs to.
 */
const HELD_FIX_MIN_LAG_MS = 2 * 60 * 1000;

exports.getHeldFixes = async (req, res) => {
    try {
        const { employeeId, from, to } = req.query;
        if (!employeeId) {
            return res.status(400).json({ message: 'employeeId is required' });
        }

        const start = from ? new Date(from) : istStartOfDay(new Date());
        const end = to ? new Date(to) : istEndOfDay(new Date());
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
            return res.status(400).json({ message: 'from/to must be valid dates' });
        }

        const rows = await Tracking.aggregate([
            {
                $match: {
                    adminId: new mongoose.Types.ObjectId(req.adminId),
                    employeeId: new mongoose.Types.ObjectId(employeeId),
                    timestamp: { $gte: start, $lte: end },
                    receivedAt: { $ne: null },
                },
            },
            { $project: { timestamp: 1, receivedAt: 1, lagMs: { $subtract: ['$receivedAt', '$timestamp'] } } },
            { $match: { lagMs: { $gte: HELD_FIX_MIN_LAG_MS } } },
            { $sort: { timestamp: 1 } },
            // A day of buffered fixes is thousands of rows and the caller only
            // ever counts them per interval; the cap keeps one bad day from
            // returning a payload nobody reads.
            { $limit: 2000 },
        ]);

        res.json({ fixes: rows, minLagMs: HELD_FIX_MIN_LAG_MS });
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
        const liveSince = new Date(Date.now() - LIVE_WINDOW_MS);

        const [fieldStaff, trackingPoints, liveEmployeeIds] = await Promise.all([
            User.countDocuments({ adminId, role: 'employee', trackingEnabled: true }),
            Tracking.countDocuments({ adminId, timestamp: { $gte: dayStart, $lte: dayEnd } }),
            Tracking.distinct('employeeId', { adminId, timestamp: { $gte: liveSince } }),
        ]);

        const liveNow = liveEmployeeIds.length;

        // "Expected but silent": punched in, tracking is supposed to be on, and
        // yet nothing has arrived for a while.
        //
        // This is the number that matters operationally. "Offline" counts
        // everyone not currently reporting, most of whom are simply off shift
        // and perfectly fine. This counts only the people who SHOULD be sending
        // and are not — which is the only version of the question an admin can
        // act on, and the failure that otherwise goes unnoticed until payroll.
        const onDuty = await Attendance.find({
            adminId,
            date: { $gte: dayStart, $lte: dayEnd },
            punchIn: { $ne: null },
            punchOut: null,
        }).select('employeeId').lean();

        let expectedButSilent = 0;
        if (onDuty.length) {
            const ids = onDuty.map((a) => a.employeeId);
            const tracked = await User.find({
                _id: { $in: ids }, adminId,
            }).populate('departmentId', 'trackingEnabled').select('trackingEnabled departmentId').lean();

            const liveSet = new Set(liveEmployeeIds.map(String));
            for (const u of tracked) {
                const shouldTrack = u.trackingEnabled === true || u.departmentId?.trackingEnabled === true;
                if (shouldTrack && !liveSet.has(String(u._id))) expectedButSilent++;
            }
        }

        res.json({
            liveNow,
            offline: Math.max(0, fieldStaff - liveNow),
            trackingPoints,
            fieldStaff,
            expectedButSilent,
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
