require('dotenv').config();
const connectDB = require('../src/config/db');
const User = require('../src/models/User');

async function check() {
    await connectDB();
    const user = await User.findOne({ phone: '635367931118' });
    console.log('User found:', JSON.stringify(user, null, 2));
    process.exit(0);
}

check().catch(console.error);
