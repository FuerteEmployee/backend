const mongoose = require('mongoose');

const BranchSchema = new mongoose.Schema({
    adminId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true,
        index: true 
    },
    branchName: { type: String, required: true },
    branchLocation: { type: String, required: true },
    latitude: { type: Number },
    longitude: { type: Number }
}, { timestamps: true });

BranchSchema.index({ adminId: 1, branchName: 1 });

module.exports = mongoose.model('Branch', BranchSchema);
