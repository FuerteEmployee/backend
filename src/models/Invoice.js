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

// ─── Invoice numbers ─────────────────────────────────────────────────────────
//
// The number used to be `countDocuments() + 1`. Two creates at the same moment
// both read the same count and the second failed on the unique index, and after
// any delete the count fell behind the highest number, so the next invoice
// reused one that already existed. It also ran in pre('save'), which Mongoose
// runs AFTER validation, so `required: true` rejected every invoice created
// without a number: creating one never worked at all.
//
// Now a single counter row is incremented atomically ($inc on one document is
// atomic in MongoDB), so every caller gets a different number. The counter is
// seeded from the highest number already issued with $max, which is idempotent
// and only ever raises the value, so concurrent first calls cannot move it
// backwards and existing invoice numbers are never reissued or changed.

const InvoiceCounter = mongoose.models.InvoiceCounter || mongoose.model('InvoiceCounter', new mongoose.Schema({
    _id: { type: String },
    seq: { type: Number, default: 0 },
}, { collection: 'invoicecounters', versionKey: false }));

const COUNTER_ID = 'invoice';
const NUMBER_RE = /^#INV-(\d+)$/;
const formatInvoiceNumber = (n) => `#INV-${String(n).padStart(4, '0')}`;

async function highestIssuedNumber() {
    const Invoice = mongoose.model('Invoice');
    const rows = await Invoice.find({ invoiceNumber: /^#INV-\d+$/ }).select('invoiceNumber').lean();
    let max = 0;
    for (const r of rows) {
        const m = NUMBER_RE.exec(r.invoiceNumber || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max;
}

async function nextInvoiceNumber() {
    const existing = await InvoiceCounter.findById(COUNTER_ID).lean();
    if (!existing) {
        await InvoiceCounter.updateOne(
            { _id: COUNTER_ID },
            { $max: { seq: await highestIssuedNumber() } },
            { upsert: true },
        );
    }
    const row = await InvoiceCounter.findOneAndUpdate(
        { _id: COUNTER_ID },
        { $inc: { seq: 1 } },
        { new: true, upsert: true },
    ).lean();
    return formatInvoiceNumber(row.seq);
}

// Re-seed the counter past the highest number in use (used after a unique-index
// collision, e.g. a number that was typed in by hand).
async function resyncInvoiceCounter() {
    await InvoiceCounter.updateOne(
        { _id: COUNTER_ID },
        { $max: { seq: await highestIssuedNumber() } },
        { upsert: true },
    );
}

// pre('validate'), not pre('save'): validation runs first and would reject the
// missing number before a save hook could fill it in.
InvoiceSchema.pre('validate', async function () {
    if (this.isNew && !this.invoiceNumber) {
        this.invoiceNumber = await nextInvoiceNumber();
    }
});

const Invoice = mongoose.model('Invoice', InvoiceSchema);
Invoice.nextInvoiceNumber = nextInvoiceNumber;
Invoice.resyncInvoiceCounter = resyncInvoiceCounter;

module.exports = Invoice;
