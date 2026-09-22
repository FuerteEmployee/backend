// Finish what fix_skewed_taps.js started: the tap times were corrected, but the
// re-derivation crashed on an unregistered Shift model, leaving Attendance rows
// still built from the OLD times. Register every model, then re-derive each
// affected employee-day so status, worked time and payroll follow the corrected
// taps.
require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8', '1.1.1.1']);
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// reconcileDay populates shiftId and calculateAndSaveSalary reaches further
// still, so register the whole model directory rather than guessing which.
const MODELS_DIR = path.join(__dirname, '..', 'src', 'models');
for (const f of fs.readdirSync(MODELS_DIR)) {
    if (f.endsWith('.js')) require(path.join(MODELS_DIR, f));
}

const PunchLog = mongoose.model('PunchLog');
const Attendance = mongoose.model('Attendance');
const User = mongoose.model('User');
const Settings = mongoose.model('Settings');
const punchReconcile = require('../src/utils/punch_reconcile');

const SERIAL = process.argv[2] || 'EUF7254400194';
const IST = (d) => (d ? new Date(new Date(d).getTime() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) : '-');

(async () => {
    await mongoose.connect(process.env.MONGO_URI);

    const taps = await PunchLog.find({ serialNumber: SERIAL }).lean();

    // Days as they are NOW...
    const days = new Set(taps.map((t) => `${t.adminId}|${t.employeeId}|${t.dayKey}`));
    // ...plus any day the pre-correction rows used to sit on, which would
    // otherwise keep an attendance row derived from taps that have moved away.
    const backupPath = path.join(__dirname, 'backup_clockfix.json');
    if (fs.existsSync(backupPath)) {
        for (const t of JSON.parse(fs.readFileSync(backupPath, 'utf8')).taps || []) {
            days.add(`${t.adminId}|${t.employeeId}|${t.dayKey}`);
        }
    }

    console.log(`re-deriving ${days.size} employee-day(s)\n`);
    for (const key of days) {
        const [adminId, employeeId, dayKey] = key.split('|');
        try {
            const att = await punchReconcile.reconcileDay({
                Attendance, PunchLog, User, Settings, adminId, employeeId, dayKey,
            });
            const u = await User.findById(employeeId).select('name').lean();
            console.log(att
                ? `  ${dayKey} ${(u?.name || employeeId).trim().padEnd(24)} ` +
                  `in=${IST(att.punchIn)} out=${IST(att.punchOut)} ` +
                  `lunch=${IST(att.lunchInTime)}..${IST(att.lunchOutTime)} ` +
                  `status=${att.status} worked=${((att.totalWorkMs || 0) / 3600000).toFixed(2)}h`
                : `  ${dayKey} ${(u?.name || employeeId).trim()} — no taps on this day`);
        } catch (e) {
            console.error(`  ${dayKey} ${employeeId} FAILED: ${e.message}`);
        }
    }

    // Salary recalculation is fire-and-forget inside reconcileDay; give it a
    // moment to land before dropping the connection out from under it.
    await new Promise((r) => setTimeout(r, 4000));
    await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
