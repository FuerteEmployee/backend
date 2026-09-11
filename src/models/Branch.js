const mongoose = require('mongoose');

const BranchSchema = new mongoose.Schema({
    adminId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true,
        index: true 
    },
    branchName: { type: String, required: true },
    branchLocation: { type: String, required: true },
    city: { type: String },
    latitude: { type: Number },
    longitude: { type: Number },
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
