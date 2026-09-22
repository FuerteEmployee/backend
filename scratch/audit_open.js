require('node:dns').setServers(['8.8.8.8','1.1.1.1']);
require('dotenv').config({ path: require('path').join(__dirname,'..','.env') });
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const A = db.collection('attendances');
  const yest = new Date(Date.now() - 24*3600*1000);

  const openOld = await A.countDocuments({ punchIn: {$ne:null}, punchOut: null, date: {$lt: yest} });
  console.log('open sessions older than 24h :', openOld);

  const dupes = await A.aggregate([
    { $group: { _id: { e:'$employeeId', d:'$dayKey' }, n:{$sum:1} } },
    { $match: { n: {$gt:1}, '_id.d': {$ne:null} } }, { $count:'dupes' },
  ]).toArray();
  console.log('duplicate employee-days       :', dupes[0]?.dupes ?? 0);

  const noKey = await A.countDocuments({ dayKey: null });
  console.log('rows missing dayKey           :', noKey);

  const cached = await db.collection('trackings').countDocuments({ cached: true });
  const totalTrk = await db.collection('trackings').estimatedDocumentCount();
  console.log('Tracking rows flagged cached  :', cached, 'of', totalTrk);

  const idx = await A.indexes();
  console.log('dayKey unique index exists    :', idx.some(i => i.unique && JSON.stringify(i.key).includes('dayKey')));

  await mongoose.disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
