const mongoose = require('mongoose');

const SettingsSchema = new mongoose.Schema({
    adminId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true,
        unique: true 
    },
    // Company Profile
    companyName: { type: String },
    companyLogo: { type: String },
    address: { type: String },
    email: { type: String },
    phone: { type: String },
    
    // Notifications
    notifications: {
        email: { type: Boolean, default: true },
        push: { type: Boolean, default: true },
        weekly: { type: Boolean, default: false }
    },
    
    // Appearance & Layout
    appearance: {
        defaultLayout: { type: String, enum: ['grid', 'list'], default: 'list' }
    },

    // Branch Configuration
    branchSettings: {
        // When enabled, an employee can be assigned to more than one branch.
        allowMultipleBranches: { type: Boolean, default: false }
    },
    
    // Salary Templates
    salaryTemplates: [{
        name: { type: String, required: true },
        components: { type: Object }
    }],
    
    // Attendance Configuration
    attendance: {
        defaultShiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' },
        requireLocation: { type: Boolean, default: false },
        remotePunch: { type: Boolean, default: true },
        workDays: { type: [String], default: ['M', 'T', 'W', 'Th', 'F'] },
        reqHours: { type: Number, default: 8 },
        reqMins: { type: Number, default: 0 },
        halfDayHours: { type: Number, default: 4 },
        allowMultiplePunches: { type: Boolean, default: false },
        // Minutes of grace before a punch-in counts as "late". Was read at
        // attendance_controller but previously missing here (Mongoose strict
        // mode silently dropped it) — now declared so it persists.
        lateGrace: { type: Number, default: 15 },

        // ── Half-day rule configuration ──────────────────────────────────────
        // Admins choose which method (or combination) decides a half-day, so
        // the platform works for companies with different attendance policies.
        halfDayRules: {
            // 'timeBased'    → punch-in after cutoffTime = half day
            // 'durationBased'→ net worked hours < minHours = half day
            // 'both'         → apply both, combined by bothLogic
            method: { type: String, enum: ['timeBased', 'durationBased', 'both'], default: 'durationBased' },
            // 'or'  = EITHER condition failing triggers half day (stricter)
            // 'and' = BOTH conditions must fail to trigger half day (lenient)
            bothLogic: { type: String, enum: ['or', 'and'], default: 'or' },
            // Absolute HH:MM cutoff. Punching in AFTER this time (strictly) = late arrival.
            // "after 09:35" means 09:35:01 and later; 09:35:00 is still on time.
            cutoffTime: { type: String, default: '09:35' },
            // Minimum net hours required for a full day (duration-based method).
            minHours: { type: Number, default: 8 },
            // Whether to subtract the lunch break from worked hours.
            // If true: net = (punchOut - punchIn) - (lunchOut - lunchIn)
            // If false: net = punchOut - punchIn  (gross)
            deductLunch: { type: Boolean, default: true },
        },
    },

    // Payroll Configuration (deterministic, configurable salary engine).
    // The whole engine is gated behind `enabled`: when false (default) the
    // legacy salary calculation runs verbatim, so existing tenants are
    // unaffected until they opt in by saving the Payroll settings tab.
    payroll: {
        enabled: { type: Boolean, default: false },
        // Per-day rate basis. fixed30 = salary/30 (recommended, predictable).
        dailyRateBasis: {
            type: String,
            enum: ['calendar', 'fixed30', 'fixed26', 'workingDay'],
            default: 'fixed30',
        },
        // When ON, a weekly-off/holiday flanked by unexcused absence on BOTH
        // the prior and next working day is reclassified to unpaid (LOP).
        sandwichRuleEnabled: { type: Boolean, default: true },
        // Rounding applied ONCE to the final net salary.
        rounding: {
            mode: { type: String, enum: ['none', 'nearest', 'floor', 'ceil'], default: 'nearest' },
            precision: { type: Number, default: 0 },
        },
        // Multiplier for days worked on a holiday/weekly-off. Default 1 (no
        // bonus); the legacy engine accidentally paid ~2x via double-counting.
        holidayWorkBonusMultiplier: { type: Number, default: 1 },
        // Pay weight (0..1) per day-bucket. Defaults reproduce today's weights
        // for the buckets that exist today (present=1, half-day=0.5).
        bucketWeights: {
            present: { type: Number, default: 1, min: 0, max: 1 },
            wfh: { type: Number, default: 1, min: 0, max: 1 },
            halfDay: { type: Number, default: 0.5, min: 0, max: 1 },
            paidLeave: { type: Number, default: 1, min: 0, max: 1 },
            weeklyOff: { type: Number, default: 1, min: 0, max: 1 },
            holiday: { type: Number, default: 1, min: 0, max: 1 },
            absent: { type: Number, default: 0, min: 0, max: 1 },
            unpaidLeave: { type: Number, default: 0, min: 0, max: 1 },
        },
    },
}, { timestamps: true });

module.exports = mongoose.model('Settings', SettingsSchema);
