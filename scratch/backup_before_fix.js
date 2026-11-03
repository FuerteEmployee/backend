require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8','1.1.1.1']);
const fs = require('fs');
const mongoose = require('mongoose');
const PunchLog = require('../src/models/PunchLog');
const Attendance = require('../src/models/Attendance');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const taps = await PunchLog.find({ serialNumber: 'EUF7254400194' }).lean();
  const empIds = [...new Set(taps.map(t => String(t.employeeId)))];
  const att = await Attendance.find({ employeeId: { $in: empIds } }).lean();
  const out = { takenAt: new Date().toISOString(), taps, attendance: att };
  fs.writeFileSync('scratch/backup_clockfix.json', JSON.stringify(out, null, 2));
  console.log(`backed up ${taps.length} taps and ${att.length} attendance docs -> scratch/backup_clockfix.json`);
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
