require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8','1.1.1.1']);
const mongoose = require('mongoose');
const User = require('../src/models/User');
const ClientDevice = require('../src/models/ClientDevice');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const users = await User.find({ name: /brij/i }).select('name role adminId _id').lean();
  console.log('Brij matches:', JSON.stringify(users));

  const recent = await ClientDevice.find({})
    .sort({ lastSeenAt: -1 })
    .limit(8)
    .select('adminId employeeId isNative appVersion lastSeenAt platform')
    .lean();
  console.log('\nRecent ClientDevice rows:');
  for (const d of recent) console.log(JSON.stringify(d));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
