// READ ONLY. Current production state of background tracking + the geofence
// engine's shadow run. Run from backend/: node scratch/diag_geofence_status.js
require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');

const User = require('../src/models/User');
const Tracking = require('../src/models/Tracking');
const GeofenceAudit = require('../src/models/GeofenceAudit');
const GeofencePendingExit = require('../src/models/GeofencePendingExit');
const Settings = require('../src/models/Settings');

const ist = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '—');

(async () => {
    await mongoose.connect(process.env.MONGO_URI);

    console.log('=== employees with trackingEnabled=true ===');
    const tracked = await User.find({ trackingEnabled: true }).select('name adminId').lean();
    for (const u of tracked) console.log(`  ${u.name}  (adminId=${u.adminId})`);
    if (!tracked.length) console.log('  (none)');

    console.log('\n=== Tracking fixes, last 24h, grouped by source ===');
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const bySource = await Tracking.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$source', count: { $sum: 1 }, lastAt: { $max: '$timestamp' } } },
    ]);
    for (const s of bySource) console.log(`  source=${s._id || '(unset/app)'}  count=${s.count}  lastFix=${ist(s.lastAt)}`);
    if (!bySource.length) console.log('  (no fixes at all in the last 24h)');

    console.log('\n=== GeofenceAudit rows, last 7 days ===');
    const since7 = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const rows = await GeofenceAudit.find({ createdAt: { $gte: since7 } })
        .populate('employeeId', 'name')
        .sort({ createdAt: -1 })
        .lean();
    console.log('  total rows:', rows.length);
    const byDecision = {};
    for (const r of rows) byDecision[r.decision] = (byDecision[r.decision] || 0) + 1;
    console.log('  by decision:', JSON.stringify(byDecision));
    const byReason = {};
    for (const r of rows) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
    console.log('  by reason:', JSON.stringify(byReason));

    console.log('\n  most recent 10 rows:');
    for (const r of rows.slice(0, 10)) {
        console.log(`    ${ist(r.createdAt)}  ${r.employeeId?.name || r.employeeId}  ${r.decision}/${r.reason}  shadow=${r.shadow}  ${r.narrative || ''}`);
    }

    console.log('\n=== Pending exit confirmations right now ===');
    const pending = await GeofencePendingExit.find({}).populate('employeeId', 'name').lean();
    for (const p of pending) console.log(`  ${p.employeeId?.name}  round ${p.rounds}, since ${ist(p.since)}`);
    if (!pending.length) console.log('  (none)');

    console.log('\n=== Per-tenant geofenceAutoPunchOut config ===');
    const settingsRows = await Settings.find({}).select('adminId attendance.geofenceAutoPunchOut').lean();
    for (const s of settingsRows) {
        const cfg = s.attendance?.geofenceAutoPunchOut;
        if (cfg && (cfg.enabled || cfg.shadowMode === false)) {
            console.log(`  adminId=${s.adminId}  enabled=${cfg.enabled}  shadowMode=${cfg.shadowMode}`);
        }
    }
    console.log('  (tenants not listed are on the field default: enabled=false, shadowMode=true)');

    await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
