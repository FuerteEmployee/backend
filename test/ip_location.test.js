// IP-based approximate location (src/utils/ip_location.js).
//
// No database: the city lookup reads the bundled DB-IP file, and the throttle
// and plausibility checks are pure. Run with plain Node:
//
//   node test/ip_location.test.js
const assert = require('node:assert/strict');
const { clientIp } = require('../src/utils/client_ip');
const {
    lookupIp,
    isPlausible,
    shouldRecord,
    POLL_EVERY_MS,
    GPS_FRESH_MS,
} = require('../src/utils/ip_location');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (e) {
        failed++;
        console.error(`  FAIL  ${name}`);
        console.error(`    ${e.message}`);
    }
}

function section(label) {
    console.log(`\n-- ${label} --`);
}

const MIN = 60 * 1000;
const NOW = Date.parse('2026-11-04T10:00:00Z');
const RAJKOT = { latitude: 22.3039, longitude: 70.8022 };
const MORBI = { latitude: 22.8173, longitude: 70.8378 };       // ~57 km from Rajkot
const NAVI_MUMBAI = { latitude: 19.1258, longitude: 73.0004 }; // Jio's hub, ~420 km

(async () => {
    section('lookupIp: city from a public address');

    await test('an IPv4 address resolves to a city with coordinates', async () => {
        const r = await lookupIp('8.8.8.8');
        assert.equal(r.country, 'US');
        assert.ok(r.city);
        assert.ok(Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
    });

    await test('an IPv6 address resolves too (Jio hands out IPv6 widely)', async () => {
        // Which country DB-IP files Google's anycast address under is its own
        // call (CA in the June 2026 data); only that it resolves is ours.
        const r = await lookupIp('2001:4860:4860::8888');
        assert.ok(r && r.country && Number.isFinite(r.latitude));
    });

    await test('an Indian mobile address resolves inside India', async () => {
        const r = await lookupIp('49.36.10.20');
        assert.equal(r.country, 'IN');
        assert.ok(r.region);
    });

    await test('private, loopback and malformed addresses give null, never a throw', async () => {
        for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.106', '172.20.0.1', 'fd00::1', 'not-an-ip', '', null, undefined]) {
            assert.equal(await lookupIp(ip), null, String(ip));
        }
    });

    section('clientIp: whose address is read');

    await test('behind Nginx the LAST X-Forwarded-For hop is used, not the client-written first one', () => {
        const req = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '1.2.3.4, 49.36.10.20' } };
        assert.equal(clientIp(req), '49.36.10.20');
    });

    await test('local development (loopback, no header) gives null, so nothing is recorded', () => {
        assert.equal(clientIp({ socket: { remoteAddress: '::1' }, headers: {} }), null);
    });

    section('shouldRecord: the throttle');

    await test('the first reading for an employee records', () => {
        assert.equal(shouldRecord({ last: undefined, ip: '49.36.10.20', trigger: 'poll', lastGpsAt: null, now: NOW }), true);
    });

    await test('no address, no reading', () => {
        assert.equal(shouldRecord({ last: undefined, ip: null, trigger: 'gps_off', lastGpsAt: null, now: NOW }), false);
    });

    await test('the poll records at most once per window on the same address', () => {
        const last = { at: NOW - (POLL_EVERY_MS - MIN), ip: '49.36.10.20' };
        assert.equal(shouldRecord({ last, ip: '49.36.10.20', trigger: 'poll', lastGpsAt: null, now: NOW }), false);
        const older = { at: NOW - POLL_EVERY_MS, ip: '49.36.10.20' };
        assert.equal(shouldRecord({ last: older, ip: '49.36.10.20', trigger: 'poll', lastGpsAt: null, now: NOW }), true);
    });

    await test('a changed address records at once: the phone moved network', () => {
        const last = { at: NOW - MIN, ip: '49.36.10.20' };
        assert.equal(shouldRecord({ last, ip: '106.205.10.10', trigger: 'poll', lastGpsAt: null, now: NOW }), true);
    });

    await test('a fresh GPS fix makes the poll skip: GPS is working', () => {
        const lastGpsAt = new Date(NOW - (GPS_FRESH_MS - MIN));
        assert.equal(shouldRecord({ last: undefined, ip: '49.36.10.20', trigger: 'poll', lastGpsAt, now: NOW }), false);
        const stale = new Date(NOW - GPS_FRESH_MS);
        assert.equal(shouldRecord({ last: undefined, ip: '49.36.10.20', trigger: 'poll', lastGpsAt: stale, now: NOW }), true);
    });

    await test('gps_off records even with a fresh GPS fix, but not twice within a minute', () => {
        const lastGpsAt = new Date(NOW - MIN);
        assert.equal(shouldRecord({ last: undefined, ip: '49.36.10.20', trigger: 'gps_off', lastGpsAt, now: NOW }), true);
        const last = { at: NOW - 30 * 1000, ip: '49.36.10.20' };
        assert.equal(shouldRecord({ last, ip: '49.36.10.20', trigger: 'gps_off', lastGpsAt, now: NOW }), false);
    });

    section('isPlausible: is this the phone, or the carrier hub?');

    await test('nothing to compare with gives null (unknown), not false', () => {
        assert.equal(isPlausible({ ...RAJKOT, timestamp: new Date(NOW) }, null), null);
    });

    await test('within 50 km of the last GPS fix is plausible however soon', () => {
        // ~22 km from Rajkot, one minute after the GPS fix: too fast to drive,
        // but well inside how wrong a city-level reading can be.
        assert.equal(isPlausible({ latitude: 22.5, longitude: 70.8, timestamp: new Date(NOW) }, { ...RAJKOT, timestamp: new Date(NOW - MIN) }), true);
    });

    await test('Rajkot to Morbi (~57 km) in one hour is plausible, in five minutes is not', () => {
        assert.equal(isPlausible({ ...MORBI, timestamp: new Date(NOW) }, { ...RAJKOT, timestamp: new Date(NOW - 60 * MIN) }), true);
        assert.equal(isPlausible({ ...MORBI, timestamp: new Date(NOW) }, { ...RAJKOT, timestamp: new Date(NOW - 5 * MIN) }), false);
    });

    await test('the limit is 80 km/h: Rajkot to Ahmedabad (~200 km) in 2 h is not plausible, in 3 h it is', () => {
        const AHMEDABAD = { latitude: 23.0225, longitude: 72.5714 };
        assert.equal(isPlausible({ ...AHMEDABAD, timestamp: new Date(NOW) }, { ...RAJKOT, timestamp: new Date(NOW - 120 * MIN) }), false);
        assert.equal(isPlausible({ ...AHMEDABAD, timestamp: new Date(NOW) }, { ...RAJKOT, timestamp: new Date(NOW - 180 * MIN) }), true);
    });

    await test('GPS in Rajkot, IP says Navi Mumbai an hour later: implausible (carrier hub)', () => {
        assert.equal(isPlausible({ ...NAVI_MUMBAI, timestamp: new Date(NOW) }, { ...RAJKOT, timestamp: new Date(NOW - 60 * MIN) }), false);
    });

    await test('...but after a full day on the road, the same distance is plausible', () => {
        assert.equal(isPlausible({ ...NAVI_MUMBAI, timestamp: new Date(NOW) }, { ...RAJKOT, timestamp: new Date(NOW - 8 * 60 * MIN) }), true);
    });

    console.log(`\n============================================`);
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log(`============================================`);
    process.exitCode = failed > 0 ? 1 : 0;
})();
