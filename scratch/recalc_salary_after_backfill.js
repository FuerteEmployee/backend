// Recompute salary for every employee/month touched by
// backfill_grading_tz_fix.js --apply, so already-generated payroll reflects
// the corrected attendance status.
require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
const User = require('../src/models/User');
require('../src/models/Shift');
const { calculateAndSaveSalary } = require('../src/controllers/salary_controller');

async function main() {
  const changes = require('./backfill_grading_tz_fix.changes.json');

  const combos = new Map();
  for (const c of changes) {
    const key = `${c.adminId}|${c.employeeId}|${c.month}|${c.year}`;
    combos.set(key, { adminId: c.adminId, employeeId: c.employeeId, month: c.month, year: c.year });
  }
  console.log(`${changes.length} changed records -> ${combos.size} unique employee/month combos to recompute.\n`);

  await mongoose.connect(process.env.MONGO_URI);

  let ok = 0, failed = 0;
  for (const { adminId, employeeId, month, year } of combos.values()) {
    try {
      const emp = await User.findById(employeeId).populate('shiftId');
      if (!emp) { console.log(`  SKIP ${employeeId} (${month}/${year}) - user not found`); failed++; continue; }
      const salary = await calculateAndSaveSalary(adminId, emp, month, year);
      console.log(`  OK  ${emp.name}  ${month}/${year}  netSalary=${salary.netSalary}  totalSalary=${salary.totalSalary}`);
      ok++;
    } catch (err) {
      console.log(`  FAIL ${employeeId} (${month}/${year}): ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${ok} recomputed, ${failed} failed.`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
