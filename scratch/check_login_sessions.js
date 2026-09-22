require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8','1.1.1.1']);
const mongoose = require('mongoose');
const LoginSession = require('../src/models/LoginSession');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const sessions = await LoginSession.find({ userId: '6aa53e822ea2f62fa4ddf071' })
    .sort({ createdAt: -1 }).limit(10)
    .select('createdAt type appName installId appVersion')
    .lean();
  console.log('Recent LoginSession rows for John:', sessions.length);
  for (const s of sessions) console.log(JSON.stringify(s));
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
