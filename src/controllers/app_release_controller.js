const mongoose = require('mongoose');
const { isOlderThanApk } = require('../utils/ota_version');
const AppRelease = require('../models/AppRelease');
const OtaCheckin = require('../models/OtaCheckin');
const User = require('../models/User');

const str = (v, max = 40) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, max));

/**
 * Remember what this phone told us on its update check (see models/OtaCheckin).
 * Fire-and-forget: it must never delay or fail the check itself, because the
 * plugin treats a failed check as a reason to retry on every app open.
 */
function recordCheckin(body, offeredVersion) {
    const deviceId = str(body?.device_id, 80);
    if (!deviceId) return;
    const customId = body?.custom_id;
    const set = {
        platform: str(body.platform, 10) || 'android',
        apkVersion: str(body.version_build),
        apkCode: str(body.version_code),
        bundleVersion: str(body.version_name),
        osVersion: str(body.version_os),
        pluginVersion: str(body.plugin_version),
        isEmulator: body.is_emulator === true || body.is_emulator === 'true',
        offeredVersion: offeredVersion || null,
        lastSeenAt: new Date(),
    };
    // Only overwrite the tenant when the phone sends one: before login the
    // custom_id is empty, and that must not erase what an earlier check said.
    if (customId && mongoose.Types.ObjectId.isValid(customId)) set.adminId = new mongoose.Types.ObjectId(customId);
    OtaCheckin.updateOne(
        { deviceId },
        { $set: set, $inc: { checkins: 1 }, $setOnInsert: { firstSeenAt: new Date() } },
        { upsert: true },
    ).catch((e) => console.error('[ota] check-in record failed:', e.message));
}

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
            version_build: apkVersionName,
        } = req.body || {};

        const plat = ['android', 'ios'].includes(platform) ? platform : 'android';
        const note = (offered) => recordCheckin(req.body || {}, offered);

        // Eligibility filters; RECENCY chooses: the newest enabled release this
        // tenant may receive, pilot or production. A pilot that targets this
        // tenant therefore wins while it is the newer build, which is what a
        // staged rollout is.
        //
        // This used to be "pilot first, then production". A tenant that had any
        // enabled pilot then never saw a NEWER production release: piloting one
        // bundle pinned them to it until somebody disabled it by hand
        // (scratch/disable_stale_pilot.js exists for exactly that). getApkRelease
        // below had the same flaw and was fixed the same way.
        const eligible = [{ channel: 'production' }];
        if (customId && mongoose.Types.ObjectId.isValid(customId)) {
            eligible.push({ channel: 'pilot', pilotAdminIds: new mongoose.Types.ObjectId(customId) });
        }
        const release = await AppRelease.findOne({
            enabled: true,
            platform: { $in: [plat, 'any'] },
            $or: eligible,
        }).sort({ createdAt: -1 }).lean();

        if (!release) {
            note(null);
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
            note(null);
            return res.json({ kind: 'up_to_date', message: 'Up to date' });
        }

        // Never offer a bundle older than the APK's own version: a fresh APK reports
        // its own versionName as its bundle version, so without this a new APK was
        // offered last week's bundle and downgraded itself. See utils/ota_version.js.
        if (isOlderThanApk(release.version, apkVersionName)) {
            note(null);
            console.log(
                `[ota] ${plat} device=${String(deviceId || '').slice(0, 8)} apk ${apkVersionName} ` +
                `is newer than release ${release.version} (${release.channel}) -> not offered`
            );
            return res.json({ kind: 'up_to_date', message: 'Up to date' });
        }

        note(release.version);
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
/**
 * GET /api/app/fleet (super admin): the installed apps that checked for
 * updates in the last 30 days, by APK build and by web bundle, with the tenant.
 * Every phone listed can take an OTA bundle; a phone missing from here is on an
 * APK older than the updater (pre-1.2) and needs a new APK installed.
 */
exports.getFleet = async (req, res) => {
    try {
        const days = 30;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const rows = await OtaCheckin.find({ lastSeenAt: { $gte: since }, isEmulator: { $ne: true } })
            .sort({ lastSeenAt: -1 }).limit(2000).lean();

        const latest = await AppRelease.findOne({ channel: 'production', enabled: true })
            .sort({ createdAt: -1 }).select('version').lean();
        const tenantIds = [...new Set(rows.map((r) => r.adminId && String(r.adminId)).filter(Boolean))];
        const tenants = await User.find({ _id: { $in: tenantIds } }).select('name companyName').lean();
        const tenantName = new Map(tenants.map((t) => [String(t._id), t.companyName || t.name || 'Unknown company']));

        const apkLabel = (r) => (r.apkVersion ? `${r.apkVersion}${r.apkCode ? ` (build ${r.apkCode})` : ''}` : 'unknown');
        const bundleLabel = (r) => (!r.bundleVersion || r.bundleVersion === 'builtin' ? 'Built into the APK' : r.bundleVersion);
        const count = (key) => {
            const m = new Map();
            for (const r of rows) { const k = key(r); m.set(k, (m.get(k) || 0) + 1); }
            return [...m].map(([label, devices]) => ({ label, devices })).sort((a, b) => b.devices - a.devices);
        };

        res.json({
            windowDays: days,
            total: rows.length,
            latestBundle: latest?.version || null,
            onLatestBundle: latest ? rows.filter((r) => r.bundleVersion === latest.version).length : null,
            byApk: count(apkLabel),
            byBundle: count(bundleLabel),
            devices: rows.slice(0, 300).map((r) => ({
                company: r.adminId ? (tenantName.get(String(r.adminId)) || 'Unknown company') : 'Not logged in yet',
                apk: apkLabel(r),
                bundle: bundleLabel(r),
                android: r.osVersion,
                lastSeenAt: r.lastSeenAt,
                firstSeenAt: r.firstSeenAt,
            })),
        });
    } catch (error) {
        console.error('[ota] fleet failed:', error);
        res.status(500).json({ message: 'Could not load the fleet. Please try again.' });
    }
};

exports.listReleases = async (req, res) => {
    try {
        const releases = await AppRelease.find({})
            .populate('pilotAdminIds', 'name companyName')
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
        res.json(releases);
    } catch (error) {
        console.error('[ota] list releases failed:', error);
        res.status(500).json({ message: 'Could not load the web bundles. Please try again.' });
    }
};

/**
 * PUT /api/app/releases/:id — flip `enabled`, or promote pilot → production.
 * The instant kill switch for a bad bundle: disabling it makes the next check
 * fall back to the previous enabled release.
 */
const isObjectId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);

/**
 * pilotAdminIds from a request: every entry must be an existing company
 * (tenant admin). A typo would otherwise be stored as an id that matches no
 * phone, and the pilot would silently reach nobody.
 */
async function readPilotIds(raw) {
    if (!Array.isArray(raw)) return { error: 'pilotAdminIds must be a list of company ids.' };
    const ids = [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
    if (ids.length > 50) return { error: 'A pilot can name at most 50 companies.' };
    if (ids.some((id) => !isObjectId(id))) return { error: 'One of the pilot company ids is not valid.' };
    const found = await User.countDocuments({ _id: { $in: ids }, role: 'admin' });
    if (found !== ids.length) return { error: 'One of the pilot companies does not exist.' };
    return { ids };
}

exports.updateRelease = async (req, res) => {
    try {
        if (!isObjectId(String(req.params.id))) return res.status(404).json({ message: 'Release not found.' });
        const existing = await AppRelease.findById(req.params.id);
        if (!existing) return res.status(404).json({ message: 'Release not found.' });

        const { enabled, channel, pilotAdminIds, notes } = req.body || {};
        if (enabled !== undefined && typeof enabled !== 'boolean') {
            return res.status(400).json({ message: 'enabled must be true or false.' });
        }
        if (channel !== undefined && !['production', 'pilot'].includes(channel)) {
            return res.status(400).json({ message: 'Audience must be production or pilot.' });
        }
        if (notes !== undefined && typeof notes !== 'string') {
            return res.status(400).json({ message: 'Notes must be text.' });
        }

        if (enabled !== undefined) existing.enabled = enabled;
        if (channel !== undefined) existing.channel = channel;
        if (pilotAdminIds !== undefined) {
            const pilot = await readPilotIds(pilotAdminIds);
            if (pilot.error) return res.status(400).json({ message: pilot.error });
            existing.pilotAdminIds = pilot.ids;
        }
        // Promoted to everyone: a leftover pilot list would only mislead.
        if (existing.channel === 'production') existing.pilotAdminIds = [];
        if (notes !== undefined) existing.notes = notes.trim().slice(0, 500);

        if (existing.enabled && existing.channel === 'pilot' && existing.pilotAdminIds.length === 0) {
            return res.status(400).json({ message: 'A pilot release must name at least one company before it can be live.' });
        }

        await existing.save();
        const release = await AppRelease.findById(existing._id).populate('pilotAdminIds', 'name companyName').lean();
        res.json(release);
    } catch (error) {
        console.error('[ota] update release failed:', error);
        res.status(500).json({ message: 'Could not change the release. Please try again.' });
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
        if (versionName.length > 40 || !/^[\w.+-]+$/.test(versionName)) {
            cleanup();
            return res.status(400).json({ message: 'Version name can use letters, digits, dots and dashes, up to 40 characters.' });
        }
        if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) {
            cleanup();
            return res.status(400).json({ message: 'versionCode must be a positive whole number' });
        }
        if (req.body.notes !== undefined && typeof req.body.notes !== 'string') {
            cleanup();
            return res.status(400).json({ message: 'Notes must be text.' });
        }

        // Pilot companies are checked BEFORE anything is stored. They used to be
        // filtered silently, so one mistyped id turned a pilot into an empty
        // list -- and an empty list meant channel 'production': a build meant
        // for one company went to every phone.
        const pilotRaw = String(req.body.pilotAdminIds || '').split(',').map((v) => v.trim()).filter(Boolean);
        let pilotAdminIds = [];
        if (pilotRaw.length) {
            const pilot = await readPilotIds(pilotRaw);
            if (pilot.error) { cleanup(); return res.status(400).json({ message: pilot.error }); }
            pilotAdminIds = pilot.ids;
        }

        // An APK is a zip. Anything else would be offered to every phone and
        // then fail to install on each of them.
        const head = Buffer.alloc(4);
        const fd = fs.openSync(req.file.path, 'r');
        try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
        if (head.readUInt32LE(0) !== 0x04034b50) {
            cleanup();
            return res.status(400).json({ message: 'That file is not an Android app (.apk).' });
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
        console.error('[apk] publish failed:', error);
        if (error?.name === 'ValidationError') {
            const first = Object.values(error.errors || {})[0];
            return res.status(409).json({ message: first?.message || 'That APK could not be saved.' });
        }
        res.status(500).json({ message: 'Could not publish the APK. Please try again.' });
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
        console.error('[apk] list failed:', error);
        res.status(500).json({ message: 'Could not load the APKs. Please try again.' });
    }
};

/** PUT /api/app/apks/:id — the kill switch, and the mandatory flag. */
exports.updateApk = async (req, res) => {
    try {
        if (!isObjectId(String(req.params.id))) return res.status(404).json({ message: 'APK release not found.' });
        const body = req.body || {};
        for (const k of ['enabled', 'mandatory']) {
            if (body[k] !== undefined && typeof body[k] !== 'boolean') {
                return res.status(400).json({ message: `${k} must be true or false.` });
            }
        }
        if (body.notes !== undefined && typeof body.notes !== 'string') {
            return res.status(400).json({ message: 'Notes must be text.' });
        }
        // Only a promotion to everyone is offered; narrowing an APK back to a
        // pilot is a new upload.
        if (body.channel !== undefined && body.channel !== 'production') {
            return res.status(400).json({ message: 'An APK can only be moved to everyone (production).' });
        }

        const patch = {};
        if (body.enabled !== undefined) patch.enabled = body.enabled;
        if (body.mandatory !== undefined) patch.mandatory = body.mandatory;
        if (body.notes !== undefined) patch.notes = body.notes.trim().slice(0, 500);
        if (body.channel === 'production') { patch.channel = 'production'; patch.pilotAdminIds = []; }

        const release = await ApkRelease.findByIdAndUpdate(req.params.id, patch, { new: true })
            .populate('pilotAdminIds', 'name companyName').lean();
        if (!release) return res.status(404).json({ message: 'APK release not found.' });
        res.json(release);
    } catch (error) {
        console.error('[apk] update failed:', error);
        res.status(500).json({ message: 'Could not change the APK. Please try again.' });
    }
};
