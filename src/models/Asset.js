const mongoose = require('mongoose');

const AssetSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    employeeName: { type: String, required: true },
    deviceName: { type: String, required: true },
    deviceType: { type: String, required: true },
    brand: { type: String, required: true },
    model: { type: String, required: true },
    serialNumber: { type: String, required: true },
    amount: { type: Number, required: true },
    allocatedAt: { type: String, required: true }, // Format: YYYY-MM-DD
    status: { 
        type: String, 
        enum: ['active', 'returned', 'damaged'], 
        default: 'active' 
    },
    unlockCredentials: { type: String },
    unlockType: { 
        type: String, 
        enum: ['password', 'pin', 'pattern'], 
        default: 'password' 
    },
    // Grid of a pattern unlock. Was sent by the page but not in the schema,
    // so strict mode dropped it and a 4x4 pattern re-opened as 3x3.
    patternSize: { type: Number, enum: [3, 4], default: 3 },
    // YYYY-MM-DD (IST) the device came back; set by asset_controller when
    // the status changes to returned, cleared when it goes out again.
    returnedAt: { type: String, default: null }
}, { timestamps: true });

AssetSchema.index({ adminId: 1, employeeId: 1 });

module.exports = mongoose.model('Asset', AssetSchema);
