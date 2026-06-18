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
    description: { type: String },
    // Whether approved leave of this type is paid. Routes a leave day to the
    // PaidLeave vs UnpaidLeave bucket in the payroll engine.
    isPaid: { type: Boolean, default: true },
    // Optional per-type pay weight (0..1) that overrides the tenant's
    // bucketWeights.paidLeave for this leave type. Null = use bucket weight.
    payWeight: { type: Number, min: 0, max: 1, default: null }
}, { timestamps: true });

LeaveTypeSchema.index({ adminId: 1, leaveName: 1 });
LeaveTypeSchema.index({ adminId: 1, code: 1 });

module.exports = mongoose.model('LeaveType', LeaveTypeSchema);
