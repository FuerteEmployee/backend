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

    // How many days before the deadline the tenant's trial/renewal banner starts
    // showing (with a live countdown). Set per-tenant by the super admin.
    bannerThresholdDays: { type: Number, default: 7 },

    // Day-milestones (e.g. 7, 3, 1) already notified for the current period,
    // so reminders fire at most once each. Reset when a new period begins.
    remindersSent: { type: [Number], default: [] },

    // Per-tenant feature toggles. The super admin enables/disables specific
    // features for each tenant from the Customers page; a false entry hides
    // the page from the admin panel and 403s its API (checkFeatureToggle).
    //
    // Holds ONLY the super admin's explicit choices. There is deliberately no
    // schema default: a Map default is written into the document the next
    // time it is saved for any reason (renewal, lifecycle job), freezing
    // today's defaults into every tenant. An absent key resolves through
    // FEATURE_TOGGLE_DEFAULTS in utils/feature_toggles.js at read time.
    featureToggles: {
        type: Map,
        of: Boolean,
    },

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
