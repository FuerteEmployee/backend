// The 1.2.1 pilot is superseded by the 1.2.2 production release. It has to be
// disabled, not just left alone: checkForUpdate looks for a matching PILOT
// release first and only falls back to production, so the moment those two
// tenants' devices ever do send their custom_id they would be handed the OLDER
// bundle instead of the newer one.
require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const AppRelease = require('../src/models/AppRelease');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const updated = await AppRelease.findOneAndUpdate(
    { version: '1.2.1' },
    { $set: { enabled: false, notes: 'Superseded by 1.2.2 production.' } },
    { new: true }
  ).lean();
  console.log('1.2.1 ->', JSON.stringify({ version: updated?.version, channel: updated?.channel, enabled: updated?.enabled }));

  const all = await AppRelease.find({}).sort({ createdAt: -1 }).select('version channel enabled url').lean();
  console.log('\nAll releases:');
  for (const r of all) console.log('  ' + JSON.stringify(r));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
