require('node:dns').setServers(['8.8.8.8','1.1.1.1']);
require('dotenv').config({ path: require('path').join(__dirname,'..','.env') });
const mongoose = require('mongoose');
const T = d => d ? new Date(d).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}) : '--';
(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const u = await db.collection('users').findOne({ phone: '2121212121' });
  if (!u) { console.log('no user with phone 2121212121'); process.exit(0); }
  console.log('user     :', u.name, '| role', u.role, '| _id', String(u._id));
  console.log('adminId  :', String(u.adminId));
  const admin = u.adminId && await db.collection('users').findOne({_id:u.adminId},{projection:{name:1,phone:1}});
  console.log('tenant   :', admin ? admin.name + ' (' + admin.phone + ')' : '(none)');
  console.log('PILOT id :', '6a6990c0835fb1fb12e33268');
  console.log('MATCHES PILOT?', String(u.adminId) === '6a6990c0835fb1fb12e33268' ? 'YES' : '*** NO ***');
  const devs = await db.collection('clientdevices').find({ employeeId: u._id }).sort({lastSeenAt:-1}).limit(4).toArray();
  console.log('\ndevices:');
  for (const d of devs) console.log('  ', T(d.lastSeenAt), d.appVersion, d.deviceModel||'', 'installId', d.installId.slice(0,8), 'opens', d.appOpenCount);
  if (!devs.length) console.log('   (none reported)');
  await mongoose.disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
