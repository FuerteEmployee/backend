// READ ONLY. Is the terminal's clock right? Compare deviceTime vs receivedAt.
require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const PunchLog = require('../src/models/PunchLog');
const Device = require('../src/models/Device');
const ist = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '—');

(async () => {
    await mongoose.connect(process.env.MONGO_URI);

    console.log('=== DEVICES ===');
    for (const d of await Device.find({}).lean()) {
        console.log(`  ${d.serialNumber}  status=${d.status}  name=${d.name || '—'}  lastSeen=${ist(d.lastSeenAt)}`);
    }

    console.log('\n=== EVERY TAP EVER, deviceTime vs receivedAt ===');
    const taps = await PunchLog.find({}).sort({ receivedAt: 1 }).lean();
    for (const t of taps) {
        const skewMin = (new Date(t.receivedAt) - new Date(t.deviceTime)) / 60000;
        console.log(
            `  sn=${t.serialNumber} pin=${t.pin}  device=${ist(t.deviceTime)}  received=${ist(t.receivedAt)}` +
            `  SKEW=${skewMin.toFixed(1)} min` + (t.discarded ? `  [${t.discardReason}]` : '')
        );
    }
    await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
