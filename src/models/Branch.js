const mongoose = require('mongoose');

const BranchSchema = new mongoose.Schema({
    adminId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true,
        index: true 
    },
    // trim: 12 of 39 stored branch names carried a stray leading/trailing
    // space ("rajkot "), which made "Rajkot" and "rajkot " look like two
    // different branches and let a whitespace-only name through `required`.
    branchName: { type: String, required: true, trim: true },
    branchLocation: { type: String, required: true, trim: true },
    city: { type: String, trim: true },
    // Range-checked here as a backstop to the controller's own validation: a
    // latitude of 200 is not a place, and a fence anchored on it refuses
    // every punch with a distance nobody can make sense of.
    latitude: { type: Number, min: [-90, 'Latitude must be between -90 and 90.'], max: [90, 'Latitude must be between -90 and 90.'] },
    longitude: { type: Number, min: [-180, 'Longitude must be between -180 and 180.'], max: [180, 'Longitude must be between -180 and 180.'] },
    // Allowed punch-in radius (meters) for THIS branch. When unset, geofencing
    // falls back to the tenant-wide settings.attendance.officeRadius default.
    radius: { type: Number, default: null },
    // Per-branch switch for the fence. Previously geofencing was all-or-nothing
    // per tenant via Settings.attendance.requireLocation, which cannot express
    // a company with one fenced office and one warehouse staff roam around.
    //
    // Defaults true so existing branches keep behaving exactly as before; the
    // tenant-level requireLocation still has to be on for anything to be
    // enforced, so this only ever narrows, never widens.
    geoFenceEnabled: { type: Boolean, default: true }
}, { timestamps: true });

BranchSchema.index({ adminId: 1, branchName: 1 });

module.exports = mongoose.model('Branch', BranchSchema);
