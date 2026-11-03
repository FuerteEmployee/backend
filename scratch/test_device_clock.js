// Tests for terminal clock-skew detection and automatic correction.
//
// The case these were written against is real: device EUF7254400194 reports
// every tap exactly 330 minutes early because its timezone is UTC, it has no
// NTP, and its clock resets on every power cut -- so it cannot be fixed on the
// device and has to be corrected here.
//
// Run:  node scratch/test_device_clock.js
const {
    recordClockSkew,
    resolveClockCorrection,
    describeSkew,
    SKEW_SUSPECT_MINUTES,
} = require('../src/utils/device_clock');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

const MIN = 60 * 1000;
const now = new Date('2026-09-12T13:00:00Z');
/** Build a device whose samples are the given skews, in minutes. */
const deviceWith = (skews, extra = {}) => ({
    clockSkewSamples: skews.map((m, i) => ({ minutes: m, at: new Date(now - i * 10 * MIN) })),
    clockOffsetMinutes: 0,
    ...extra,
});

console.log('- a terminal left on UTC: constant 330 min skew -');
{
    const device = deviceWith([330, 330, 331, 330]);
    const c = resolveClockCorrection(device);
    ok('correction is +330 minutes', c.minutes === 330, JSON.stringify(c));
    ok('reported as measured, not manual', c.source === 'measured', c.source);
    ok('confident', c.confident === true);
}

console.log('\n- THE self-cancelling property (why this may be automatic at all) -');
{
    // The Device schema forbids a STORED offset precisely because it keeps
    // correcting after the clock is fixed. A MEASURED one must not: the first
    // live tap from a corrected clock has to switch it off by itself.
    const device = deviceWith([330, 330, 330, 330]);
    ok('correcting while the clock is wrong', resolveClockCorrection(device).minutes === 330);

    // Somebody fixes the clock; the next genuine tap arrives ~live.
    device.clockSkewSamples.push({ minutes: 0, at: now });
    const after = resolveClockCorrection(device);
    ok('stops correcting the instant one live tap proves the clock is right',
        after.minutes === 0, JSON.stringify(after));
    ok('and says so explicitly rather than silently', after.source === 'none', after.source);
}

console.log('\n- an offline backlog must NOT be mistaken for a wrong clock -');
{
    // A device that was offline flushes stale taps, then catches up. The newest
    // sample is near zero because it is live again by then.
    const device = deviceWith([420, 300, 180, 60, 2]);
    const c = resolveClockCorrection(device);
    ok('no correction applied to a backlog flush', c.minutes === 0, JSON.stringify(c));
    ok('source is none', c.source === 'none');
}

console.log('\n- a wrong clock that ALSO had a backlog is still corrected -');
{
    // Samples sit at the true offset or ABOVE it (queue latency only ever adds),
    // so the corroborated minimum is still the clock offset.
    const device = deviceWith([330, 332, 330, 500, 640]);
    const c = resolveClockCorrection(device);
    ok('correction is the corroborated minimum, not the average', c.minutes === 330, JSON.stringify(c));
}

console.log('\n- one odd sample is not enough to move anybody\'s punches -');
{
    const device = deviceWith([330, 1, 2]);
    const c = resolveClockCorrection(device);
    ok('a single large gap is treated as one late tap, not a clock offset',
        c.minutes === 0, JSON.stringify(c));

    ok('too few samples to judge at all -> no correction',
        resolveClockCorrection(deviceWith([330, 330])).minutes === 0);
}

console.log('\n- a manual offset always wins -');
{
    const device = deviceWith([330, 330, 330], { clockOffsetMinutes: 120 });
    const c = resolveClockCorrection(device);
    ok('manual value used', c.minutes === 120, JSON.stringify(c));
    ok('labelled manual', c.source === 'manual');
}

console.log('\n- ordinary latency is left alone -');
{
    for (const skew of [0, 1, 5, 20, SKEW_SUSPECT_MINUTES]) {
        const c = resolveClockCorrection(deviceWith([skew, skew, skew, skew]));
        ok(`${skew} min skew -> no correction`, c.minutes === 0, JSON.stringify(c));
    }
}

console.log('\n- a clock running AHEAD is corrected backwards -');
{
    const device = deviceWith([-330, -330, -331]);
    const c = resolveClockCorrection(device);
    ok('correction is negative', c.minutes === -330, JSON.stringify(c));
}

console.log('\n- near-miss offsets snap to the real timezone -');
{
    // A terminal is on the wrong TIMEZONE, not off by a random 328 minutes;
    // snapping avoids leaving every punch two minutes out.
    const c = resolveClockCorrection(deviceWith([328, 329, 331]));
    ok('328/329/331 snaps to 330', c.minutes === 330, JSON.stringify(c));

    const odd = resolveClockCorrection(deviceWith([200, 201, 200]));
    ok('a value near no timezone is used as measured', odd.minutes === 200, JSON.stringify(odd));
}

console.log('\n- recordClockSkew still measures the raw gap -');
{
    const device = { clockSkewSamples: [] };
    const deviceTime = new Date('2026-09-12T07:24:40Z');  // what the terminal said
    const receivedAt = new Date('2026-09-12T12:54:42Z');  // when it actually arrived
    const r = recordClockSkew(device, deviceTime, receivedAt);
    ok('measures 330 minutes', r.minMinutes === 330, JSON.stringify(r));
    ok('flags it as suspected', r.suspected === true);
    ok('explains it in terms an admin can act on',
        /UTC|GMT/.test(r.description || ''), r.description);

    // Repeated live taps must not erode the minimum.
    recordClockSkew(device, new Date('2026-09-12T07:34:40Z'), new Date('2026-09-12T13:04:41Z'));
    ok('a second equally-skewed tap keeps the minimum at 330', device.clockSkewMinutes === 330);
}

console.log('\n- describeSkew names the timezone when it recognises one -');
{
    ok('330 is identified as the India offset', /5:30|UTC\/GMT/.test(describeSkew(330)));
    ok('an unrecognised offset still reads plainly', describeSkew(37).includes('37m'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
