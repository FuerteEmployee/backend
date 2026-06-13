const mongoose = require('mongoose');

const LeaveTypeSchema = new mongoose.Schema({
    adminId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true,
        index: true 
    },
    leaveName: { type: String, required: true },
    code: { type: String, required: true },
    totalDays: { type: Number, required: true, min: 0 },
    iconStyle: { type: String, required: true },
    colorCode: { type: String, default: '#3b82f6' },
    description: { type: String }
}, { timestamps: true });

LeaveTypeSchema.index({ adminId: 1, leaveName: 1 });
LeaveTypeSchema.index({ adminId: 1, code: 1 });

module.exports = mongoose.model('LeaveType', LeaveTypeSchema);
