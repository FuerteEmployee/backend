require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8','1.1.1.1']);
const mongoose = require('mongoose');
const ClientError = require('../src/models/ClientError');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const errors = await ClientError.find({ employeeId: '6aa53e822ea2f62fa4ddf071' })
    .sort({ createdAt: -1 }).limit(15)
    .select('createdAt message url source')
    .lean();
  console.log('Recent ClientError rows:', errors.length);
  for (const e of errors) console.log(JSON.stringify(e));
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
