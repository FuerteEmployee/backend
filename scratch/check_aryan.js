require('node:dns').setServers(['8.8.8.8','1.1.1.1']);
require('dotenv').config({ path: require('path').join(__dirname,'..','.env') });
const mongoose = require('mongoose');
const T = d => d ? new Date(d).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:false}) : '--';
const ago = d => d ? Math.round((Date.now()-new Date(d))/60000)+' min ago' : '--';

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log('db:', db.databaseName, '\n');

  const u = await db.collection('users').findOne({ name: /aryan/i, role: 'employee' });
  if (!u) { console.log('no employee matching "Aryan"'); process.exit(0); }

  console.log('=== WHO ===');
  console.log('  name           :', u.name.trim(), '| phone', u.phone, '| _id', String(u._id));
  console.log('  trackingEnabled:', u.trackingEnabled);
  const dept = u.departmentId && await db.collection('departments').findOne({_id:u.departmentId});
  console.log('  department     :', dept ? `${dept.name} (trackingEnabled=${dept.trackingEnabled}, autoPunchOut=${dept.autoPunchOutEnabled})` : 'none');
  const br = u.branchId && await db.collection('branches').findOne({_id:u.branchId});
  console.log('  branch         :', br ? `${br.branchName} radius=${br.radius ?? 'default'}m` : 'none');

  console.log('\n=== TRACKING ROWS ===');
  const total = await db.collection('trackings').countDocuments({ employeeId: u._id });
  console.log('  lifetime fixes :', total);
  const last = await db.collection('trackings').find({ employeeId: u._id }).sort({ timestamp: -1 }).limit(12).toArray();
  if (!last.length) console.log('  *** NO COORDINATES EVER RECEIVED ***');
  for (const t of last) {
    console.log('   ', T(t.timestamp), `(${ago(t.timestamp)})`,
      'lat', Number(t.latitude).toFixed(5), 'lng', Number(t.longitude).toFixed(5),
      'acc', t.accuracy != null ? Math.round(t.accuracy)+'m' : '--',
      'batt', t.batteryLevel ?? '--');
  }

  console.log('\n=== TODAY ===');
  const ist = new Date(Date.now()+5.5*3600*1000);
  const mid = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5*3600*1000);
  const todayFixes = await db.collection('trackings').countDocuments({ employeeId: u._id, timestamp: { $gte: mid } });
  console.log('  fixes today    :', todayFixes);
  const att = await db.collection('attendances').findOne({ employeeId: u._id, date: { $gte: mid } });
  console.log('  attendance     :', att ? `punchIn ${T(att.punchIn)} punchOut ${T(att.punchOut)} status=${att.status} sessions=${(att.shifts||[]).length}` : 'none');

  console.log('\n=== DEVICE / EVENTS ===');
  const dev = await db.collection('clientdevices').find({ employeeId: u._id }).sort({lastSeenAt:-1}).limit(2).toArray();
  for (const d of dev) console.log('  ', T(d.lastSeenAt), d.appVersion, d.deviceModel, '| bgLoc', d.permissions.backgroundLocation, '| precise', d.permissions.preciseLocation, '| batt', d.permissions.batteryUnrestricted);
  const ev = await db.collection('trackerevents').find({ employeeId: u._id }).sort({at:-1}).limit(8).toArray();
  console.log('  recent events  :', ev.length);
  for (const e of ev) console.log('   ', T(e.at), e.type, e.batteryLevel!=null?e.batteryLevel+'%':'', e.meta?JSON.stringify(e.meta):'');

  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
