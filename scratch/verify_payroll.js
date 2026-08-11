const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { calculateAndSaveSalary } = require('../src/controllers/salary_controller');
const User = require('../src/models/User');
const Settings = require('../src/models/Settings');
const Salary = require('../src/models/Salary');

async function run() {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/bot_db';
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);

    const emp = await User.findOne({ name: /tirth-brij/i });
    if (!emp) {
        console.error('Employee not found!');
        process.exit(1);
    }
    console.log(`Testing payroll calculation for ${emp.name}...`);
    
    const settings = await Settings.findOne({ adminId: emp.adminId });
    if (!settings) {
        console.error('Settings not found!');
        process.exit(1);
    }

    const originalSandwich = settings.payroll?.sandwichRuleEnabled ?? true;

    // Test Scenario 1: Sandwich Rule ENABLED
    console.log('\n--- Scenario 1: Sandwich Rule ENABLED ---');
    settings.payroll.sandwichRuleEnabled = true;
    await settings.save();
    console.log('Saved settings with sandwichRuleEnabled = true.');

    let salRecord1 = await calculateAndSaveSalary(emp.adminId, emp, 8, 2026);
    console.log('Calculation result:');
    console.log(`- Base Salary: ${salRecord1.baseSalary}`);
    console.log(`- Net Salary: ${salRecord1.totalSalary}`);
    console.log(`- Payable Days: ${salRecord1.payableDays}`);
    console.log(`- Total Days in Window: ${salRecord1.totalDaysInWindow}`);
    console.log(`- Remarks: ${salRecord1.remarks}`);

    if (salRecord1.payableDays === 0 && salRecord1.totalSalary === 0) {
        console.log('✅ Scenario 1 Passed (0 payable days, 0 salary)');
    } else {
        console.error('❌ Scenario 1 Failed! Expected 0 payable days and 0 salary.');
    }

    // Test Scenario 2: Sandwich Rule DISABLED
    console.log('\n--- Scenario 2: Sandwich Rule DISABLED ---');
    settings.payroll.sandwichRuleEnabled = false;
    await settings.save();
    console.log('Saved settings with sandwichRuleEnabled = false.');

    let salRecord2 = await calculateAndSaveSalary(emp.adminId, emp, 8, 2026);
    console.log('Calculation result:');
    console.log(`- Base Salary: ${salRecord2.baseSalary}`);
    console.log(`- Net Salary: ${salRecord2.totalSalary}`);
    console.log(`- Payable Days: ${salRecord2.payableDays}`);
    console.log(`- Total Days in Window: ${salRecord2.totalDaysInWindow}`);
    console.log(`- Remarks: ${salRecord2.remarks}`);

    if (salRecord2.payableDays === 1 && salRecord2.totalSalary === 323) {
        console.log('✅ Scenario 2 Passed (1 payable day, 323 salary)');
    } else {
        console.error('❌ Scenario 2 Failed! Expected 1 payable day and 323 salary.');
    }

    // Revert settings to original
    console.log('\nReverting settings to original state...');
    settings.payroll.sandwichRuleEnabled = originalSandwich;
    await settings.save();

    await mongoose.disconnect();
    console.log('Done!');
}

run().catch(err => {
    console.error('Error running verification script:', err);
    process.exit(1);
});
