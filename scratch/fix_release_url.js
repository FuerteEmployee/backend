require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const AppRelease = require('../src/models/AppRelease');

const CORRECT_URL = 'https://api.beontimeofficial.com/bundles/bundle-1.2.1.zip';

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const before = await AppRelease.findOne({ version: '1.2.1' }).lean();
  console.log('before:', JSON.stringify(before));

  const updated = await AppRelease.findOneAndUpdate(
    { version: '1.2.1' },
    { $set: { url: CORRECT_URL } },
    { new: true }
  ).lean();
  console.log('after: ', JSON.stringify(updated));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
