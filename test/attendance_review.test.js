// ─────────────────────────────────────────────────────────────────────────────
// Attendance, timezone & geofence review tests
//
// Plain Node 20, no framework.  Run with:
//   TZ=UTC          node test/attendance_review.test.js
//   TZ=Asia/Kolkata node test/attendance_review.test.js
//   TZ=America/New_York node test/attendance_review.test.js
//
// All assertions must PASS in all three — the point of the IST fix is that the
// host timezone no longer matters.
//
// Dependencies: none beyond what the backend already has.
// ─────────────────────────────────────────────────────────────────────────────

const assert = require('node:assert/strict');

// ── Utility: isolate the modules that don't need Mongoose ────────────────────
// shiftTimeOnDate, gradeDay, etc. are pure functions that take plain objects.
// We can require them directly without a running database.

const {
    shiftTimeOnDate,
    gradeDay,
    allSessions,
    isDayOpen,
    computeWorkedMs,
    computeSessionWorkMs,
    computeSessionGrossMs,
    syncRootPunchOut,
    requiredWorkMs,
    DAY_MS,
} = require('../src/utils/shift_status');

const {
    istTimeOnDate,
    istMinutesOfDay,
    istSecondsOfMinute,
    istHHMM,
    istDateKey,
    istStartOfDay,
    isLatePunchIn,
} = require('../src/utils/attendance_helpers');

const {
    evaluateExit,
    GEOFENCE_CONFIRMATIONS,
    MIN_CONFIRMATION_SPAN_MS,
    GEOFENCE_UNAMBIGUOUS_FACTOR,
    GEOFENCE_PENDING_STALE_MS,
    MIN_FIXES,
    MIN_SPAN_MS,
    MIN_DISTINCT,
    GRACE_MS,
    MAX_FIX_AGE_MS,
    WINDOW_MS,
} = require('../src/utils/geofence_window');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
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

// ═════════════════════════════════════════════════════════════════════════════
//  §1  shiftTimeOnDate / istTimeOnDate — timezone invariance
// ═════════════════════════════════════════════════════════════════════════════

section('shiftTimeOnDate / istTimeOnDate — timezone invariance');

// A reference date well inside an IST day: 2026-09-10 12:00 IST = 06:30 UTC
const REF_IST_NOON = new Date(Date.UTC(2026, 8, 10, 6, 30, 0)); // 2026-09-10 12:00 IST

test('"7:45" on 2026-09-10 -> 2026-09-10 07:45 IST regardless of TZ', () => {
    const ms = shiftTimeOnDate('7:45', REF_IST_NOON);
    const expected = Date.UTC(2026, 8, 10, 2, 15, 0); // 07:45 IST = 02:15 UTC
    assert.equal(ms, expected, `got ${new Date(ms).toISOString()}, expected ${new Date(expected).toISOString()}`);
});

test('"00:00" on 2026-09-10 -> IST midnight (2026-09-09 18:30 UTC)', () => {
    const ms = shiftTimeOnDate('00:00', REF_IST_NOON);
    const expected = Date.UTC(2026, 8, 9, 18, 30, 0); // 00:00 IST = previous day 18:30 UTC
    assert.equal(ms, expected);
});

test('"23:59" on 2026-09-10 -> 2026-09-10 23:59 IST', () => {
    const ms = shiftTimeOnDate('23:59', REF_IST_NOON);
    const expected = Date.UTC(2026, 8, 10, 18, 29, 0); // 23:59 IST = 18:29 UTC
    assert.equal(ms, expected);
});

test('istTimeOnDate agrees with shiftTimeOnDate (returns Date, not ms)', () => {
    const ms = shiftTimeOnDate('7:45', REF_IST_NOON);
    const dt = istTimeOnDate('7:45', REF_IST_NOON);
    assert.equal(dt.getTime(), ms);
});

test('istTimeOnDate with extra minutes adds correctly', () => {
    const dt = istTimeOnDate('7:45', REF_IST_NOON, 15);
    const expected = Date.UTC(2026, 8, 10, 2, 30, 0); // 08:00 IST = 02:30 UTC
    assert.equal(dt.getTime(), expected);
});

// Near-boundary reference: 2026-09-10 18:45 UTC = 2026-09-11 00:15 IST
const REF_NEAR_BOUNDARY = new Date(Date.UTC(2026, 8, 10, 18, 45, 0));

test('"7:45" near IST day boundary -> resolves on the IST day (Sep 11)', () => {
    const ms = shiftTimeOnDate('7:45', REF_NEAR_BOUNDARY);
    const expected = Date.UTC(2026, 8, 11, 2, 15, 0);
    assert.equal(ms, expected, `got ${new Date(ms).toISOString()}, expected ${new Date(expected).toISOString()}`);
});

test('"00:00" near IST day boundary -> IST midnight of Sep 11', () => {
    const ms = shiftTimeOnDate('00:00', REF_NEAR_BOUNDARY);
    const expected = Date.UTC(2026, 8, 10, 18, 30, 0); // Sep 11 00:00 IST = Sep 10 18:30 UTC
    assert.equal(ms, expected);
});

// ── Overnight shifts ────────────────────────────────────────────────────────

section('Overnight shifts');

test('overnight shift end < start detected correctly by shiftWindow', () => {
    const ref = REF_IST_NOON;
    const startMs = shiftTimeOnDate('22:00', ref);
    let endMs = shiftTimeOnDate('06:00', ref);
    assert.ok(endMs < startMs, 'end < start for overnight shift');
    endMs += DAY_MS;
    assert.ok(endMs > startMs, 'after +24h, end > start');
    assert.equal(endMs - startMs, 8 * 60 * 60 * 1000, '22:00-06:00 = 8 hours');
});

// ═════════════════════════════════════════════════════════════════════════════
//  §2  istDateKey / istStartOfDay / istMinutesOfDay
// ═════════════════════════════════════════════════════════════════════════════

section('IST date utilities');

test('istDateKey at 18:45 UTC (00:15 IST next day) -> next day key', () => {
    const d = new Date(Date.UTC(2026, 8, 10, 18, 45, 0));
    assert.equal(istDateKey(d), '2026-09-11');
});

test('istDateKey at 18:29 UTC (23:59 IST same day) -> same day key', () => {
    const d = new Date(Date.UTC(2026, 8, 10, 18, 29, 0));
    assert.equal(istDateKey(d), '2026-09-10');
});

test('istStartOfDay for Sep 10 IST noon -> Sep 9 18:30 UTC', () => {
    const d = istStartOfDay(REF_IST_NOON);
    assert.equal(d.getTime(), Date.UTC(2026, 8, 9, 18, 30, 0));
});

test('istMinutesOfDay at IST midnight = 0', () => {
    const istMidnight = new Date(Date.UTC(2026, 8, 9, 18, 30, 0));
    assert.equal(istMinutesOfDay(istMidnight), 0);
});

test('istMinutesOfDay at 07:45 IST = 465', () => {
    const d = new Date(Date.UTC(2026, 8, 10, 2, 15, 0)); // 07:45 IST
    assert.equal(istMinutesOfDay(d), 465);
});

test('istHHMM at 07:45 IST = "07:45"', () => {
    const d = new Date(Date.UTC(2026, 8, 10, 2, 15, 0));
    assert.equal(istHHMM(d), '07:45');
});

// ═════════════════════════════════════════════════════════════════════════════
//  §3  gradeDay
// ═════════════════════════════════════════════════════════════════════════════

section('gradeDay');

const SHIFT_9_18 = { startTime: '9:00', endTime: '18:00' };
const SETTINGS = { attendance: { minLunch: 30, lateGrace: 15 } };

function mkAttendance(punchIn, punchOut) {
    return {
        date: new Date(Date.UTC(2026, 8, 9, 18, 30, 0)), // IST midnight Sep 10
        punchIn: punchIn ? new Date(punchIn) : null,
        punchOut: punchOut ? new Date(punchOut) : null,
        shifts: [],
    };
}

test('open day -> null (not graded)', () => {
    const att = mkAttendance(Date.UTC(2026, 8, 10, 3, 30), null); // 09:00 IST
    assert.equal(gradeDay(att, SHIFT_9_18, SETTINGS), null);
});

test('no punch at all, closed -> absent', () => {
    const att = mkAttendance(null, null);
    att.punchOut = new Date(); // force closed
    assert.equal(gradeDay(att, SHIFT_9_18, SETTINGS), 'absent');
});

test('punch-in + zero worked time -> needs_review (not absent)', () => {
    const t = Date.UTC(2026, 8, 10, 3, 30);
    const att = mkAttendance(t, t);
    const grade = gradeDay(att, SHIFT_9_18, SETTINGS);
    assert.equal(grade, 'needs_review', `expected needs_review, got ${grade}`);
});

test('full shift -> present', () => {
    const pIn = Date.UTC(2026, 8, 10, 3, 30);  // 09:00 IST
    const pOut = Date.UTC(2026, 8, 10, 12, 30); // 18:00 IST
    const att = mkAttendance(pIn, pOut);
    assert.equal(gradeDay(att, SHIFT_9_18, SETTINGS), 'present');
});

test('short day -> half-day', () => {
    const pIn = Date.UTC(2026, 8, 10, 3, 30);
    const pOut = Date.UTC(2026, 8, 10, 7, 30); // 13:00 IST
    const att = mkAttendance(pIn, pOut);
    assert.equal(gradeDay(att, SHIFT_9_18, SETTINGS), 'half-day');
});

test('no shift -> needs_review', () => {
    const pIn = Date.UTC(2026, 8, 10, 3, 30);
    const pOut = Date.UTC(2026, 8, 10, 12, 30);
    const att = mkAttendance(pIn, pOut);
    assert.equal(gradeDay(att, null, SETTINGS), 'needs_review');
});

// ═════════════════════════════════════════════════════════════════════════════
//  §3b  Work performed entirely outside the shift window
//
//  Regression cover for a real 2026-09-16 row: punch-in 18:31 against an
//  09:30-18:30 shift, auto-closed 19:23:08.  The end clamp pulled punch-out
//  back to 18:30 while punch-in stayed at 18:31, so the subtraction went
//  negative, floored to zero, and 52 real minutes were stored as a plain
//  half-day with nothing to show the time had ever existed.
// ═════════════════════════════════════════════════════════════════════════════

section('post-shift session (clamp to zero)');

const SHIFT_0930_1830 = { startTime: '09:30', endTime: '18:30' };

// IST midnight on 16 Sep 2026, and the two real punch instants of that row.
const SEP16_IST_MIDNIGHT = Date.UTC(2026, 8, 15, 18, 30, 0);
const TIRTH_IN = Date.UTC(2026, 8, 16, 13, 1, 0);    // 18:31:00 IST
const TIRTH_OUT = Date.UTC(2026, 8, 16, 13, 53, 8);  // 19:23:08 IST

function mkPostShiftDay() {
    const session = { punchIn: new Date(TIRTH_IN), punchOut: new Date(TIRTH_OUT) };
    return {
        date: new Date(SEP16_IST_MIDNIGHT),
        punchIn: new Date(TIRTH_IN),
        punchOut: new Date(TIRTH_OUT),
        shifts: [session],
    };
}

test('clamped session credits zero (the clamp still applies)', () => {
    const att = mkPostShiftDay();
    const ms = computeSessionWorkMs(att.shifts[0], att, SHIFT_0930_1830);
    assert.equal(ms, 0, `expected 0 credited, got ${ms}`);
});

test('gross keeps the 52 minutes the clamp discards', () => {
    const att = mkPostShiftDay();
    const gross = computeSessionGrossMs(att.shifts[0]);
    assert.equal(gross, TIRTH_OUT - TIRTH_IN);
    assert.equal(gross, 3128000); // 52 min 8 s
});

test('post-shift-only day grades needs_review, never half-day or absent', () => {
    const att = mkPostShiftDay();
    const grade = gradeDay(att, SHIFT_0930_1830, SETTINGS);
    assert.equal(grade, 'needs_review', `expected needs_review, got ${grade}`);
});

test('a normal in-shift day is unaffected by the gross field', () => {
    // Guards against "fixing" the clamp by removing it: a full 09:30-18:30 day
    // must still grade present and still credit the clamped figure.
    const pIn = Date.UTC(2026, 8, 16, 4, 0);   // 09:30 IST
    const pOut = Date.UTC(2026, 8, 16, 13, 0); // 18:30 IST
    const att = {
        date: new Date(SEP16_IST_MIDNIGHT),
        punchIn: new Date(pIn),
        punchOut: new Date(pOut),
        shifts: [{ punchIn: new Date(pIn), punchOut: new Date(pOut) }],
    };
    assert.equal(computeSessionWorkMs(att.shifts[0], att, SHIFT_0930_1830), pOut - pIn);
    assert.equal(computeSessionGrossMs(att.shifts[0]), pOut - pIn);
    assert.equal(gradeDay(att, SHIFT_0930_1830, SETTINGS), 'present');
});

// ═════════════════════════════════════════════════════════════════════════════
//  §3c  syncRootPunchOut
//
//  The root punchOut is what the nightly close job, the on-duty stat and the
//  punch-in guard read to decide whether a day is finished.  Punch-in clears it
//  for every new session, so a close that does not put it back leaves the day
//  permanently open.  The rule it replaces keyed on session index 0.
// ═════════════════════════════════════════════════════════════════════════════

section('syncRootPunchOut');

// An IST wall-clock time on 16 Sep 2026, as a UTC instant. Written as plain
// arithmetic off IST midnight rather than hour/minute subtraction, because the
// 5:30 offset borrows across the hour and the obvious version gets it wrong.
const T = (h, m) => Date.UTC(2026, 8, 16, 0, 0, 0) + (h * 60 + m - 330) * 60 * 1000;

function mkMultiSession(sessions) {
    return {
        date: new Date(SEP16_IST_MIDNIGHT),
        punchIn: new Date(sessions[0].punchIn),
        punchOut: null, // punch-in cleared it when the latest session opened
        shifts: sessions,
    };
}

test('mirrors from a closed session that is NOT index 0', () => {
    const att = mkMultiSession([
        { punchIn: new Date(T(10, 0)), punchOut: new Date(T(14, 41)) },
        { punchIn: new Date(T(18, 14)), punchOut: new Date(T(18, 58)) },
    ]);
    syncRootPunchOut(att);
    assert.equal(att.punchOut.getTime(), T(18, 58), 'root should follow the final session');
});

test('uses timestamps, not array order', () => {
    // shifts[] is not stored chronologically — a real row carried 15:30
    // sessions ahead of 11:37 ones. Index-based logic picks the wrong session.
    const att = mkMultiSession([
        { punchIn: new Date(T(15, 0)), punchOut: new Date(T(18, 0)) },
        { punchIn: new Date(T(10, 0)), punchOut: new Date(T(12, 0)) },
        { punchIn: new Date(T(12, 30)), punchOut: new Date(T(14, 0)) },
    ]);
    syncRootPunchOut(att);
    assert.equal(att.punchOut.getTime(), T(18, 0), 'latest punchOut wins regardless of position');
});

test('carries the closing location across with the time', () => {
    const att = mkMultiSession([
        { punchIn: new Date(T(10, 0)), punchOut: new Date(T(12, 0)), punchOutDistance: 12 },
        {
            punchIn: new Date(T(14, 0)),
            punchOut: new Date(T(18, 58)),
            punchOutDistance: 689,
            punchOutLocation: '22.29641, 70.79854',
            punchOutCoordinates: { lat: 22.296411, lng: 70.7985376 },
        },
    ]);
    syncRootPunchOut(att);
    assert.equal(att.punchOutDistance, 689);
    assert.equal(att.punchOutLocation, '22.29641, 70.79854');
    assert.equal(att.punchOutCoordinates.lat, 22.296411);
});

test('leaves the root alone while a session is still open', () => {
    const att = mkMultiSession([
        { punchIn: new Date(T(10, 0)), punchOut: new Date(T(12, 0)) },
        { punchIn: new Date(T(15, 0)), punchOut: null },
    ]);
    syncRootPunchOut(att);
    assert.equal(att.punchOut, null, 'an open day must not read as finished');
});

test('no shifts[] is a no-op (the root IS the session)', () => {
    const att = {
        date: new Date(SEP16_IST_MIDNIGHT),
        punchIn: new Date(T(10, 0)),
        punchOut: new Date(T(18, 0)),
        shifts: [],
    };
    syncRootPunchOut(att);
    assert.equal(att.punchOut.getTime(), T(18, 0), 'must not disturb a legacy single-session row');
});

// ═════════════════════════════════════════════════════════════════════════════
//  §4  isLatePunchIn
// ═════════════════════════════════════════════════════════════════════════════

// The half-day late-arrival cutoff, as the live punch path computes it.
//
// This is the rule that decides whether arriving very late costs half a day's
// pay, and for a long time it silently never fired: the punch-in handler built
// the cutoff with `setHours`, which resolves in the HOST timezone, and
// production runs on a UTC box. A 09:30 shift produced a 15:00 IST cutoff, so
// 87 of 303 rows on tenants that had configured the rule were stored `present`
// when they should have been `half-day` — one of them a 14:13 arrival.
section('half-day late-arrival cutoff');

test('the cutoff is IST, not host-local', () => {
    // 09:30 shift, half-day if more than 60 minutes late => 10:30 IST.
    const punchIn = new Date(Date.UTC(2026, 8, 17, 6, 0)); // 11:30 IST, two hours late
    const cutoff = istTimeOnDate('09:30', punchIn, 60);
    assert.equal(istHHMM(cutoff), '10:30');
    assert.ok(punchIn > cutoff, 'an 11:30 IST arrival must be past a 10:30 cutoff');
});

test('the old setHours form disagrees — which is the bug', () => {
    const punchIn = new Date(Date.UTC(2026, 8, 17, 6, 0)); // 11:30 IST
    const legacy = new Date(punchIn);
    legacy.setHours(9, 30 + 60, 0, 0);
    // Under TZ=UTC this lands at 16:00 IST and the rule never fires. Under
    // TZ=Asia/Kolkata it happens to be right — which is exactly why the defect
    // was invisible in local testing and live in production.
    if (new Date().getTimezoneOffset() === 0) {
        assert.ok(punchIn < legacy, 'precondition: on a UTC host the legacy cutoff really is too late');
        assert.notEqual(istHHMM(legacy), istHHMM(istTimeOnDate('09:30', punchIn, 60)));
    }
});

test('an on-time arrival is still not half-day', () => {
    const punchIn = new Date(Date.UTC(2026, 8, 17, 4, 5)); // 09:35 IST
    const cutoff = istTimeOnDate('09:30', punchIn, 60);
    assert.ok(punchIn < cutoff);
});

test('no rule configured means no cutoff to breach', () => {
    // halfDayLatePunchInMin unset — the caller guards on it, but the helper
    // must not invent a cutoff from a missing shift time either.
    assert.equal(istTimeOnDate(undefined, new Date(), 60), null);
});

section('isLatePunchIn');

const SHIFT_0745 = { startTime: '7:45' };
const SETTINGS_15 = { attendance: { lateGrace: 15 } };
// Cutoff = 07:45 + 15 = 08:00 IST = 02:30 UTC

test('punch at 07:59:59 IST -> NOT late', () => {
    const punchIn = new Date(Date.UTC(2026, 8, 10, 2, 29, 59)); // 07:59:59 IST
    assert.equal(isLatePunchIn(punchIn, SHIFT_0745, SETTINGS_15), false);
});

test('punch at 08:00:00 IST -> NOT late (grace boundary is inclusive)', () => {
    const punchIn = new Date(Date.UTC(2026, 8, 10, 2, 30, 0)); // 08:00:00 IST
    assert.equal(isLatePunchIn(punchIn, SHIFT_0745, SETTINGS_15), false);
});

test('punch at 08:00:01 IST -> LATE', () => {
    const punchIn = new Date(Date.UTC(2026, 8, 10, 2, 30, 1)); // 08:00:01 IST
    assert.equal(isLatePunchIn(punchIn, SHIFT_0745, SETTINGS_15), true);
});

test('punch at 07:30 IST (early) -> NOT late', () => {
    const punchIn = new Date(Date.UTC(2026, 8, 10, 2, 0, 0));
    assert.equal(isLatePunchIn(punchIn, SHIFT_0745, SETTINGS_15), false);
});

test('no shift -> NOT late (safe default)', () => {
    const punchIn = new Date(Date.UTC(2026, 8, 10, 10, 0, 0));
    assert.equal(isLatePunchIn(punchIn, null, SETTINGS_15), false);
});

// ═════════════════════════════════════════════════════════════════════════════
//  §5  Geofence evaluateExit — state machine
// ═════════════════════════════════════════════════════════════════════════════

section('Geofence evaluateExit');

const BRANCH = {
    _id: 'branch1',
    branchName: 'Office',
    latitude: 19.076,
    longitude: 72.8777,
    geoFenceEnabled: true,
    radius: 100,
};

const METRES_TO_DEG_LAT = 1 / 111111;

function makeFixesAtDistance(count, distanceM, { spanMs = 120000, accuracyM = 10, now } = {}) {
    const fixes = [];
    const startMs = now.getTime() - spanMs;
    const step = spanMs / (count - 1 || 1);
    const baseLat = BRANCH.latitude + (distanceM * METRES_TO_DEG_LAT);
    for (let i = 0; i < count; i++) {
        fixes.push({
            latitude: baseLat + (i * 20 * METRES_TO_DEG_LAT),
            longitude: BRANCH.longitude,
            accuracy: accuracyM,
            timestamp: new Date(startMs + i * step),
        });
    }
    return fixes;
}

function makeFixesInside(count, { spanMs = 120000, accuracyM = 10, now } = {}) {
    const fixes = [];
    const startMs = now.getTime() - spanMs;
    const step = spanMs / (count - 1 || 1);
    for (let i = 0; i < count; i++) {
        fixes.push({
            latitude: BRANCH.latitude + (i * 8 * METRES_TO_DEG_LAT),
            longitude: BRANCH.longitude + (i * 18 * METRES_TO_DEG_LAT),
            accuracy: accuracyM,
            timestamp: new Date(startMs + i * step),
        });
    }
    return fixes;
}

test('inside the fence -> decision=inside', () => {
    const now = new Date();
    const punchInAt = new Date(now.getTime() - 3600000);
    const fixes = makeFixesInside(6, { now, spanMs: 120000 });
    const r = evaluateExit({ fixes, branches: [BRANCH], now, punchInAt });
    assert.equal(r.decision, 'inside');
    assert.equal(r.outside, false);
});

test('outside but too few fixes -> abstained', () => {
    const now = new Date();
    const punchInAt = new Date(now.getTime() - 3600000);
    const fixes = makeFixesAtDistance(3, 500, { now, spanMs: 120000 });
    const r = evaluateExit({ fixes, branches: [BRANCH], now, punchInAt });
    assert.equal(r.decision, 'abstained');
    assert.equal(r.reason, 'too_few_fixes');
});

test('marginal exit (under 3x threshold) -> outside=true', () => {
    const now = new Date();
    const punchInAt = new Date(now.getTime() - 3600000);
    const fixes = makeFixesAtDistance(6, 250, { now, spanMs: 150000 });
    const r = evaluateExit({ fixes, branches: [BRANCH], now, punchInAt });
    assert.equal(r.outside, true);
    assert.equal(r.decision, 'punched_out');
});

test('unambiguous exit (> 3x threshold) -> outside=true', () => {
    const now = new Date();
    const punchInAt = new Date(now.getTime() - 3600000);
    const fixes = makeFixesAtDistance(6, 900, { now, spanMs: 120000 });
    const r = evaluateExit({ fixes, branches: [BRANCH], now, punchInAt });
    assert.equal(r.outside, true);
    assert.equal(r.decision, 'punched_out');
});

test('within_buffer -> abstained (between radius and threshold)', () => {
    const now = new Date();
    const punchInAt = new Date(now.getTime() - 3600000);
    const fixes = [];
    const startMs = now.getTime() - 120000;
    for (let i = 0; i < 6; i++) {
        fixes.push({
            latitude: BRANCH.latitude + (130 * METRES_TO_DEG_LAT),
            longitude: BRANCH.longitude + (i * 16 * METRES_TO_DEG_LAT),
            accuracy: 10,
            timestamp: new Date(startMs + i * 20000),
        });
    }
    const r = evaluateExit({ fixes, branches: [BRANCH], now, punchInAt });
    assert.equal(r.decision, 'abstained');
    assert.equal(r.reason, 'within_buffer');
});

test('grace period -> suppressed', () => {
    const now = new Date();
    const punchInAt = new Date(now.getTime() - 10000); // only 10s ago
    const fixes = makeFixesAtDistance(6, 900, { now, spanMs: 120000 });
    const r = evaluateExit({ fixes, branches: [BRANCH], now, punchInAt });
    assert.equal(r.decision, 'suppressed');
    assert.equal(r.reason, 'grace_period');
});

test('on lunch -> suppressed', () => {
    const now = new Date();
    const punchInAt = new Date(now.getTime() - 3600000);
    const fixes = makeFixesAtDistance(6, 900, { now, spanMs: 120000 });
    const r = evaluateExit({ fixes, branches: [BRANCH], now, punchInAt, onLunch: true });
    assert.equal(r.decision, 'suppressed');
    assert.equal(r.reason, 'on_lunch');
});

test('repeated coordinates -> abstained', () => {
    const now = new Date();
    const punchInAt = new Date(now.getTime() - 3600000);
    const fixes = [];
    const startMs = now.getTime() - 120000;
    for (let i = 0; i < 6; i++) {
        fixes.push({
            latitude: BRANCH.latitude + 0.01, // far outside
            longitude: BRANCH.longitude,
            accuracy: 10,
            timestamp: new Date(startMs + i * 20000),
        });
    }
    const r = evaluateExit({ fixes, branches: [BRANCH], now, punchInAt });
    assert.equal(r.decision, 'abstained');
});

test('no fixes at all -> abstained (no_fixes)', () => {
    const now = new Date();
    const punchInAt = new Date(now.getTime() - 3600000);
    const r = evaluateExit({ fixes: [], branches: [BRANCH], now, punchInAt });
    assert.equal(r.decision, 'abstained');
    assert.equal(r.reason, 'no_fixes');
});

test('no branches -> suppressed (no_branch)', () => {
    const now = new Date();
    const punchInAt = new Date(now.getTime() - 3600000);
    const fixes = makeFixesAtDistance(6, 900, { now, spanMs: 120000 });
    const r = evaluateExit({ fixes, branches: [], now, punchInAt });
    assert.equal(r.decision, 'suppressed');
    assert.equal(r.reason, 'no_branch');
});

// ═════════════════════════════════════════════════════════════════════════════
//  Summary
// ═════════════════════════════════════════════════════════════════════════════

console.log(`\n============================================`);
console.log(`  ${passed} passed, ${failed} failed (TZ=${process.env.TZ || 'system default'})`);
console.log(`============================================`);

process.exitCode = failed > 0 ? 1 : 0;
