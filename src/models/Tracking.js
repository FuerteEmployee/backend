const mongoose = require('mongoose');

const TrackingSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

TrackingSchema.index({ adminId: 1, employeeId: 1, timestamp: -1 });

module.exports = mongoose.model('Tracking', TrackingSchema);
