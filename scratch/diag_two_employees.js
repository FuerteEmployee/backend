const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const users = db.collection('users');
  const salaries = db.collection('salaries');
  const attendances = db.collection('attendances');
  const settingsColl = db.collection('settings');

  const emails = ['bvhdh@gmail.com', 'bharat@gmail.com'];
  const emps = await users.find({ email: { $in: emails } }).toArray();

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  for (const emp of emps) {
    console.log('\n================================================');
    console.log('Employee:', emp.name, emp.email, emp.phone);
    console.log('_id:', emp._id.toString(), 'adminId:', emp.adminId?.toString());
    console.log('employmentType:', emp.employmentType || 'monthly(default)');
    console.log('salary(base):', emp.salary);
    console.log('salaryComponents:', JSON.stringify(emp.salaryComponents, null, 2));
    console.log('weeklyHolidays:', emp.weeklyHolidays);
    console.log('payrollOverride:', JSON.stringify(emp.payrollOverride || {}, null, 2));

    const settings = await settingsColl.findOne({ adminId: emp.adminId });
    console.log('\nSettings.payroll:', JSON.stringify(settings?.payroll || {}, null, 2));
    console.log('Settings.attendance:', JSON.stringify(settings?.attendance || {}, null, 2));

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    const att = await attendances.find({
      adminId: emp.adminId,
      employeeId: emp._id,
      date: { $gte: startDate, $lte: endDate },
    }).sort({ date: 1 }).toArray();

    console.log(`\nAttendance records for ${month}/${year}: ${att.length}`);
    att.forEach(a => {
      console.log(' -', a.date.toISOString().split('T')[0], 'status:', a.status, 'punchIn:', a.punchIn, 'punchOut:', a.punchOut);
    });

    const sal = await salaries.find({ adminId: emp.adminId, employeeId: emp._id }).sort({ year: -1, month: -1 }).toArray();
    console.log(`\nSalary records: ${sal.length}`);
    sal.forEach(s => {
      console.log(' -', `${s.month}/${s.year}`, 'status:', s.status, 'baseSalary:', s.baseSalary, 'gross:', s.grossSalary, 'net:', s.netSalary, 'totalSalary:', s.totalSalary, 'deductions:', s.deductions);
      console.log('   payableDays:', s.payableDays, 'totalDaysInWindow:', s.totalDaysInWindow, 'buckets:', JSON.stringify(s.buckets));
      console.log('   remarks:', s.remarks);
      console.log('   earnings:', JSON.stringify(s.breakdown?.earnings));
      console.log('   deductions_list:', JSON.stringify(s.breakdown?.deductions));
    });
  }

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
