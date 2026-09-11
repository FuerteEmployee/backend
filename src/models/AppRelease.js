const mongoose = require('mongoose');

// A published web bundle that installed apps can download over the air.
//
// Capacitor apps are a web bundle running in a WebView, so replacing that
// bundle replaces the entire UI and most logic without anyone reinstalling.
// Only the *web* layer can be shipped this way — new native plugins, Android
// permissions, or a Capacitor version bump still require a real APK.
//
// Self-hosted deliberately: the @capgo/capacitor-updater plugin is open source
// and the hosted service exists mainly to provide a CDN, rollout channels and
// statistics. We already serve from our own Nginx, the update check hits our
// own authenticated-ish endpoint (so channels are just a query), and app
// version telemetry already lives in ClientDevice — so the hosted tier would
// be paying for three things we have.
const AppReleaseSchema = new mongoose.Schema({
    // Bundle version, e.g. "1.4.3". This is what the plugin compares against
    // the version currently running on the device, so it must increase.
    version: { type: String, required: true, trim: true },

    // Absolute URL of the zip. Absolute rather than a path because the device
    // fetches it directly and may not share our origin assumptions.
    url: { type: String, required: true, trim: true },

    // SHA-256 of the zip. The plugin verifies it before swapping the bundle,
    // which is the only thing standing between a corrupted or tampered
    // download and executing it as application code.
    checksum: { type: String, default: null },

    // 'production' reaches everyone. 'pilot' reaches only the tenants listed
    // in pilotAdminIds — a staged rollout. Normally a paid cloud feature;
    // trivial here because the update check reaches our own backend, which
    // knows which tenant is asking (the app sets custom_id after login).
    channel: { type: String, enum: ['production', 'pilot'], default: 'pilot', index: true },
    pilotAdminIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // Lets a bad release be pulled instantly without deleting the record —
    // devices fall back to the previous enabled release on their next check.
    enabled: { type: Boolean, default: true, index: true },

    platform: { type: String, enum: ['android', 'ios', 'any'], default: 'android' },
    notes: { type: String, default: '' },
    sizeBytes: { type: Number, default: null },
    publishedBy: { type: String, default: null },
}, { timestamps: true });

AppReleaseSchema.index({ channel: 1, enabled: 1, createdAt: -1 });

module.exports = mongoose.model('AppRelease', AppReleaseSchema);
