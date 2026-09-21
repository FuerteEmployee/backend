// One-off backfill: re-grade Attendance records that the nightly auto-close
// job (attendance_close.js) graded using the timezone-dependent shiftTimeOnDate
// bug (fixed in attendance_helpers.js). Scope is deliberately narrow: only
// records carrying the auto-close job's own remark are touched -- these are
// exactly the ones a SYSTEM decision (not an admin) may have mis-graded.
// Explicit admin/regularization status choices are never touched.
//
// Usage:
//   node scratch/backfill_grading_tz_fix.js            -- dry run, no writes
//   node scratch/backfill_grading_tz_fix.js --apply     -- actually updates
require('dotenv').config();
const mongoose = require('mongoose');
const Attendance = require('../src/models/Attendance');
const User = require('../src/models/User');
const Settings = require('../src/models/Settings');
require('../src/models/Shift');
const { gradeDay, computeWorkedMs, isDayOpen } = require('../src/utils/shift_status');
const { istDateKey } = require('../src/utils/attendance_helpers');
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const AUTO_CLOSE_MARK = 'Auto-closed at shift end (no punch-out recorded)';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const candidates = await Attendance.find({ remarks: { $regex: AUTO_CLOSE_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } });
  console.log(`Found ${candidates.length} auto-closed records to check.\n`);

  const settingsCache = new Map();
  const userCache = new Map();

  let changed = 0, unchanged = 0, skippedOpen = 0, skippedNoUser = 0;
  const changes = [];

  for (const record of candidates) {
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

    const grade = gradeDay(record, user.shiftId, settings);
    if (!grade || grade === record.status) { unchanged++; continue; }

    changed++;
    const [y, m] = istDateKey(record.date).split('-').map(Number);
    changes.push({
      id: String(record._id),
      adminId: String(record.adminId),
      employeeId: String(record.employeeId),
      employee: user.name,
      date: record.date.toISOString().slice(0, 10),
      month: m,
      year: y,
      from: record.status,
      to: grade,
      workedH: (computeWorkedMs(record, user.shiftId, settings) / 3600000).toFixed(2),
    });

    if (APPLY) {
      record.status = grade;
      record.remarks = (record.remarks || '') + ' | Re-graded: fixed server-timezone bug in shift-time calculation';
      await record.save();
    }
  }

  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'} summary:`);
  console.log(`  changed:      ${changed}`);
  console.log(`  unchanged:    ${unchanged}`);
  console.log(`  skipped (still open): ${skippedOpen}`);
  console.log(`  skipped (no user):    ${skippedNoUser}`);

  console.log('\nBy transition:');
  const byTransition = {};
  for (const c of changes) {
    const k = `${c.from} -> ${c.to}`;
    byTransition[k] = (byTransition[k] || 0) + 1;
  }
  for (const [k, v] of Object.entries(byTransition)) console.log(`  ${k}: ${v}`);

  const byEmployee = {};
  for (const c of changes) byEmployee[c.employee] = (byEmployee[c.employee] || 0) + 1;
  console.log('\nBy employee:');
  for (const [k, v] of Object.entries(byEmployee)) console.log(`  ${k}: ${v}`);

  console.log('\nSample (first 20):');
  for (const c of changes.slice(0, 20)) {
    console.log(`  ${c.date}  ${c.employee}  ${c.from} -> ${c.to}  (${c.workedH}h)`);
  }

  const outPath = path.join(__dirname, 'backfill_grading_tz_fix.changes.json');
  fs.writeFileSync(outPath, JSON.stringify(changes, null, 2));
  console.log(`\nWrote ${changes.length} change records to ${outPath}`);

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
