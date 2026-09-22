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

    // ── Payment, recorded as fact rather than inferred from `status` ─────────
    //
    // `status` is RECOMPUTED from scratch on every payroll run
    // (calculateAndSaveSalary derives it from "is this the current month?"), so
    // for as long as it was the only record of a payment, a regenerate silently
    // rewrote 'paid' to 'pending' and there was afterwards no way to tell that
    // anyone had ever been paid -- not flagged, not archived, not derivable.
    //
    // These two fields are what make that recoverable: they are written once,
    // when a human marks the row paid, and the generator is required to carry
    // them across untouched. A row with a `paidAt` has been paid, whatever
    // `status` currently says.
    paidAt: { type: Date, default: null },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
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

    // Approved advance-salary/loan requests recovered via this month's payroll.
    // Re-applied on every recompute so a later bulk regenerate can't silently
    // drop an already-included recovery.
    deductedAdvanceRequestIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AdvanceSalaryRequest' }],

    // Approved expense claims reimbursed via this month's payroll. Re-applied on
    // every recompute for the same reason as deductedAdvanceRequestIds above.
    reimbursedExpenseIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Expense' }],
}, { timestamps: true });

SalarySchema.index({ adminId: 1, employeeId: 1, year: 1, month: 1 });

module.exports = mongoose.model('Salary', SalarySchema);
