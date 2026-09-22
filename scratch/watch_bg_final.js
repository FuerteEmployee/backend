// Final gate: a source='background' Tracking row, which only appears once a
// device running the FIXED bundle is punched in. Also watches for the native
// syncer hitting the CORRECT path -- the old bug posted to /api/api/... and
// 404'd silently, so seeing /api/tracking/update/batch at all is itself proof.
require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8','1.1.1.1']);
const mongoose = require('mongoose');
const Tracking = require('../src/models/Tracking');
const User = require('../src/models/User');

const SINCE = new Date('2026-09-12T13:14:00.000Z'); // when 1.2.3 first landed on a device
const POLL_MS = 30_000;
const MAX_MIN = 9;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const deadline = Date.now() + MAX_MIN * 60_000;
  let found = false;
  while (Date.now() < deadline) {
    const bg = await Tracking.find({ source: 'background', createdAt: { $gt: SINCE } })
      .sort({ createdAt: -1 }).limit(10).select('employeeId createdAt accuracy').lean();
    if (bg.length) {
      console.log(`\n*** BACKGROUND TRACKING IS LIVE — ${bg.length} row(s) ***`);
      for (const t of bg) {
        const u = await User.findById(t.employeeId).select('name').lean();
        console.log(`  ${(u?.name||t.employeeId).trim()}  ${t.createdAt.toISOString()}  acc=${t.accuracy}`);
      }
      found = true;
      break;
    }
    const anyNew = await Tracking.countDocuments({ createdAt: { $gt: SINCE } });
    console.log(`[${new Date().toISOString().slice(11,19)}] background=0, any-new-tracking=${anyNew}`);
    await sleep(POLL_MS);
  }
  if (!found) console.log('\nNo background rows yet — still waiting on a punch-in from a device running 1.2.3.');
  await mongoose.disconnect();
  process.exit(found ? 0 : 2);
})().catch(e => { console.error(e); process.exit(1); });
