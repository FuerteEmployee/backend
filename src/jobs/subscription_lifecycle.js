const Subscription = require('../models/Subscription');
const User = require('../models/User');
const { sendSubscriptionReminder } = require('./notify');

// Days a tenant keeps access after a paid period ends before being hard-expired.
const GRACE_DAYS = parseInt(process.env.SUBSCRIPTION_GRACE_DAYS || '3', 10);

// Day-milestones at which to remind tenants before a deadline.
const REMINDER_MILESTONES = [7, 3, 1];

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function daysUntil(deadline, now) {
    if (!deadline) return null;
    return Math.ceil((new Date(deadline).getTime() - now.getTime()) / MS_PER_DAY);
}

/**
 * Advance subscriptions through their lifecycle based on the current date.
 * Idempotent: safe to run repeatedly (e.g. daily cron + manual triggers).
 *
 *   trial   (trialEndDate  < now) → expired
 *   active  (currentPeriodEnd < now) → grace   (graceEndDate = now + GRACE_DAYS)
 *   grace   (graceEndDate  < now) → expired
 *
 * Each transition appends a history entry so the timeline stays auditable.
 * Returns a summary of how many records changed in each bucket.
 */
async function runSubscriptionLifecycle(now = new Date()) {
    const summary = { trialExpired: 0, enteredGrace: 0, graceExpired: 0, remindersSent: 0, seatsReconciled: 0, errors: 0 };

    // 1. Trials whose trial window has elapsed → expired
    try {
        const expiredTrials = await Subscription.find({
            status: 'trial',
            trialEndDate: { $lt: now },
        });
        for (const sub of expiredTrials) {
            sub.status = 'expired';
            sub.mrr = 0;
            sub.history.push({ action: 'expired', date: now, note: 'Trial period ended' });
            await sub.save();
            summary.trialExpired++;
        }
    } catch (err) {
        console.error('[lifecycle] trial→expired error:', err.message);
        summary.errors++;
    }

    // 2. Active subscriptions past their paid period → grace
    try {
        const lapsed = await Subscription.find({
            status: 'active',
            currentPeriodEnd: { $lt: now },
        });
        for (const sub of lapsed) {
            sub.status = 'grace';
            sub.graceEndDate = new Date(now.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);
            sub.history.push({ action: 'grace', date: now, note: `Entered ${GRACE_DAYS}-day grace period` });
            await sub.save();
            summary.enteredGrace++;
        }
    } catch (err) {
        console.error('[lifecycle] active→grace error:', err.message);
        summary.errors++;
    }

    // 3. Grace subscriptions past their grace window → expired
    try {
        const graceExpired = await Subscription.find({
            status: 'grace',
            graceEndDate: { $lt: now },
        });
        for (const sub of graceExpired) {
            sub.status = 'expired';
            sub.mrr = 0;
            sub.history.push({ action: 'expired', date: now, note: 'Grace period ended' });
            await sub.save();
            summary.graceExpired++;
        }
    } catch (err) {
        console.error('[lifecycle] grace→expired error:', err.message);
        summary.errors++;
    }

    // 3.5 Send deadline reminders at the configured milestones (once each).
    try {
        const upcoming = await Subscription.find({ status: { $in: ['trial', 'active', 'grace'] } });
        for (const sub of upcoming) {
            const deadline =
                sub.status === 'trial' ? sub.trialEndDate
                : sub.status === 'grace' ? (sub.graceEndDate || sub.currentPeriodEnd)
                : sub.currentPeriodEnd;

            const days = daysUntil(deadline, now);
            if (days == null) continue;

            // A fresh/long period means a renewal happened — clear old reminders.
            if (days > Math.max(...REMINDER_MILESTONES) && sub.remindersSent.length) {
                sub.remindersSent = [];
                await sub.save();
                continue;
            }

            // Every milestone the deadline has now reached but we haven't notified.
            const dueMilestones = REMINDER_MILESTONES.filter(
                (m) => days <= m && !sub.remindersSent.includes(m),
            );
            if (dueMilestones.length === 0) continue;

            const admin = await User.findById(sub.adminId).lean();
            if (!admin) continue;

            try {
                // One reminder per run referencing the actual days remaining; mark all
                // reached milestones sent so a single run can't fan out duplicates.
                await sendSubscriptionReminder({ admin, kind: sub.status, daysRemaining: days });
                sub.remindersSent.push(...dueMilestones);
                await sub.save();
                summary.remindersSent++;
            } catch (sendErr) {
                console.error('[lifecycle] reminder send failed:', sendErr.message);
                summary.errors++;
            }
        }
    } catch (err) {
        console.error('[lifecycle] reminder pass error:', err.message);
        summary.errors++;
    }

    // 4. Reconcile employeesUsed against the actual employee count, so seat
    //    usage stays accurate even if a create/delete missed the in-line sync.
    try {
        const subs = await Subscription.find({}, { adminId: 1, employeesUsed: 1 });
        for (const sub of subs) {
            const count = await User.countDocuments({ adminId: sub.adminId, role: 'employee' });
            if (sub.employeesUsed !== count) {
                sub.employeesUsed = count;
                await sub.save();
                summary.seatsReconciled++;
            }
        }
    } catch (err) {
        console.error('[lifecycle] seat reconciliation error:', err.message);
        summary.errors++;
    }

    const total = summary.trialExpired + summary.enteredGrace + summary.graceExpired
        + summary.remindersSent + summary.seatsReconciled;
    if (total > 0 || summary.errors > 0) {
        console.log(
            `[lifecycle] ${now.toISOString()} → trialExpired=${summary.trialExpired} ` +
            `enteredGrace=${summary.enteredGrace} graceExpired=${summary.graceExpired} ` +
            `remindersSent=${summary.remindersSent} seatsReconciled=${summary.seatsReconciled} ` +
            `errors=${summary.errors}`,
        );
    }

    return summary;
}

module.exports = { runSubscriptionLifecycle, GRACE_DAYS };
