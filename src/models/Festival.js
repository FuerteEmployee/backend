const mongoose = require('mongoose');

const festivalSchema = new mongoose.Schema({
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    startDate: {
        type: String, // YYYY-MM-DD
        required: true
    },
    endDate: {
        type: String, // YYYY-MM-DD
        required: true
    },
    type: {
        type: String,
        enum: ['mandatory', 'optional', 'event'],
        default: 'mandatory'
    },
    description: {
        type: String,
        trim: true
    },
    posterUrl: {
        type: String
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Festival', festivalSchema);
