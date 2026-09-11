const {
    exitBufferM,
    isTrustworthyFix,
    GEOFENCE_MIN_ACCURACY_M,
    PUNCH_MAX_ACCURACY_M,
    nearestBranchDistance,
    calculateDistance,
} = require('../src/utils/distance');

let pass = 0;
let fail = 0;

const display = (value) => {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    return JSON.stringify(value);
};

const ok = (name, actual, expected) => {
    if (actual === expected) {
        pass++;
        console.log(`  PASS  ${name}`);
    } else {
        fail++;
        console.log(`  FAIL  ${name}  expected ${display(expected)}, got ${display(actual)}`);
    }
};

const approximately = (name, actual, expected, tolerance) => {
    if (Math.abs(actual - expected) <= tolerance) {
        pass++;
        console.log(`  PASS  ${name}`);
    } else {
        fail++;
        console.log(`  FAIL  ${name}  expected ${expected} +/- ${tolerance}, got ${actual}`);
    }
};

console.log('— exitBufferM() —');
ok('40m branch gets a 35m exit buffer', exitBufferM(40), 35);
ok('100m branch gets a 50m exit buffer', exitBufferM(100), 50);
ok('500m branch gets a 50m exit buffer', exitBufferM(500), 50);
ok('3000m branch gets a 50m exit buffer', exitBufferM(3000), 50);

let belowAccuracyFloor = null;
for (let radius = 1; radius <= 5000; radius++) {
    if (exitBufferM(radius) < GEOFENCE_MIN_ACCURACY_M) {
        belowAccuracyFloor = { radius, buffer: exitBufferM(radius) };
        break;
    }
}
ok('exit buffer never falls below the geofence accuracy floor (1m–5000m)', belowAccuracyFloor, null);

console.log('\n— isTrustworthyFix() —');
[
    [null, false],
    [undefined, false],
    [0, false],
    [-1, false],
    [NaN, false],
    ['abc', false],
    [36, false],
    [100, false],
    [0.5, true],
    [10, true],
    [35, true],
    ['25', true],
].forEach(([accuracy, expected]) => {
    ok(`accuracy ${display(accuracy)} is ${expected ? 'trusted' : 'not trusted'}`, isTrustworthyFix(accuracy), expected);
});
ok('punch accuracy limit is looser than the geofence decision limit', PUNCH_MAX_ACCURACY_M > GEOFENCE_MIN_ACCURACY_M, true);

console.log('\n— nearestBranchDistance() —');
const nearest = nearestBranchDistance(12.9716, 77.5946, [
    { latitude: 12.9816, longitude: 77.5946, radius: 111 },
    { latitude: 12.9716, longitude: 77.5946, radius: 222 },
]);
ok('selects the closest branch radius instead of the first branch radius', nearest.radius, 222);
approximately('closest branch distance is zero at its coordinates', nearest.distance, 0, 0.001);

const fallbackForMissingRadius = nearestBranchDistance(12.9716, 77.5946, [
    { latitude: 12.9716, longitude: 77.5946 },
], 777);
ok('uses fallback radius when the nearest branch has no radius', fallbackForMissingRadius.radius, 777);

const empty = nearestBranchDistance(12.9716, 77.5946, [], 888);
ok('empty branch list has infinite distance', empty.distance, Infinity);
ok('empty branch list returns fallback radius', empty.radius, 888);

console.log('\n— calculateDistance() —');
ok('identical coordinates are zero metres apart', calculateDistance(12.9716, 77.5946, 12.9716, 77.5946), 0);
approximately(
    'London to Paris is roughly the hand-checked 344 km',
    calculateDistance(51.5074, -0.1278, 48.8566, 2.3522),
    343556,
    20000
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
