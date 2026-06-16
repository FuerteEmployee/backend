const mongoose = require('mongoose');

const SubscriptionSchema = new mongoose.Schema({
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true
    },
    planId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Plan',
        required: true
    },

    status: {
        type: String,
        enum: ['active', 'trial', 'grace', 'paused', 'expired', 'cancelled'],
        default: 'trial'
    },
    billingCycle: {
        type: String,
        enum: ['monthly', 'annual'],
        default: 'monthly'
    },

    trialStartDate: { type: Date },
    trialEndDate: { type: Date },
    currentPeriodStart: { type: Date },
    currentPeriodEnd: { type: Date },   // = renewal date
    graceEndDate: { type: Date },       // grace period after expiry

    employeesUsed: { type: Number, default: 0 },
    mrr: { type: Number, default: 0 },  // Monthly recurring revenue

    // Day-milestones (e.g. 7, 3, 1) already notified for the current period,
    // so reminders fire at most once each. Reset when a new period begins.
    remindersSent: { type: [Number], default: [] },

    // History of plan changes
    history: [{
        action: {
            type: String,
            enum: ['created', 'upgraded', 'downgraded', 'renewed', 'cancelled', 'trial_started', 'paused', 'reactivated', 'grace', 'expired'],
            required: true
        },
        fromPlan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
        toPlan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
        date: { type: Date, default: Date.now },
        note: { type: String }
    }]
}, { timestamps: true });

module.exports = mongoose.model('Subscription', SubscriptionSchema);
