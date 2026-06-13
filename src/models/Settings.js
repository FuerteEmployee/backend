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
    
    // Salary Templates
    salaryTemplates: [{
        name: { type: String, required: true },
        components: { type: Object }
    }],
    
    // Attendance Configuration
    attendance: {
        defaultShiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' },
        requireLocation: { type: Boolean, default: false },
        remotePunch: { type: Boolean, default: true },
        workDays: { type: [String], default: ['M', 'T', 'W', 'Th', 'F'] },
        reqHours: { type: Number, default: 8 },
        reqMins: { type: Number, default: 0 },
        halfDayHours: { type: Number, default: 4 },
        allowMultiplePunches: { type: Boolean, default: false },
    }
}, { timestamps: true });

module.exports = mongoose.model('Settings', SettingsSchema);
