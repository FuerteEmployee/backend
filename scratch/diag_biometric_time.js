// Is the 5:30 discrepancy a WRONG DEVICE CLOCK or a DISPLAY bug?
//
// Both produce the identical symptom, and they need opposite fixes:
//   - device clock on UTC  -> deviceTime lands ~5:30 BEFORE receivedAt
//   - display not converting -> deviceTime ~= receivedAt, and the stored
//     instant is right while the UI renders it raw
require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const User = require('../src/models/User');
const PunchLog = require('../src/models/PunchLog');
const Attendance = require('../src/models/Attendance');

const IST = (d) => (d ? new Date(new Date(d).getTime() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' IST' : String(d));

(async () => {
    await mongoose.connect(process.env.MONGO_URI);

    const user = await User.findOne({ phone: '2222222222' }).select('name adminId deviceUserId').lean();
    console.log('User:', JSON.stringify(user));
    if (!user) { await mongoose.disconnect(); return; }

    const taps = await PunchLog.find({ employeeId: user._id })
        .sort({ deviceTime: -1 }).limit(8)
        .select('deviceTime receivedAt serialNumber pin dayKey derivedAction discarded discardReason')
        .lean();

    console.log(`\n--- last ${taps.length} raw taps ---`);
    for (const t of taps) {
        const skewMin = Math.round((new Date(t.receivedAt) - new Date(t.deviceTime)) / 60000);
        console.log(
            `deviceTime  UTC ${new Date(t.deviceTime).toISOString().slice(0, 19)}  = ${IST(t.deviceTime)}\n` +
            `receivedAt  UTC ${new Date(t.receivedAt).toISOString().slice(0, 19)}  = ${IST(t.receivedAt)}\n` +
            `  skew(received - device) = ${skewMin} min   dayKey=${t.dayKey}  action=${t.derivedAction}` +
            `${t.discarded ? `  DISCARDED(${t.discardReason})` : ''}\n`
        );
    }

    const att = await Attendance.find({ employeeId: user._id })
        .sort({ date: -1 }).limit(2)
        .select('date punchIn punchOut status source derivedFields punchOutIsProvisional')
        .lean();

    console.log('--- attendance ---');
    for (const a of att) {
        console.log(JSON.stringify({
            date: a.date, dateIST: IST(a.date),
            punchIn: a.punchIn, punchInIST: IST(a.punchIn),
            punchOut: a.punchOut, punchOutIST: IST(a.punchOut),
            status: a.status, source: a.source, derivedFields: a.derivedFields,
        }, null, 2));
    }

    console.log('\nserver now: UTC', new Date().toISOString().slice(0, 19), '=', IST(new Date()));
    await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
