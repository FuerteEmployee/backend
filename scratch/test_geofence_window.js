const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const { evaluateExit } = require(path.join(SRC, 'utils/geofence_window'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

const NOW = new Date('2026-09-12T04:30:00.000Z');
const BASE = new Date('2026-09-12T04:20:00.000Z').getTime();
const OFFICE = {
    _id: 'office', branchName: 'HQ', latitude: 22.3039, longitude: 70.8022,
    radius: 100, geoFenceEnabled: true,
};
const at = (secondsAfterBase) => new Date(BASE + secondsAfterBase * 1000);
const point = (metres) => ({
    latitude: OFFICE.latitude,
    longitude: OFFICE.longitude + metres / (111320 * Math.cos(OFFICE.latitude * Math.PI / 180)),
});

function fixes({ n = 6, distance = 2000, accuracy = 10, spanSeconds = 300, spread = 25, lastAt = 590 } = {}) {
    return Array.from({ length: n }, (_, i) => {
        const p = point(distance + i * spread);
        return {
            ...p,
            accuracy,
            timestamp: at(lastAt - spanSeconds + Math.round(spanSeconds * i / Math.max(1, n - 1))),
        };
    });
}

function run(overrides = {}) {
    return evaluateExit({
        fixes: fixes(),
        branches: [OFFICE],
        fallbackRadius: 3000,
        now: NOW,
        punchInAt: at(-4 * 3600),
        onLunch: false,
        ...overrides,
    });
}

console.log('- safety abstentions -');
let r = run({ fixes: fixes({ n: 4 }) });
ok('fewer than 5 trusted fixes abstains', r.outside === false && r.reason === 'too_few_fixes', r.reason);

r = run({ fixes: fixes({ accuracy: 36 }) });
ok('all fixes over 35m accuracy abstain', r.outside === false && r.reason === 'no_trustworthy_fix', r.reason);

r = run({ fixes: fixes({ accuracy: 0 }) });
ok('accuracy 0 is unreported, not perfect', r.outside === false && r.reason === 'no_trustworthy_fix', r.reason);

for (const [label, accuracy] of [['null', null], ['NaN', NaN], ['negative', -1]]) {
    r = run({ fixes: fixes({ accuracy }) });
    ok(`accuracy ${label} abstains`, r.outside === false && r.reason === 'no_trustworthy_fix', r.reason);
}

r = run({ fixes: fixes({ spanSeconds: 89 }) });
ok('trusted window under 90 seconds abstains', r.outside === false && r.reason === 'window_too_short', r.reason);

r = run({ fixes: fixes({ n: 20, spread: 0 }) });
ok('20 identical fixes abstain as one position', r.outside === false && r.reason === 'too_few_distinct_positions', r.reason);

r = run({ fixes: fixes({ spanSeconds: 120, lastAt: -120 }) });
ok('newest trusted fix older than 10 minutes abstains', r.outside === false && r.reason === 'stale_fixes', r.reason);

// n:5 (== MIN_FIXES, so all 5 are the deciding set) spaced 16m apart -- clears
// the pairwise-distinctness guard added for the repeated-coordinate fix, and
// the medoid (the middle, colinear point) lands at 144m: inside the 150m
// exit threshold but past the 100m radius.
r = run({ fixes: fixes({ n: 5, distance: 112, spread: 16 }) });
ok('distance between fence and buffer abstains', r.outside === false && r.reason === 'within_buffer', r.reason);

r = run({ punchInAt: new Date(NOW.getTime() - 59 * 1000) });
ok('punch-in less than 60 seconds ago is suppressed', r.outside === false && r.decision === 'suppressed' && r.reason === 'grace_period', r.reason);

r = run({ onLunch: true });
ok('lunch is suppressed', r.outside === false && r.decision === 'suppressed' && r.reason === 'on_lunch', r.reason);

r = run({ branches: [{ ...OFFICE, geoFenceEnabled: false }] });
ok('disabled branch is suppressed', r.outside === false && r.decision === 'suppressed' && r.reason === 'no_branch', r.reason);

r = run({ branches: [{ ...OFFICE, latitude: null, longitude: null }] });
ok('branch without coordinates is suppressed', r.outside === false && r.decision === 'suppressed' && r.reason === 'no_branch', r.reason);

console.log('\n- confirmed exit -');
r = run();
ok('six accurate, distinct, five-minute fixes 2 km away confirm exit', r.outside === true && r.reason === 'confirmed_exit', r.reason);

console.log('\n- medoid resilience -');
const cluster = [0, 20, 40, 60, 80].map((metres, i) => ({
    ...point(metres), accuracy: 10, timestamp: at(290 + i * 60),
}));
const wild = { ...point(5000), accuracy: 10, timestamp: at(590) };
r = run({ fixes: [...cluster, wild] });
ok('office cluster plus one wild 5 km fix remains inside', r.outside === false && r.reason === 'within_fence', r.reason);
ok('medoid is exactly an observed cluster point',
    cluster.some((f) => f.latitude === r.evidence.medoidLat && f.longitude === r.evidence.medoidLng),
    `${r.evidence.medoidLat},${r.evidence.medoidLng}`);

console.log('\n- close time evidence -');
const inside = [20, 40, 60].map((metres, i) => ({
    ...point(metres), accuracy: 10, timestamp: at(60 + i * 60),
}));
const outside = [2000, 2030, 2060, 2090, 2120, 2150].map((metres, i) => ({
    ...point(metres), accuracy: 10, timestamp: at(300 + i * 50),
}));
r = run({ fixes: [...inside, ...outside] });
ok('inside-to-outside window confirms exit', r.outside === true && r.reason === 'confirmed_exit', r.reason);
ok('lastInsideAt is the final inside timestamp',
    r.lastInsideAt && new Date(r.lastInsideAt).getTime() === inside[inside.length - 1].timestamp.getTime(),
    String(r.lastInsideAt));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
