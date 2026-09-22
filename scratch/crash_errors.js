require('dns').setServers(['8.8.8.8','1.1.1.1']);
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log('db:', db.databaseName);
  const since = new Date(Date.now() - 12 * 3600 * 1000);
  const errs = await db.collection('clienterrors')
    .find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(40).toArray();
  console.log('client errors in last 12h:', errs.length);
  for (const e of errs) {
    console.log('---', new Date(e.createdAt).toISOString(), '|', e.kind || e.type, '|', (e.message||'').slice(0,220));
    if (e.stack) console.log('   stack:', String(e.stack).split('\n').slice(0,4).join(' | ').slice(0,400));
    if (e.url) console.log('   url:', e.url);
  }
  const devs = await db.collection('clientdevices')
    .find({ lastSeenAt: { $gte: since } }).sort({ lastSeenAt: -1 }).limit(15).toArray();
  console.log('\ndevices seen in last 12h:', devs.length);
  for (const d of devs) console.log('  ', new Date(d.lastSeenAt).toISOString(), d.installId, 'v'+(d.appVersion||'?'), d.model||'', 'android'+(d.osVersion||'?'));
  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
