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
        requireLocation: { type: Boolean, default: true },
        officeRadius: { type: Number, default: 3000 },

        // ── Geofence auto punch-out ─────────────────────────────────────────
        // Off by default, and OFF is the only safe default: turning this on
        // lets the server end somebody's working day without them touching
        // anything, which affects their pay.
        //
        // `shadowMode` is the deliberate middle state and every tenant must
        // pass through it. With shadowMode true the engine runs in full, writes
        // a GeofenceAudit row for every decision, and closes NOTHING. That is
        // what makes the behaviour reviewable on a tenant's own real staff and
        // real building before it is trusted -- the alternative is discovering
        // the thresholds are wrong by taking money off somebody's payslip.
        //
        // NAMED `geofenceAutoPunchOut`, NOT `autoPunchOut`. There is already an
        // `autoPunchOut` Boolean further down this same object (beside
        // earliestIn/latestOut), meaning "close the day at the latest allowed
        // time". Reusing the name produced a DUPLICATE KEY in the object
        // literal, where the later definition silently wins -- so this config
        // vanished and `autoPunchOut.enabled` read undefined off a boolean,
        // leaving the engine permanently unarmed with no error anywhere.
        geofenceAutoPunchOut: {
            enabled: { type: Boolean, default: false },
            shadowMode: { type: Boolean, default: true },
        },
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
        // Minutes allowed for lunch before the Attendance Detail view flags an
        // "overrun" — mirrors a field attendance-config.tsx already sends.
        maxLunch: { type: Number, default: 90 },

        // ── attendance-config.tsx fields below ───────────────────────────────
        // These were previously sent by the UI but absent from this schema, so
        // Mongoose's default strict mode silently dropped every one of them on
        // every save — the admin would set them, save, reload, and see them
        // revert. Declared here purely so they persist; see salary_controller.js
        // (overtime) and attendance_helpers.js (rounding) for the ones that also
        // feed real calculations.
        punchIn: { type: String, default: '09:00' },
        punchOut: { type: String, default: '18:00' },
        earliestIn: { type: String, default: '07:30' },
        latestOut: { type: String, default: '22:00' },
        autoPunchOut: { type: Boolean, default: true },
        lunchIn: { type: String, default: '13:00' },
        lunchOut: { type: String, default: '14:00' },
        minLunch: { type: Number, default: 30 },
        earlyGrace: { type: Number, default: 5 },
        lunchGrace: { type: Number, default: 5 },
        // Daily hours beyond which extra worked time counts as overtime, the
        // weekly OT cap (hours), and the pay multiplier applied to OT hours —
        // consumed by salary_controller.js's overtime earnings line.
        otThreshold: { type: Number, default: 9 },
        weeklyOT: { type: Number, default: 45 },
        otMultiplier: { type: Number, default: 1.5 },
        // How many days back an EMPLOYEE may reach when asking to correct a
        // missed punch-out. Admins are not bound by it. Kept short on purpose:
        // the further away the day, the less anyone actually remembers, and a
        // correction nobody can verify is a guess with an approval stamp on it.
        correctionWindowDays: { type: Number, default: 7 },
        // Minimum gap between two taps by the same employee on a biometric
        // terminal. A second tap inside this window is treated as an accidental
        // repeat and discarded (still stored, flagged, so it stays auditable) —
        // without it, someone arriving at 09:30 who presses twice gets a
        // punch-in and an instant "lunch break started". 0 disables.
        punchDebounceSeconds: { type: Number, default: 120 },
        // Refuse a NEW punch-in once the employee's shift has ended. Punch-out
        // is never blocked. Default on: a punch-in after shift end can only
        // produce a zero-length, unpayable day (see attendance_controller's
        // punchIn). A tenant running 24/7, or one whose shift times are
        // nominal rather than enforced, sets this false.
        blockPunchInAfterShiftEnd: { type: Boolean, default: true },
        // Minutes past shift end during which a punch-in is still accepted --
        // for a site where people genuinely start a few minutes over.
        punchInGraceAfterShiftEndMins: { type: Number, default: 0 },
        // Punch-time rounding applied before late/half-day/payroll math runs
        // (see attendance_helpers.js's roundPunchTime).
        roundingInterval: { type: Number, default: 0 }, // minutes; 0 = off
        roundingDirection: { type: String, enum: ['nearest', 'up', 'down'], default: 'nearest' },
        roundingAppliedTo: { type: [String], default: ['Punch In', 'Punch Out'] },
        // Reminder scheduling preferences — persisted for forward-compatibility,
        // but no reminder-delivery job exists yet (see backend/src/jobs), so
        // these currently have no effect beyond being saved/reloaded correctly.
        notifications: {
            punchInReminder: { type: Boolean, default: true },
            punchInReminderMins: { type: Number, default: 15 },
            lunchReminder: { type: Boolean, default: true },
            lunchReminderMins: { type: Number, default: 5 },
            lunchReturnReminder: { type: Boolean, default: true },
            lunchReturnReminderMins: { type: Number, default: 10 },
            punchOutReminder: { type: Boolean, default: true },
            punchOutReminderMins: { type: Number, default: 10 },
            missedPunchAlert: { type: Boolean, default: true },
            channels: { type: [String], default: ['Push', 'SMS'] },
        },
        // Display/locale preferences — persisted, but nothing server-side reads
        // these yet (formatting is currently client-only wherever it happens).
        display: {
            timeFormat: { type: String, default: '24h' },
            timezone: { type: String, default: 'UTC+05:30' },
            weekStart: { type: String, default: 'Monday' },
            dateFormat: { type: String, default: 'YYYY-MM-DD' },
        },

        // ── What each successive punch of the day MEANS ──────────────────────
        // A biometric terminal reports only "somebody was recognised"; it can't
        // say whether the tap is an arrival, a lunch break or a departure. When
        // enabled, steps[0] is what the 1st tap of the day does, steps[1] the
        // 2nd, and so on — so four taps can mean in / leave for lunch / back /
        // out. When disabled (default) the legacy toggle applies: no open
        // record → punch in, open record → punch out.
        //
        // NOTE 'lunch-in' = the break STARTS, 'lunch-out' = back at work. See
        // utils/punch_sequence.js — the ordering is enforced because
        // attendance_controller.lunchOut requires an existing lunchInTime.
        punchSequence: {
            enabled: { type: Boolean, default: false },
            steps: {
                type: [String],
                default: ['punch-in', 'lunch-in', 'lunch-out', 'punch-out'],
            },
            // What to do with taps once every step is done.
            // 'ignore' → discard (an accidental extra tap can't reopen the day)
            // 'toggle' → fall back to the legacy in/out toggle, for second shifts
            afterLast: { type: String, enum: ['ignore', 'toggle'], default: 'ignore' },
        },

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
    leadFields: [{
        key: { type: String, required: true },
        label: { type: String, required: true },
        type: { type: String, enum: ['text', 'number', 'email', 'phone', 'select', 'date'], default: 'text' },
        options: [{ type: String }],
        required: { type: Boolean, default: false },
        showInTable: { type: Boolean, default: true },
        isSystem: { type: Boolean, default: false }
    }]
}, { timestamps: true });

module.exports = mongoose.model('Settings', SettingsSchema);
