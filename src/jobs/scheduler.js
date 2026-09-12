const cron = require('node-cron');
const { runSubscriptionLifecycle } = require('./subscription_lifecycle');
const { runDeviceHealthCheck } = require('./device_health');
const { closeForgottenPunches } = require('./attendance_close');

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

    // 04:00 IST, fixed rather than configurable: this is a safety net, not a
    // policy. It closes YESTERDAY only -- running it against today would punch
    // out the entire night shift mid-shift.
    cron.schedule('0 4 * * *', () => {
        closeForgottenPunches().catch((err) =>
            console.error('[scheduler] forgotten-punch close failed:', err.message),
        );
    }, { timezone: process.env.TZ || 'Asia/Kolkata' });

    console.log('[scheduler] subscription lifecycle scheduled (daily 02:00)');
    console.log('[scheduler] forgotten-punch close scheduled (daily 04:00 IST)');
    console.log('[scheduler] device health check scheduled (hourly at :15)');
}

module.exports = { startScheduler };
