const mongoose = require('mongoose');

// One row per (employee, physical install). Employees legitimately have more
// than one — a phone plus a tablet, or a replaced handset — so the identity is
// the app-generated `installId`, not the user. A reinstall produces a new
// installId and therefore a new row, which is what makes "who is still on an
// old APK" answerable: the stale row simply stops updating lastSeenAt.
const PERMISSION_STATES = ['granted', 'denied', 'prompt', 'prompt-with-rationale', 'unavailable', 'unknown'];

const permission = () => ({ type: String, enum: PERMISSION_STATES, default: 'unknown' });

const ClientDeviceSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Stable per-install UUID minted by the app on first run and kept in
    // localStorage. Not a device serial — we can't read one without privileged
    // permissions, and don't need to.
    installId: { type: String, required: true },

    // Build identity. `appVersion` is the human version name (e.g. "1.4.2"),
    // `appBuild` the monotonic build/version code used to compare releases.
    appVersion: { type: String, default: null },
    appBuild: { type: String, default: null },

    // 'android' | 'ios' | 'web'. A browser login reports 'web' and has no APK
    // version — those rows are still useful for the session history.
    platform: { type: String, default: null },
    osVersion: { type: String, default: null },
    deviceModel: { type: String, default: null },
    manufacturer: { type: String, default: null },
    // Capacitor's own flag for "running inside the native shell" — the reliable
    // way to tell an installed APK from the same bundle opened in Chrome.
    isNative: { type: Boolean, default: false },

    // Only permissions the app actually declares can ever be read. Anything the
    // build doesn't request stays 'unknown' rather than being reported as denied,
    // so an admin isn't chasing a permission the APK never asked for.
    permissions: {
        location: permission(),
        coarseLocation: permission(),
        camera: permission(),
        notifications: permission(),
    },

    appOpenCount: { type: Number, default: 0 },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

// The upsert key. Unique so a racing double-report (login and resume firing
// together) can't create two rows for one install.
ClientDeviceSchema.index({ adminId: 1, employeeId: 1, installId: 1 }, { unique: true });
// Drives the fleet view: newest reporting installs for a tenant first.
ClientDeviceSchema.index({ adminId: 1, lastSeenAt: -1 });

module.exports = mongoose.model('ClientDevice', ClientDeviceSchema);
module.exports.PERMISSION_STATES = PERMISSION_STATES;
