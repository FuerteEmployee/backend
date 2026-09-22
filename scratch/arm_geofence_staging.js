#!/usr/bin/env node
/**
 * Arm (or disarm) the geofence auto punch-out engine on the STAGING tenant.
 *
 *   node scratch/arm_geofence_staging.js          # show current mode only
 *   node scratch/arm_geofence_staging.js --arm    # enable real punch-outs
 *   node scratch/arm_geofence_staging.js --shadow # back to shadow (safe)
 *
 * Arming uses acknowledgeRisk:true, which deliberately overrides the promotion
 * gate in geofence_controller.updateAutoPunchOutMode. That gate normally
 * refuses to arm until the shadow run has produced 7 distinct days, 3 distinct
 * employees, 50 decisions and at least one real detected exit -- because the
 * cost of arming early is somebody's pay.
 *
 * Overriding it is defensible HERE and ONLY here: this points at the test
 * cluster, whose data is a restored copy used for testing, and the whole point
 * is to watch a real closure happen. The guard below refuses to run against
 * any other cluster, so this file cannot arm production by accident.
 *
 * Disarming is never gated -- --shadow works instantly, any time.
 */
require('dotenv').config();
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');

const API = process.env.STAGING_API || 'https://staging-api.beontimeofficial.com/api';
const TENANT_ADMIN_ID = '6a6990c0835fb1fb12e33268';

const arm = process.argv.includes('--arm');
const shadow = process.argv.includes('--shadow');

(async () => {
    if (!/htzax8x/.test(process.env.MONGO_URI || '')) {
        console.error('ABORT: MONGO_URI is not the staging cluster. Refusing to run.');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
    const db = mongoose.connection.db;

    const admin = await db.collection('users').findOne(
        { _id: new mongoose.Types.ObjectId(TENANT_ADMIN_ID) },
        { projection: { phone: 1, name: 1 } },
    );
    if (!admin) throw new Error('tenant admin not found');

    // OTP comes back in the response body -- there is no SMS gateway.
    let r = await fetch(`${API}/users/login-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: admin.phone }),
    });
    const { otp } = await r.json();
    r = await fetch(`${API}/users/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: admin.phone, otp }),
    });
    const { token } = await r.json();
    if (!token) throw new Error('login failed');
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    const show = async (label) => {
        const s = await db.collection('settings').findOne(
            { adminId: new mongoose.Types.ObjectId(TENANT_ADMIN_ID) },
            { projection: { 'attendance.geofenceAutoPunchOut': 1 } },
        );
        const g = s?.attendance?.geofenceAutoPunchOut;
        const armed = g?.enabled === true && g?.shadowMode === false;
        console.log(`${label}: ${g ? JSON.stringify(g) : '(no config -> defaults)'}  ->  ${armed ? 'ARMED (real punch-outs)' : 'SHADOW (records only)'}`);
    };

    await show('current ');

    if (!arm && !shadow) {
        console.log('\nNothing changed. Pass --arm or --shadow.');
        await mongoose.disconnect();
        return;
    }

    if (shadow) {
        r = await fetch(`${API}/geofence/mode`, {
            method: 'PUT', headers: H,
            body: JSON.stringify({ enabled: true, shadowMode: true }),
        });
        console.log('\ndisarm ->', r.status, JSON.stringify(await r.json()));
        await show('now     ');
        await mongoose.disconnect();
        return;
    }

    // Show what the gate says before overriding it, so the override is an
    // informed act rather than a blind one.
    r = await fetch(`${API}/geofence/mode`, {
        method: 'PUT', headers: H,
        body: JSON.stringify({ enabled: true, shadowMode: false }),
    });
    const gate = await r.json();
    console.log(`\npromotion gate (${r.status}):`);
    for (const f of gate.failures || [gate.message]) console.log('   -', f);

    r = await fetch(`${API}/geofence/mode`, {
        method: 'PUT', headers: H,
        body: JSON.stringify({ enabled: true, shadowMode: false, acknowledgeRisk: true }),
    });
    console.log('\narm ->', r.status, JSON.stringify(await r.json()));
    await show('now     ');

    console.log('\nRevert at any time with:  node scratch/arm_geofence_staging.js --shadow');
    await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
