const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────────────
// Persisted multi-round confirmation state for one employee's currently-open
// session.
//
// A single evaluation saying "outside" is not enough to act on, even after the
// repeated-coordinate and newest-MIN_FIXES fixes: a burst of otherwise-valid,
// mutually-distinct fixes can still describe one bad moment rather than a real
// departure (a delivery van idling just past the fence, a fix that wandered
// during a building's dead zone). The reference requires the SAME exit to be
// re-confirmed GEOFENCE_CONFIRMATIONS times, each round backed by at least one
// fix newer than the previous round's, spanning >=120s in total -- explicitly
// because re-evaluating the identical five fixes a second later would only
// ever confirm itself, proving nothing new.
//
// This cannot live in module memory the way the reference's does: this app
// runs on Vercel serverless with no persistent process between invocations,
// and even a long-running host may run several instances behind a load
// balancer. State that has to survive from one evaluation to the next belongs
// in the database, not in a variable.
const GeofencePendingExitSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // When the FIRST round of this exit sequence was observed.
    since: { type: Date, required: true },
    rounds: { type: Number, default: 1 },

    // The newest evidence fix the LAST round decided on. The next round must
    // be backed by a fix strictly newer than this, or it is the same evidence
    // re-arriving (a retried request, or two evaluations firing moments apart
    // before any new fix has landed) rather than independent confirmation.
    lastFixTimestamp: { type: Date, required: true },
    lastEvaluatedAt: { type: Date, default: Date.now },

    // The MOST RECENT demonstrably-inside moment seen across every round so
    // far. Each round can only push this forward, never back: a later round
    // has visibility into fixes an earlier round did not, and if one of those
    // reveals a more recent inside reading, that is a truer boundary than
    // what round 1 saw. This is what makes the close time fair either way --
    // an employee is never docked time they were still inside for, and never
    // credited time after the last moment they demonstrably were.
    lastInsideAt: { type: Date, default: null },
}, { timestamps: true });

GeofencePendingExitSchema.index({ adminId: 1, employeeId: 1 }, { unique: true });

// A sequence that goes quiet -- the employee's phone stopped reporting mid-
// confirmation, or a bug leaves it uncleared -- must not haunt the collection
// forever; a day is far longer than any real confirmation sequence takes.
GeofencePendingExitSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('GeofencePendingExit', GeofencePendingExitSchema);
