require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8','1.1.1.1']);
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Attendance = require('../src/models/Attendance');
const { istStartOfDay, istEndOfDay } = require('../src/utils/attendance_helpers');

const IST = (d) => (d ? new Date(new Date(d).getTime()+5.5*3600*1000).toISOString().slice(11,19) : '-');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const rows = await Attendance.find({ date: { $gte: istStartOfDay(), $lte: istEndOfDay() } })
    .select('employeeId punchIn punchOut').lean();
  console.log('Today attendance:');
  for (const r of rows) {
    const u = await User.findById(r.employeeId).select('name trackingEnabled').lean();
    const open = r.punchIn && !r.punchOut;
    console.log(`  ${(u?.name||'?').trim().padEnd(24)} in=${IST(r.punchIn)} out=${IST(r.punchOut)} ` +
      `tracking=${u?.trackingEnabled===true?'ON':'off'}  ${open ? '<-- OPEN, should be recording' : ''}`);
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
