// The geofence decision, tested where it is cheapest to test: as a pure
// function over fabricated windows.
//
// Every abstention below is a safety rule that somebody's pay depends on, so
// each one is asserted by its REASON, not merely by "did not punch out" -- a
// test that only checks the outcome passes just as happily when the engine
// abstains for the wrong reason, which is how a broken guard hides.
//
// Run from the backend directory:  node scratch/test_geofence_decision.js
const path = require('path');
const SRC = path.join(__dirname, '..', 'src');
const { evaluateExit, isFieldRole, medoid, countDistinct } = require(path.join(SRC, 'utils/geofence_window'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

// A fixed clock. Never Date.now(): an expectation derived from the same call
// under test proves nothing.
const T0 = new Date('2026-09-12T10:00:00+05:30').getTime();
const at = (secondsAgo) => new Date(T0 - secondsAgo * 1000);
const NOW = new Date(T0);
const PUNCH_IN = new Date(T0 - 4 * 3600 * 1000); // 4h ago, well past the grace

const OFFICE = { _id: 'b1', branchName: 'HQ', latitude: 22.3039, longitude: 70.8022, radius: 100, geoFenceEnabled: true };

/** Metres east of the office, as a lat/lng. */
const away = (metres) => ({
    latitude: OFFICE.latitude,
    longitude: OFFICE.longitude + metres / (111320 * Math.cos(OFFICE.latitude * Math.PI / 180)),
});

/** A window of `n` fixes, each `spreadM` apart, centred `distM` from the office. */
function windowOf({ n = 6, distM = 2000, accuracy = 12, spanSec = 300, spreadM = 25, endSecAgo = 10 }) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const p = away(distM + i * spreadM);
        out.push({
            latitude: p.latitude,
            longitude: p.longitude,
            accuracy,
            timestamp: at(endSecAgo + Math.round((spanSec * (n - 1 - i)) / Math.max(1, n - 1))),
        });
    }
    return out;
}

const run = (over = {}) => evaluateExit({
    fixes: windowOf({}),
    branches: [OFFICE],
    fallbackRadius: 3000,
    now: NOW,
    punchInAt: PUNCH_IN,
    onLunch: false,
    ...over,
});

console.log('- confirmed exit: the one case that may act -');
{
    const r = run();
    ok('6 accurate fixes, 2 km away, over 5 min -> punch out', r.outside === true && r.reason === 'confirmed_exit', JSON.stringify(r.reason));
    ok('distance is reported', r.evidence.distanceM > 1900, `${r.evidence.distanceM}`);
    ok('threshold is radius + buffer', r.evidence.thresholdM === 100 + 50, `${r.evidence.thresholdM}`);
}

console.log('\n- abstentions: each one is a safety rule -');
ok('fewer than 5 usable fixes',
    run({ fixes: windowOf({ n: 4 }) }).reason === 'too_few_fixes');

ok('every fix too inaccurate (>35m)',
    run({ fixes: windowOf({ accuracy: 80 }) }).reason === 'no_trustworthy_fix');

// THE most important assertion here. Every APK in the field sends `accuracy||0`
// for an unreported reading, and 0 must read as UNKNOWN, never as a perfect fix.
ok('accuracy 0 is UNKNOWN, not perfect',
    run({ fixes: windowOf({ accuracy: 0 }) }).reason === 'no_trustworthy_fix');
ok('accuracy null is untrusted',
    run({ fixes: windowOf({ accuracy: null }) }).reason === 'no_trustworthy_fix');
ok('accuracy negative is untrusted',
    run({ fixes: windowOf({ accuracy: -5 }) }).reason === 'no_trustworthy_fix');

ok('window spanning under 90s',
    run({ fixes: windowOf({ spanSec: 30 }) }).reason === 'window_too_short');

// The real incident: one phantom coordinate repeated 76 times produced 29 wrong
// auto punch-outs. Many readings of the SAME place is one observation.
ok('20 fixes at ONE identical position',
    run({ fixes: windowOf({ n: 20, spreadM: 0 }) }).reason === 'too_few_distinct_positions');

// 12 min old: inside the 15-minute window, past the 10-minute freshness limit.
ok('newest usable fix is 12 min old -> stale',
    run({ fixes: windowOf({ endSecAgo: 12 * 60, spanSec: 120 }) }).reason === 'stale_fixes',
    JSON.stringify(run({ fixes: windowOf({ endSecAgo: 12 * 60, spanSec: 120 }) }).reason));

// Beyond the window entirely: the phone has gone silent, which is a DIFFERENT
// operational problem from poor accuracy and must not be reported as one.
ok('nothing at all in the window -> no_fixes, not an accuracy complaint',
    run({ fixes: windowOf({ endSecAgo: 30 * 60 }) }).reason === 'no_fixes',
    JSON.stringify(run({ fixes: windowOf({ endSecAgo: 30 * 60 }) }).reason));
ok('a silent phone never punches anyone out',
    run({ fixes: [] }).outside === false && run({ fixes: [] }).reason === 'no_fixes');

// 105..145 m, 8 m apart: inside the 100-150 m buffer band, and far enough
// apart to clear the 15 m distinctness epsilon.
// 5 fixes (== MIN_FIXES, so all 5 are the deciding set), 16m apart -- clears
// the new 15m pairwise-distinctness guard -- landing between the 100m radius
// and the 150m threshold (radius + 50m buffer).
ok('between radius and exit threshold -> buffer',
    run({ fixes: windowOf({ n: 5, distM: 110, spreadM: 16 }) }).reason === 'within_buffer',
    JSON.stringify(run({ fixes: windowOf({ n: 5, distM: 110, spreadM: 16 }) }).reason));

console.log('\n- suppressions: rules that forbid acting at all -');
ok('punched in 20s ago -> grace period',
    run({ punchInAt: new Date(T0 - 20 * 1000) }).reason === 'grace_period');
ok('on lunch -> fence does not apply',
    run({ onLunch: true }).reason === 'on_lunch');
ok('fence switched off for the branch',
    run({ branches: [{ ...OFFICE, geoFenceEnabled: false }] }).reason === 'no_branch');
// Must NOT fall through to a punch-out -- that was a real bug in the reference.
ok('branch with no coordinates does NOT punch out',
    run({ branches: [{ ...OFFICE, latitude: null, longitude: null }] }).outside === false);
ok('no branches at all does NOT punch out',
    run({ branches: [] }).outside === false);

console.log('\n- the medoid: why not a mean -');
console.log('\n- the repeated-coordinate guard: the reference\'s actual incident -');
{
    // 3 identical wifi-phantom readings 400m out + 2 real desk fixes 20m apart.
    // Overall distinct count is 3 (>= MIN_DISTINCT), so the coarse guard alone
    // would pass this straight through -- and the medoid of these 5 points is
    // pulled onto the REPEATED phantom (it has zero distance to its own two
    // twins, so its total distance to the other four is smaller than either
    // desk fix's). This is the exact shape that produced 29 wrong auto
    // punch-outs across 4 employees in the reference.
    const phantom = away(400);
    const desk1 = away(10);
    const desk2 = away(30);
    const fixes = [
        { latitude: desk1.latitude, longitude: desk1.longitude, accuracy: 10, timestamp: at(300) },
        { latitude: phantom.latitude, longitude: phantom.longitude, accuracy: 10, timestamp: at(240) },
        { latitude: phantom.latitude, longitude: phantom.longitude, accuracy: 10, timestamp: at(180) },
        { latitude: desk2.latitude, longitude: desk2.longitude, accuracy: 10, timestamp: at(120) },
        { latitude: phantom.latitude, longitude: phantom.longitude, accuracy: 10, timestamp: at(60) },
    ];
    const r = run({ fixes });
    ok('3 identical phantom + 2 real desk fixes -> abstains, does NOT punch out',
        r.outside === false, JSON.stringify(r.reason));
    ok('the specific reason is repeated_coordinate, not a coincidental pass',
        r.reason === 'repeated_coordinate', JSON.stringify(r.reason));
}

{
    // Five fixes at the desk, one wifi phantom 5 km away. A mean lands ~800m
    // out and punches an employee out who never moved.
    const desk = [];
    for (let i = 0; i < 5; i++) {
        const p = away(10 + i * 4);
        desk.push({ latitude: p.latitude, longitude: p.longitude, accuracy: 10, timestamp: at(300 - i * 60) });
    }
    const phantom = away(5000);
    const fixes = [...desk, { latitude: phantom.latitude, longitude: phantom.longitude, accuracy: 10, timestamp: at(5) }];

    const r = run({ fixes });
    ok('one wild outlier does NOT drag the verdict outside', r.outside === false, JSON.stringify(r.reason));

    const m = medoid(fixes);
    ok('medoid is an OBSERVED point, not an average',
        fixes.some((f) => f.latitude === m.latitude && f.longitude === m.longitude));
    ok('medoid sits in the cluster, not near the phantom',
        Math.abs(m.longitude - phantom.longitude) > 1e-4);
}

console.log('\n- close time: the employee must not pay for our caution -');
{
    // Starts inside, walks out. The session should end when they were last
    // demonstrably INSIDE, not at the moment we became certain.
    const fixes = [];
    for (let i = 0; i < 4; i++) {
        const p = away(20 + i * 5);
        fixes.push({ latitude: p.latitude, longitude: p.longitude, accuracy: 10, timestamp: at(600 - i * 60) });
    }
    const lastInside = fixes[fixes.length - 1].timestamp;
    for (let i = 0; i < 5; i++) {
        const p = away(3000 + i * 40);
        fixes.push({ latitude: p.latitude, longitude: p.longitude, accuracy: 10, timestamp: at(300 - i * 60) });
    }
    const r = run({ fixes });
    ok('walking out is detected', r.outside === true, JSON.stringify(r.reason));
    ok('lastInsideAt is the final INSIDE fix, not now',
        r.lastInsideAt && new Date(r.lastInsideAt).getTime() === lastInside.getTime(),
        `got ${r.lastInsideAt}`);
}

console.log('\n- helpers -');
ok('countDistinct collapses near-identical points', countDistinct([
    { latitude: 22.3, longitude: 70.8 },
    { latitude: 22.3, longitude: 70.8 },
    { latitude: 22.3, longitude: 70.8 },
]) === 1);
// Exemption must read fields that EXIST on the User schema. `designation` and
// `jobTitle` do not, so matching against them exempted nobody -- and the cost of
// that is a salesperson punched out on arrival at every customer.
ok('explicit geofenceExempt flag exempts', isFieldRole({ geofenceExempt: true }) === true);
ok('field department exempts', isFieldRole({ departmentId: { name: 'Field Sales' } }) === true);
ok('office department does not exempt', isFieldRole({ departmentId: { name: 'Accounts' } }) === false);
ok('an employee already granted remote punch is exempt',
    isFieldRole({ attendanceExceptions: { overrideGlobal: true, remotePunch: true } }) === true);
ok('a plain employee is not exempt', isFieldRole({ role: 'employee' }) === false);
ok('a non-existent designation field cannot exempt anyone',
    isFieldRole({ designation: 'Field Sales Executive' }) === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
