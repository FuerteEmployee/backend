const mongoose = require('mongoose');

const AnnouncementSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true },
    content: { type: String, required: true },
    type: { 
        type: String, 
        enum: ['general', 'urgent', 'event', 'policy'], 
        default: 'general' 
    },
    author: { type: String, default: 'Admin' },
    pinned: { type: Boolean, default: false },
    date: { type: String } // Display date
}, { timestamps: true });

AnnouncementSchema.index({ adminId: 1, pinned: -1, createdAt: -1 });

module.exports = mongoose.model('Announcement', AnnouncementSchema);
