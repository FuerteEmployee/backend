// Read-only check: how many CLOSED Attendance records have a stored
// totalWorkMs that disagrees with what the (now-fixed) computeWorkedMs
// would produce today. A punch-out saves totalWorkMs at the moment it
// happens (attendance_controller.js punchOut handler), so any record closed
// before the timezone-bug fix was deployed may carry a stale, wrong value —
// not just the auto-closed ones the earlier backfill targeted.
require('dotenv').config();
const mongoose = require('mongoose');
const Attendance = require('../src/models/Attendance');
const User = require('../src/models/User');
const Settings = require('../src/models/Settings');
require('../src/models/Shift');
const { computeWorkedMs, isDayOpen } = require('../src/utils/shift_status');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const records = await Attendance.find({ punchOut: { $ne: null } });
  console.log(`Checking ${records.length} closed records...\n`);

  const userCache = new Map();
  const settingsCache = new Map();
  let mismatches = 0, matched = 0, skippedOpen = 0, skippedNoUser = 0;
  const samples = [];

  for (const record of records) {
    if (isDayOpen(record)) { skippedOpen++; continue; }

    let user = userCache.get(String(record.employeeId));
    if (user === undefined) {
      user = await User.findById(record.employeeId).populate('shiftId').lean();
      userCache.set(String(record.employeeId), user);
    }
    if (!user) { skippedNoUser++; continue; }

    let settings = settingsCache.get(String(record.adminId));
    if (settings === undefined) {
      settings = await Settings.findOne({ adminId: record.adminId }).lean();
      settingsCache.set(String(record.adminId), settings);
    }

    const recomputed = computeWorkedMs(record, user.shiftId, settings);
    const stored = record.totalWorkMs || 0;
    const diffMin = Math.abs(recomputed - stored) / 60000;

    if (diffMin > 2) { // >2min tolerance for rounding
      mismatches++;
      samples.push({
        date: record.date.toISOString().slice(0, 10),
        employee: user.name,
        stored: (stored / 3600000).toFixed(2) + 'h',
        recomputed: (recomputed / 3600000).toFixed(2) + 'h',
        status: record.status,
      });
    } else {
      matched++;
    }
  }

  console.log(`matched (stored == recomputed): ${matched}`);
  console.log(`MISMATCHED (stale totalWorkMs):  ${mismatches}`);
  console.log(`skipped (still open): ${skippedOpen}`);
  console.log(`skipped (no user): ${skippedNoUser}`);

  console.log('\nAll mismatches:');
  for (const s of samples) {
    console.log(`  ${s.date}  ${s.employee}  stored=${s.stored} -> recomputed=${s.recomputed}  (status: ${s.status})`);
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
