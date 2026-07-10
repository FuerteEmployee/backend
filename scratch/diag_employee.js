const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const users = db.collection('users');

  const targetId = '6a477747f97ef22e5e57a595';
  let target;
  try {
    target = await users.findOne({ _id: new mongoose.Types.ObjectId(targetId) });
  } catch (e) {
    console.log('Could not cast id as ObjectId:', e.message);
  }

  if (!target) {
    console.log('No user found with _id', targetId);
    process.exit(0);
  }

  console.log('Target employee:', {
    _id: target._id,
    name: target.name,
    phone: target.phone,
    adminId: target.adminId,
    shiftId: target.shiftId,
    shiftIds: target.shiftIds,
  });

  const dupes = await users.find({ phone: target.phone, _id: { $ne: target._id } }).toArray();
  console.log(`Other users sharing phone "${target.phone}":`, dupes.length);
  dupes.forEach(d => console.log(' -', { _id: d._id, name: d.name, adminId: d.adminId, role: d.role }));

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
