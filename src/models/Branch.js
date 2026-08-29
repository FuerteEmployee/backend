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
    radius: { type: Number, default: null }
}, { timestamps: true });

BranchSchema.index({ adminId: 1, branchName: 1 });

module.exports = mongoose.model('Branch', BranchSchema);
