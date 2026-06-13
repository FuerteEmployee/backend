/**
 * Seeds the initial super admin user and default plans + alert rules.
 * Run: node seedSuperAdmin.js
 * Safe to re-run — skips if records already exist.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./src/config/db');

const User = require('./src/models/User');
const Plan = require('./src/models/Plan');
const AlertRule = require('./src/models/AlertRule');

async function seed() {
    await connectDB();

    // ─── 1. Super Admin User ────────────────────────────────────────────
    const existingByPhone = await User.findOne({ phone: '8888888888' });
    if (existingByPhone) {
        existingByPhone.role = 'superadmin';
        existingByPhone.status = 'active';
        existingByPhone.isActive = true;
        await existingByPhone.save();
        console.log('✓ Super admin role verified/updated for phone:', existingByPhone.phone);
    } else {
        const superAdmin = await User.create({
            name: 'Bharat Kadavala',
            phone: '8888888888',
            email: 'bharat@beont.me',
            role: 'superadmin',
            status: 'active',
            isActive: true
        });
        console.log('✓ Super admin created:', superAdmin.phone);
    }

    // ─── 2. Default Plans ───────────────────────────────────────────────
    const defaultPlans = [
        {
            name: 'Starter',
            slug: 'starter',
            price: 1200,
            annualPrice: 12000,
            maxEmployees: 30,
            trialDays: 14,
            color: '#888780',
            isFeatured: false,
            modules: {
                attendance: true,
                salary: 'basic',
                gpsTracking: false,
                firebaseNotifications: false,
                expensesAssets: false,
                crmLeads: false,
                geminiAI: false,
                customBranding: false,
                prioritySupport: false
            }
        },
        {
            name: 'Growth',
            slug: 'growth',
            price: 3600,
            annualPrice: 36000,
            maxEmployees: 150,
            trialDays: 14,
            color: '#1D9E75',
            isFeatured: true,
            modules: {
                attendance: true,
                salary: 'full',
                gpsTracking: true,
                firebaseNotifications: true,
                expensesAssets: true,
                crmLeads: false,
                geminiAI: false,
                customBranding: false,
                prioritySupport: false
            }
        },
        {
            name: 'Pro',
            slug: 'pro',
            price: 15000,
            annualPrice: 150000,
            maxEmployees: null, // Unlimited
            trialDays: 30,
            color: '#534AB7',
            isFeatured: false,
            modules: {
                attendance: true,
                salary: 'full',
                gpsTracking: true,
                firebaseNotifications: true,
                expensesAssets: true,
                crmLeads: true,
                geminiAI: true,
                customBranding: true,
                prioritySupport: true
            }
        }
    ];

    for (const plan of defaultPlans) {
        const existing = await Plan.findOne({ slug: plan.slug });
        if (existing) {
            console.log(`✓ Plan "${plan.name}" already exists`);
        } else {
            await Plan.create(plan);
            console.log(`✓ Plan "${plan.name}" created — ₹${plan.price}/mo`);
        }
    }

    // ─── 3. Default Alert Rules ─────────────────────────────────────────
    const defaultAlerts = [
        { slug: 'trial_expiry', name: 'Trial expiry warning', description: 'Email tenant admin 3 days before trial ends', isEnabled: true },
        { slug: 'seat_limit', name: 'Employee seat limit', description: 'Warn when tenant reaches 90% of seat limit', isEnabled: true },
        { slug: 'payment_failed', name: 'Payment failed', description: 'Email + auto-retry after 3 days', isEnabled: true },
        { slug: 'renewal_reminder', name: 'Renewal reminder', description: 'Email 7 days before next renewal date', isEnabled: false },
        { slug: 'grace_expiry', name: 'Grace period expiry', description: 'Lock tenant access after 5-day grace period', isEnabled: true },
        { slug: 'push_on_upgrade', name: 'Firebase push on upgrade', description: 'Notify tenant employees on plan change', isEnabled: false }
    ];

    for (const alert of defaultAlerts) {
        const existing = await AlertRule.findOne({ slug: alert.slug });
        if (existing) {
            console.log(`✓ Alert rule "${alert.name}" already exists`);
        } else {
            await AlertRule.create(alert);
            console.log(`✓ Alert rule "${alert.name}" created (${alert.isEnabled ? 'ON' : 'OFF'})`);
        }
    }

    console.log('\n✅ Seeding complete!');
    process.exit(0);
}

seed().catch(err => {
    console.error('Seeding failed:', err);
    process.exit(1);
});
