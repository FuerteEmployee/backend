const mongoose = require('mongoose');

const TrackingSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    // GPS uncertainty in metres. The client has always sent this; without the
    // field declared, Mongoose strict mode dropped it on every update, so no
    // stored fix could ever be judged trustworthy.
    //
    // null means "not reported" and must stay distinguishable from a small
    // number: unknown accuracy is untrustworthy, whereas 0 would read as a
    // perfect fix. Anything deciding whether someone left a geofence has to
    // exclude unknowns rather than trust them.
    accuracy: { type: Number, default: null },

    // WHEN THE DEVICE CAPTURED THE FIX.
    //
    // This used to be stamped `new Date()` server-side on arrival, which is
    // only correct while the device is online. The background tracker queues
    // fixes in a local database and flushes them when the network returns, so
    // a receive-time stamp would record six hours of someone's movements at
    // the single instant their signal came back -- collapsing a whole route
    // onto one point and, worse, feeding the geofence engine a burst of
    // identical timestamps that looks like a long stationary dwell.
    //
    // This is the same failure the eSSL terminals had (see
    // parseDeviceTimestamp in utils/attendance_helpers.js). Defaults to now so
    // a single-fix client that sends nothing keeps working unchanged.
    timestamp: { type: Date, default: Date.now },
    // When the SERVER heard about it. The gap between this and `timestamp` is
    // how long the fix sat in the offline queue, and is what tells an auditor
    // that a decision was made on a stale reading.
    receivedAt: { type: Date, default: Date.now },

    // Metres per second, as reported by the platform. null when unknown --
    // never 0, which is a real value meaning "standing still".
    speed: { type: Number, default: null },
    // 0-100. A tracker that stops reporting is usually a flat battery, and
    // without this the difference between "left the building" and "phone died"
    // is unknowable after the fact.
    batteryLevel: { type: Number, default: null },
    // Platform activity hint (still / walking / running / vehicle / cycling /
    // moving / stationary / unknown).
    activityType: { type: String, default: null },

    // ── How activityType was arrived at ──────────────────────────────────────
    //
    // 'sensor'  Activity Recognition read the accelerometer. Trustworthy: a
    //           phone lying on a desk produces no acceleration, however far its
    //           reported coordinates wander.
    // 'speed'   Inferred from the GPS speed field, which on a stationary handset
    //           is computed from the very drift it is supposed to explain.
    //           Measured 2026-09-18: a phone on a desk reported 191 of 568 fixes
    //           as "moving" at up to 24.2 m/s, while an employee who genuinely
    //           walked 711 m was called "stationary" for 137 of 162 fixes.
    //
    // Recorded rather than assumed because both arrive at once: every APK in the
    // field sends speed-derived labels and will until it is replaced. Without
    // this the server cannot tell a measured 'still' from a guessed one and
    // would have to distrust both, wasting the signal entirely.
    activitySource: { type: String, enum: [null, 'sensor', 'speed'], default: null },
    // 0-100, as reported by Play Services. 0 when unknown.
    activityConfidence: { type: Number, default: null },

    // Which punch session this fix belongs to, when the client knows. Lets a
    // route be reconstructed per session on a multi-session day rather than
    // smeared across the whole calendar day.
    sessionId: { type: String, default: null },

    // How the fix reached us: 'app' = foreground WebView, 'background' = the
    // native foreground service, 'ping' = an admin-requested immediate fix.
    // This coordinate was already reported by this employee recently, so it
    // is the same underlying Location object re-delivered rather than a new
    // observation — the phone had no fresh GPS and handed back its cache.
    //
    // Stored rather than dropped: the map trace and the audit trail both want
    // every point the device sent. But a repeat must never VOTE in a geofence
    // decision, because five copies of one reading are one observation, and a
    // medoid over them lands on the repeat. That is the exact mechanism behind
    // the reference implementation's 84 wrong punch-outs.
    cached: { type: Boolean, default: false },

    source: {
        type: String,
        enum: ['app', 'background', 'ping'],
        default: 'app',
    },
}, { timestamps: true });

TrackingSchema.index({ adminId: 1, employeeId: 1, timestamp: -1 });

// Idempotent batch ingest. The native syncer deletes a row only after the
// server acknowledges it, so a response lost in flight makes it resend the
// same points -- which without this index would duplicate the whole batch and
// bias every geofence decision toward wherever the device happened to be.
TrackingSchema.index(
    { employeeId: 1, timestamp: 1 },
    { unique: true }
);

// 90-day retention. Routes are high-volume and only useful while a dispute is
// live; payroll itself never reads them.
TrackingSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('Tracking', TrackingSchema);
