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
            return res.json({ message: 'No release configured' });
        }

        // Already running it. Returning the same version would be harmless —
        // the plugin de-duplicates — but answering plainly keeps the device
        // from re-downloading several megabytes on every app open.
        if (versionName && versionName === release.version) {
            return res.json({ message: 'Up to date' });
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
