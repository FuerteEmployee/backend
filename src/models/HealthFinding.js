const mongoose = require('mongoose');

// Problems the hourly health check found in real data, for the super admin's
// Health page. Every bug real phones found on 30 Sept and 1 Oct (a wrong auto
// punch-out at a desk, a tracker silent while punched in, duplicate days, a
// phone whose device report stopped updating) was sitting in the database for
// hours before a user mentioned it. This is where those patterns surface first.
//
// Written only by jobs/health_check.js. Nothing here changes attendance, pay or
// tracking: a finding is a pointer for a person, never an action.
const KINDS = [
    'suspect_auto_punchout',
    'tracker_silent_on_duty',
    'duplicate_day',
    'open_day_past',
    'needs_review_day',
    'bad_day_shape',
    'tracking_gaps',
    'tracker_failures',
    'repeated_app_error',
    'gps_jumps',
    'stale_device_report',
    'tracking_blockers',
    'old_apk',
    'stale_corrections',
];

const HealthFindingSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    kind: { type: String, enum: KINDS, required: true },
    severity: { type: String, enum: ['high', 'medium', 'low'], required: true },
    dayKey: { type: String, default: null },

    // Plain words for the page: what is wrong, and what was measured.
    title: { type: String, required: true, maxlength: 300 },
    detail: { type: String, default: '', maxlength: 2000 },
    evidence: { type: mongoose.Schema.Types.Mixed, default: {} },

    // kind + tenant + employee + day + a reference (an audit id, an install id,
    // an error text). Unique, so an hourly run updates the same row instead of
    // adding another one.
    fingerprint: { type: String, required: true, unique: true },

    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    occurrences: { type: Number, default: 1 },

    // `open` until a person marks it resolved, or the check stops seeing it.
    status: { type: String, enum: ['open', 'resolved'], default: 'open' },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: null }, // a user id, or 'auto'
    note: { type: String, default: null, maxlength: 500 },
}, { timestamps: true });

// 90 days after it was last seen. A finding nobody has seen for three months
// is history, not a problem.
HealthFindingSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
HealthFindingSchema.index({ status: 1, severity: 1, lastSeenAt: -1 });
HealthFindingSchema.index({ kind: 1, status: 1 });

HealthFindingSchema.statics.KINDS = KINDS;

module.exports = mongoose.model('HealthFinding', HealthFindingSchema);
module.exports.KINDS = KINDS;
