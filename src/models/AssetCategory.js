const mongoose = require('mongoose');

const AssetCategorySchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    icon: { type: String, default: 'Monitor' },
    description: { type: String }
}, { timestamps: true });

AssetCategorySchema.index({ adminId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('AssetCategory', AssetCategorySchema);
