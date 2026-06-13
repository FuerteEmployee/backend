const mongoose = require('mongoose');

const LeaveSchema = new mongoose.Schema({
    adminId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true,
        index: true 
    },
    employeeId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true,
        index: true
    },
    leaveTypeId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'LeaveType', 
        required: true 
    },
    startDate: { 
        type: Date, 
        required: true 
    },
    endDate: { 
        type: Date, 
        required: true 
    },
    duration: { 
        type: Number, 
        required: true, 
        min: 1 
    },
    reason: { 
        type: String, 
        required: true 
    },
    status: { 
        type: String, 
        enum: ['pending', 'approved', 'rejected'], 
        default: 'pending',
        index: true
    },
    adminRemark: { 
        type: String 
    }
}, { timestamps: true });

LeaveSchema.index({ adminId: 1, employeeId: 1 });
LeaveSchema.index({ adminId: 1, status: 1 });

module.exports = mongoose.model('Leave', LeaveSchema);
