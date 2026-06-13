/**
 * One-time migration: converts existing admin users with inline
 * subscriptionPlan fields into proper Subscription documents.
 *
 * IDEMPOTENT — safe to re-run. Skips admins that already have
 * a Subscription record.
 *
 * Run: node migrateSubscriptions.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./src/config/db');

const User = require('./src/models/User');
const Plan = require('./src/models/Plan');
const Subscription = require('./src/models/Subscription');

// Map old inline plan names to new Plan slugs
const PLAN_MAP = {
    free: 'starter',
    basic: 'growth',
    pro: 'pro'
};

async function migrate() {
    await connectDB();

    // Get all admin users (not superadmin, not employee)
    const admins = await User.find({ role: 'admin' }).lean();
    console.log(`Found ${admins.length} admin tenant(s) to process.\n`);

    // Pre-load plan documents
    const plans = await Plan.find({}).lean();
    const planBySlug = {};
    for (const p of plans) {
        planBySlug[p.slug] = p;
    }

    if (Object.keys(planBySlug).length === 0) {
        console.error('❌ No plans found. Run seedSuperAdmin.js first!');
        process.exit(1);
    }

    let created = 0;
    let skipped = 0;

    for (const admin of admins) {
        // Check if subscription already exists
        const existing = await Subscription.findOne({ adminId: admin._id });
        if (existing) {
            console.log(`  ⏭  ${admin.name || admin.phone} — already has subscription (${existing.status})`);
            skipped++;
            continue;
        }

        // Resolve plan
        const oldPlan = admin.subscriptionPlan || 'free';
        const newSlug = PLAN_MAP[oldPlan] || 'starter';
        const plan = planBySlug[newSlug];

        if (!plan) {
            console.log(`  ⚠  ${admin.name || admin.phone} — plan "${newSlug}" not found, skipping`);
            skipped++;
            continue;
        }

        // Count employees
        const employeeCount = await User.countDocuments({ adminId: admin._id, role: 'employee' });

        // Determine status from existing fields
        let status = 'active';
        const now = new Date();

        if (admin.subscriptionEndDate && admin.subscriptionEndDate < now) {
            status = 'expired';
        } else if (oldPlan === 'free') {
            status = 'trial';
        }

        const periodStart = admin.subscriptionStartDate || admin.createdAt || now;
        const periodEnd = admin.subscriptionEndDate || new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        await Subscription.create({
            adminId: admin._id,
            planId: plan._id,
            status,
            billingCycle: 'monthly',
            trialStartDate: status === 'trial' ? periodStart : undefined,
            trialEndDate: status === 'trial' ? periodEnd : undefined,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            employeesUsed: employeeCount,
            mrr: status === 'active' ? plan.price : 0,
            history: [{
                action: 'created',
                toPlan: plan._id,
                date: now,
                note: `Migrated from legacy subscriptionPlan="${oldPlan}"`
            }]
        });

        console.log(`  ✓  ${admin.name || admin.phone} — "${oldPlan}" → "${plan.name}" (${status}, ${employeeCount} employees)`);
        created++;
    }

    console.log(`\n✅ Migration complete: ${created} created, ${skipped} skipped.`);
    process.exit(0);
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
