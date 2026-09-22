const mongoose = require('mongoose');
const AppRelease = require('../models/AppRelease');

// Over-the-air update check for the Capacitor app.
//
// The @capgo/capacitor-updater plugin POSTs here every time the app opens and
// expects either { version, url, checksum } to download a new bundle, or a
// { message } to stand pat. See:
// https://capgo.app/docs/plugins/updater/self-hosted/auto-update/

/**
 * POST /api/app/update
 *
 * Deliberately UNAUTHENTICATED. The plugin fires this before anyone has logged
 * in — it is the mechanism that would deliver a fix for a build too broken to
 * reach the login screen, so gating it on a session would defeat the point.
 * That is acceptable because the only thing it discloses is the current bundle
 * version and its URL, and the bundle is the same public JavaScript already
 * served from the web app.
 *
 * Tenant targeting still works: the app calls setCustomId(adminId) after login,
 * so `custom_id` arrives on subsequent checks and a pilot release can be scoped
 * to specific companies.
 */
exports.checkForUpdate = async (req, res) => {
    try {
        const {
            platform,
            version_name: versionName,
            custom_id: customId,
            device_id: deviceId,
            is_emulator: isEmulator,
        } = req.body || {};

        const plat = ['android', 'ios'].includes(platform) ? platform : 'android';

        // A pilot release wins for the tenants it targets — that is the staged
        // rollout. Everyone else gets production.
        let release = null;
        if (customId && mongoose.Types.ObjectId.isValid(customId)) {
            release = await AppRelease.findOne({
                channel: 'pilot',
                enabled: true,
                platform: { $in: [plat, 'any'] },
                pilotAdminIds: new mongoose.Types.ObjectId(customId),
            }).sort({ createdAt: -1 }).lean();
        }

        if (!release) {
            release = await AppRelease.findOne({
                channel: 'production',
                enabled: true,
                platform: { $in: [plat, 'any'] },
            }).sort({ createdAt: -1 }).lean();
        }

        if (!release) {
            // `kind` matters, not just `message`. The Capgo plugin rejects a
            // bare {message} response (CapacitorUpdaterPlugin.java ~4140) — so
            // "there is no update" reached the app as a FAILED call, and the
            // in-app checker rendered a red error box reading "Up to date".
            // With a recognised kind the plugin resolves instead.
            return res.json({ kind: 'up_to_date', message: 'No release configured' });
        }

        // Already running it. Returning the same version would be harmless —
        // the plugin de-duplicates — but answering plainly keeps the device
        // from re-downloading several megabytes on every app open.
        if (versionName && versionName === release.version) {
            return res.json({ kind: 'up_to_date', message: 'Up to date' });
        }

        console.log(
            `[ota] ${plat} device=${String(deviceId || '').slice(0, 8)} ` +
            `on ${versionName || 'unknown'} → offering ${release.version} (${release.channel})` +
            (isEmulator ? ' [emulator]' : '')
        );

        return res.json({
            version: release.version,
            url: release.url,
            ...(release.checksum ? { checksum: release.checksum } : {}),
            // `comment` is the field the Capgo plugin surfaces on its
            // LatestVersion result, so release notes reach the in-app update
            // prompt without inventing a parallel endpoint for them. An update
            // dialog that cannot say what changed trains people to dismiss it.
            ...(release.notes ? { comment: release.notes } : {}),
            ...(release.sizeBytes ? { sizeBytes: release.sizeBytes } : {}),
        });
    } catch (error) {
        // Never 500 at the device: the plugin treats a failed check as a reason
        // to retry, and a noisy error loop on every app open across every
        // handset is worse than quietly serving no update this time.
        console.error('[ota] update check failed:', error.message);
        return res.json({ message: 'Update check unavailable' });
    }
};

/**
 * GET /api/app/releases  — admin visibility into what is published to whom.
 */
exports.listReleases = async (req, res) => {
    try {
        const releases = await AppRelease.find({})
            .populate('pilotAdminIds', 'name companyName')
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
        res.json(releases);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * PUT /api/app/releases/:id — flip `enabled`, or promote pilot → production.
 * The instant kill switch for a bad bundle: disabling it makes the next check
 * fall back to the previous enabled release.
 */
exports.updateRelease = async (req, res) => {
    try {
        const { enabled, channel, pilotAdminIds, notes } = req.body;
        const update = {};
        if (enabled !== undefined) update.enabled = !!enabled;
        if (channel && ['production', 'pilot'].includes(channel)) update.channel = channel;
        if (Array.isArray(pilotAdminIds)) update.pilotAdminIds = pilotAdminIds;
        if (notes !== undefined) update.notes = String(notes).slice(0, 500);

        const release = await AppRelease.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
        if (!release) return res.status(404).json({ message: 'Release not found' });
        res.json(release);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  APK releases
//
//  The other half of shipping this app. AppRelease above replaces the web
//  bundle silently; none of it can deliver a native change -- a new permission,
//  a plugin, a foreground-service fix. Those need a real package install, and
//  until now that meant somebody carrying a file to a phone. The measurable
//  cost of that: one employee is still on build 1.2 and reports no diagnostics
//  at all, four builds after the one that added them.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ApkRelease = require('../models/ApkRelease');

const APK_DIR = path.join(__dirname, '..', '..', 'apks');

/**
 * Move an uploaded file into place, across filesystems if need be.
 *
 * `fs.renameSync` cannot cross a filesystem boundary: it fails with EXDEV. The
 * upload lands in the OS temp directory deliberately -- a half-written or
 * rejected APK must never be reachable at /apks -- and whether that is the same
 * volume as the serving directory is an accident of where the app happens to be
 * installed. On the Linux server both sit on one disk and the rename succeeds,
 * which is why this held for so long. On a Windows workstation the temp dir is
 * on C: and the checkout is on D:, so every upload failed with:
 *
 *   EXDEV: cross-device link not permitted, rename
 *   'C:\Users\...\Temp\bot-apk-uploads\7a163bbc...'
 *   -> 'D:\...\backend\apks\bot-1.9-staging-10.apk'
 *
 * Copy-then-delete is the portable fallback. It runs only when the cheap rename
 * is genuinely impossible, so the server path keeps its single atomic operation
 * and pays nothing for this.
 *
 * The source is removed only after the copy succeeds. If that delete then
 * fails, the file is already safely in place and a stray temp file is rubbish
 * the OS clears up -- not a lost upload.
 */
function moveInto(from, to) {
    try {
        fs.renameSync(from, to);
        return;
    } catch (err) {
        if (err.code !== 'EXDEV') throw err;
    }
    fs.copyFileSync(from, to);
    try { fs.unlinkSync(from); } catch { /* best effort -- the copy is what matters */ }
}
const BASE_URL = (process.env.BASE_URL || 'https://api.beontimeofficial.com').replace(/\/$/, '');

/**
 * GET /api/app/apk-release?custom_id=<adminId>
 *
 * Unauthenticated, for the same reason /update is: the build most in need of
 * replacing is the one that cannot reach the login screen. It discloses a
 * version number and a download URL for an APK that is signed anyway.
 */
exports.getApkRelease = async (req, res) => {
    try {
        const customId = req.query.custom_id || req.body?.custom_id;

        // Eligibility filters; RECENCY chooses. One query over everything this
        // tenant may receive, newest versionCode wins.
        //
        // Not "pilot first, then production", which is the obvious shape and is
        // wrong: a tenant with any pilot release would match on that branch and
        // never see a NEWER general release, so piloting one build silently
        // pinned them to it forever. That is not hypothetical — the bundle path
        // has the same flaw, and scratch/disable_stale_pilot.js exists solely to
        // hand-disable a stale pilot that was holding tenants on an older
        // bundle. Here it meant a device on code 8, with code 9 published, was
        // told it was up to date.
        //
        // A pilot build should win only when it is actually ahead, which is
        // what piloting means.
        const eligible = [{ channel: 'production' }];
        if (customId && mongoose.Types.ObjectId.isValid(customId)) {
            eligible.push({
                channel: 'pilot',
                pilotAdminIds: new mongoose.Types.ObjectId(customId),
            });
        }

        const release = await ApkRelease.findOne({
            enabled: true,
            platform: 'android',
            $or: eligible,
        }).sort({ versionCode: -1 }).lean();

        if (!release) return res.json({ kind: 'up_to_date', message: 'No APK published' });

        res.json({
            versionName: release.versionName,
            versionCode: release.versionCode,
            url: release.url,
            sizeBytes: release.sizeBytes,
            mandatory: release.mandatory === true,
            notes: release.notes || '',
            checksum: release.checksum,
        });
    } catch (error) {
        // Never 500 a client that is only asking whether it is out of date: the
        // app treats a failed check as "try again later", and an error here
        // would surface as a scary banner about something the employee cannot
        // act on.
        res.json({ kind: 'up_to_date', message: error.message });
    }
};

/** POST /api/app/apk — multipart upload, super admin only. */
exports.publishApk = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No .apk file was uploaded' });

        const versionName = String(req.body.versionName || '').trim();
        const versionCode = Number(req.body.versionCode);

        const cleanup = () => { try { fs.unlinkSync(req.file.path); } catch { /* best effort */ } };

        if (!versionName) { cleanup(); return res.status(400).json({ message: 'versionName is required' }); }
        if (!Number.isInteger(versionCode) || versionCode < 1) {
            cleanup();
            return res.status(400).json({ message: 'versionCode must be a positive whole number' });
        }
        // The versionCode is what every out-of-date decision is made on, so a
        // duplicate would make two different builds indistinguishable to every
        // device -- including for the mandatory block.
        if (await ApkRelease.findOne({ versionCode })) {
            cleanup();
            return res.status(409).json({ message: `versionCode ${versionCode} has already been published.` });
        }

        const buf = fs.readFileSync(req.file.path);
        const checksum = crypto.createHash('sha256').update(buf).digest('hex');

        // Name the stored file by versionCode, not by whatever the uploader's
        // file was called: the URL is cached immutably for a year, so it must
        // be unique per build and must never be reused.
        const fileName = `bot-${versionName.replace(/[^\w.-]/g, '')}-${versionCode}.apk`;
        fs.mkdirSync(APK_DIR, { recursive: true });
        moveInto(req.file.path, path.join(APK_DIR, fileName));

        const pilotAdminIds = String(req.body.pilotAdminIds || '')
            .split(',').map((s) => s.trim())
            .filter((s) => mongoose.Types.ObjectId.isValid(s));

        const release = await ApkRelease.create({
            versionName,
            versionCode,
            url: `${BASE_URL}/apks/${fileName}`,
            checksum,
            sizeBytes: buf.length,
            fileName,
            mandatory: req.body.mandatory === 'true' || req.body.mandatory === true,
            channel: pilotAdminIds.length ? 'pilot' : 'production',
            pilotAdminIds,
            notes: String(req.body.notes || '').slice(0, 500),
            uploadedBy: req.userId || null,
        });

        res.status(201).json(release);
    } catch (error) {
        try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch { /* best effort */ }
        res.status(500).json({ message: error.message });
    }
};

/** GET /api/app/apks — operator list. */
exports.listApks = async (req, res) => {
    try {
        const rows = await ApkRelease.find({})
            .sort({ versionCode: -1 })
            .limit(50)
            .populate('pilotAdminIds', 'name companyName')
            .lean();
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/** PUT /api/app/apks/:id — the kill switch, and the mandatory flag. */
exports.updateApk = async (req, res) => {
    try {
        const patch = {};
        if (req.body.enabled !== undefined) patch.enabled = !!req.body.enabled;
        if (req.body.mandatory !== undefined) patch.mandatory = !!req.body.mandatory;
        if (req.body.notes !== undefined) patch.notes = String(req.body.notes).slice(0, 500);
        if (req.body.channel === 'production') { patch.channel = 'production'; patch.pilotAdminIds = []; }

        const release = await ApkRelease.findByIdAndUpdate(req.params.id, patch, { new: true });
        if (!release) return res.status(404).json({ message: 'APK release not found' });
        res.json(release);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};
