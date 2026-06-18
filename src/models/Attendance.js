const mongoose = require('mongoose');

const AttendanceSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: Date, required: true },
    punchIn: { type: Date, default: null },
    punchInLocation: { type: String, default: null },
    punchInCoordinates: { lat: { type: Number }, lng: { type: Number } },
    punchInPhoto: { type: String, default: null },
    punchOut: { type: Date, default: null },
    punchOutLocation: { type: String, default: null },
    punchOutCoordinates: { lat: { type: Number }, lng: { type: Number } },
    punchOutPhoto: { type: String, default: null },
    lunchInTime: { type: Date, default: null },
    lunchInLocation: { type: String, default: null },
    lunchInCoordinates: { lat: { type: Number }, lng: { type: Number } },
    lunchOutTime: { type: Date, default: null },
    lunchOutLocation: { type: String, default: null },
    lunchOutCoordinates: { lat: { type: Number }, lng: { type: Number } },
    status: {
        type: String,
        enum: ['present', 'absent', 'half-day', 'late', 'wfh'],
        default: 'absent',
    },
    // Work-from-home flag — first-class signal (was previously only a remarks
    // substring). Set on punch-in; lets payroll pay WFH at its own weight.
    isWFH: { type: Boolean, default: false },
    // Persistent punctuality signal that survives punch-out normalisation
    // (status 'late' used to be overwritten to 'present' on punch-out, making
    // punctuality unrecoverable). True when the punch-in was within grace.
    wasLate: { type: Boolean, default: false },
    shifts: [{
        punchIn: { type: Date },
        punchOut: { type: Date }
    }],
    totalWorkMs: { type: Number, default: 0 },
    remarks: { type: String, default: null }
}, { timestamps: true });

AttendanceSchema.index({ adminId: 1, date: 1 });
AttendanceSchema.index({ adminId: 1, employeeId: 1, date: 1 });
AttendanceSchema.index({ adminId: 1, status: 1 });

module.exports = mongoose.model('Attendance', AttendanceSchema);
