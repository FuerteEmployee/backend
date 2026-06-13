const mongoose = require('mongoose');

const PlanSchema = new mongoose.Schema({
    name: { type: String, required: true },         // "Starter", "Growth", "Pro"
    slug: { type: String, required: true, unique: true }, // "starter", "growth", "pro"
    price: { type: Number, required: true },         // Monthly price in INR
    annualPrice: { type: Number },                   // Annual price (optional)
    maxEmployees: { type: Number, default: null },   // null = unlimited
    trialDays: { type: Number, default: 14 },
    color: { type: String, default: '#1D9E75' },     // Dot color for UI
    isFeatured: { type: Boolean, default: false },   // "Popular" badge

    // Module gating — dynamic map of feature keys to their values (boolean or string)
    modules: {
        type: Map,
        of: mongoose.Schema.Types.Mixed,
        default: {}
    },

    isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Plan', PlanSchema);
