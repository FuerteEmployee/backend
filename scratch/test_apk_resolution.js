/**
 * Which APK does a given tenant get offered?
 *
 *   node scratch/test_apk_resolution.js
 *
 * In-memory mongod; never touches MONGO_URI.
 *
 * The bug this exists to prevent: resolving "pilot first, then production"
 * means any tenant with a pilot release stops seeing newer general releases
 * entirely — the pilot branch matches, so the fallback never runs. A device on
 * code 8 was told it was up to date while code 9 sat published. The bundle path
 * has the same flaw; scratch/disable_stale_pilot.js is the manual workaround
 * someone already had to write for it.
 *
 * The rule is: eligibility filters, recency chooses.
 */
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SRC = path.join(__dirname, '..', 'src');
const ApkRelease = require(path.join(SRC, 'models/ApkRelease'));
const { getApkRelease } = require(path.join(SRC, 'controllers/app_release_controller'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

const TENANT = new mongoose.Types.ObjectId();
const OTHER = new mongoose.Types.ObjectId();

function mockRes() {
    const r = { statusCode: 200, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
}

const ask = async (customId) => {
    const res = mockRes();
    await getApkRelease({ query: customId ? { custom_id: String(customId) } : {} }, res);
    return res.body;
};

const make = (versionCode, channel, pilots = [], enabled = true) => ApkRelease.create({
    versionName: `v${versionCode}`, versionCode, channel, pilotAdminIds: pilots, enabled,
    url: `https://example.test/apks/v${versionCode}.apk`, platform: 'android',
});

(async () => {
    const mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { dbName: 'apk_resolution_test' });
    console.log('connected to in-memory mongod\n');

    console.log('- the regression: a stale pilot must not hide a newer release -');
    await ApkRelease.deleteMany({});
    await make(8, 'pilot', [TENANT]);
    await make(9, 'production');
    let r = await ask(TENANT);
    ok('a tenant with an OLD pilot still gets the newer production build',
        r.versionCode === 9, JSON.stringify(r));

    console.log('\n- piloting still works when the pilot is ahead -');
    await ApkRelease.deleteMany({});
    await make(9, 'production');
    await make(10, 'pilot', [TENANT]);
    r = await ask(TENANT);
    ok('the piloting tenant gets the newer pilot build', r.versionCode === 10, JSON.stringify(r));
    r = await ask(OTHER);
    ok('everyone else stays on production', r.versionCode === 9, JSON.stringify(r));
    r = await ask(null);
    ok('a device with no tenant id gets production', r.versionCode === 9, JSON.stringify(r));

    console.log('\n- scoping and the kill switch -');
    await ApkRelease.deleteMany({});
    await make(11, 'pilot', [TENANT]);
    r = await ask(OTHER);
    ok('another tenant is not offered someone else\'s pilot',
        r.kind === 'up_to_date', JSON.stringify(r));
    r = await ask(TENANT);
    ok('the pilot tenant is', r.versionCode === 11, JSON.stringify(r));

    await ApkRelease.deleteMany({});
    await make(12, 'production', [], false);
    await make(11, 'production');
    r = await ask(TENANT);
    ok('a disabled release is skipped and the previous one is offered',
        r.versionCode === 11, JSON.stringify(r));

    await ApkRelease.deleteMany({});
    r = await ask(TENANT);
    ok('no releases at all is not an error', r.kind === 'up_to_date', JSON.stringify(r));

    console.log('\n- malformed input -');
    r = await ask('not-an-objectid');
    ok('a junk custom_id degrades to production, never throws',
        r && (r.kind === 'up_to_date' || typeof r.versionCode === 'number'), JSON.stringify(r));

    console.log(`\n${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    await mongod.stop();
    process.exit(fail === 0 ? 0 : 1);
})().catch(async (err) => {
    console.error('\nTEST HARNESS ERROR:', err);
    try { await mongoose.disconnect(); } catch { /* already down */ }
    process.exit(1);
});
