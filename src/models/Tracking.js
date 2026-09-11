const mongoose = require('mongoose');

const TrackingSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    // GPS uncertainty in metres. The client has always sent this; without the
    // field declared, Mongoose strict mode dropped it on every update, so no
    // stored fix could ever be judged trustworthy.
    //
    // null means "not reported" and must stay distinguishable from a small
    // number: unknown accuracy is untrustworthy, whereas 0 would read as a
    // perfect fix. Anything deciding whether someone left a geofence has to
    // exclude unknowns rather than trust them.
    accuracy: { type: Number, default: null },
    timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

TrackingSchema.index({ adminId: 1, employeeId: 1, timestamp: -1 });

module.exports = mongoose.model('Tracking', TrackingSchema);
