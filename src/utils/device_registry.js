const Device = require('../models/Device');
const User = require('../models/User');

// Serial number → device record, resolved from the Device collection.
//
// Biometric terminals push on every punch plus a heartbeat every ~30s, so this
// is a hot path. Results are cached briefly rather than per-process-forever
// (which the old env-var approach effectively did) so that claiming a machine
// in the super admin panel takes effect on its own without a server restart.
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // serialNumber -> { device, at }

function normalizeSerial(sn) {
    return String(sn || '').trim().toUpperCase();
}

function invalidateDeviceCache(serialNumber) {
    if (serialNumber) cache.delete(normalizeSerial(serialNumber));
    else cache.clear();
}

/**
 * Legacy fallback: the ESSL_DEVICES="SN:adminPhone,..." env var this registry
 * replaces. Only consulted when a serial has no Device row yet, so an existing
 * deployment keeps working before `node migrateDevices.js` has been run. Once
 * matched, the mapping is written into the Device collection and the env var is
 * never needed for that machine again.
 */
async function adoptFromLegacyEnv(serialNumber) {
    const raw = process.env.ESSL_DEVICES || '';
    if (!raw) return null;

    const map = {};
    raw.split(',').map((s) => s.trim()).filter(Boolean).forEach((pair) => {
        const [sn, phone] = pair.split(':').map((s) => s.trim());
        if (sn && phone) map[normalizeSerial(sn)] = phone;
    });

    const phone = map[serialNumber];
    if (!phone) return null;

    const admin = await User.findOne({ phone, role: 'admin' }).select('_id');
    if (!admin) return null;

    const device = await Device.findOneAndUpdate(
        { serialNumber },
        {
            $setOnInsert: {
                serialNumber,
                adminId: admin._id,
                status: 'active',
                label: 'Migrated from ESSL_DEVICES',
                autoDiscovered: false,
            },
        },
        { new: true, upsert: true },
    );

    console.log(`[devices] adopted ${serialNumber} from ESSL_DEVICES → adminId=${admin._id}`);
    return device;
}

/**
 * Resolve a device by serial number, auto-registering unknown ones.
 *
 * An unknown serial is recorded as an unassigned device rather than discarded,
 * so a machine that gets plugged in shows up in the super admin's Machines
 * screen ready to claim — nobody has to walk over and read the serial off the
 * device menu.
 *
 * Returns the Device document, always. Callers must check `adminId` and
 * `status` before recording attendance.
 */
async function resolveDevice(rawSerial, { touch = true } = {}) {
    const serialNumber = normalizeSerial(rawSerial);
    if (!serialNumber || serialNumber === 'UNKNOWN') return null;

    const hit = cache.get(serialNumber);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        if (touch) markSeen(serialNumber);
        return hit.device;
    }

    let device = await Device.findOne({ serialNumber });

    if (!device) {
        device = await adoptFromLegacyEnv(serialNumber);
    }

    if (!device) {
        // First contact from a machine nobody has registered. Upsert rather
        // than create so two simultaneous pushes can't race into a duplicate
        // key error on the unique serial index.
        device = await Device.findOneAndUpdate(
            { serialNumber },
            {
                $setOnInsert: {
                    serialNumber,
                    adminId: null,
                    status: 'unassigned',
                    autoDiscovered: true,
                },
            },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );
        console.warn(`[devices] new machine seen: SN=${serialNumber} — unassigned, awaiting claim in Machines`);
    }

    cache.set(serialNumber, { device, at: Date.now() });
    if (touch) markSeen(serialNumber);
    return device;
}

/**
 * Record that we heard from a device. Fire-and-forget: a failed telemetry
 * write must never block or fail an actual punch.
 */
function markSeen(serialNumber) {
    Device.updateOne(
        { serialNumber: normalizeSerial(serialNumber) },
        { $set: { lastSeenAt: new Date() } },
    ).catch((err) => console.error('[devices] markSeen failed:', err.message));
}

function markPunch(serialNumber) {
    Device.updateOne(
        { serialNumber: normalizeSerial(serialNumber) },
        { $set: { lastPunchAt: new Date() }, $inc: { punchCount: 1 } },
    ).catch((err) => console.error('[devices] markPunch failed:', err.message));
}

/**
 * Log a punch we could not attribute to a person, so the failure is visible in
 * the UI instead of only in a server log line nobody reads. Keeps the 20 most
 * recent entries.
 */
function recordUnresolved(serialNumber, { pin, reason, deviceTime }) {
    Device.updateOne(
        { serialNumber: normalizeSerial(serialNumber) },
        {
            $push: {
                recentUnresolved: {
                    $each: [{ pin, reason, deviceTime, at: new Date() }],
                    $slice: -20,
                },
            },
        },
    ).catch((err) => console.error('[devices] recordUnresolved failed:', err.message));
}

module.exports = {
    resolveDevice,
    invalidateDeviceCache,
    normalizeSerial,
    markSeen,
    markPunch,
    recordUnresolved,
};
