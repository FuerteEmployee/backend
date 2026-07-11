const mongoose = require('mongoose');

// Employee-submitted attendance correction request, approved/rejected by an
// admin — mirrors the Leave/Expense pending-approval pattern. Approval
// applies the requested times to the Attendance record (creating one if it
// doesn't exist yet) via regularization_controller.approveRegularization.
const RegularizationSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    attendanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Attendance', default: null },
    date: { type: Date, required: true },

    requestedPunchIn: { type: Date, default: null },
    requestedPunchOut: { type: Date, default: null },
    requestedLunchInTime: { type: Date, default: null },
    requestedLunchOutTime: { type: Date, default: null },
    // Explicit status override; when set it always wins over the derived
    // late/half-day calculation on approval (e.g. for a "Mark Absent"-style
    // correction submitted through this same request flow).
    requestedStatus: {
        type: String,
        enum: ['present', 'absent', 'half-day', 'late', 'wfh', null],
        default: null,
    },

    reason: { type: String, required: true },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
        index: true,
    },
    adminRemark: { type: String, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
}, { timestamps: true });

RegularizationSchema.index({ adminId: 1, status: 1 });
RegularizationSchema.index({ adminId: 1, employeeId: 1, date: 1 });

module.exports = mongoose.model('Regularization', RegularizationSchema);
