const mongoose = require('mongoose');

const DepartmentSchema = new mongoose.Schema({
    adminId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true,
        index: true 
    },
    name: { type: String, required: true },
    colorCode: { type: String, default: '#000000' }
}, { timestamps: true });

DepartmentSchema.index({ adminId: 1, name: 1 });

module.exports = mongoose.model('Department', DepartmentSchema);
