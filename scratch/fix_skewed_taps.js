// Correct taps recorded while a terminal's clock was wrong.
//
//   node scratch/fix_skewed_taps.js <serial>            # dry run, changes nothing
//   node scratch/fix_skewed_taps.js <serial> --apply
//
// Only touches PunchLog rows from the named terminal whose skew is within a
// couple of minutes of the measured offset -- a tap that does not match the
// pattern is left alone rather than guessed at. Each affected day is then
// re-derived through the normal reconciliation, so status, worked time and
// payroll all follow from the corrected times instead of being patched
// separately and drifting apart.
require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const PunchLog = require('../src/models/PunchLog');
const Attendance = require('../src/models/Attendance');
const User = require('../src/models/User');
const Settings = require('../src/models/Settings');
const punchReconcile = require('../src/utils/punch_reconcile');
const { istDateKey } = require('../src/utils/attendance_helpers');

const SERIAL = process.argv[2];
const APPLY = process.argv.includes('--apply');
const TOLERANCE_MIN = 3;

const IST = (d) => new Date(new Date(d).getTime() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

(async () => {
    if (!SERIAL) {
        console.error('Usage: node scratch/fix_skewed_taps.js <serialNumber> [--apply]');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URI);

    const taps = await PunchLog.find({ serialNumber: SERIAL }).sort({ deviceTime: 1 }).lean();
    if (!taps.length) { console.log('No taps for that serial.'); await mongoose.disconnect(); return; }

    // The offset each tap implies. For a wrong clock these cluster tightly;
    // anything well off the cluster is a backlog tap and must not be moved.
    const skews = taps.map((t) => Math.round((new Date(t.receivedAt) - new Date(t.deviceTime)) / 60000));
    const offset = skews.slice().sort((a, b) => a - b)[Math.floor(skews.length / 2)];  // median

    console.log(`serial ${SERIAL}: ${taps.length} taps, median skew ${offset} min\n`);

    const targets = [];
    for (const t of taps) {
        const skew = Math.round((new Date(t.receivedAt) - new Date(t.deviceTime)) / 60000);
        const matches = Math.abs(skew - offset) <= TOLERANCE_MIN;
        const corrected = new Date(new Date(t.deviceTime).getTime() + offset * 60000);
        console.log(
            `  ${IST(t.deviceTime)} -> ${matches ? IST(corrected) : '(left alone)'}  ` +
            `skew=${skew}  ${matches ? '' : 'OUTSIDE PATTERN, likely a backlog tap'}`
        );
        if (matches) targets.push({ tap: t, corrected });
    }

    if (!APPLY) {
        console.log(`\nDRY RUN — nothing written. ${targets.length} of ${taps.length} taps would move by ${offset} min.`);
        console.log('Re-run with --apply to write.');
        await mongoose.disconnect();
        return;
    }

    const days = new Set();
    for (const { tap, corrected } of targets) {
        const dayKey = istDateKey(corrected);
        await PunchLog.updateOne({ _id: tap._id }, { $set: { deviceTime: corrected, dayKey } });
        days.add(`${tap.adminId}|${tap.employeeId}|${dayKey}`);
        // The day it used to sit on must be re-derived too, or it keeps the
        // attendance row built from the tap that is no longer there.
        days.add(`${tap.adminId}|${tap.employeeId}|${tap.dayKey}`);
    }
    console.log(`\nmoved ${targets.length} taps by ${offset} min`);

    for (const key of days) {
        const [adminId, employeeId, dayKey] = key.split('|');
        const att = await punchReconcile.reconcileDay({
            Attendance, PunchLog, User, Settings, adminId, employeeId, dayKey,
        });
        console.log(`  re-derived ${dayKey}: ` + (att
            ? `in=${att.punchIn ? IST(att.punchIn) : '-'} out=${att.punchOut ? IST(att.punchOut) : '-'} ` +
              `status=${att.status} worked=${((att.totalWorkMs || 0) / 3600000).toFixed(2)}h`
            : 'no taps left on this day'));
    }

    await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
