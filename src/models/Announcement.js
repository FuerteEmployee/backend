const mongoose = require('mongoose');

// A notice-board post. Besides the text it can carry:
//   display  - how it reaches employees: a popup when the app opens, and/or a
//              "Mark as read" button. With neither, it only sits under the bell
//              and on the board.
//   question - something employees answer: yes/no, pick one, pick several, or
//              a number (e.g. "How many Navratri passes do you need?").
//   audience - who it is for: everyone, some branches, departments or shifts,
//              or employees picked by hand.
// Answers and read marks live in AnnouncementResponse, one row per employee.
const AnnouncementSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true },
    content: { type: String, required: true },
    // No new values here: phones still on app 1.2 read this through the old
    // API and look the type up in a fixed table.
    type: {
        type: String,
        enum: ['general', 'urgent', 'event', 'policy'],
        default: 'general'
    },
    author: { type: String, default: 'Admin' },
    pinned: { type: Boolean, default: false },
    date: { type: String }, // Display date
    display: {
        popup: { type: Boolean, default: false },
        markAsRead: { type: Boolean, default: false },
    },
    question: {
        kind: { type: String, enum: ['none', 'yes_no', 'single', 'multiple', 'number'], default: 'none' },
        prompt: { type: String, default: '' },
        options: { type: [String], default: undefined },
        min: { type: Number, default: null },
        max: { type: Number, default: null },
        unit: { type: String, default: '' },
        allowChange: { type: Boolean, default: true },
    },
    // After this, answers are refused and the popup stops asking.
    closesAt: { type: Date, default: null },
    audience: {
        mode: { type: String, enum: ['all', 'branches', 'departments', 'shifts', 'employees'], default: 'all' },
        ids: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

AnnouncementSchema.index({ adminId: 1, pinned: -1, createdAt: -1 });

module.exports = mongoose.model('Announcement', AnnouncementSchema);
