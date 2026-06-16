const cron = require('node-cron');
const { runSubscriptionLifecycle } = require('./subscription_lifecycle');

let started = false;

/**
 * Start in-process scheduled jobs. Only meaningful on a long-running host
 * (local / PM2 / EC2). On Vercel serverless there is no persistent process,
 * so the same jobs are triggered via the secured /api/cron endpoints instead.
 */
function startScheduler() {
    if (started) return; // guard against double-registration (e.g. hot reload)
    started = true;

    // Run daily at 02:00 server time.
    cron.schedule('0 2 * * *', () => {
        runSubscriptionLifecycle().catch((err) =>
            console.error('[scheduler] subscription lifecycle failed:', err.message),
        );
    });

    console.log('[scheduler] subscription lifecycle scheduled (daily 02:00)');
}

module.exports = { startScheduler };
