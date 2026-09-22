const mongoose = require('mongoose');
const { istDateKey } = require('../utils/attendance_helpers');

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
    // Canonical IST day, "YYYY-MM-DD". Set automatically on save; see the
    // pre-save hook and the unique index note at the bottom of this file.
    dayKey: { type: String, default: null },

    status: {
        type: String,
        // 'needs_review' is not a grade -- it is the absence of one. A closed
        // day that computes to zero worked time while carrying a real punch-in
        // cannot honestly be called present, half-day OR absent, and calling it
        // absent silently costs the employee a day. It means: this needs a
        // human, and it must not be paid from until one has looked.
        enum: ['present', 'absent', 'half-day', 'late', 'wfh', 'needs_review'],
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
        // `regularized` is deliberately distinct from `admin`: both end with an
        // admin writing the time, but one of them started with the employee
        // saying what actually happened and is backed by an approved
        // Regularization carrying the original value. "Corrected on request"
        // and "overwritten by the office" are not the same audit answer.
        closeReason: {
            type: String,
            enum: [null, 'manual', 'auto_geofence', 'shift_end', 'admin', 'device', 'regularized'],
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
        // Raw out-minus-in for THIS session, with NO shift clamp. Never used
        // for pay -- `workMs` above is the credited figure. It exists so the
        // two can be shown side by side, because a session lying entirely
        // outside the shift window clamps to zero and the time it represents
        // otherwise leaves no trace in the record at all. The gap between the
        // two is precisely what a `needs_review` day is asking a human about.
        grossMs: { type: Number, default: null },
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

/**
 * The canonical IST calendar day this row belongs to, "YYYY-MM-DD".
 *
 * `date` is an IST-midnight INSTANT, which is the right thing to store but the
 * wrong thing to match on: two thirds of existing rows were written before the
 * IST helpers existed and sit at local or UTC midnight instead. An equality
 * lookup misses those, so the caller concludes no row exists and writes a
 * second one next to the first -- which is how one employee-day ends up with
 * two records that disagree.
 *
 * A string key cannot drift. It is derived here rather than at the call sites
 * so that every writer gets it without having to remember, and so the unique
 * index below has something stable to be unique ON.
 */
AttendanceSchema.pre('save', function setDayKey(next) {
    if (this.date) this.dayKey = istDateKey(this.date);
    next();
});

/**
 * `status: 'late'` and `wasLate: false` must never coexist.
 *
 * `wasLate` was set in ONE place -- the app's punch-out path -- but `status` is
 * written by several: the geofence engine's close, the end-of-day job, an admin
 * correction, regularization approval. Observed 2026-09-17: a day closed by the
 * geofence engine carried `status: 'late'` with `wasLate: false`, so the record
 * contradicted itself and payroll's punctuality read disagreed with the badge
 * the admin saw.
 *
 * Enforced here because this is the only point every writer passes through.
 * It only ever SETS the flag: `wasLate` exists precisely to survive status
 * being normalised to 'present' on punch-out, so clearing it here would
 * destroy the signal it was added to preserve.
 */
AttendanceSchema.pre('save', function syncPunctuality(next) {
    if (this.status === 'late') this.wasLate = true;
    next();
});

/**
 * Collapse repeated remarks fragments.
 *
 * `remarks` is built by appending ' | <note>' from several places, and the
 * half-day note is re-appended on EVERY session close. Observed 2026-09-17: one
 * employee's remarks held six fragments of which three were unique, the same
 * "Late punch-in... Early punch-out" sentence four times over. Some appenders
 * guard with `.includes()` and some do not, so the guard has to live where all
 * of them meet.
 *
 * Order is preserved (first occurrence wins) because the fragments read as a
 * narrative of the day, and a single-fragment value such as 'Work From Home'
 * is returned untouched -- code elsewhere compares against it exactly.
 */
AttendanceSchema.pre('save', function dedupeRemarks(next) {
    if (typeof this.remarks !== 'string' || !this.remarks.includes('|')) return next();
    const seen = new Set();
    const kept = [];
    for (const raw of this.remarks.split('|')) {
        const frag = raw.trim();
        if (!frag || seen.has(frag)) continue;
        seen.add(frag);
        kept.push(frag);
    }
    this.remarks = kept.join(' | ');
    next();
});

AttendanceSchema.index({ adminId: 1, date: 1 });
AttendanceSchema.index({ adminId: 1, employeeId: 1, dayKey: 1 });
AttendanceSchema.index({ adminId: 1, employeeId: 1, date: 1 });
AttendanceSchema.index({ adminId: 1, status: 1 });

module.exports = mongoose.model('Attendance', AttendanceSchema);

// NOTE: the uniqueness guarantee is NOT declared here.
//
// A `unique: true` on { adminId, employeeId, dayKey } is the correct end state
// and the only thing that makes a duplicate employee-day structurally
// impossible. It is deliberately not switched on in the schema, because
// Mongoose would try to build it on boot, the build would fail against the
// duplicate rows that already exist, and the failure would be a log line
// nobody reads -- leaving everyone believing the guarantee is in place when it
// is not.
//
// Order matters: backfill dayKey, merge the existing duplicates by hand (only
// a person can say which punch was real), THEN build the index once:
//
//   node scratch/migrate_attendance_daykey.js            # report
//   node scratch/migrate_attendance_daykey.js --backfill # write dayKey
//   node scratch/migrate_attendance_daykey.js --index    # build unique index
