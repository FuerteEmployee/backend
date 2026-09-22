require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8','1.1.1.1']);
const mongoose = require('mongoose');
const User = require('../src/models/User');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const u = await User.findById('6aa53e822ea2f62fa4ddf071').select('name role adminId').lean();
  console.log(JSON.stringify(u));
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
