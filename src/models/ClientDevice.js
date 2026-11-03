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

        // ── Background-tracking readiness ───────────────────────────────────
        // Every one of these must hold or location stops the moment the screen
        // locks -- which is exactly when it is needed. They are stored
        // separately because each has a DIFFERENT fix, and an admin answering
        // "my BOT isn't working" needs to know which screen to send the
        // employee to, not merely that something is wrong.

        // "Allow all the time" rather than "While using the app". Without it
        // Android revokes location seconds after the screen goes off.
        backgroundLocation: permission(),
        // Android 12+ lets a user grant location as "Approximate", which
        // reports as GRANTED while returning kilometre-fuzzed coordinates. A
        // geofence built on that is meaningless, so it is tracked apart from
        // the plain grant.
        preciseLocation: permission(),
        // Battery optimisation exemption. With it on, the OS freezes the
        // service after a few minutes of screen-off.
        batteryUnrestricted: permission(),
        // OEM auto-start whitelist (MIUI, ColorOS, Funtouch, One UI). No public
        // API can READ this, so a 'granted' here is normally the EMPLOYEE'S OWN
        // CLAIM after being sent to the settings screen -- UNLESS
        // autoStartProven below is also set, which is the one case where it was
        // actually observed.
        autoStart: permission(),
    },

    // Auto-start was not claimed but DEMONSTRATED: the app resumed tracking by
    // itself after a device reboot, which only an auto-start whitelisting could
    // have allowed. Latched, because a device that has done it once has the
    // permission, and a phone that simply has not rebooted since is not
    // evidence that it lost it.
    autoStartProven: { type: Boolean, default: false },

    // True once the employee completed the first-run setup gate with every
    // required item satisfied. Stored rather than derived so support can see
    // that setup was finished at some point even if a permission has since been
    // revoked -- "never set up" and "set up then broken" need different help.
    trackingSetupComplete: { type: Boolean, default: false },
    trackingSetupCompletedAt: { type: Date, default: null },
    // Phone maker, so support can name the right OEM screen without asking.
    oemHint: { type: String, default: null },

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
