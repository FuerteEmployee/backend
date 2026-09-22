require('node:dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const IST = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log('db:', db.databaseName, '\n');

  const ev = await db.collection('trackerevents').find({}).sort({ at: -1 }).limit(60).toArray();
  console.log('=== tracker events: ' + ev.length + ' (newest first) ===');
  if (!ev.length) console.log('  none yet');

  const names = {};
  for (const e of ev) {
    const k = String(e.employeeId);
    if (!names[k]) {
      const u = await db.collection('users').findOne({ _id: e.employeeId }, { projection: { name: 1 } });
      names[k] = (u && u.name) ? u.name.trim() : k.slice(-6);
    }
  }
  for (const e of ev) {
    const lag = Math.round((new Date(e.createdAt) - new Date(e.at)) / 1000);
    console.log(
      IST(e.at).padEnd(20),
      String(names[String(e.employeeId)]).padEnd(16),
      String(e.type).padEnd(18),
      'batt=' + (e.batteryLevel == null ? '--' : e.batteryLevel + '%') + (e.charging ? '+' : ' '),
      'lag=' + lag + 's',
      e.meta ? JSON.stringify(e.meta) : ''
    );
  }

  console.log('\n=== by type ===');
  const agg = await db.collection('trackerevents').aggregate([
    { $group: { _id: '$type', n: { $sum: 1 } } }, { $sort: { n: -1 } },
  ]).toArray();
  for (const a of agg) console.log('  ' + String(a._id).padEnd(20), a.n);

  console.log('\n=== devices on 1.5 ===');
  const devs = await db.collection('clientdevices').find({ appVersion: /1\.5/ }).sort({ lastSeenAt: -1 }).toArray();
  for (const d of devs) {
    const u = await db.collection('users').findOne({ _id: d.employeeId }, { projection: { name: 1 } });
    console.log(' ', IST(d.lastSeenAt), (u && u.name ? u.name.trim() : '?').padEnd(16), d.appVersion, d.deviceModel || '', 'android' + (d.osVersion||'?'),
      '| notif=' + d.permissions.notifications, 'autoStart=' + d.permissions.autoStart, 'proven=' + !!d.autoStartProven);
  }
  if (!devs.length) console.log('  none reporting 1.5 yet');

  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
