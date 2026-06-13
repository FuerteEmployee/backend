require('dotenv').config();
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const User = require('./src/models/User');

async function seedAdmin() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    
    let admin = await User.findOne({ role: 'admin' });
    if (!admin) {
        admin = await User.create({
            role: 'admin',
            name: 'Super Admin',
            phone: '9999999999',
            email: 'admin@example.com',
            subscriptionPlan: 'pro',
            isActive: true
        });
        console.log('✅ Admin user created successfully in ATLAS! Phone: 9999999999');
    } else {
        console.log(`ℹ️ Admin user already exists in ATLAS. Phone: ${admin.phone}`);
    }
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding admin:', error);
    process.exit(1);
  }
}

seedAdmin();
