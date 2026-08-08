const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { calculateAndSaveSalary } = require('../src/controllers/salary_controller');
const Salary = require('../src/models/Salary');

async function run() {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/bot_db';
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);

    console.log('Finding August 2026 pending salary records...');
    const pendingSalaries = await Salary.find({ month: 8, year: 2026, status: 'pending' }).populate('employeeId');
    console.log(`Found ${pendingSalaries.length} pending August 2026 salary records.`);

    for (const sal of pendingSalaries) {
        const emp = sal.employeeId;
        if (!emp) continue;
        console.log(`Recalculating for ${emp.name} (${emp.email}), joiningDate: ${emp.joiningDate}`);
        const updated = await calculateAndSaveSalary(sal.adminId, emp, 8, 2026);
        console.log(`Updated record for ${emp.name}: Net Salary = ${updated.totalSalary}, Remarks = ${updated.remarks}, Payable Days = ${updated.payableDays}`);
    }

    await mongoose.disconnect();
    console.log('Done!');
}

run().catch(err => {
    console.error('Error running script:', err);
    process.exit(1);
});
