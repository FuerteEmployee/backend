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
        enum: ['paid', 'pending'], 
        default: 'pending' 
    },
    breakdown: {
        earnings: [{ name: String, amount: Number }],
        deductions: [{ name: String, amount: Number }]
    },
    employmentType: { type: String, enum: ['monthly', 'daily', 'hourly'], default: 'monthly' },
    remarks: { type: String }
}, { timestamps: true });

SalarySchema.index({ adminId: 1, employeeId: 1, year: 1, month: 1 });

module.exports = mongoose.model('Salary', SalarySchema);
