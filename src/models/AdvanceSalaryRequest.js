const mongoose = require('mongoose');

const AdvanceSalaryRequestSchema = new mongoose.Schema({
    employeeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    branchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        required: true,
        index: true
    },
    type: {
        type: String,
        enum: ['advance-salary', 'loan'],
        required: true
    },
    amount: {
        type: Number,
        required: true,
        min: 1
    },
    reason: {
        type: String,
        required: true,
        maxlength: 500
    },
    notes: {
        type: String,
        maxlength: 500
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'repaid'],
        default: 'pending',
        index: true
    },
    reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    reviewedAt: {
        type: Date
    },
    repaidAt: {
        type: Date
    },
    // Reserved for payroll processor — do NOT set from advance-salary routes
    deductedInMonth: {
        type: Date
    }
}, { timestamps: true });

// Compound index for efficient multi-filter queries
AdvanceSalaryRequestSchema.index({ companyId: 1, branchId: 1, status: 1 });
AdvanceSalaryRequestSchema.index({ companyId: 1, employeeId: 1 });
AdvanceSalaryRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AdvanceSalaryRequest', AdvanceSalaryRequestSchema);
