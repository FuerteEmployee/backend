require('node:dns').setServers(['8.8.8.8','1.1.1.1']);
require('dotenv').config({ path: require('path').join(__dirname,'..','.env') });
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const rows = await mongoose.connection.db.collection('clientdevices').aggregate([
    { $group: { _id: '$appVersion', n: { $sum: 1 }, last: { $max: '$lastSeenAt' } } },
    { $sort: { last: -1 } },
  ]).toArray();
  for (const r of rows) console.log(String(r._id).padEnd(16), r.n, 'device(s)  last seen', new Date(r.last).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}));
  await mongoose.disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
