require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Department = require('../models/Department');
const Shift = require('../models/Shift');

// --- CONFIG ---
const ADMIN_ID = '6a2d11c3bee6693b7ae623ab'; // vidhyadeep academy

const DOB          = new Date(Date.UTC(2002, 1, 2));  // 02-02-2002
const JOINING_DATE = new Date(Date.UTC(2026, 5, 16)); // 16-06-2026

// Branch mapping (data label -> actual branchName)
const BRANCH_MAP = {
    Vidyadeep: 'Vidyadeep Academy - Ramapir',
    Nebula:    'Nebula Preschool - Sadhuvaswani',
    Both:      'Vidyadeep Academy - Ramapir',
};

// Designation (data) -> Department name (existing). Handles the typos in source data.
const DEPT_MAP = {
    'Academic Head':              'Academic Head',
    'H.K.G Teacher':              'H.K.G Teacher',
    'Playgroup teacher':          'Playgroup teacher',
    'Playgruop Teacher':          'Playgroup teacher',
    'Nursery Teacher':            'Nursery Teacher',
    'L.K.G Teacher':              'L.K.G Teacher',
    'Ayamasi':                    'Ayamasi',
    'Secondary Teacher':          'Secondary Teacher',
    'Higher - Secondary Teacher': 'Higher - Secondary Teacher',
    'Primary Teacher':            'Primary Teacher',
};

// Full source list (Admin department intentionally excluded).
// The 4 already-added employees are skipped automatically (existing phone).
const ROWS = [
    { name: 'Sweta Vora',         designation: 'L.K.G Teacher',              phone: '9662756665', branch: 'Vidyadeep' },
    { name: 'Heena Sakariya',     designation: 'Playgruop Teacher',          phone: '8200803328', branch: 'Nebula' },
    { name: 'Bharti Bhinde',      designation: 'L.K.G Teacher',              phone: '7567459922', branch: 'Nebula' },
    { name: 'Alpa Jagda',         designation: 'Nursery Teacher',            phone: '7874010902', branch: 'Nebula' },
    { name: 'Hema Popat',         designation: 'Nursery Teacher',            phone: '8141742740', branch: 'Nebula' },
    { name: 'Krishna Siddhpura',  designation: 'H.K.G Teacher',              phone: '7069038952', branch: 'Nebula' },
    { name: 'Neepa Parmar',       designation: 'Playgroup teacher',          phone: '8160305998', branch: 'Nebula' },
    { name: 'Bhavna Lolariya',    designation: 'Playgroup teacher',          phone: '9712977175', branch: 'Nebula' },
    { name: 'Neeta Dholakiya',    designation: 'Ayamasi',                    phone: '9875152975', branch: 'Nebula' },
    { name: 'Usha Rathod',        designation: 'Ayamasi',                    phone: '9023144234', branch: 'Nebula' },
    { name: 'Jasmin Kureshi',     designation: 'Ayamasi',                    phone: '9724161237', branch: 'Vidyadeep' },
    { name: 'Muffadal Africawala', designation: 'Secondary Teacher',         phone: '9016026099', branch: 'Vidyadeep' },
    { name: 'Dharmesh Jalu',      designation: 'Secondary Teacher',          phone: '9737811500', branch: 'Vidyadeep' },
    { name: 'Siddharth Kamani',   designation: 'Secondary Teacher',          phone: '9909390442', branch: 'Vidyadeep' },
    { name: 'Simran Kaur',        designation: 'Secondary Teacher',          phone: '7622092037', branch: 'Vidyadeep' },
    { name: 'Dev Ghumnani',       designation: 'Higher - Secondary Teacher', phone: '9664628563', branch: 'Vidyadeep' },
    { name: 'Kartik Jasani',      designation: 'Higher - Secondary Teacher', phone: '9825315601', branch: 'Vidyadeep' },
    { name: 'Vandana Jobanputra', designation: 'Higher - Secondary Teacher', phone: '7622812153', branch: 'Vidyadeep' },
    { name: 'Bhaumik sir',        designation: 'Higher - Secondary Teacher', phone: '8087377353', branch: 'Vidyadeep' },
    { name: 'Dev Bagadia',        designation: 'Primary Teacher',            phone: '9023650907', branch: 'Vidyadeep' },
    { name: 'Rohit Kanjani',      designation: 'Primary Teacher',            phone: '9998207630', branch: 'Both' },
    { name: 'Zeel Lathiya',       designation: 'Primary Teacher',            phone: '8200818138', branch: 'Both' },
];

const norm = s => String(s || '').trim().toLowerCase();

async function seed() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    const adminId = new mongoose.Types.ObjectId(ADMIN_ID);

    const branches = await Branch.find({ adminId }).lean();
    const depts    = await Department.find({ adminId }).lean();
    const shift    = await Shift.findOne({ adminId }).lean();
    if (!shift) throw new Error('No shift found for this admin');

    const findBranch = label => {
        const target = norm(BRANCH_MAP[label]);
        const b = branches.find(x => norm(x.branchName) === target);
        if (!b) throw new Error(`Branch not found for "${label}" -> "${BRANCH_MAP[label]}"`);
        return b._id;
    };
    const findDept = designation => {
        const target = norm(DEPT_MAP[designation]);
        if (!target) throw new Error(`No dept mapping for designation "${designation}"`);
        const d = depts.find(x => norm(x.name) === target);
        if (!d) throw new Error(`Department not found "${DEPT_MAP[designation]}"`);
        return d._id;
    };

    let created = 0, skipped = 0;
    for (const r of ROWS) {
        const exists = await User.findOne({ phone: r.phone }).select('_id name').lean();
        if (exists) {
            console.log(`⏭️  Skip ${r.name} (${r.phone}) — already exists as "${exists.name}"`);
            skipped++;
            continue;
        }
        await User.create({
            role: 'employee',
            adminId,
            name: r.name,
            phone: r.phone,
            departmentId: findDept(r.designation),
            branchId: findBranch(r.branch),
            shiftId: shift._id,
            dob: DOB,
            joiningDate: JOINING_DATE,
            employmentType: 'monthly',
            status: 'active',
            isActive: true,
        });
        console.log(`✅ Created ${r.name} — ${DEPT_MAP[r.designation]} @ ${BRANCH_MAP[r.branch]}`);
        created++;
    }

    console.log(`\n📊 Done. Created: ${created}, Skipped (existing): ${skipped}, Total rows: ${ROWS.length}`);
    await mongoose.disconnect();
    console.log('🔌 Disconnected.');
}

seed().catch(err => { console.error('❌ Seed failed:', err); process.exit(1); });
