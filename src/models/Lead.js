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
        enum: ['new', 'contacted', 'qualified', 'lost', 'won'], 
        default: 'new' 
    },
    assignedTo: { type: String, default: 'Unassigned' },
    notes: { type: String }
}, { timestamps: true });

LeadSchema.index({ adminId: 1, status: 1 });

module.exports = mongoose.model('Lead', LeadSchema);
