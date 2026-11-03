require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const ClientDevice = require('../src/models/ClientDevice');

const PILOT_ADMIN_IDS = ['6a6990c0835fb1fb12e33268', '6aa241437fbdaa2294482e5b'];

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const devices = await ClientDevice.find({ adminId: { $in: PILOT_ADMIN_IDS }, isNative: true })
    .select('adminId employeeId installId appVersion appBuild firstSeenAt lastSeenAt platform')
    .sort({ lastSeenAt: -1 })
    .lean();
  for (const d of devices) console.log(JSON.stringify(d));
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
