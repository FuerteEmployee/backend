const mongoose = require('mongoose');

// Every raw tap a device reported, before any interpretation.
//
// This exists because the meaning of a tap cannot be known when it arrives:
// "the last tap of the day is the punch-out" is unanswerable until the day is
// over. Storing the taps lets the day's Attendance be *re-derived* from the
// full set each time a new one lands, which also makes the whole pipeline
// self-correcting — a terminal that was offline and flushes a backlog hours
// later simply causes a re-derivation with the real tap times, instead of
// stamping four punches at the moment the network came back.
//
// It is also the audit trail for "I tapped and it didn't count": rejected taps
// are stored with `discarded` set and a reason, rather than silently dropped.
const PunchLogSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // IST calendar day the tap belongs to ('YYYY-MM-DD'), derived from
    // deviceTime via istDateKey. Stored rather than computed at query time so
    // "all of this employee's taps for this day" is one indexed lookup — that
    // query runs on every single tap, so it has to be cheap.
    dayKey: { type: String, required: true },

    // The terminal's own reported wall-clock time, parsed to a real instant.
    // This — not the server's receive time — is what the derivation uses.
    deviceTime: { type: Date, required: true },
    // When we actually processed it. Differs from deviceTime by hours when a
    // device flushes a backlog, which is precisely the case worth being able
    // to see after the fact.
    receivedAt: { type: Date, default: Date.now },

    serialNumber: { type: String, default: null },
    pin: { type: String, default: null },
    source: { type: String, enum: ['biometric', 'lens', 'app'], default: 'biometric' },

    // Set when the tap was rejected rather than counted. 'debounced' is the
    // common one: a second tap within the configured window, i.e. somebody
    // pressed twice by mistake.
    discarded: { type: Boolean, default: false },
    discardReason: {
        type: String,
        enum: [null, 'debounced', 'sequence_complete', 'handler_rejected'],
        default: null,
    },

    // What the most recent derivation decided this tap meant. Null for taps
    // that are only shown in the expandable list. Recomputed on every
    // re-derivation, so never trust it as history — it is a cache of the
    // current interpretation.
    derivedAction: {
        type: String,
        enum: [null, 'punch-in', 'lunch-in', 'lunch-out', 'punch-out'],
        default: null,
    },
}, { timestamps: true });

// Durable dedupe. The same physical tap is identified by (serial, pin, device
// timestamp), and a terminal re-pushes its buffer on any un-acked batch. Making
// the database reject the repeat is what lets dedupe survive a server restart —
// the previous in-memory-only guard silently re-counted taps after a deploy.
PunchLogSchema.index({ serialNumber: 1, pin: 1, deviceTime: 1 }, { unique: true, sparse: true });

// The derivation query: one employee's taps for one day, in tap order.
PunchLogSchema.index({ adminId: 1, employeeId: 1, dayKey: 1, deviceTime: 1 });

// 1-year retention. Long enough to settle a payroll dispute for the period a
// payslip covers, bounded so raw taps don't accumulate forever.
PunchLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = mongoose.model('PunchLog', PunchLogSchema);
