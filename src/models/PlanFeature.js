const mongoose = require('mongoose');

const PlanFeatureSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true }, // e.g. "attendance"
    label: { type: String, required: true }, // e.g. "Attendance & leave"
    type: { type: String, enum: ['boolean', 'select'], default: 'boolean' },
    // If type is select, specify the available options (e.g., ['none', 'basic', 'full'])
    options: [{ type: String }],
    order: { type: Number, default: 0 }, // For UI sorting
    isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('PlanFeature', PlanFeatureSchema);
