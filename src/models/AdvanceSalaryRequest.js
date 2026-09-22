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
    // Ceiling matches the controller's MAX_ADVANCE_SALARY_AMOUNT check — kept
    // here too as the last line of defense in case of a direct DB write or a
    // future code path that skips the controller's own validation.
    amount: {
        type: Number,
        required: true,
        min: 1,
        max: 10_000_000 // ₹1 crore
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
    // Amount the admin actually approved. May be less than the requested `amount`
    // (partial approval). Set when the request is approved.
    approvedAmount: {
        type: Number,
        min: 0,
        max: 10_000_000 // ₹1 crore
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
