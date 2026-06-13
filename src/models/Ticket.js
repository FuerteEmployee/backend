const mongoose = require('mongoose');

const TicketSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true }, // e.g., 'Leave', 'Complaint', 'Query'
    reason: { type: String, required: true },
    status: { 
        type: String, 
        enum: ['pending', 'approved', 'rejected'], 
        default: 'pending' 
    },
    adminRemark: { type: String }
}, { timestamps: true });

TicketSchema.index({ adminId: 1, status: 1 });

module.exports = mongoose.model('Ticket', TicketSchema);
