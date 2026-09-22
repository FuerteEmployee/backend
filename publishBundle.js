#!/usr/bin/env node
/**
 * Publish a web bundle for over-the-air delivery to installed apps.
 *
 *   node publishBundle.js <version> [--production] [--pilot <adminId>,<adminId>]
 *
 *   node publishBundle.js 1.4.3 --pilot 66f0a1...       # one tenant only
 *   node publishBundle.js 1.4.3 --production            # everyone
 *
 * Zips the frontend's built `dist/`, computes its SHA-256, copies it into
 * backend/bundles/, and records an AppRelease row. Devices pick it up on their
 * next app open via POST /api/app/update.
 *
 * Only ships the WEB layer. New native plugins, Android permissions or a
 * Capacitor upgrade still need a real APK — see CLAUDE.md.
 */
require('dotenv').config();
// Atlas SRV lookups fail on some hosts' resolvers -- src/index.js pins these
// before anything else for exactly this reason, and this script needs the same
// treatment because it dials Atlas directly rather than through the server.
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const mongoose = require('mongoose');
const AppRelease = require('./src/models/AppRelease');

// The frontend checkout is named differently on the dev machine
// (botcrm-frontend-) than on the server (~/frontend), so resolve rather than
// assume — otherwise this only works in one of the two places it has to run.
// FRONTEND_DIST overrides for any other layout.
const DIST_CANDIDATES = [
    process.env.FRONTEND_DIST,
    path.resolve(__dirname, '..', 'frontend', 'dist'),
    path.resolve(__dirname, '..', 'botcrm-frontend-', 'dist'),
].filter(Boolean);

const DIST = DIST_CANDIDATES.find((p) => fs.existsSync(path.join(p, 'index.html')))
    || DIST_CANDIDATES[DIST_CANDIDATES.length - 1];

const BUNDLES = path.join(__dirname, 'bundles');
const BASE_URL = process.env.BASE_URL || 'https://api.beontimeofficial.com';

function fail(msg) {
    console.error(`\n✗ ${msg}\n`);
    process.exit(1);
}

/**
 * Rewrite `\` to `/` in the zip's stored file NAMES.
 *
 * PowerShell 5.1's Compress-Archive writes Windows path separators into entry
 * names, which the ZIP spec (APPNOTE 4.4.17.1) forbids -- names must always use
 * forward slashes. Android's unzip is a strict reader: it treats
 * "assets\index-abc.js" as one flat filename, so no assets/ directory is ever
 * created. index.html then 404s on its own script, the bundle never boots,
 * notifyAppReady() never fires, the plugin rolls back on appReadyTimeout, and
 * the device downloads the same broken 1.6 MB again on its next check --
 * forever, on mobile data.
 *
 * That is exactly what bundle-1.2.2 did in the field.
 *
 * Rewriting is safe in place: '\' and '/' are both one byte, so every offset,
 * length and the CRC over the file DATA are unaffected. Only the two places a
 * name is stored are touched -- the local header and the central directory --
 * never the compressed data, where 0x5C is just an ordinary byte.
 */
function normalizeZipSeparators(zipPath) {
    const buf = fs.readFileSync(zipPath);
    let renamed = 0;

    const rewrite = (nameStart, nameLen) => {
        let touched = false;
        for (let i = nameStart; i < nameStart + nameLen; i++) {
            if (buf[i] === 0x5c) { buf[i] = 0x2f; touched = true; }
        }
        if (touched) renamed++;
    };

    for (let i = 0; i + 4 <= buf.length; i++) {
        const sig = buf.readUInt32LE(i);
        if (sig === 0x04034b50) {          // local file header
            rewrite(i + 30, buf.readUInt16LE(i + 26));
        } else if (sig === 0x02014b50) {   // central directory header
            rewrite(i + 46, buf.readUInt16LE(i + 28));
        }
    }

    if (renamed > 0) {
        fs.writeFileSync(zipPath, buf);
        console.log(`  normalised ${renamed} entry name(s) to forward slashes`);
    }
}

/**
 * Refuse to publish a bundle that cannot work on a device.
 *
 * A bad bundle is not cheap to discover in the field: it reaches every phone,
 * fails to boot, and each one re-downloads it on a loop until it is pulled.
 * These two checks are the ones that would have caught 1.2.2 before it shipped.
 */
function verifyBundle(zipPath) {
    const buf = fs.readFileSync(zipPath);
    const names = [];
    for (let i = 0; i + 4 <= buf.length; i++) {
        if (buf.readUInt32LE(i) === 0x02014b50) {
            const len = buf.readUInt16LE(i + 28);
            names.push(buf.slice(i + 46, i + 46 + len).toString('utf8'));
        }
    }

    if (names.length === 0) fail('The zip has no central directory — it is not a readable archive.');

    const bad = names.filter((n) => n.includes('\\'));
    if (bad.length) {
        fail(`${bad.length} entr${bad.length === 1 ? 'y uses' : 'ies use'} backslash separators, which Android cannot unpack:\n` +
             bad.slice(0, 5).map((n) => `    ${n}`).join('\n'));
    }

    // The WebView loads index.html from the bundle root. A nested dist/ folder
    // makes it load nothing, and every device that took it would roll back.
    if (!names.includes('index.html')) {
        fail('index.html is not at the root of the zip — the WebView would have nothing to load.\n' +
             `  Found instead: ${names.slice(0, 5).join(', ')}`);
    }

    console.log(`  verified ${names.length} entries, index.html at root, no backslash paths`);
}

function parseArgs(argv) {
    const version = argv[2];
    if (!version || version.startsWith('--')) {
        fail('Usage: node publishBundle.js <version> [--production] [--pilot <adminId,adminId>] [--notes "what changed"]');
    }
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        fail(`Version must look like 1.4.3 — got "${version}". The plugin compares these to decide whether to update.`);
    }
    // Release notes. Shown verbatim in the in-app update prompt, so write them
    // for the employee reading the popup, not for the changelog.
    const notesIdx = argv.indexOf('--notes');
    const notes = notesIdx !== -1 && argv[notesIdx + 1] && !argv[notesIdx + 1].startsWith('--')
        ? String(argv[notesIdx + 1]).slice(0, 500)
        : '';

    const production = argv.includes('--production');
    const pilotIdx = argv.indexOf('--pilot');
    const pilotAdminIds = pilotIdx !== -1 && argv[pilotIdx + 1]
        ? argv[pilotIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
        : [];

    if (!production && pilotAdminIds.length === 0) {
        fail('Choose an audience: --production (everyone) or --pilot <adminId,...> (specific tenants).\n' +
             '  Start with --pilot. A bad bundle reaching every phone is the failure mode worth avoiding.');
    }
    return { version, production, pilotAdminIds, notes };
}

(async () => {
    const { version, production, pilotAdminIds, notes } = parseArgs(process.argv);

    if (!fs.existsSync(DIST)) {
        fail(`No build found. Looked in:\n${DIST_CANDIDATES.map((p) => `    ${p}`).join('\n')}\n` +
             `  Run "npm run build" in the frontend first, or set FRONTEND_DIST.`);
    }
    // index.html is what the WebView loads; a dist without it is a broken build
    // and would brick every device that downloaded it.
    if (!fs.existsSync(path.join(DIST, 'index.html'))) {
        fail(`${DIST} has no index.html — that build is not usable as a bundle.`);
    }

    fs.mkdirSync(BUNDLES, { recursive: true });
    const zipName = `bundle-${version}.zip`;
    const zipPath = path.join(BUNDLES, zipName);

    if (fs.existsSync(zipPath)) {
        fail(`${zipName} already exists. Bump the version — bundles are immutable once published.`);
    }

    console.log(`\nzipping ${DIST}`);
    // Publishing happens from a Windows dev machine AND from the Ubuntu server,
    // so use whichever archiver that platform actually has rather than adding a
    // dependency. Either way the zip must contain dist's CONTENTS at the root
    // (index.html at top level) — a nested dist/ folder makes the WebView load
    // nothing and every device that took it would roll back.
    try {
        if (process.platform === 'win32') {
            execFileSync('powershell', [
                '-NoProfile', '-Command',
                `Compress-Archive -Path '${path.join(DIST, '*')}' -DestinationPath '${zipPath}' -Force`,
            ], { stdio: 'inherit' });
        } else {
            // -r recurse, -q quiet, . = contents of cwd, so paths stay relative
            execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: DIST, stdio: 'inherit' });
        }
    } catch (err) {
        if (err.code === 'ENOENT' && process.platform !== 'win32') {
            fail('The "zip" command is not installed. On the server: sudo apt install zip');
        }
        fail(`Zip failed: ${err.message}`);
    }

    normalizeZipSeparators(zipPath);
    verifyBundle(zipPath);

    const buf = fs.readFileSync(zipPath);
    const checksum = crypto.createHash('sha256').update(buf).digest('hex');
    const sizeMb = (buf.length / 1024 / 1024).toFixed(2);
    console.log(`  ${zipName}  ${sizeMb} MB`);
    console.log(`  sha256 ${checksum}`);

    if (!process.env.MONGO_URI) fail('MONGO_URI is not set — cannot record the release.');
    await mongoose.connect(process.env.MONGO_URI);

    const existing = await AppRelease.findOne({ version });
    if (existing) {
        await mongoose.disconnect();
        fail(`Release ${version} already exists in the database. Bump the version.`);
    }

    const release = await AppRelease.create({
        version,
        url: `${BASE_URL.replace(/\/$/, '')}/bundles/${zipName}`,
        checksum,
        channel: production ? 'production' : 'pilot',
        pilotAdminIds,
        platform: 'android',
        sizeBytes: buf.length,
        notes,
        publishedBy: 'publishBundle.js',
    });

    console.log(`\n✓ published ${version} → ${release.channel}`);
    if (!notes) {
        console.log('  (no --notes given — the in-app prompt will show a generic message)');
    }
    console.log(`  ${release.url}`);
    if (!production) console.log(`  targeted at ${pilotAdminIds.length} tenant(s): ${pilotAdminIds.join(', ')}`);
    console.log('\n  Devices pick this up on their next app open.');
    console.log('  To pull it back:  set enabled=false via PUT /api/app/releases/:id');
    console.log(`  id: ${release._id}\n`);

    await mongoose.disconnect();
})().catch(async (err) => {
    console.error('\n✗ publish failed:', err.message);
    try { await mongoose.disconnect(); } catch { /* already closed */ }
    process.exit(1);
});
