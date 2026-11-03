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
    // Working days charged against the leave balance. 0.5 for a half day; the
    // old `min: 1` is what made a half day unrepresentable.
    duration: { 
        type: Number, 
        required: true, 
        min: 0.5 
    },
    // Which part of the day is being taken off.
    //
    // 'full' covers both a one-day leave and every day of a date range, so it
    // is the default and every row written before this field existed reads as
    // one. A half day is only ever a SINGLE day -- addLeave refuses one with
    // startDate != endDate -- because "the second half of a three-day range"
    // has no meaning anyone could act on.
    //
    // WHICH half matters and is not cosmetic: it is the difference between an
    // employee who is expected at 09:00 and one who is expected after lunch,
    // and it is what an approver is actually approving.
    dayPortion: {
        type: String,
        enum: ['full', 'first_half', 'second_half'],
        default: 'full'
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
