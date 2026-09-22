require('node:dns').setServers(['8.8.8.8','1.1.1.1']);
require('dotenv').config({ path: require('path').join(__dirname,'..','.env') });
const mongoose = require('mongoose');
const T = (d) => d ? new Date(d).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour12:false}) : '--';
(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  // today IST
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5*3600*1000);
  const midIST = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5*3600*1000);

  const rows = await db.collection('attendances')
    .find({ date: { $gte: midIST } , $or:[{ 'shifts.0': { $exists: true } }, { punchIn: { $ne: null } }] })
    .sort({ updatedAt: -1 }).limit(6).toArray();

  for (const a of rows) {
    const u = await db.collection('users').findOne({_id:a.userId},{projection:{name:1}});
    console.log('\n=== ' + ((u&&u.name)||a.userId) + ' ===');
    console.log('  root punchIn :', T(a.punchIn));
    console.log('  root punchOut:', T(a.punchOut), a.punchOut ? '' : '  <-- NULL');
    console.log('  shifts       :', (a.shifts||[]).length);
    (a.shifts||[]).forEach((s,i)=>console.log('    ['+i+']', T(s.punchIn), '->', T(s.punchOut), s.closeReason||''));
    console.log('  totalWorkMs  :', a.totalWorkMs, '=', a.totalWorkMs ? (a.totalWorkMs/3600000).toFixed(2)+'h' : '-');
    console.log('  status       :', a.status);
    // What allSessions() would return
    const sess = (a.shifts||[]).filter(Boolean).length ? a.shifts.filter(Boolean)
               : (a.punchIn ? [{punchIn:a.punchIn, punchOut:a.punchOut}] : []);
    console.log('  allSessions() ->', sess.length, 'session(s):', sess.map(s=>T(s.punchIn)+'-'+T(s.punchOut)).join(', '));
  }
  await mongoose.disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
