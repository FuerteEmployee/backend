const mongoose = require('mongoose');

// Append-only log of every punch, from every channel.
//
// `Attendance` is the day's *state* — it gets overwritten by a re-punch, an
// admin correction or a reconciliation pass. This is the *evidence*: one
// immutable row per punch, so a disputed day can be reconstructed without
// trying to reverse-engineer what `shifts[]` used to look like.
//
// It is also what makes an employee-facing activity feed possible
// ("Punched in — 9:32 AM · 24 m from Rajkot branch") without exposing the
// day-state document.
//
// Writes are fire-and-forget: see utils/attendance_event_logger.js. A failure
// to log must never fail a punch — the punch is the thing that matters.
const AttendanceEventSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // IST calendar day, 'YYYY-MM-DD'. Stored as a string so day-boundary
    // queries are exact and immune to timezone drift, matching how PunchLog
    // and the reconciliation engine already key days.
    dayKey: { type: String, required: true },

    type: {
        type: String,
        enum: ['punch-in', 'punch-out', 'lunch-in', 'lunch-out', 'auto-punch-out'],
        required: true,
    },

    // Which channel produced it. 'app' = explicit employee action,
    // 'biometric'/'lens' = a device tap, 'system' = a job or the geofence
    // engine acting without anyone pressing anything, 'admin' = a correction.
    source: {
        type: String,
        enum: ['app', 'biometric', 'lens', 'system', 'admin'],
        default: 'app',
    },

    // The true instant of the punch. On an offline replay this is the
    // HISTORICAL capture time, not when the server heard about it — the whole
    // point of an evidence row is that it records when something happened.
    at: { type: Date, required: true },

    // Which session of the day this punch belongs to (1-based).
    sessionNumber: { type: Number, default: 1 },

    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    // Metres, null when unreported. Never 0 — a 0 reads as a perfect fix and
    // every APK currently in the field sends 0 to mean "unknown".
    accuracy: { type: Number, default: null },
    // Precomputed so a feed or audit does not have to re-derive geometry, and
    // so it stays correct even if the branch is later moved or deleted.
    distanceFromBranch: { type: Number, default: null },

    // Why a close happened, when it was not the employee pressing the button.
    closeReason: {
        type: String,
        enum: [null, 'manual', 'auto_geofence', 'shift_end', 'admin', 'device'],
        default: null,
    },
}, { timestamps: true });

// The feed: one employee's punches for one day, in order.
AttendanceEventSchema.index({ adminId: 1, employeeId: 1, dayKey: 1, at: 1 });
// Tenant-wide triage.
AttendanceEventSchema.index({ adminId: 1, at: -1 });
// 1-year retention: long enough to settle a dispute over any payslip period,
// bounded so evidence rows do not accumulate forever.
AttendanceEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = mongoose.model('AttendanceEvent', AttendanceEventSchema);
