const mongoose = require('mongoose');

const ExpenseSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Can be null for general office
    employeeName: { type: String, required: true },
    category: { type: String, required: true },
    amount: { type: Number, required: true },
    date: { type: Date, required: true },
    description: { type: String },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'reimbursed'],
        default: 'pending'
    },
    attachmentUrl: { type: String }, // Cloudinary URL of uploaded doc/pdf receipt
    splitGroupId: { type: mongoose.Schema.Types.ObjectId, index: true }, // links sibling records created by one split submission
    splitTotalAmount: { type: Number }, // original total before dividing (only set when splitGroupId is set)
    splitParticipantCount: { type: Number }, // N participants in the split
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    reimbursedInMonth: { type: Date } // set when this expense's amount was pulled into a Salary payout
}, { timestamps: true });

ExpenseSchema.index({ adminId: 1, date: -1 });

module.exports = mongoose.model('Expense', ExpenseSchema);
