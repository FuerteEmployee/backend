const mongoose = require('mongoose');

const AttendanceSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: Date, required: true },
    punchIn: { type: Date, default: null },
    punchInLocation: { type: String, default: null },
    punchInCoordinates: { lat: { type: Number }, lng: { type: Number } },
    punchInPhoto: { type: String, default: null },
    punchOut: { type: Date, default: null },
    punchOutLocation: { type: String, default: null },
    punchOutCoordinates: { lat: { type: Number }, lng: { type: Number } },
    punchOutPhoto: { type: String, default: null },
    lunchInTime: { type: Date, default: null },
    lunchInLocation: { type: String, default: null },
    lunchInCoordinates: { lat: { type: Number }, lng: { type: Number } },
    lunchOutTime: { type: Date, default: null },
    lunchOutLocation: { type: String, default: null },
    lunchOutCoordinates: { lat: { type: Number }, lng: { type: Number } },
    // Distance (meters) from the nearest assigned branch at the moment of each
    // punch — previously computed live for the geofence check and discarded.
    // Persisted so the UI can flag borderline "Geo Violation" punches.
    punchInDistance: { type: Number, default: null },
    punchOutDistance: { type: Number, default: null },
    lunchInDistance: { type: Number, default: null },
    lunchOutDistance: { type: Number, default: null },
    status: {
        type: String,
        enum: ['present', 'absent', 'half-day', 'late', 'wfh'],
        default: 'absent',
    },
    // Which channel recorded this day's attendance — the CRM shows a
    // different icon per source (Phone app / Lens camera / Biometric device).
    source: {
        type: String,
        enum: ['app', 'lens', 'biometric'],
        default: 'app',
    },
    // Work-from-home flag — first-class signal (was previously only a remarks
    // substring). Set on punch-in; lets payroll pay WFH at its own weight.
    isWFH: { type: Boolean, default: false },
    // Persistent punctuality signal that survives punch-out normalisation
    // (status 'late' used to be overwritten to 'present' on punch-out, making
    // punctuality unrecoverable). True when the punch-in was within grace.
    wasLate: { type: Boolean, default: false },
    shifts: [{
        punchIn: { type: Date },
        punchOut: { type: Date },
        // Why this session closed. Stamped on EVERY close path -- manual,
        // device tap, the end-of-day job, an admin correction, or the geofence
        // engine. Without it a job-closed day is indistinguishable from a real
        // punch-out, which is how the reference ended up with 97% of records
        // carrying no reason and no way to audit them after the fact.
        closeReason: {
            type: String,
            enum: [null, 'manual', 'auto_geofence', 'shift_end', 'admin', 'device'],
            default: null,
        },
        // Where and how each END of the session happened, mirroring the root
        // punch fields. Session 2+ used to carry nothing but two timestamps, so
        // a day where someone punched in on their phone at the warehouse and
        // out on the terminal at head office was indistinguishable from one
        // where they never moved -- and an auto punch-out could not be shown
        // the distance that triggered it.
        //
        // `source` is per END, not per session, because that is the real
        // granularity: the whole point of this system is that the three
        // channels interleave freely within one session.
        punchInSource: { type: String, enum: ['app', 'lens', 'biometric', 'system', 'admin'], default: null },
        punchOutSource: { type: String, enum: ['app', 'lens', 'biometric', 'system', 'admin'], default: null },
        punchInLocation: { type: String, default: null },
        punchOutLocation: { type: String, default: null },
        punchInCoordinates: { lat: { type: Number }, lng: { type: Number } },
        punchOutCoordinates: { lat: { type: Number }, lng: { type: Number } },
        punchInAccuracy: { type: Number, default: null },
        punchOutAccuracy: { type: Number, default: null },
        punchInDistance: { type: Number, default: null },
        punchOutDistance: { type: Number, default: null },
        // Net worked ms for THIS session, clamped to the shift window by
        // computeWorkedMs(). Stored per session so the UI can show a per-row
        // duration without re-deriving the shift clamp in the browser -- the
        // reference showed raw out-minus-in there, which disagreed with the
        // day total whenever a session ran outside the shift.
        workMs: { type: Number, default: null },
    }],
    // True when the current `punchOut` was set by a device (Lens/biometric)
    // tap, not an explicit app punch-out. Devices only ever send a generic
    // in/out toggle, so a device-set punchOut may just be the employee
    // leaving for lunch, not the real end of day — cleared (false) whenever
    // the app itself sets punchOut, since that's always an unambiguous,
    // final signal.
    punchOutIsProvisional: { type: Boolean, default: false },
    totalWorkMs: { type: Number, default: 0 },
    // Quality of the GPS fix each punch was taken on. Kept per punch rather
    // than per day because a day can contain several sessions taken in very
    // different conditions -- indoors on wifi, then outside on GPS.
    //
    // `accuracy` is metres and null when unreported; `fixAt` is when the device
    // captured the position, which can lag the punch by seconds or, on a queued
    // offline fix, much longer. Both are needed to tell a real boundary case
    // from a phone guessing off a cell tower.
    punchInAccuracy: { type: Number, default: null },
    punchOutAccuracy: { type: Number, default: null },
    punchInFixAt: { type: Date, default: null },
    punchOutFixAt: { type: Date, default: null },

    // Which punch fields the last day-reconciliation wrote (see
    // utils/punch_reconcile.js). A field holding a value that is NOT listed
    // here was set explicitly by the app — the employee pressed "punch out" —
    // and reconciliation must not overwrite it with positional inference from
    // raw device taps. Without this there is no way to tell a derived value
    // from a deliberate one, and someone who punches in on their phone and out
    // on the terminal would lose their real start time.
    derivedFields: { type: [String], default: [] },

    // ── Geofence outcome for the day ────────────────────────────────────────
    // True when a session was closed by the geofence engine rather than by the
    // employee. Kept at day level as well as on the session's closeReason so a
    // list view can flag the day without loading every session.
    autoPunchOut: { type: Boolean, default: false },
    // Plain-language account of WHY, written by the engine at decision time.
    // A punch-out the employee did not make has to be explainable, not merely
    // asserted -- this is the sentence the admin and the employee both read.
    autoPunchOutReason: { type: String, default: null },
    // Metres from the branch on the fix that DECIDED the auto punch-out. Not
    // recomputed on read: the branch may since have been moved or deleted, and
    // an audit has to show the number the decision actually used.
    calculatedDistance: { type: Number, default: null },
    geoStatus: {
        type: String,
        enum: [null, 'inside_geofence', 'outside_geofence', 'auto_exit', 'unknown'],
        default: null,
    },

    remarks: { type: String, default: null }
}, { timestamps: true });

AttendanceSchema.index({ adminId: 1, date: 1 });
AttendanceSchema.index({ adminId: 1, employeeId: 1, date: 1 });
AttendanceSchema.index({ adminId: 1, status: 1 });

module.exports = mongoose.model('Attendance', AttendanceSchema);
