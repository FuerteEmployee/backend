require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8','1.1.1.1']);
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Attendance = require('../src/models/Attendance');
const PunchLog = require('../src/models/PunchLog');

const IST = (d) => (d ? new Date(new Date(d).getTime() + 5.5*3600*1000).toISOString().replace('T',' ').slice(0,19) : String(d));

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const u = await User.findOne({ phone: '2222222222' }).select('name adminId').lean();
  const a = await Attendance.findOne({ employeeId: u._id }).sort({ date: -1 }).lean();

  console.log('ATTENDANCE DOC');
  console.log('  date            ', IST(a.date), 'IST');
  console.log('  punchIn         ', IST(a.punchIn), 'IST');
  console.log('  punchOut        ', IST(a.punchOut), 'IST');
  console.log('  lunchInTime     ', IST(a.lunchInTime), 'IST');
  console.log('  lunchOutTime    ', IST(a.lunchOutTime), 'IST');
  console.log('  status          ', a.status);
  console.log('  source          ', a.source);
  console.log('  derivedFields   ', JSON.stringify(a.derivedFields));
  console.log('  punchOutIsProvisional', a.punchOutIsProvisional);
  console.log('  totalWorkMs     ', a.totalWorkMs, '=', (a.totalWorkMs/3600000).toFixed(2), 'h');
  console.log('  shifts          ', JSON.stringify(a.shifts, null, 2));

  const taps = await PunchLog.find({ employeeId: u._id }).sort({ deviceTime: 1 }).lean();
  console.log(`\nTAPS (${taps.length}):`);
  for (const t of taps) console.log(`  ${IST(t.deviceTime)} IST  action=${t.derivedAction} discarded=${!!t.discarded}`);

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
