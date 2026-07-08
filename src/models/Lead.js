const mongoose = require('mongoose');

const LeadSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    company: { type: String, required: true },
    source: { type: String, default: 'Direct' },
    status: { 
        type: String, 
        enum: ['new', 'contacted', 'qualified', 'proposal', 'lost', 'won'], 
        default: 'new' 
    },
    value: { type: Number, default: 0 },
    followUpDate: { type: String },
    assignedTo: { type: String, default: 'Unassigned' },
    notes: { type: String },
    salesCalls: { type: Number, default: 0 },
    botStatus: {
        type: String,
        enum: ['Inactive', 'Active', 'Completed - Converted', 'Completed - Lost'],
        default: 'Inactive'
    },
    address: { type: String },
    businessType: { type: String },
    requirement: { type: String },
    imageUrls: [{ type: String }] // Cloudinary URLs of uploaded lead images
}, { timestamps: true, strict: false });

LeadSchema.index({ adminId: 1, status: 1 });

module.exports = mongoose.model('Lead', LeadSchema);
