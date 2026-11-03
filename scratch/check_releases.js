require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const AppRelease = require('../src/models/AppRelease');
const User = require('../src/models/User');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const releases = await AppRelease.find({}).sort({ createdAt: -1 }).lean();
  console.log('AppRelease count:', releases.length);
  for (const r of releases) {
    console.log(JSON.stringify({ version: r.version, channel: r.channel, enabled: r.enabled, platform: r.platform, pilotAdminIds: r.pilotAdminIds, createdAt: r.createdAt, url: r.url }));
  }

  const names = ['Bharat Kadavala', 'Bharat Fuerte', 'Brij Fuerte'];
  const users = await User.find({ name: { $in: names } }).select('name role adminId _id').lean();
  console.log('\nTest users:');
  for (const u of users) console.log(JSON.stringify(u));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
