require('node:dns').setServers(['8.8.8.8','1.1.1.1']);
require('dotenv').config({ path: require('path').join(__dirname,'..','.env') });
const mongoose = require('mongoose');
const T = d => d ? new Date(d).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:false}) : '--';

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const ADMIN = '6a6990c0835fb1fb12e33268';
  const oid = new mongoose.Types.ObjectId(ADMIN);

  console.log('=== 1. IS AUTO PUNCH-OUT ACTUALLY ARMED? ===');
  const st = await db.collection('settings').findOne({ adminId: oid });
  const g = st?.attendance?.autoPunchOut || st?.geofence || st?.attendance?.geofence || null;
  console.log('  settings.attendance.autoPunchOut :', JSON.stringify(g));
  const armed = g && g.enabled === true && g.shadowMode === false;
  console.log('  ARMED (enabled && !shadowMode)   :', armed ? 'YES — it will close days' : 'NO — shadow only, nothing will be closed');

  console.log('\n=== 2. WHO WILL ACTUALLY BE TRACKED ===');
  const depts = await db.collection('departments').find({ adminId: oid }).toArray();
  for (const d of depts) {
    const n = await db.collection('users').countDocuments({ adminId: oid, departmentId: d._id, role: 'employee' });
    console.log(`  ${String(d.name).trim().padEnd(18)} employees=${String(n).padStart(3)}  tracking=${d.trackingEnabled === true}  autoPunchOut=${d.autoPunchOutEnabled === true}`);
  }
  const perUser = await db.collection('users').countDocuments({ adminId: oid, role: 'employee', trackingEnabled: true });
  const totalEmp = await db.collection('users').countDocuments({ adminId: oid, role: 'employee' });
  console.log(`  individually trackingEnabled: ${perUser} of ${totalEmp} employees`);

  console.log('\n=== 3. BRANCH FENCES ===');
  const brs = await db.collection('branches').find({ adminId: oid }).toArray();
  for (const b of brs) console.log(`  ${String(b.branchName).padEnd(22)} radius=${b.radius ?? '(tenant default)'}  coords=${b.latitude != null ? 'set' : '*** MISSING ***'}`);
  console.log('  tenant officeRadius:', st?.attendance?.officeRadius ?? '(none → 3000m fallback)');

  console.log('\n=== 4. DATA PIPELINES ALIVE? ===');
  const since = new Date(Date.now() - 24*3600*1000);
  for (const [label, coll, field] of [['location fixes','trackings','timestamp'], ['tracker events','trackerevents','at'], ['client errors','clienterrors','createdAt'], ['geofence audits','geofenceaudits','createdAt']]) {
    const n = await db.collection(coll).countDocuments({ [field]: { $gte: since } });
    const last = await db.collection(coll).find({}).sort({ [field]: -1 }).limit(1).toArray();
    console.log(`  ${label.padEnd(16)} last 24h=${String(n).padStart(5)}   newest=${T(last[0]?.[field])}`);
  }

  console.log('\n=== 5. OPEN SESSIONS THAT THE 04:00 JOB SHOULD BE CLOSING ===');
  const yest = new Date(Date.now() - 24*3600*1000);
  console.log('  open >24h:', await db.collection('attendances').countDocuments({ punchIn: {$ne:null}, punchOut: null, date: {$lt: yest} }));

  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
