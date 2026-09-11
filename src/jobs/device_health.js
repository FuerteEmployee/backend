const Device = require('../models/Device');
const User = require('../models/User');
const AlertRule = require('../models/AlertRule');
const { sendDeviceOfflineAlert } = require('./notify');

// A biometric terminal that loses network is the quietest failure in the
// system. It keeps matching fingers and beeping locally, so employees believe
// their attendance is recorded, while nothing reaches the server. The Device
// model already tracked lastSeenAt — nothing watched it, so the discovery point
// was month-end payroll.
//
// Devices handshake on a ~30s Delay, so silence is unambiguous quickly: two
// hours is roughly 240 missed check-ins, which no transient network blip
// explains.
const QUIET_MINUTES = parseInt(process.env.DEVICE_QUIET_MINUTES || '120', 10);

// Don't re-alert every run for a machine that stays unplugged over a weekend.
const ALERT_REPEAT_HOURS = parseInt(process.env.DEVICE_ALERT_REPEAT_HOURS || '24', 10);

const ALERT_SLUG = 'device_offline';
const MS_PER_MIN = 60 * 1000;

/**
 * Flag biometric terminals that have stopped reporting, and notify the tenant.
 *
 * Idempotent and safe to run repeatedly — the same cron drives it in-process on
 * a long-running host and via /api/cron on serverless, and a manual trigger is
 * a legitimate support action.
 *
 * Only devices that are `active` AND assigned to a tenant are considered:
 * an unassigned machine has nobody to notify, and a deliberately disabled one
 * is *expected* to be silent, so alerting on either would be noise that trains
 * people to ignore the real alert.
 *
 * @returns summary counts
 */
async function runDeviceHealthCheck(now = new Date()) {
    const summary = { checked: 0, offline: 0, alerted: 0, suppressed: 0, recovered: 0, errors: 0 };

    // Respect the super admin's alert toggle. A missing rule is treated as
    // enabled so a deployment that predates the seed still alerts — silence is
    // the failure mode we are trying to remove, so default to noisy.
    let enabled = true;
    try {
        const rule = await AlertRule.findOne({ slug: ALERT_SLUG }).lean();
        if (rule && rule.isEnabled === false) enabled = false;
    } catch (err) {
        console.error('[device-health] could not read alert rule:', err.message);
    }

    const cutoff = new Date(now.getTime() - QUIET_MINUTES * MS_PER_MIN);

    try {
        // Clear the alert flag on anything that has since made contact, so the
        // next outage is reported immediately instead of being swallowed by a
        // stale offlineAlertedAt.
        const recovered = await Device.updateMany(
            { offlineAlertedAt: { $ne: null }, lastSeenAt: { $gt: cutoff } },
            { $set: { offlineAlertedAt: null } },
        );
        summary.recovered = recovered.modifiedCount || 0;
    } catch (err) {
        summary.errors++;
        console.error('[device-health] recovery sweep failed:', err.message);
    }

    let devices = [];
    try {
        devices = await Device.find({
            status: 'active',
            adminId: { $ne: null },
            // A device that has genuinely never reported (null lastSeenAt) is
            // a claim that was never completed, not an outage — it has no
            // working baseline to have regressed from.
            lastSeenAt: { $ne: null, $lt: cutoff },
        }).lean();
        summary.checked = devices.length;
    } catch (err) {
        summary.errors++;
        console.error('[device-health] device query failed:', err.message);
        return summary;
    }

    for (const device of devices) {
        summary.offline++;

        const minutesQuiet = Math.floor((now.getTime() - new Date(device.lastSeenAt).getTime()) / MS_PER_MIN);

        if (!enabled) {
            summary.suppressed++;
            continue;
        }

        // Already warned recently enough.
        if (device.offlineAlertedAt &&
            now.getTime() - new Date(device.offlineAlertedAt).getTime() < ALERT_REPEAT_HOURS * 60 * MS_PER_MIN) {
            summary.suppressed++;
            continue;
        }

        try {
            const admin = await User.findById(device.adminId).select('name companyName phone email').lean();
            if (!admin) {
                // Tenant deleted but the device row survived — nobody to tell.
                console.warn(`[device-health] ${device.serialNumber} has no reachable admin (adminId=${device.adminId})`);
                summary.suppressed++;
                continue;
            }

            await sendDeviceOfflineAlert({ admin, device, minutesQuiet });

            await Device.updateOne(
                { _id: device._id },
                { $set: { offlineAlertedAt: now }, $inc: { offlineAlertCount: 1 } },
            );

            summary.alerted++;
            console.warn(
                `[device-health] OFFLINE: "${device.label || device.serialNumber}" ` +
                `(SN=${device.serialNumber}) silent for ${minutesQuiet} min — tenant notified`
            );
        } catch (err) {
            summary.errors++;
            console.error(`[device-health] alert failed for ${device.serialNumber}:`, err.message);
        }
    }

    console.log(
        `[device-health] checked=${summary.checked} offline=${summary.offline} ` +
        `alerted=${summary.alerted} suppressed=${summary.suppressed} recovered=${summary.recovered} errors=${summary.errors}`
    );

    return summary;
}

module.exports = { runDeviceHealthCheck, QUIET_MINUTES, ALERT_REPEAT_HOURS, ALERT_SLUG };
