require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8','1.1.1.1']);
const mongoose = require('mongoose');
const Tracking = require('../src/models/Tracking');
const User = require('../src/models/User');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const bySource = await Tracking.aggregate([
    { $group: { _id: '$source', count: { $sum: 1 }, latest: { $max: '$createdAt' } } },
  ]);
  console.log('ALL tracking rows by source:');
  for (const s of bySource) console.log('  ' + JSON.stringify(s));

  const bg = await Tracking.find({ source: 'background' }).sort({ createdAt: -1 }).limit(10)
    .select('employeeId createdAt lat lng accuracy').lean();
  console.log(`\nsource=background rows: ${bg.length}`);
  for (const t of bg) {
    const u = await User.findById(t.employeeId).select('name').lean();
    console.log(`  ${u?.name || t.employeeId}  ${t.createdAt?.toISOString()}  acc=${t.accuracy}`);
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
