const mongoose = require('mongoose');

/**
 * One row per installed app that asks the OTA endpoint for updates.
 *
 * The Capgo updater's native code calls POST /api/app/update on every app
 * start and reports the APK build, the web bundle it is running, the Android
 * version and (after login) the tenant. That is the only fleet signal that
 * needs no new code on the phone: ClientDevice telemetry only exists on a
 * bundle that contains the reporting code, while this works for every APK that
 * can take OTA at all (1.2 / versionCode 3, 2026-09-11, onward). It answers
 * "which phones are still on an old build" and "did the new bundle arrive".
 *
 * A phone that never appears here is on an APK older than the updater and can
 * only be fixed by installing a new APK.
 */
const OtaCheckinSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },
    // Tenant, from the updater's custom_id (set after login). Null until then.
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    platform: { type: String, default: 'android' },
    apkVersion: { type: String, default: null },    // version_build (APK versionName)
    apkCode: { type: String, default: null },       // version_code (APK versionCode)
    bundleVersion: { type: String, default: null }, // version_name (web bundle running now)
    osVersion: { type: String, default: null },
    pluginVersion: { type: String, default: null },
    isEmulator: { type: Boolean, default: false },
    offeredVersion: { type: String, default: null }, // what we offered on the last check, if anything
    checkins: { type: Number, default: 0 },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now }, // indexed by the TTL index below
}, { timestamps: false });

// Phones not seen for 180 days are gone (uninstalled or replaced).
OtaCheckinSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60, name: 'lastSeenAt_ttl' });

module.exports = mongoose.model('OtaCheckin', OtaCheckinSchema);
