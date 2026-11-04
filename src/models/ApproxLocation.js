const mongoose = require('mongoose');

// A city-level guess at where an employee's phone is, from its network address,
// recorded while GPS is unavailable (utils/ip_location.js explains how coarse).
//
// Deliberately NOT a Tracking row. The geofence engine, route smoothing and
// distance totals read Tracking, and a 25 km guess must never reach any of
// them: it would punch someone out, or add hundreds of kilometres to a route.
const ApproxLocationSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    timestamp: { type: Date, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    accuracyM: { type: Number, required: true },
    city: { type: String, default: null },
    region: { type: String, default: null },
    country: { type: String, default: null },
    source: { type: String, enum: ['ip'], default: 'ip' },
    ip: { type: String, default: null },
    // What prompted the reading: the phone reporting GPS off, or the regular
    // attendance poll while no fresh GPS fix had arrived.
    trigger: { type: String, enum: ['gps_off', 'poll'], required: true },
    // Consistent with the last GPS fix (true), impossibly far from it (false:
    // almost always the mobile carrier's hub), or nothing to compare (null).
    plausible: { type: Boolean, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });

ApproxLocationSchema.index({ adminId: 1, employeeId: 1, timestamp: -1 });
// Same lifetime as client errors: long enough to settle a delivery dispute.
ApproxLocationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('ApproxLocation', ApproxLocationSchema);
