// Polls production for signs that a pilot device has actually picked up the
// 1.2.1 OTA bundle: a fresh native check-in, or (the real proof) a new
// source='background' Tracking row from one of the two pilot tenants.
require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const ClientDevice = require('../src/models/ClientDevice');
const Tracking = require('../src/models/Tracking');

const PILOT_ADMIN_IDS = ['6a6990c0835fb1fb12e33268', '6aa241437fbdaa2294482e5b'];
const SINCE = new Date('2026-09-12T12:27:00.000Z');
const POLL_MS = 30_000;
const MAX_MINUTES = 9;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    await mongoose.connect(process.env.MONGO_URI);
    console.log(`watching since ${SINCE.toISOString()} for up to ${MAX_MINUTES} minutes...`);

    const deadline = Date.now() + MAX_MINUTES * 60_000;
    let found = false;

    while (Date.now() < deadline) {
        const devices = await ClientDevice.find({
            adminId: { $in: PILOT_ADMIN_IDS },
            isNative: true,
            lastSeenAt: { $gt: SINCE },
        }).select('adminId employeeId lastSeenAt appVersion').lean();

        const bgTracking = await Tracking.find({
            adminId: { $in: PILOT_ADMIN_IDS },
            source: 'background',
            createdAt: { $gt: SINCE },
        }).select('adminId employeeId createdAt lat lng').lean();

        if (devices.length) {
            console.log(`[${new Date().toISOString()}] native check-ins since watch start: ${devices.length}`);
            for (const d of devices) console.log('  ' + JSON.stringify(d));
        }

        if (bgTracking.length) {
            console.log(`\n*** BACKGROUND TRACKING ROWS FOUND (${bgTracking.length}) ***`);
            for (const t of bgTracking) console.log('  ' + JSON.stringify(t));
            found = true;
            break;
        }

        await sleep(POLL_MS);
    }

    if (!found) console.log('\nNo source=background Tracking rows yet within the watch window.');
    await mongoose.disconnect();
    process.exit(found ? 0 : 2);
})().catch((e) => { console.error(e); process.exit(1); });
