/**
 * One-time migration to the dynamic biometric-machine registry.
 *
 *   node migrateDevices.js          # report only, changes nothing
 *   node migrateDevices.js --apply  # write the changes
 *
 * Does three things:
 *   1. Copies every SN:adminPhone pair out of the ESSL_DEVICES env var into the
 *      Device collection, so machines keep working once the env var is dropped.
 *   2. Normalises deviceUserId: trims whitespace and turns "" into null, so
 *      unmapped employees don't collide under the new partial unique index.
 *   3. Reports duplicate Biometric Device IDs within a company. These MUST be
 *      resolved by hand — the script will not guess which employee owns a PIN,
 *      because picking wrong silently misattributes attendance and pay. The
 *      unique index cannot build until they're gone.
 *
 * Safe to re-run.
 */
require('dotenv').config();
// Match src/index.js: the Atlas SRV record fails to resolve on some networks
// (notably local dev behind an ISP resolver), so pin public DNS before connecting.
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const connectDB = require('./src/config/db');

const User = require('./src/models/User');
const Device = require('./src/models/Device');

const APPLY = process.argv.includes('--apply');

function heading(text) {
    console.log(`\n${text}\n${'─'.repeat(text.length)}`);
}

async function migrateEnvDevices() {
    heading('1. Machines from ESSL_DEVICES');

    const raw = process.env.ESSL_DEVICES || '';
    if (!raw.trim()) {
        console.log('ESSL_DEVICES is empty or unset — nothing to import.');
        return;
    }

    const pairs = raw.split(',').map((s) => s.trim()).filter(Boolean);
    for (const pair of pairs) {
        const [snRaw, phone] = pair.split(':').map((s) => s.trim());
        if (!snRaw || !phone) {
            console.log(`  ✗ skipping malformed entry "${pair}" (expected SN:adminPhone)`);
            continue;
        }
        const serialNumber = snRaw.toUpperCase();

        const admin = await User.findOne({ phone, role: 'admin' }).select('_id name');
        if (!admin) {
            console.log(`  ✗ ${serialNumber} → no admin found with phone ${phone}; assign it by hand in Machines`);
            continue;
        }

        const existing = await Device.findOne({ serialNumber });
        if (existing) {
            console.log(`  = ${serialNumber} already registered (${existing.adminId ? 'assigned' : 'unassigned'})`);
            continue;
        }

        if (APPLY) {
            await Device.create({
                serialNumber,
                adminId: admin._id,
                status: 'active',
                label: 'Migrated from ESSL_DEVICES',
                autoDiscovered: false,
            });
        }
        console.log(`  ${APPLY ? '✓' : '→'} ${serialNumber} → ${admin.name}`);
    }
}

async function normalizeBlankPins() {
    heading('2. Blank Biometric Device IDs');

    const blanks = await User.countDocuments({ deviceUserId: '' });
    if (blanks === 0) {
        console.log('No empty-string device IDs found.');
    } else if (APPLY) {
        const r = await User.updateMany({ deviceUserId: '' }, { $set: { deviceUserId: null } });
        console.log(`  ✓ cleared ${r.modifiedCount} empty-string device ID(s) to null`);
    } else {
        console.log(`  → would clear ${blanks} empty-string device ID(s) to null`);
    }

    // Trim stray whitespace — " 1" never matches the "1" a device sends.
    const padded = await User.find({ deviceUserId: /(^\s+|\s+$)/ }).select('_id name deviceUserId');
    if (padded.length === 0) {
        console.log('No padded device IDs found.');
    } else {
        for (const u of padded) {
            const clean = u.deviceUserId.trim();
            if (APPLY) await User.updateOne({ _id: u._id }, { $set: { deviceUserId: clean || null } });
            console.log(`  ${APPLY ? '✓' : '→'} ${u.name}: "${u.deviceUserId}" → "${clean}"`);
        }
    }
}

async function reportDuplicatePins() {
    heading('3. Duplicate Biometric Device IDs (must be fixed by hand)');

    const dupes = await User.aggregate([
        { $match: { deviceUserId: { $type: 'string', $ne: '' } } },
        { $group: { _id: { adminId: '$adminId', pin: '$deviceUserId' }, count: { $sum: 1 }, users: { $push: { name: '$name', id: '$_id' } } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
    ]);

    if (dupes.length === 0) {
        console.log('None — the unique index can build cleanly. ✓');
        return true;
    }

    console.log(`Found ${dupes.length} clashing PIN(s). Punches for these are currently\nattributed to whichever employee the database returns first:\n`);
    for (const d of dupes) {
        const admin = await User.findById(d._id.adminId).select('name');
        console.log(`  PIN "${d._id.pin}" · ${admin?.name || d._id.adminId}`);
        for (const u of d.users) console.log(`      - ${u.name} (${u.id})`);
    }
    console.log(
        '\nClear the Biometric Device ID on whichever employees are wrong (or give them\n' +
        'their real PIN from the device), then re-run this script.'
    );
    return false;
}

async function buildIndex() {
    heading('4. Unique index on { adminId, deviceUserId }');

    const collection = mongoose.connection.db.collection('users');
    const existing = await collection.indexes();
    const old = existing.find(
        (i) => i.name === 'adminId_1_deviceUserId_1' && i.unique !== true,
    );
    const already = existing.find(
        (i) => i.name === 'adminId_1_deviceUserId_1' && i.unique === true,
    );

    if (already) {
        console.log('  = unique index already in place — nothing to do');
        return;
    }

    if (!APPLY) {
        if (old) console.log('→ would DROP the old non-unique index adminId_1_deviceUserId_1');
        console.log('→ would CREATE unique partial index on { adminId, deviceUserId }');
        return;
    }

    // NOTE: deliberately NOT User.syncIndexes(). syncIndexes() drops every index
    // absent from the schema, and this collection has production indexes the
    // schema doesn't describe — notably phone_1, which is unique with a partial
    // filter limiting it to admin/superadmin roles, while the schema declares a
    // plain global `unique: true`. Syncing would drop that and try to rebuild it
    // globally unique, breaking employees who legitimately share a phone number
    // across tenants. Create exactly the one index we want, nothing else.
    try {
        if (old) {
            // Mongo rejects two indexes with identical keys but different
            // options, so the old non-unique one has to go first.
            await collection.dropIndex('adminId_1_deviceUserId_1');
            console.log('  ✓ dropped old non-unique index adminId_1_deviceUserId_1');
        }
        await collection.createIndex(
            { adminId: 1, deviceUserId: 1 },
            { unique: true, partialFilterExpression: { deviceUserId: { $type: 'string' } } },
        );
        console.log('  ✓ unique index created — duplicate PINs now rejected by the database');
    } catch (err) {
        console.error(`  ✗ index build failed: ${err.message}`);
        console.error('    If this was a duplicate-key error, re-run the report above and clear the clash.');
    }
}

async function main() {
    await connectDB();
    console.log(APPLY ? '\n=== APPLYING CHANGES ===' : '\n=== DRY RUN (no changes written) ===');

    await migrateEnvDevices();
    await normalizeBlankPins();
    const clean = await reportDuplicatePins();

    if (clean) {
        await buildIndex();
    } else {
        heading('4. Unique index on { adminId, deviceUserId }');
        console.log('Skipped — resolve the duplicates above first.');
    }

    if (!APPLY) console.log('\nNothing was written. Re-run with --apply to commit.\n');
    await mongoose.connection.close();
    process.exit(0);
}

main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
