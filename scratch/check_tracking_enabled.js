require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8','1.1.1.1']);
const mongoose = require('mongoose');
const User = require('../src/models/User');
const ClientDevice = require('../src/models/ClientDevice');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  // Everyone who has a native device checked in today
  const devices = await ClientDevice.find({ isNative: true }).select('employeeId adminId lastSeenAt').lean();
  const ids = [...new Set(devices.map(d => String(d.employeeId)))];
  const users = await User.find({ _id: { $in: ids } })
    .select('name phone trackingEnabled branchId adminId').lean();
  console.log('Employees with a native app install:\n');
  for (const u of users) {
    console.log(`  ${u.name?.trim().padEnd(24)} trackingEnabled=${u.trackingEnabled === true ? 'YES' : String(u.trackingEnabled)}  branch=${u.branchId ? 'set' : 'NONE'}`);
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
