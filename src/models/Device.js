const mongoose = require('mongoose');

// A physical biometric attendance terminal (eSSL/ZKTeco ADMS device).
//
// This collection replaces the old hand-edited ESSL_DEVICES env var. It is the
// single registry deciding which company a pushed punch belongs to, so the
// serial number is UNIQUE ACROSS THE WHOLE PLATFORM — one physical machine can
// only ever be claimed by one tenant. That constraint is what guarantees a
// punch on machine A can never resolve into another company's data.
//
// A device whose serial we've never seen is auto-registered here with
// adminId: null and status 'unassigned', so it shows up in the super admin's
// Machines screen ready to be claimed — no need to read the serial off the
// device menu by hand.
const DeviceSchema = new mongoose.Schema({
    serialNumber: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        uppercase: true,
    },

    // The tenant this machine belongs to. null while unclaimed.
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
        index: true,
    },

    // Free-text location/name so support can tell two machines apart,
    // e.g. "Reception — ground floor".
    label: { type: String, default: '', trim: true },
    model: { type: String, default: '', trim: true },

    status: {
        type: String,
        enum: ['unassigned', 'active', 'disabled'],
        default: 'unassigned',
        index: true,
    },

    // Set true when we learned about this device from its own first push
    // rather than somebody typing the serial in.
    autoDiscovered: { type: Boolean, default: false },

    // Audit trail for who attached this machine to its company. Company admins
    // can self-register a serial, so this records whether it was them or the
    // platform — the mapping decides whose attendance a punch becomes, and a
    // mistaken or malicious claim needs to be traceable after the fact.
    claimedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    claimedAt: { type: Date, default: null },
    claimedVia: { type: String, enum: ['admin', 'superadmin', 'migration'], default: null },

    // ── Health / support telemetry ──
    lastSeenAt: { type: Date, default: null },   // any contact, incl. handshake & heartbeat
    lastPunchAt: { type: Date, default: null },  // last successfully recorded punch
    punchCount: { type: Number, default: 0 },
    firmware: { type: String, default: '' },

    // Bookkeeping for the offline alert (jobs/device_health.js).
    //
    // `offlineAlertedAt` is what stops a machine that stays unplugged over a
    // long weekend from sending the same warning on every job run — the alert
    // repeats only after ALERT_REPEAT_HOURS. It is cleared the moment the
    // device makes contact again, so the next outage alerts immediately rather
    // than being suppressed by a stale timestamp.
    offlineAlertedAt: { type: Date, default: null },
    offlineAlertCount: { type: Number, default: 0 },

    // Rolling diagnostic buffer of punches this device sent that we could NOT
    // attribute to anybody — an unmatched PIN, or pushes that arrived before
    // the machine was claimed. Without this the failure is invisible: the
    // device beeps and accepts the employee while nothing is recorded.
    // Capped to the 20 most recent via $slice on write.
    recentUnresolved: [{
        pin: { type: String },
        // 'unassigned_device' | 'disabled_device' | 'unknown_pin'
        // | 'duplicate_pin' | 'sequence_complete'
        reason: { type: String },
        deviceTime: { type: String },  // raw timestamp string as the device sent it
        at: { type: Date, default: Date.now },
    }],

    // ── Clock health (see utils/device_clock.js) ────────────────────────────
    // Rolling skew samples and their 24h minimum. The minimum is the signal:
    // an offline backlog contributes a near-zero sample once the device is
    // live again, a wrong timezone never does.
    clockSkewSamples: [{
        minutes: { type: Number },
        at: { type: Date },
        _id: false,
    }],
    clockSkewMinutes: { type: Number, default: null },
    clockSkewAlertedAt: { type: Date, default: null },
    // Deliberate correction, in minutes, ADDED to every timestamp this terminal
    // reports. Left at 0 by default and never set automatically: silently
    // correcting a clock means that the day somebody finally fixes the device,
    // every punch starts being corrected twice with nothing to show why.
    clockOffsetMinutes: { type: Number, default: 0 },

    notes: { type: String, default: '' },
}, { timestamps: true });

// Support lookups: "all machines for this customer", newest first.
DeviceSchema.index({ adminId: 1, createdAt: -1 });

module.exports = mongoose.model('Device', DeviceSchema);
