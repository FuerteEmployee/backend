const mongoose = require('mongoose');

const DepartmentSchema = new mongoose.Schema({
    adminId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true,
        index: true 
    },
    name: { type: String, required: true },
    colorCode: { type: String, default: '#000000' },

    // ── Location policy, decided per department ──────────────────────────────
    //
    // Whether a department is tracked is a business decision, not a per-person
    // one: field sales are tracked because the job is outdoors, back office are
    // not because it would be surveillance for no operational gain. Setting it
    // here means an admin makes that call once instead of remembering it for
    // every new joiner.

    /**
     * Do employees in this department send background location while on duty?
     *
     * Composes with User.trackingEnabled as an OR, deliberately. Employees were
     * enabled individually before this field existed, and making the department
     * an AND would have silently switched them all off the moment it shipped.
     */
    trackingEnabled: { type: Boolean, default: false },

    /**
     * May the geofence engine actually CLOSE a day for this department?
     *
     * Separate from tracking on purpose. Tracking answers "where are they";
     * this answers "may we end their shift on the strength of that" — a far
     * bigger decision, and the whole point of a pilot is to do the first
     * without the second. Defaults to false: auto punch-out is opted INTO,
     * never inherited, because the cost of it firing wrongly is somebody's pay.
     *
     * A per-employee User.geofenceExempt still excludes individuals from an
     * otherwise enabled department.
     */
    autoPunchOutEnabled: { type: Boolean, default: false }
}, { timestamps: true });

DepartmentSchema.index({ adminId: 1, name: 1 });

module.exports = mongoose.model('Department', DepartmentSchema);
