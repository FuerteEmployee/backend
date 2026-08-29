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
    workDays: { type: [String], default: null }
}, { timestamps: true });

ShiftSchema.index({ adminId: 1, name: 1 });

module.exports = mongoose.model('Shift', ShiftSchema);
