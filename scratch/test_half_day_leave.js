// ─────────────────────────────────────────────────────────────────────────────
// Half-day leave: what a day actually pays.
//
//   node scratch/test_half_day_leave.js
//
// Pure engine, no database. The whole point of payroll_engine being free of
// Mongoose is that every one of these cases is a fabricated month.
//
// The rule being locked down: a half-day PAID leave taken on a day the employee
// also worked pays a FULL day (0.5 worked + 0.5 leave). Before this, attendance
// won the bucket outright and the approved half was silently discarded.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const engine = require(path.join(__dirname, '..', 'src', 'utils', 'payroll_engine'));

let pass = 0, fail = 0;
const ok = (name, actual, expected) => {
    if (actual === expected) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}  expected ${expected}, got ${actual}`); }
};

// August 2026: a month wholly in the past, so no month-to-date windowing
// trims it and the totals are the same whenever this is run.
const YEAR = 2026, MONTH = 8;
const DAYS_IN_MONTH = 31;
const EMP = { _id: 'e1', weeklyHolidays: [], salary: 31000 };
const LEAVE_TYPE = { _id: 'lt1', name: 'Casual', isPaid: true };
const UNPAID_TYPE = { _id: 'lt2', name: 'Unpaid', isPaid: false };

// Pick a real mid-month weekday rather than trusting a date literal to be one:
// the whole test is meaningless if the day under test turns out to be a Sunday.
const DAY = (() => {
    for (let d = 10; d <= 20; d++) {
        const wd = new Date(YEAR, MONTH - 1, d).getDay();
        if (wd >= 1 && wd <= 5) return `${YEAR}-0${MONTH}-${d}`;
    }
    throw new Error('no weekday found');
})();
// Every OTHER working day in the month is attended normally.
//
// Two engine behaviours would otherwise dominate the measurement and swamp the
// one-day difference being tested:
//
//   · the `noWorkAtAll` backstop -- a month with zero present/wfh/halfDay days
//     credits no weekly-offs or holidays either;
//   · the SANDWICH RULE -- a weekly-off flanked by absence on both sides is
//     unpaid, so marking a single day present also un-sandwiches the weekend
//     beside it and silently adds two more payable days.
//
// Both are deliberate (see CLAUDE.md). A fully-attended month keeps them out of
// the way, so the delta between two runs is exactly the day under test.
console.log(`day under test: ${DAY} (${new Date(DAY + 'T06:00:00Z').toDateString()})
`);

function otherWorkdays() {
    const recs = [];
    for (let d = 1; d <= DAYS_IN_MONTH; d++) {
        const dt = new Date(YEAR, MONTH - 1, d);
        const wd = dt.getDay();
        if (wd === 0 || wd === 6) continue;
        const key = `${YEAR}-0${MONTH}-${String(d).padStart(2, '0')}`;
        if (key === DAY) continue;
        recs.push({ date: new Date(`${key}T06:00:00.000Z`), status: 'present' });
    }
    return recs;
}

function run({ attendanceStatus, dayPortion, leaveType = LEAVE_TYPE }) {
    const attendanceRecords = otherWorkdays();
    if (attendanceStatus) {
        attendanceRecords.push({ date: new Date(`${DAY}T06:00:00.000Z`), status: attendanceStatus });
    }
    const leaves = dayPortion
        ? [{
            status: 'approved',
            leaveTypeId: leaveType._id,
            startDate: DAY,
            endDate: DAY,
            dayPortion,
        }]
        : [];

    return engine.runEngine({
        emp: EMP,
        year: YEAR,
        month: MONTH,
        attendanceRecords,
        leaves,
        leaveTypesById: { [leaveType._id]: leaveType },
        festivals: [],
        settings: { attendance: { workDays: ['M', 'T', 'W', 'Th', 'F'] } },
        asOfDate: new Date(`${YEAR}-09-30T00:00:00.000Z`),
    });
}

/** Payable days attributable to the one day under test. */
function dayValue(result, baseline) {
    return Math.round((result.payableDays - baseline.payableDays) * 1000) / 1000;
}

(() => {
    // Baseline: the employee is absent that day and takes no leave.
    const absent = run({ attendanceStatus: null, dayPortion: null });

    console.log('— the day pays —');

    const workedFull = run({ attendanceStatus: 'present', dayPortion: null });
    ok('present, no leave                      -> 1.0', dayValue(workedFull, absent), 1);

    const halfNoLeave = run({ attendanceStatus: 'half-day', dayPortion: null });
    ok('half-day attendance, no leave          -> 0.5', dayValue(halfNoLeave, absent), 0.5);

    // THE CASE THIS EXISTS FOR.
    const halfPlusLeave = run({ attendanceStatus: 'half-day', dayPortion: 'first_half' });
    ok('half-day worked + half-day PAID leave  -> 1.0', dayValue(halfPlusLeave, absent), 1);

    const halfSecond = run({ attendanceStatus: 'half-day', dayPortion: 'second_half' });
    ok('  same for second_half                 -> 1.0', dayValue(halfSecond, absent), 1);

    // Took the half day and never came in: only the granted half is paid.
    const leaveOnly = run({ attendanceStatus: null, dayPortion: 'first_half' });
    ok('half-day PAID leave, no attendance     -> 0.5', dayValue(leaveOnly, absent), 0.5);

    // Unpaid half day is worth nothing on its own, and tops up nothing.
    const unpaidOnly = run({ attendanceStatus: null, dayPortion: 'first_half', leaveType: UNPAID_TYPE });
    ok('half-day UNPAID leave, no attendance   -> 0.0', dayValue(unpaidOnly, absent), 0);

    const unpaidWorked = run({ attendanceStatus: 'half-day', dayPortion: 'first_half', leaveType: UNPAID_TYPE });
    ok('half-day worked + half-day UNPAID      -> 0.5', dayValue(unpaidWorked, absent), 0.5);

    // Over-claim is capped rather than over-paid.
    const fullPlusHalf = run({ attendanceStatus: 'present', dayPortion: 'first_half' });
    ok('full day worked + half-day leave       -> 1.0 (capped)', dayValue(fullPlusHalf, absent), 1);

    console.log('\n— nothing else moved —');

    // A whole-day leave must behave exactly as it did before this change.
    const fullLeave = run({ attendanceStatus: null, dayPortion: 'full' });
    ok('full-day PAID leave, no attendance     -> 1.0', dayValue(fullLeave, absent), 1);

    console.log('\n— the day-sum invariant still holds —');
    for (const [label, r] of [
        ['half worked + half leave', halfPlusLeave],
        ['half leave only', leaveOnly],
        ['full leave', fullLeave],
    ]) {
        const counts = r.counts;
        const sum = Object.keys(counts).reduce((a, k) => a + counts[k], 0);
        ok(`  ${label}: every day in exactly one bucket`, sum, DAYS_IN_MONTH);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
