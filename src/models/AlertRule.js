const mongoose = require('mongoose');

const AlertRuleSchema = new mongoose.Schema({
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String },
    isEnabled: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('AlertRule', AlertRuleSchema);
