#!/usr/bin/env node
/**
 * Live trace of a geofence walk test. Read-only — it never writes.
 *
 *   node scratch/watch_geofence_walk.js <employeeId> [minutes]
 *
 * Lives in scratch/ rather than a temp dir on purpose: Node resolves
 * `require` against the SCRIPT's directory, not the shell's cwd, so a copy
 * parked outside the project cannot find dotenv or mongoose and dies on the
 * first line.
 */
require('dotenv').config();
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');

const EMP = process.argv[2];
const MINUTES = Number(process.argv[3]) || 30;
if (!EMP) { console.error('usage: node scratch/watch_geofence_walk.js <employeeId> [minutes]'); process.exit(1); }

const POLL_MS = 15000;
const t = (d) => new Date(d).toISOString().slice(11, 19);

function metres(aLat, aLng, bLat, bLng) {
    const R = 6371000, rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
    return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
}

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
    const db = mongoose.connection.db;
    const oid = new mongoose.Types.ObjectId(EMP);

    const user = await db.collection('users').findOne({ _id: oid });
    const branch = user.branchId ? await db.collection('branches').findOne({ _id: user.branchId }) : null;
    const radius = (branch && branch.radius) || 100;
    const threshold = radius + Math.max(35, radius * 0.5);

    console.log(`watching ${user.name} — ${branch ? branch.branchName : 'no branch'}, radius ${radius}m, exit beyond ${Math.round(threshold)}m`);
    console.log(`cluster: ${(process.env.MONGO_URI.match(/@([^/]+)/) || [])[1]}\n`);

    let lastFix = new Date(Date.now() - 60000);
    let lastAudit = new Date(Date.now() - 60000);
    let wasOpen = null;
    const until = Date.now() + MINUTES * 60 * 1000;

    while (Date.now() < until) {
        const a = (await db.collection('attendances').find({ employeeId: oid }).sort({ date: -1 }).limit(1).toArray())[0];
        const open = !!(a && a.punchIn && !a.punchOut);
        if (wasOpen !== null && open !== wasOpen && !open) {
            console.log(`\n*** SESSION CLOSED ${t(a.punchOut)} — autoPunchOut=${a.autoPunchOut} status=${a.status} geoStatus=${a.geoStatus}`);
            if (a.autoPunchOutReason) console.log(`    ${a.autoPunchOutReason}`);
            console.log(`    worked: ${a.totalWorkMs ? Math.round(a.totalWorkMs / 60000) + ' min' : '-'}\n`);
        } else if (wasOpen !== null && open !== wasOpen && open) {
            console.log(`\n*** PUNCHED IN ${t(a.punchIn)} ***\n`);
        }
        wasOpen = open;

        for (const f of await db.collection('trackings').find({ employeeId: oid, timestamp: { $gt: lastFix } }).sort({ timestamp: 1 }).toArray()) {
            const d = branch ? metres(branch.latitude, branch.longitude, f.latitude, f.longitude) : 0;
            const zone = d <= radius ? 'inside' : d <= threshold ? 'buffer' : d <= threshold * 3 ? 'MARGINAL' : 'OUTSIDE';
            console.log(`  fix    ${t(f.timestamp)} ${String(d).padStart(6)}m ${zone.padEnd(9)} acc=${Math.round(f.accuracy)}m`);
            lastFix = f.timestamp;
        }

        for (const r of await db.collection('geofenceaudits').find({ employeeId: oid, createdAt: { $gt: lastAudit } }).sort({ createdAt: 1 }).toArray()) {
            console.log(`  ENGINE ${t(r.createdAt)} ${String(r.decision).toUpperCase().padEnd(11)} ${String(r.reason).padEnd(26)} fixes=${r.trustworthyFixes} distinct=${r.distinctPositions} dist=${r.distanceM ?? '-'}m shadow=${r.shadow}`);
            if (r.narrative) console.log(`         ${r.narrative.slice(0, 130)}`);
            lastAudit = r.createdAt;
        }

        await new Promise((res) => setTimeout(res, POLL_MS));
    }
    console.log('\nwatcher finished');
    await mongoose.disconnect();
})().catch((e) => { console.error('WATCHER FAILED:', e.message); process.exit(1); });
