require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8','1.1.1.1']);
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Tracking = require('../src/models/Tracking');
const ClientDevice = require('../src/models/ClientDevice');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ phone: '3333333333' }).select('name role adminId phone _id branchId').lean();
  console.log('User:', JSON.stringify(user));
  if (!user) { console.log('No user found with that phone number.'); await mongoose.disconnect(); return; }

  const devices = await ClientDevice.find({ employeeId: user._id }).sort({ lastSeenAt: -1 }).select('installId isNative appVersion appBuild platform lastSeenAt permissions').lean();
  console.log('\nClientDevice rows:', devices.length);
  for (const d of devices) console.log(JSON.stringify(d));

  const recentTracking = await Tracking.find({ employeeId: user._id }).sort({ createdAt: -1 }).limit(15).select('createdAt source lat lng accuracy').lean();
  console.log('\nMost recent Tracking rows:', recentTracking.length);
  for (const t of recentTracking) console.log(JSON.stringify(t));

  const bySource = await Tracking.aggregate([
    { $match: { employeeId: user._id } },
    { $group: { _id: '$source', count: { $sum: 1 }, latest: { $max: '$createdAt' } } },
  ]);
  console.log('\nBy source:', JSON.stringify(bySource));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
