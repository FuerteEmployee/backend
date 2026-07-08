const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    role: {
        type: String,
        enum: ['superadmin', 'admin', 'employee', 'subadmin'],
        required: true
    },
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true,
        required: function() { return this.role === 'employee' || this.role === 'subadmin'; }
    },
    name: { type: String, required: true },
    phone: { type: String, required: true, unique: true },
    email: { type: String, sparse: true },
    
    // Admin specific account fields
    subscriptionPlan: { 
        type: String, 
        enum: ['free', 'basic', 'pro'], 
        default: 'free' 
    },
    subscriptionStartDate: { type: Date, default: Date.now },
    subscriptionEndDate: { type: Date },
    
    // Employee specific fields
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }, // primary branch (kept for backward compatibility)
    branchIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }], // all branches when multi-branch is enabled
    salary: { type: Number, default: 0 },
    shiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' }, // primary shift (used for attendance/lateness calculations)
    shiftIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Shift' }], // all shifts assigned, when multi-shift is enabled
    profileImage: { type: String },

    // Attendance Exceptions
    attendanceExceptions: {
        overrideGlobal: { type: Boolean, default: false },
        requireLocation: { type: Boolean, default: false },
        remotePunch: { type: Boolean, default: true }
    },

    // Additional Personal Details
    gender: { type: String, enum: ['male', 'female', 'other'] },
    dob: { type: Date },
    joiningDate: { type: Date },
    employmentType: { type: String, enum: ['monthly', 'daily', 'hourly'], default: 'monthly' },
    leadDeletionPermission: { type: Boolean, default: false },
    
    address: { type: String },
    bloodGroup: { type: String },
    contactPersonName: { type: String },
    contactPersonMobile: { type: String },
    aadhaarNo: { type: String },
    panNo: { type: String },
    experience: { type: String },
    residentialAddress: { type: String },
    residentialPhone: { type: String },
    education: { type: String },

    bankDetails: {
        accountNumber: { type: String },
        bankName: { type: String },
        ifsc: { type: String },
        branchName: { type: String },
        nameAsPerBank: { type: String }
    },

    panCardUrls: [{ type: String }],      // uploaded PAN card scan(s), front/back
    aadhaarCardUrls: [{ type: String }],  // uploaded Aadhaar card scan(s), front/back

    // Customized Holiday Fields
    weeklyHolidays: [{
        day: { type: String, enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] },
        weeks: { type: [Number], default: [] } // Empty means all weeks, [1, 3] means 1st and 3rd week
    }],

    // Salary Configuration
    salaryComponents: {
        tds: { enabled: { type: Boolean, default: false }, percentage: { type: Number, default: 0 }, amount: { type: Number, default: 0 }, type: { type: String, enum: ['percentage', 'amount'], default: 'percentage' }, includeInTotal: { type: Boolean, default: true } },
        tdsCategory: { type: String }, // e.g., 92B, 92J
        basic: { enabled: { type: Boolean, default: false }, percentage: { type: Number, default: 0 }, amount: { type: Number, default: 0 }, type: { type: String, enum: ['percentage', 'amount'], default: 'percentage' }, includeInTotal: { type: Boolean, default: true } },
        da: { enabled: { type: Boolean, default: false }, percentage: { type: Number, default: 0 }, amount: { type: Number, default: 0 }, type: { type: String, enum: ['percentage', 'amount'], default: 'percentage' }, includeInTotal: { type: Boolean, default: true } },
        hra: { enabled: { type: Boolean, default: false }, percentage: { type: Number, default: 0 }, amount: { type: Number, default: 0 }, type: { type: String, enum: ['percentage', 'amount'], default: 'percentage' }, includeInTotal: { type: Boolean, default: true } },
        ca: { enabled: { type: Boolean, default: false }, percentage: { type: Number, default: 0 }, amount: { type: Number, default: 0 }, type: { type: String, enum: ['percentage', 'amount'], default: 'percentage' }, includeInTotal: { type: Boolean, default: true } },
        pf: { enabled: { type: Boolean, default: false }, percentage: { type: Number, default: 0 }, amount: { type: Number, default: 0 }, type: { type: String, enum: ['percentage', 'amount'], default: 'percentage' }, includeInTotal: { type: Boolean, default: true } },
        esic: { enabled: { type: Boolean, default: false }, percentage: { type: Number, default: 0 }, amount: { type: Number, default: 0 }, type: { type: String, enum: ['percentage', 'amount'], default: 'percentage' }, includeInTotal: { type: Boolean, default: true } },
        epf: { enabled: { type: Boolean, default: false }, percentage: { type: Number, default: 0 }, amount: { type: Number, default: 0 }, type: { type: String, enum: ['percentage', 'amount'], default: 'percentage' }, includeInTotal: { type: Boolean, default: true } },
        tdsOnProfession: { enabled: { type: Boolean, default: false }, percentage: { type: Number, default: 0 }, amount: { type: Number, default: 0 }, type: { type: String, enum: ['percentage', 'amount'], default: 'percentage' }, includeInTotal: { type: Boolean, default: true } },
        retention: { enabled: { type: Boolean, default: false }, percentage: { type: Number, default: 0 }, amount: { type: Number, default: 0 }, type: { type: String, enum: ['percentage', 'amount'], default: 'percentage' }, includeInTotal: { type: Boolean, default: true } },
        pt: { enabled: { type: Boolean, default: false }, percentage: { type: Number, default: 0 }, amount: { type: Number, default: 0 }, type: { type: String, enum: ['percentage', 'amount'], default: 'percentage' }, includeInTotal: { type: Boolean, default: true } },
        adminCharge: { enabled: { type: Boolean, default: false }, percentage: { type: Number, default: 0 }, amount: { type: Number, default: 0 }, type: { type: String, enum: ['percentage', 'amount'], default: 'percentage' }, includeInTotal: { type: Boolean, default: true } },
        bonus: { enabled: { type: Boolean, default: false }, percentage: { type: Number, default: 0 }, amount: { type: Number, default: 0 }, type: { type: String, enum: ['percentage', 'amount'], default: 'percentage' }, includeInTotal: { type: Boolean, default: true } },
    },
    
    // Per-employee payroll override. When overrideGlobal is true, any field set
    // here wins over the tenant Settings.payroll value; unset fields fall back
    // to the tenant config. Mirrors attendanceExceptions/weeklyHolidays pattern.
    payrollOverride: {
        overrideGlobal: { type: Boolean, default: false },
        dailyRateBasis: { type: String, enum: ['calendar', 'fixed30', 'fixed26', 'workingDay'] },
        sandwichRuleEnabled: { type: Boolean },
        bucketWeights: {
            present: { type: Number, min: 0, max: 1 },
            wfh: { type: Number, min: 0, max: 1 },
            halfDay: { type: Number, min: 0, max: 1 },
            paidLeave: { type: Number, min: 0, max: 1 },
            weeklyOff: { type: Number, min: 0, max: 1 },
            holiday: { type: Number, min: 0, max: 1 },
            absent: { type: Number, min: 0, max: 1 },
            unpaidLeave: { type: Number, min: 0, max: 1 },
        },
    },

    // Common fields
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active'
    },
    // Optional admin-supplied reason shown to the user at login when status is 'inactive'.
    inactiveReason: { type: String, default: '' },
    isActive: { type: Boolean, default: true }, // For Admin tenant status
    // Admin-controlled live-location tracking. When true, this employee's
    // position is reported during an active shift. Defaults to false — the
    // admin opts each employee in from the Tracking page (employees are NOT
    // tracked unless explicitly enabled).
    trackingEnabled: { type: Boolean, default: false },
    permissions: { type: mongoose.Schema.Types.Mixed, default: null },
    otp: { type: String },
    otpExpiry: { type: Date },
    activeToken: { type: String, default: null },
}, { timestamps: true });

UserSchema.index({ adminId: 1, role: 1 });

module.exports = mongoose.model('User', UserSchema);
