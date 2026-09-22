/**
 * toISTDateKey vs the .slice(0, 10) it replaced.
 *
 *   node scratch/test_ist_date_key.mjs
 *
 * Mirrors botcrm-frontend-/src/lib/utils.ts. Pure, no DB.
 *
 * An Attendance `date` is an IST-MIDNIGHT INSTANT, so the IST day of 17 Sep is
 * stored as "2026-09-16T18:30:00.000Z" — every row's UTC date is one day behind
 * the day it represents. Slicing the ISO string therefore always returns the
 * previous day.
 *
 * That was not cosmetic: "Mark Absent" sent the sliced value, the server
 * resolved it to a different row, and the WRONG DAY was marked absent — a new
 * row created for it, and the day the admin actually clicked left untouched.
 */
import assert from 'node:assert/strict';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// The fix.
const toISTDateKey = (date) => {
    const d = typeof date === 'string' ? new Date(date) : date;
    return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
};

// What it replaced.
const sliced = (iso) => iso.slice(0, 10);

let pass = 0, fail = 0;
const test = (name, fn) => {
    try { fn(); pass++; console.log(`  PASS  ${name}`); }
    catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

console.log('- an IST-midnight instant resolves to the day it represents -');

test('IST 17 Sep is stored as 16 Sep 18:30Z and must read back as 17 Sep', () => {
    const stored = '2026-09-16T18:30:00.000Z';
    assert.equal(toISTDateKey(stored), '2026-09-17');
    assert.equal(sliced(stored), '2026-09-16', 'precondition: the old code really did return the previous day');
});

test('every IST midnight across a month maps to its own day, never the one before', () => {
    for (let day = 1; day <= 28; day++) {
        // IST midnight of Sep <day> == Sep <day-1> 18:30Z
        const prev = String(day - 1).padStart(2, '0');
        const stored = `2026-09-${prev}T18:30:00.000Z`;
        if (day === 1) continue; // month boundary covered separately
        assert.equal(
            toISTDateKey(stored),
            `2026-09-${String(day).padStart(2, '0')}`,
            `IST day ${day} resolved wrongly`,
        );
    }
});

test('a month boundary does not roll backwards', () => {
    // IST midnight 1 Oct 2026 == 30 Sep 18:30Z
    assert.equal(toISTDateKey('2026-09-30T18:30:00.000Z'), '2026-10-01');
    assert.equal(sliced('2026-09-30T18:30:00.000Z'), '2026-09-30');
});

test('a year boundary does not roll backwards', () => {
    assert.equal(toISTDateKey('2026-12-31T18:30:00.000Z'), '2027-01-01');
});

console.log('\n- instants later in the IST day still resolve to that day -');

test('a punch at 10:02 IST on 16 Sep is still 16 Sep', () => {
    // 10:02 IST == 04:32Z the same calendar day
    assert.equal(toISTDateKey('2026-09-16T04:32:16.000Z'), '2026-09-16');
});

test('a punch at 23:50 IST is still that IST day, though it is the next UTC day', () => {
    // 23:50 IST on 16 Sep == 18:20Z on 16 Sep
    assert.equal(toISTDateKey('2026-09-16T18:20:00.000Z'), '2026-09-16');
    // and one minute past IST midnight has rolled over
    assert.equal(toISTDateKey('2026-09-16T18:31:00.000Z'), '2026-09-17');
});

test('accepts a Date as well as a string', () => {
    assert.equal(toISTDateKey(new Date('2026-09-16T18:30:00.000Z')), '2026-09-17');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
