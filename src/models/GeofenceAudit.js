const mongoose = require('mongoose');

// Why the geofence engine did, or did not, punch somebody out.
//
// The decisive design choice here is that ABSTENTIONS are recorded too, not
// just closures. An engine that logs only the punch-outs it performed is
// unfalsifiable: when an employee says "it threw me out for nothing" there is
// a row to examine, but when a manager says "it never catches anyone" there is
// nothing at all, and no way to tell a correctly-cautious engine apart from
// one that is silently broken. Most rows in this collection should say
// `decision: 'abstained'` -- that is the system working.
//
// Every field is what the decision ACTUALLY used at the time. Nothing is
// recomputed on read: branches get moved, radii get edited, and an audit that
// re-derives its own evidence from current settings can no longer explain a
// decision taken last month.
const GeofenceAuditSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // IST calendar day, 'YYYY-MM-DD'. A string for the same reason PunchLog and
    // AttendanceEvent use one: day-boundary queries are then exact and immune
    // to timezone drift.
    dayKey: { type: String, required: true },

    decision: {
        type: String,
        enum: ['punched_out', 'abstained', 'inside', 'suppressed'],
        required: true,
    },

    // Machine-readable cause. `abstained` reasons are the interesting ones --
    // they are how you discover the engine has been blind for a week because
    // every fix is arriving with unusable accuracy.
    reason: {
        type: String,
        enum: [
            // punched_out
            'confirmed_exit',
            // inside
            'within_fence',
            // abstained -- not enough evidence to act
            'too_few_fixes',
            'window_too_short',
            'too_few_distinct_positions',
            'repeated_coordinate',
            'no_fixes',
            'no_trustworthy_fix',
            'within_buffer',
            'stale_fixes',
            // A marginal exit (inside 3x the threshold) that has not yet
            // accumulated the longer evidence window such a distance demands.
            // Omitting it made every one of these audit writes fail validation,
            // so the decisions vanished — and the whole point of this trail is
            // that an engine which logs only its closures cannot be shown to be
            // working, because silence is indistinguishable from broken.
            'marginal_window_too_short',
            // outside the fence, but not yet confirmed across enough rounds
            'confirming',
            // suppressed -- a rule says do not act, regardless of evidence
            'grace_period',
            'role_exempt',
            // The DAY was declared Work From Home. Distinct from role_exempt,
            // which is a standing property of the employee: this one is a
            // choice made at punch-in and true only for that day.
            'work_from_home',
            'fence_disabled',
            // The employee's department has not opted into auto punch-out.
            'department_disabled',
            'no_branch',
            'on_lunch',
            'not_punched_in',
            'already_closed',
            'shadow_mode',
        ],
        required: true,
    },

    // Human-readable account, stored rather than generated on read so the
    // sentence an admin sees is the sentence the engine wrote at the time.
    narrative: { type: String, default: null },

    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    // The radius in force, and radius + exit buffer: the line that actually
    // had to be crossed. Showing only the radius makes every decision taken
    // between the two look wrong.
    radiusM: { type: Number, default: null },
    thresholdM: { type: Number, default: null },

    // The MEDOID of the window -- an actual observed fix, not an average.
    // A mean of a cluster plus one wild outlier lands between them, at a place
    // the phone never was; the medoid is always somewhere it really reported.
    medoidLat: { type: Number, default: null },
    medoidLng: { type: Number, default: null },
    distanceM: { type: Number, default: null },

    // The evidence, so the thresholds can be re-checked against it later.
    fixesInWindow: { type: Number, default: 0 },
    trustworthyFixes: { type: Number, default: 0 },
    distinctPositions: { type: Number, default: 0 },
    windowSpanMs: { type: Number, default: 0 },
    worstAccuracyM: { type: Number, default: null },
    // How old the newest fix was when the decision ran. A decision taken on a
    // fix captured twenty minutes ago is the classic wrong auto punch-out.
    newestFixAgeMs: { type: Number, default: null },

    // True when the engine decided but was NOT allowed to act, because the
    // tenant is still in shadow mode. These rows are the entire point of the
    // shadow run: they say what would have happened.
    shadow: { type: Boolean, default: false },

    // Set only on a real closure, so the punch-out and its justification can
    // be joined without guessing.
    attendanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Attendance', default: null },
    sessionNumber: { type: Number, default: null },
    closedAt: { type: Date, default: null },
}, { timestamps: true });

// The employee's own audit trail for a day, newest first.
GeofenceAuditSchema.index({ adminId: 1, employeeId: 1, dayKey: 1, createdAt: -1 });
// Tenant-wide triage, and the shadow-run report.
GeofenceAuditSchema.index({ adminId: 1, decision: 1, createdAt: -1 });

// 1 year: long enough to settle a dispute over any payslip period, bounded so
// abstention rows -- which are the overwhelming majority -- cannot grow without
// limit.
GeofenceAuditSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = mongoose.model('GeofenceAudit', GeofenceAuditSchema);
