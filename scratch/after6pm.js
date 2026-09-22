require('node:dns').setServers(['8.8.8.8','1.1.1.1']);
require('dotenv').config({ path: require('path').join(__dirname,'..','.env') });
const mongoose = require('mongoose');
const IST = 5.5*3600*1000;
const t = d => d ? new Date(d).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour12:true,hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '--';

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const ADMIN = new mongoose.Types.ObjectId('6a6990c0835fb1fb12e33268');

  const now = new Date();
  const ist = new Date(now.getTime()+IST);
  const midIST = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST);
  const six = new Date(midIST.getTime() + 18*3600*1000);          // 18:00 IST today
  console.log('now (IST) :', t(now));
  console.log('window    : 06:00 PM IST -> now  (' + Math.max(0,Math.round((now-six)/60000)) + ' min)');
  if (now < six) console.log('*** 6:00 PM has not arrived yet today ***');
  console.log('');

  const names = {};
  const nm = async id => {
    const k=String(id);
    if(!names[k]){const u=await db.collection('users').findOne({_id:id},{projection:{name:1}}); names[k]=u&&u.name?u.name.trim():k.slice(-6);}
    return names[k];
  };

  console.log('=== PUNCHES after 6:00 PM ===');
  const atts = await db.collection('attendances').find({ adminId: ADMIN, date: { $gte: midIST } }).toArray();
  let punches = [];
  for (const a of atts) {
    const who = await nm(a.employeeId);
    const push=(kind,when,extra)=>{ if(when && new Date(when)>=six) punches.push({who,kind,when:new Date(when),extra}); };
    push('punch-in',  a.punchIn,  'session 1 (root)');
    push('punch-out', a.punchOut, 'session 1 (root)' + (a.autoPunchOut?' AUTO':''));
    push('lunch-in',  a.lunchInTime, '');
    push('lunch-out', a.lunchOutTime, '');
    (a.shifts||[]).forEach((sh,i)=>{
      push('punch-in',  sh.punchIn,  `session ${i+1}`);
      push('punch-out', sh.punchOut, `session ${i+1}` + (sh.closeReason && sh.closeReason!=='manual' ? ' ['+sh.closeReason+']' : ''));
    });
  }
  punches.sort((a,b)=>a.when-b.when);
  if(!punches.length) console.log('  (none)');
  for (const p of punches) console.log('  ' + t(p.when), String(p.who).padEnd(18), p.kind.padEnd(10), p.extra);

  console.log('\n=== TRACKING FIXES after 6:00 PM ===');
  const fixes = await db.collection('trackings').aggregate([
    { $match: { adminId: ADMIN, timestamp: { $gte: six } } },
    { $group: { _id: '$employeeId', n: {$sum:1}, first: {$min:'$timestamp'}, last: {$max:'$timestamp'}, acc: {$avg:'$accuracy'}, batt: {$last:'$batteryLevel'} } },
    { $sort: { last: -1 } },
  ]).toArray();
  if(!fixes.length) console.log('  (none)');
  for (const f of fixes) console.log('  ' + String(await nm(f._id)).padEnd(18), String(f.n).padStart(4)+' fixes', t(f.first)+' -> '+t(f.last), 'avgAcc '+Math.round(f.acc||0)+'m', 'batt '+(f.batt??'--'));

  console.log('\n=== TRACKER EVENTS after 6:00 PM ===');
  const evs = await db.collection('trackerevents').find({ adminId: ADMIN, at: { $gte: six } }).sort({at:1}).toArray();
  if(!evs.length) console.log('  (none)');
  for (const e of evs) console.log('  ' + t(e.at), String(await nm(e.employeeId)).padEnd(18), String(e.type).padEnd(18), (e.batteryLevel!=null?e.batteryLevel+'% ':'') + (e.meta?JSON.stringify(e.meta):''));

  console.log('\n=== GEOFENCE DECISIONS after 6:00 PM ===');
  const ga = await db.collection('geofenceaudits').aggregate([
    { $match: { adminId: ADMIN, createdAt: { $gte: six } } },
    { $group: { _id: { e:'$employeeId', d:'$decision', r:'$reason' }, n:{$sum:1}, last:{$max:'$createdAt'} } },
    { $sort: { last: -1 } },
  ]).toArray();
  if(!ga.length) console.log('  (none)');
  for (const g of ga) console.log('  ' + String(await nm(g._id.e)).padEnd(18), String(g._id.d).padEnd(12), String(g._id.r||'').padEnd(28), 'x'+g.n, 'last '+t(g.last));

  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
