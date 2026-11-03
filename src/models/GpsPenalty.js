const mongoose = require('mongoose');

// One GPS-off penalty: an employee's phone reported GPS switched off while they
// were on duty, for longer than the company's grace (utils/gps_penalty.js).
//
// At most one per employee per IST day (the unique index), so a phone that
// toggles GPS ten times in an afternoon is one penalty, not ten. The evidence
// is the phone's own report (TrackerEvent), which expires after 30 days, so
// the times are copied here: the row is what payroll and the admin read.
//
// pending  -> waiting for an admin; never deducted.
// approved -> deducted on that month's salary.
// waived   -> the admin decided not to charge it; kept as the record.
const GpsPenaltySchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    dayKey: { type: String, required: true },   // IST 'YYYY-MM-DD'
    offAt: { type: Date, required: true },      // GPS off (or punch-in, if it was already off)
    onAt: { type: Date, required: true },       // GPS back on (or punch-out)
    minutes: { type: Number, required: true },  // the longest stretch off that day
    amount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['pending', 'approved', 'waived'], default: 'pending' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    note: { type: String, default: '', maxlength: 300 },
}, { timestamps: true });

GpsPenaltySchema.index({ adminId: 1, employeeId: 1, dayKey: 1 }, { unique: true });
GpsPenaltySchema.index({ adminId: 1, dayKey: 1 });

module.exports = mongoose.model('GpsPenalty', GpsPenaltySchema);
