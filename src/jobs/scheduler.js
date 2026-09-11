const cron = require('node-cron');
const { runSubscriptionLifecycle } = require('./subscription_lifecycle');
const { runDeviceHealthCheck } = require('./device_health');

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

    // Hourly, not daily: the point of this alert is that somebody can go and
    // plug the machine back in during the same working day. A daily 02:00 run
    // would report a Monday-morning outage on Tuesday, by which time a day of
    // attendance is already lost.
    cron.schedule('15 * * * *', () => {
        runDeviceHealthCheck().catch((err) =>
            console.error('[scheduler] device health check failed:', err.message),
        );
    });

    console.log('[scheduler] subscription lifecycle scheduled (daily 02:00)');
    console.log('[scheduler] device health check scheduled (hourly at :15)');
}

module.exports = { startScheduler };
