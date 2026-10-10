const mongoose = require('mongoose');

// One employee's contact with one notice: when they first saw it, when they
// tapped "Mark as read", and their answer to its question. One row per
// (notice, employee), enforced by the unique index, so a double tap updates
// the same row instead of counting twice.
const AnnouncementResponseSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    announcementId: { type: mongoose.Schema.Types.ObjectId, ref: 'Announcement', required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    seenAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    answer: {
        // Option positions (0-based) for yes/no, pick one and pick several.
        choices: { type: [Number], default: undefined },
        number: { type: Number, default: undefined },
    },
    answeredAt: { type: Date, default: null },
}, { timestamps: true });

AnnouncementResponseSchema.index({ announcementId: 1, employeeId: 1 }, { unique: true });
AnnouncementResponseSchema.index({ adminId: 1, employeeId: 1 });

module.exports = mongoose.model('AnnouncementResponse', AnnouncementResponseSchema);
