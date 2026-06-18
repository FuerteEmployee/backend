const mongoose = require('mongoose');

const SalarySchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    baseSalary: { type: Number, required: true },
    bonus: { type: Number, default: 0 },
    deductions: { type: Number, default: 0 },
    month: { type: Number, required: true }, 
    year: { type: Number, required: true },
    totalSalary: { type: Number, required: true },
    status: {
        type: String,
        // 'final' = generated for a completed month; 'review' = invariant failed.
        enum: ['paid', 'pending', 'final', 'review'],
        default: 'pending'
    },
    breakdown: {
        earnings: [{ name: String, amount: Number }],
        deductions: [{ name: String, amount: Number }]
    },
    employmentType: { type: String, enum: ['monthly', 'daily', 'hourly'], default: 'monthly' },
    remarks: { type: String },

    // ── Deterministic payroll-engine audit fields (populated when payroll.enabled) ──
    // Day-bucket tallies for the pay window, so every rupee is traceable.
    buckets: {
        present: { type: Number, default: 0 },
        wfh: { type: Number, default: 0 },
        halfDay: { type: Number, default: 0 },
        paidLeave: { type: Number, default: 0 },
        weeklyOff: { type: Number, default: 0 },
        holiday: { type: Number, default: 0 },
        absent: { type: Number, default: 0 },
        unpaidLeave: { type: Number, default: 0 },
    },
    payableDays: { type: Number },
    totalDaysInWindow: { type: Number },
    grossSalary: { type: Number },
    netSalary: { type: Number },
    dailyRateBasis: { type: String },   // snapshot of the basis used
    needsReview: { type: Boolean, default: false }, // invariant failed — do not pay blindly
}, { timestamps: true });

SalarySchema.index({ adminId: 1, employeeId: 1, year: 1, month: 1 });

module.exports = mongoose.model('Salary', SalarySchema);
