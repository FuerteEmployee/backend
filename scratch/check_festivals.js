const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

async function checkFestivals() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const Festival = require('../models/Festival');
        const festivals = await Festival.find({});
        console.log(`Found ${festivals.length} festivals.`);
        festivals.forEach(f => console.log(`- ${f.name} (${f.startDate} to ${f.endDate}) for admin: ${f.adminId}`));
        await mongoose.disconnect();
    } catch (error) {
        console.error(error);
    }
}

checkFestivals();
