const mongoose = require('mongoose');

// A published Android APK that employees can download from inside the app.
//
// Deliberately NOT the same collection as AppRelease. That one is a web bundle:
// swapped silently by Capgo, no reinstall, no user action. This is a real
// package install — a different artifact, a different delivery path, and a
// different question ("which build is on the phone", not "which bundle is in
// the WebView"). One row meaning both would make "what does this employee
// actually need" unanswerable, which is precisely the state this exists to fix:
// one employee is still on 1.2 while the current build is 1.8, and nothing in
// the product ever told them.
const ApkReleaseSchema = new mongoose.Schema({
    // Human-facing, e.g. "1.9". Shown in the prompt; never compared, because
    // string ordering puts "1.10" before "1.9".
    versionName: { type: String, required: true, trim: true },

    // THE comparison key. Android's own monotonic integer, and the only value
    // that orders builds correctly. Everything that decides whether somebody is
    // out of date -- including whether they are blocked from punching -- reads
    // this and nothing else.
    versionCode: { type: Number, required: true, index: true },

    // Absolute URL of the .apk, served by /apks. Absolute because the device
    // fetches it directly, often from the system browser rather than the app.
    url: { type: String, required: true, trim: true },

    // SHA-256 of the file as uploaded. Android verifies the signature at
    // install time, so this is not a security control -- it is how we prove the
    // bytes on the server are the bytes that were built, when a download fails
    // to install and nobody can say why.
    checksum: { type: String, default: null },

    // Same staged-rollout semantics as AppRelease: 'pilot' reaches only the
    // listed tenants, 'production' reaches everyone.
    channel: { type: String, enum: ['production', 'pilot'], default: 'pilot', index: true },
    pilotAdminIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // Blocks PUNCHING on any device running an older versionCode. Reserved for
    // builds that fix something which makes attendance itself untrustworthy --
    // it costs an employee the ability to record their day, so it is not the
    // setting for "please update".
    //
    // It never blocks the rest of the app. Somebody who cannot download right
    // now must still be able to see their own attendance, leave and payslips.
    mandatory: { type: Boolean, default: false },

    // The kill switch. Devices stop being offered this build immediately and
    // fall back to the previous enabled one, without losing the record.
    enabled: { type: Boolean, default: true, index: true },

    platform: { type: String, enum: ['android'], default: 'android' },
    notes: { type: String, default: '' },
    sizeBytes: { type: Number, default: null },
    fileName: { type: String, default: null },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// Newest-first within a channel is the only read this collection serves.
ApkReleaseSchema.index({ channel: 1, enabled: 1, versionCode: -1 });

module.exports = mongoose.model('ApkRelease', ApkReleaseSchema);
