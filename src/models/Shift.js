const mongoose = require('mongoose');

const ShiftSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    startTime: { type: String, required: true }, // e.g., '09:00'
    endTime: { type: String, required: true },   // e.g., '18:00'
    halfDayLatePunchInMin: { type: Number, default: 0 },
    halfDayEarlyPunchOutMin: { type: Number, default: 0 },
    // Per-shift working-days override. null/unset = no override, falls back to
    // the employee's own weeklyHolidays, then the tenant-wide
    // settings.attendance.workDays default (see isWeeklyOff).
    workDays: { type: [String], default: null },

    // ── Unpaid lunch break ──────────────────────────────────────────────────
    //
    // How much of the day is NOT paid for. This used to be a single tenant-wide
    // `Settings.attendance.minLunch`, applied as `max(punched, minLunch)` -- so
    // a 30-minute break was deducted from EVERY employee whether or not one was
    // taken. Observed 2026-09-17: two employees who never punched a lunch at
    // all were each docked 30 minutes, and the sessions in the UI visibly did
    // not add up to the total hours beside them.
    //
    // A break is a shift-level policy, not a company-level one: a night crew
    // and a front-desk shift legitimately differ. `mode: 'inherit'` is the
    // default so every existing shift keeps behaving exactly as before, and a
    // tenant that never opens this screen sees no change.
    lunch: {
        // inherit        -- tenant settings.attendance.minLunch, legacy rule.
        // none           -- never deduct anything.
        // fixed_window   -- a scheduled window (e.g. 13:00-14:00). Only the
        //                   part that OVERLAPS actual presence is deducted, so
        //                   an employee who was not at work then loses nothing.
        // fixed_duration -- always exactly `durationMins`, punched or not.
        // from_punches   -- exactly what was punched, 0 if nothing was, with an
        //                   optional floor/cap. This is the honest one: it
        //                   cannot dock a break that was never taken.
        mode: {
            type: String,
            enum: ['inherit', 'none', 'fixed_window', 'fixed_duration', 'from_punches'],
            default: 'inherit',
        },
        // fixed_window only. 'HH:mm', resolved in IST against the punch's date.
        startTime: { type: String, default: null },
        endTime: { type: String, default: null },
        // fixed_duration only.
        durationMins: { type: Number, default: null, min: 0 },
        // from_punches only. `minMins` applies ONLY when a lunch was actually
        // punched -- it turns a mis-tap into a sensible minimum without
        // inventing a break for someone who took none. `maxMins` caps an
        // overrun so a forgotten lunch-out cannot eat the whole afternoon.
        minMins: { type: Number, default: null, min: 0 },
        maxMins: { type: Number, default: null, min: 0 },
    },
}, { timestamps: true });

ShiftSchema.index({ adminId: 1, name: 1 });

module.exports = mongoose.model('Shift', ShiftSchema);
