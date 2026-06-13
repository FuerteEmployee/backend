const mongoose = require('mongoose');

const InvoiceSchema = new mongoose.Schema({
    invoiceNumber: { type: String, required: true, unique: true }, // "#INV-0612"
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    subscriptionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Subscription'
    },
    planId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Plan'
    },

    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    period: { type: String },               // "Jun 2026"
    status: {
        type: String,
        enum: ['paid', 'pending', 'failed', 'refunded'],
        default: 'pending'
    },

    paidAt: { type: Date },
    dueDate: { type: Date },

    // Payment gateway fields (for future Razorpay integration)
    razorpayPaymentId: { type: String },
    razorpayOrderId: { type: String },
    notes: { type: String }
}, { timestamps: true });

// Auto-generate invoice number before save
InvoiceSchema.pre('save', async function (next) {
    if (this.isNew && !this.invoiceNumber) {
        const count = await mongoose.model('Invoice').countDocuments();
        this.invoiceNumber = `#INV-${String(count + 1).padStart(4, '0')}`;
    }
    next();
});

module.exports = mongoose.model('Invoice', InvoiceSchema);
