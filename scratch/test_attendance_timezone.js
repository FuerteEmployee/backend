// Plain-Node regression tests for attendance time and grade rules.
//
// Run from backend:
//   node scratch/test_attendance_timezone.js
//
// No database is used. The timezone checks launch a fresh Node process for each
// TZ so they prove that the same stored instant is produced on every host.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const helpersPath = path.join(SRC, 'utils', 'attendance_helpers');
const shiftStatusPath = path.join(SRC, 'utils', 'shift_status');
const {
    istTimeOnDate,
    isLatePunchIn,
    determineHalfDayStatus,
} = require(helpersPath);
const {
    shiftTimeOnDate,
    shiftWindow,
    gradeDay,
} = require(shiftStatusPath);

let pass = 0;
let fail = 0;

function ok(name, fn) {
    try {
        fn();
        pass += 1;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        fail += 1;
        console.log(`  FAIL  ${name}  ${err.message}`);
    }
}

function istInstant(day, hhmm) {
    const [year, month, date] = day.split('-').map(Number);
    const [hour, minute] = hhmm.split(':').map(Number);
    return new Date(Date.UTC(year, month - 1, date, hour, minute) - 5.5 * 60 * 60 * 1000);
}

function resolverOutput(tz) {
    const script = [
        `const { shiftTimeOnDate } = require(${JSON.stringify(shiftStatusPath)});`,
        `const { istTimeOnDate } = require(${JSON.stringify(helpersPath)});`,
        "const ref = new Date('2026-09-10T18:45:00.000Z');", // 00:15 IST on Sep 11
        'process.stdout.write(JSON.stringify({',
        "  shift0745: shiftTimeOnDate('7:45', ref),",
        "  shift0000: shiftTimeOnDate('00:00', ref),",
        "  shift2359: shiftTimeOnDate('23:59', ref),",
        "  helper0745: istTimeOnDate('7:45', ref).getTime(),",
        '}));',
    ].join('\n');
    return JSON.parse(execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: { ...process.env, TZ: tz },
    }));
}

console.log('— IST boundary construction, independent of host TZ —');
const expected = {
    shift0745: istInstant('2026-09-11', '07:45').getTime(),
    shift0000: istInstant('2026-09-11', '00:00').getTime(),
    shift2359: istInstant('2026-09-11', '23:59').getTime(),
};
const outputs = ['UTC', 'Asia/Kolkata', 'America/New_York'].map((tz) => ({ tz, value: resolverOutput(tz) }));
for (const { tz, value } of outputs) {
    ok(`${tz}: shiftTimeOnDate resolves 7:45 on the IST day containing a near-boundary reference`, () => {
        assert.strictEqual(value.shift0745, expected.shift0745);
        assert.strictEqual(value.helper0745, expected.shift0745);
    });
    ok(`${tz}: 00:00 and 23:59 resolve as IST, not host-local`, () => {
        assert.strictEqual(value.shift0000, expected.shift0000);
        assert.strictEqual(value.shift2359, expected.shift2359);
    });
}
ok('all three host TZs return byte-for-byte identical boundary instants', () => {
    assert.deepStrictEqual(outputs.map(({ value }) => value), [outputs[0].value, outputs[0].value, outputs[0].value]);
});

console.log('\n— gradeDay: absence is different from an unmeasurable punch —');
const day = istInstant('2026-09-11', '00:00');
const dayShift = { startTime: '09:00', endTime: '18:00' };
const settings = { attendance: { minLunch: 0, lateGrace: 0 } };
const closed = (punchIn, punchOut) => ({ date: day, punchIn, punchOut, shifts: [{ punchIn, punchOut }] });

ok('no punch at all grades absent', () => {
    assert.strictEqual(gradeDay({ date: day, punchIn: null, punchOut: null, shifts: [] }, dayShift, settings), 'absent');
});
ok('a real punch-in with zero measurable time grades needs_review', () => {
    const at0900 = istInstant('2026-09-11', '09:00');
    assert.strictEqual(gradeDay(closed(at0900, at0900), dayShift, settings), 'needs_review');
});
ok('a complete shift grades present', () => {
    assert.strictEqual(
        gradeDay(closed(istInstant('2026-09-11', '09:00'), istInstant('2026-09-11', '18:00')), dayShift, settings),
        'present',
    );
});
ok('a short completed day grades half-day', () => {
    assert.strictEqual(
        gradeDay(closed(istInstant('2026-09-11', '09:00'), istInstant('2026-09-11', '13:00')), dayShift, settings),
        'half-day',
    );
});
ok('a worked day for an employee without a shift grades needs_review', () => {
    assert.strictEqual(
        gradeDay(closed(istInstant('2026-09-11', '09:00'), istInstant('2026-09-11', '18:00')), null, settings),
        'needs_review',
    );
});

console.log('\n— overnight shifts —');
const nightShift = { startTime: '22:00', endTime: '06:00', halfDayLatePunchInMin: 30 };
const postMidnightArrival = istInstant('2026-09-11', '01:00');
ok('a 01:00 IST arrival belongs to the previous night shift window', () => {
    const window = shiftWindow({ date: istInstant('2026-09-11', '00:00') }, nightShift, [{ punchIn: postMidnightArrival }]);
    assert.strictEqual(window.startMs, istInstant('2026-09-10', '22:00').getTime());
    assert.strictEqual(window.endMs, istInstant('2026-09-11', '06:00').getTime());
});
ok('a 01:00 IST arrival is late for a 22:00 shift with a 30-minute grace', () => {
    assert.strictEqual(isLatePunchIn(postMidnightArrival, nightShift, settings), true);
});
ok('the overnight half-day late-arrival cutoff is anchored to the preceding IST day', () => {
    const result = determineHalfDayStatus({
        punchIn: postMidnightArrival,
        punchOut: istInstant('2026-09-11', '06:00'),
        totalWorkMs: 5 * 60 * 60 * 1000,
        shift: nightShift,
    }, settings);
    assert.strictEqual(result.status, 'half-day');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
