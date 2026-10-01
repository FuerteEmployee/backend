const mongoose = require('mongoose');

const TicketSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true }, // 'Query', 'Complaint', 'ForgotPunchIn', 'ForgotPunchOut'; legacy 'Correction', 'Leave'
    reason: { type: String, required: true },
    status: { 
        type: String, 
        enum: ['pending', 'approved', 'rejected'], 
        default: 'pending' 
    },
    adminRemark: { type: String },

    // Set only on a "Forgot to punch in" / "Forgot to punch out" ticket
    // (type ForgotPunchIn / ForgotPunchOut). Such a ticket is a front door to
    // an attendance correction: the Regularization it created is what gets
    // approved, through the one approveRegularization path, and its status is
    // mirrored back here. A free-text ticket leaves all of this null.
    regularizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Regularization', default: null },
    correction: {
        field: { type: String, enum: ['punchIn', 'punchOut', null], default: null },
        // IST midnight of the attendance day (the shift's day, for a night shift).
        date: { type: Date, default: null },
        // What the employee asked for.
        requestedTime: { type: Date, default: null },
        // What the day said when they asked ("You punched in at 10:00 AM").
        recordedTime: { type: Date, default: null },
        // What was actually applied on approval -- the admin may approve with
        // an edited time, and the employee must be told the real one.
        appliedTime: { type: Date, default: null },
    },
}, { timestamps: true });

TicketSchema.index({ adminId: 1, status: 1 });

module.exports = mongoose.model('Ticket', TicketSchema);
