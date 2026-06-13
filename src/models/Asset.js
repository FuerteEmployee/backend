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
    }
}, { timestamps: true });

AssetSchema.index({ adminId: 1, employeeId: 1 });

module.exports = mongoose.model('Asset', AssetSchema);
