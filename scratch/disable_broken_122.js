require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8','1.1.1.1']);
const mongoose = require('mongoose');
const AppRelease = require('../src/models/AppRelease');
(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await AppRelease.updateOne({ version: '1.2.2' }, { $set: {
    enabled: false,
    notes: 'PULLED: zip written by PowerShell Compress-Archive used backslash path separators, so Android could not create assets/ and the bundle never booted. Devices re-downloaded it in a loop. Fixed in 1.2.3.',
  }});
  const all = await AppRelease.find({}).sort({ createdAt: -1 }).select('version channel enabled').lean();
  for (const r of all) console.log('  ' + JSON.stringify(r));
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
