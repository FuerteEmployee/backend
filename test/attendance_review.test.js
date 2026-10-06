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

// 2026-10-01, OPPO CPH2495: readings alternating between the desk and 800 m-9 km away,
// each claiming ~10 m accuracy. Three far ones among the five newest put the medoid
// outside and closed a day at the desk. Mixed inside/outside evidence must abstain.
test('jumping phone: desk fixes interleaved with far phantoms -> abstained (mixed_positions)', () => {
    const now = new Date();
    const punchInAt = new Date(now.getTime() - 3600000);
    const at = (sAgo, northM, eastM = 0) => ({
        latitude: BRANCH.latitude + northM * METRES_TO_DEG_LAT,
        longitude: BRANCH.longitude + eastM * METRES_TO_DEG_LAT,
        accuracy: 12,
        timestamp: new Date(now.getTime() - sAgo * 1000),
    });
    const fixes = [at(300, 25), at(240, 30, 5), at(200, 9450), at(150, 28, 9), at(100, 935), at(60, 33, 2), at(30, 812, 40), at(0, 820, 60)];
    const r = evaluateExit({ fixes, branches: [BRANCH], now, punchInAt });
    assert.equal(r.outside, false);
    assert.equal(r.decision, 'abstained');
    assert.ok(['mixed_positions', 'implausible_jump'].includes(r.reason), r.reason);
});

test('all-outside readings that jump faster than travel -> abstained (implausible_jump)', () => {
    const now = new Date();
    const punchInAt = new Date(now.getTime() - 3600000);
    const at = (sAgo, northM) => ({ latitude: BRANCH.latitude + northM * METRES_TO_DEG_LAT, longitude: BRANCH.longitude, accuracy: 10, timestamp: new Date(now.getTime() - sAgo * 1000) });
    const fixes = [at(150, 600), at(120, 620), at(90, 9600), at(60, 640), at(30, 660), at(0, 680)];
    const r = evaluateExit({ fixes, branches: [BRANCH], now, punchInAt });
    assert.equal(r.decision, 'abstained');
    assert.equal(r.reason, 'implausible_jump');
});

test('a real walk-out (all newest fixes outside, walking speed) still punches out', () => {
    const now = new Date();
    const punchInAt = new Date(now.getTime() - 3600000);
    const at = (sAgo, northM) => ({ latitude: BRANCH.latitude + northM * METRES_TO_DEG_LAT, longitude: BRANCH.longitude, accuracy: 8, timestamp: new Date(now.getTime() - sAgo * 1000) });
    // 30 m from the desk, then walking out at ~1.5 m/s, then driving at ~10 m/s
    const fixes = [at(600, 30), at(570, 32), at(300, 400), at(240, 490), at(180, 580), at(120, 1180), at(60, 1780), at(0, 2380)];
    const r = evaluateExit({ fixes, branches: [BRANCH], now, punchInAt });
    assert.equal(r.decision, 'punched_out', `${r.reason}: ${r.narrative}`);
});

// ── Health check helpers (jobs/health_check.js) ───────────────────────────────
const health = require('../src/jobs/health_check');

test('health: phone mostly inside after an auto punch-out -> looks like a wrong exit', () => {
    const now = new Date();
    const at = (sAfter, northM, acc = 10) => ({ latitude: BRANCH.latitude + northM * METRES_TO_DEG_LAT, longitude: BRANCH.longitude, accuracy: acc, timestamp: new Date(now.getTime() + sAfter * 1000) });
    const s = health.insideAfterExit({ fixes: [at(30, 25), at(60, 820), at(90, 30), at(120, 28), at(150, 940)], branch: BRANCH, radiusM: 100 });
    assert.equal(s.trusted, 5);
    assert.equal(s.inside, 3);
    assert.equal(health.looksLikeWrongExit(s), true);
});

test('health: phone far away after an auto punch-out -> a real exit, not flagged', () => {
    const now = new Date();
    const at = (sAfter, northM) => ({ latitude: BRANCH.latitude + northM * METRES_TO_DEG_LAT, longitude: BRANCH.longitude, accuracy: 8, timestamp: new Date(now.getTime() + sAfter * 1000) });
    const s = health.insideAfterExit({ fixes: [at(30, 600), at(60, 900), at(90, 1300), at(120, 1800)], branch: BRANCH, radiusM: 100 });
    assert.equal(health.looksLikeWrongExit(s), false);
});

test('health: too few accurate readings after a punch-out -> not flagged', () => {
    const now = new Date();
    const at = (sAfter, northM, acc) => ({ latitude: BRANCH.latitude + northM * METRES_TO_DEG_LAT, longitude: BRANCH.longitude, accuracy: acc, timestamp: new Date(now.getTime() + sAfter * 1000) });
    const s = health.insideAfterExit({ fixes: [at(30, 20, 10), at(60, 25, 150), at(90, 22, 200)], branch: BRANCH, radiusM: 100 });
    assert.equal(health.looksLikeWrongExit(s), false);
});

test('health: gaps are counted only inside on-duty intervals', () => {
    const t0 = Date.UTC(2026, 9, 1, 4, 0, 0);
    const ts = [0, 5, 30, 35, 90, 95].map((m) => new Date(t0 + m * 60000)); // gaps of 25 and 55 min
    assert.equal(health.findGaps(ts, 15 * 60000).length, 2);
    assert.equal(health.findGaps(ts, 15 * 60000, [[t0, t0 + 40 * 60000]]).length, 1);
});

test('health: impossible jumps are counted, walking and driving are not', () => {
    const t0 = Date.now();
    const at = (s, northM) => ({ latitude: BRANCH.latitude + northM * METRES_TO_DEG_LAT, longitude: BRANCH.longitude, timestamp: new Date(t0 + s * 1000) });
    assert.equal(health.countJumps([at(0, 0), at(60, 90), at(120, 700), at(180, 1300)]), 0); // 1.5 and 10 m/s
    assert.equal(health.countJumps([at(0, 30), at(60, 9450), at(120, 30)]), 2); // there and back
});

test('health: expected refusals are not app errors; real failures are', () => {
    assert.equal(health.isRealError({ message: 'You punched in 11s ago. Wait at least 60s before punching out.', statusCode: 400 }), false);
    assert.equal(health.isRealError({ message: 'Already punched out today', statusCode: 400 }), false);
    assert.equal(health.isRealError({ message: 'Session expired', statusCode: 401 }), false);
    assert.equal(health.isRealError({ message: 'Network Error', statusCode: null }), true);
    assert.equal(health.isRealError({ message: 'Something went wrong on our side. Try again.', statusCode: 500 }), true);
    assert.equal(health.errorKey('punched in 11s ago'), health.errorKey('punched in 15s ago'));
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
//  Feature toggles
// ═════════════════════════════════════════════════════════════════════════════

const { resolveFeatureToggles, FEATURE_TOGGLE_DEFAULTS } = require('../src/utils/feature_toggles');

test('feature toggles: a tenant with nothing stored gets every shipped feature', () => {
    const t = resolveFeatureToggles(undefined);
    for (const key of ['tracking', 'leads', 'expenses', 'advanceSalary', 'announcements', 'biometricDevices', 'assets', 'geofenceAutoPunchOut']) {
        assert.equal(t[key], true, `${key} should default on`);
    }
});

test('feature toggles: stored choices win, from a Map or a lean() object', () => {
    assert.equal(resolveFeatureToggles(new Map([['assets', false]])).assets, false);
    assert.equal(resolveFeatureToggles({ leads: false }).leads, false);
    assert.equal(resolveFeatureToggles({ leads: false }).tracking, true);
});

test('feature toggles: unknown or non-boolean stored values are ignored', () => {
    const t = resolveFeatureToggles({ bogus: true, tracking: 'no' });
    assert.equal('bogus' in t, false);
    assert.equal(t.tracking, FEATURE_TOGGLE_DEFAULTS.tracking);
});

// ═════════════════════════════════════════════════════════════════════════════
//  Working day — which day a punch is filed under (night shifts)
// ═════════════════════════════════════════════════════════════════════════════

section('working day');

const { workDayKey, lateOutDayStart } = require('../src/utils/working_day');
const { istDateKey: dayKeyOf } = require('../src/utils/attendance_helpers');

/** An IST wall-clock instant, independent of the host timezone. */
const istAt = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS);

const NIGHT = { startTime: '22:00', endTime: '06:00' };
const DAYSHIFT = { startTime: '09:30', endTime: '18:30' };

test('working day: a day shift is always filed under the calendar day', () => {
    assert.equal(workDayKey(DAYSHIFT, istAt(2026, 9, 10, 9, 25)), '2026-09-10');
    assert.equal(workDayKey(DAYSHIFT, istAt(2026, 9, 10, 23, 50)), '2026-09-10');
    assert.equal(workDayKey(DAYSHIFT, istAt(2026, 9, 11, 0, 30)), '2026-09-11');
    assert.equal(workDayKey(null, istAt(2026, 9, 11, 0, 30)), '2026-09-11');
});

test('working day: a night shift after midnight belongs to the night it started', () => {
    assert.equal(workDayKey(NIGHT, istAt(2026, 9, 10, 21, 50)), '2026-09-10'); // early arrival
    assert.equal(workDayKey(NIGHT, istAt(2026, 9, 11, 0, 30)), '2026-09-10');  // late arrival
    assert.equal(workDayKey(NIGHT, istAt(2026, 9, 11, 5, 59)), '2026-09-10');
    assert.equal(workDayKey(NIGHT, istAt(2026, 9, 11, 21, 55)), '2026-09-11'); // next night
});

test('working day: a punch-out just after a night shift ends reaches back to that night', () => {
    assert.equal(lateOutDayStart(NIGHT, istAt(2026, 9, 11, 5, 0)), null);      // still inside
    assert.equal(dayKeyOf(lateOutDayStart(NIGHT, istAt(2026, 9, 11, 6, 30))), '2026-09-10');
    assert.equal(dayKeyOf(lateOutDayStart(NIGHT, istAt(2026, 9, 11, 11, 59))), '2026-09-10');
    assert.equal(lateOutDayStart(NIGHT, istAt(2026, 9, 11, 12, 30)), null);    // past the 6h margin
    assert.equal(lateOutDayStart(DAYSHIFT, istAt(2026, 9, 11, 1, 0)), null);   // day shifts never carry
});

test('working day: the late punch-out margin never reaches into the next night', () => {
    // An 18-hour 12:00-06:00 shift: 06:00 + 6h lands exactly on the next start.
    const LONG = { startTime: '12:00', endTime: '06:00' };
    assert.equal(dayKeyOf(lateOutDayStart(LONG, istAt(2026, 9, 11, 11, 59))), '2026-09-10');
    assert.equal(workDayKey(LONG, istAt(2026, 9, 11, 12, 0)), '2026-09-11');
    assert.equal(lateOutDayStart(LONG, istAt(2026, 9, 11, 12, 1)), null);
});

// ═════════════════════════════════════════════════════════════════════════════
//  Payroll engine — IST day boundaries and the day-sum invariant
// ═════════════════════════════════════════════════════════════════════════════

section('payroll engine');

const payroll = require('../src/utils/payroll_engine');

// August 2026: 31 days, Sundays 2/9/16/23/30. Tenant works Mon-Sat.
const PAY_SETTINGS = { payroll: { enabled: true }, attendance: { workDays: ['M', 'T', 'W', 'Th', 'F', 'Sa'] } };
const AUG_31 = new Date(2026, 7, 31, 12); // a completed-month asOfDate (local calendar date)
const istMidnightOf = (y, mo, d) => new Date(Date.UTC(y, mo - 1, d) - IST_OFFSET_MS);
const presentOn = (days) => days.map((d) => ({ date: istMidnightOf(2026, 8, d), status: 'present' }));
const workingDaysAug = [];
for (let d = 1; d <= 31; d++) if (new Date(2026, 7, d).getDay() !== 0) workingDaysAug.push(d);

test('payroll: a leave stored at IST midnight lands on its own day, on any host', () => {
    const lt = { L: { isPaid: true } };
    // 1 Sep IST midnight is 31 Aug 18:30 UTC; read with host getters on a UTC
    // host this used to become 31 Aug.
    const istStored = payroll.buildLeaveMap([{ status: 'approved', leaveTypeId: 'L', startDate: istMidnightOf(2026, 9, 1), endDate: istMidnightOf(2026, 9, 1) }], lt, 2026, 9);
    assert.deepEqual([...istStored.keys()], ['2026-09-01']);
    const utcStored = payroll.buildLeaveMap([{ status: 'approved', leaveTypeId: 'L', startDate: new Date(Date.UTC(2026, 8, 1)), endDate: new Date(Date.UTC(2026, 8, 1)) }], lt, 2026, 9);
    assert.deepEqual([...utcStored.keys()], ['2026-09-01']);
});

test('payroll: the pay window starts on the joining day however it was stored', () => {
    for (const joiningDate of [new Date(Date.UTC(2026, 7, 12)), istMidnightOf(2026, 8, 12)]) {
        const r = payroll.runEngine({ emp: { salary: 30000, joiningDate }, settings: PAY_SETTINGS, year: 2026, month: 8, attendanceRecords: presentOn(workingDaysAug.filter((d) => d >= 12)), asOfDate: AUG_31 });
        assert.equal(r.totalDaysInWindow, 20);
        assert.equal(r.counts.present, 17);
        assert.equal(r.payableDays, 20);
    }
});

test('payroll: a month that ends before the joining date has an empty window', () => {
    const r = payroll.runEngine({ emp: { salary: 30000, joiningDate: new Date(Date.UTC(2026, 8, 3)) }, settings: PAY_SETTINGS, year: 2026, month: 8, attendanceRecords: [], asOfDate: AUG_31 });
    assert.equal(r.totalDaysInWindow, 0);
    assert.equal(r.invariantSum, 0);
    assert.equal(r.payableDays, 0);
});

test('payroll: "today" defaults to the IST day, not the host day', () => {
    // 00:30 IST on 1 Sep is still 31 Aug on a UTC host.
    const FIXED = istAt(2026, 9, 1, 0, 30).getTime();
    const RealDate = Date;
    global.Date = class extends RealDate {
        constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
        static now() { return FIXED; }
    };
    try {
        const r = payroll.classifyMonth({ emp: {}, year: 2026, month: 9, attendanceByKey: new Map(), festivalSet: new Set(), leaveByKey: new Map(), workDays: PAY_SETTINGS.attendance.workDays });
        assert.equal(r.isCurrentMonth, true);
        assert.equal(r.windowEnd, 1);
    } finally {
        global.Date = RealDate;
    }
});

test('payroll: every day lands in one bucket; a needs_review day blocks the run', () => {
    const recs = presentOn(workingDaysAug.filter((d) => d !== 19));
    recs.push({ date: istMidnightOf(2026, 8, 19), status: 'needs_review' });
    const r = payroll.runEngine({ emp: { salary: 30000 }, settings: PAY_SETTINGS, year: 2026, month: 8, attendanceRecords: recs, asOfDate: AUG_31 });
    assert.equal(r.invariantSum, 31);
    assert.equal(r.counts.needsReview, 1);
    assert.equal(r.payableDays, 30); // 25 present + 5 Sundays; the review day pays 0 pending a decision
    const v = payroll.validateSalary({ counts: r.counts, windowEnd: r.totalDaysInWindow, baseSalary: 30000, netSalary: 30000 });
    assert.equal(v.ok, false);
    assert.match(v.errors.join(' '), /1 attendance day\(s\) need checking/);
});

test('payroll: a paid half-day leave tops up a half-day attended, and pays half on an absent day', () => {
    const recs = presentOn(workingDaysAug.filter((d) => d !== 18 && d !== 20));
    recs.push({ date: istMidnightOf(2026, 8, 18), status: 'half-day' });
    const leaves = [
        { status: 'approved', leaveTypeId: 'L', startDate: new Date(Date.UTC(2026, 7, 18)), endDate: new Date(Date.UTC(2026, 7, 18)), dayPortion: 'first_half' },
        { status: 'approved', leaveTypeId: 'L', startDate: new Date(Date.UTC(2026, 7, 20)), endDate: new Date(Date.UTC(2026, 7, 20)), dayPortion: 'second_half' },
    ];
    const r = payroll.runEngine({ emp: { salary: 30000 }, settings: PAY_SETTINGS, year: 2026, month: 8, attendanceRecords: recs, leaves, leaveTypesById: { L: { isPaid: true } }, asOfDate: AUG_31 });
    assert.equal(r.counts.halfDay, 1);
    assert.equal(r.counts.paidLeave, 1);
    // 24 present + 18th (0.5 + 0.5) + 20th (0.5) + 5 Sundays
    assert.equal(r.payableDays, 30.5);
});

test('payroll: with no work at all, weekly offs are not paid', () => {
    const r = payroll.runEngine({ emp: { salary: 30000 }, settings: { ...PAY_SETTINGS, payroll: { enabled: true, sandwichRuleEnabled: false } }, year: 2026, month: 8, attendanceRecords: [], asOfDate: AUG_31 });
    assert.equal(r.counts.weeklyOff, 5);
    assert.equal(r.payableDays, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
//  "Forgot to punch in / out" ticket rules (utils/punch_correction.js)
// ═════════════════════════════════════════════════════════════════════════════

const pc = require('../src/utils/punch_correction');
// 26 Sep 2026 in IST, built without the host clock.
const pcAt = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h, mi) - 5.5 * 60 * 60 * 1000);
const DAY_SHIFT = { startTime: '09:30', endTime: '18:30' };
const NIGHT_SHIFT = { startTime: '22:00', endTime: '06:00' };
const dayRow = (fields) => ({ date: pcAt(2026, 9, 26, 0, 0), shifts: [], ...fields });

test('correction: fmt12 and dayFromKey read IST and refuse impossible dates', () => {
    assert.equal(pc.fmt12(pcAt(2026, 9, 26, 9, 30)), '9:30 AM');
    assert.equal(pc.fmt12(pcAt(2026, 9, 26, 0, 5)), '12:05 AM');
    assert.equal(pc.fmt12(pcAt(2026, 9, 26, 18, 0)), '6:00 PM');
    assert.equal(pc.dayFromKey('2026-02-31'), null);
    assert.equal(pc.dayFromKey('26-09-2026'), null);
    assert.equal(pc.dayFromKey('2026-09-26').getTime(), pcAt(2026, 9, 26, 0, 0).getTime());
});

test('correction: a night shift maps after-midnight times to the next morning', () => {
    assert.equal(pc.correctionInstant('2026-09-26', '09:30', DAY_SHIFT).getTime(), pcAt(2026, 9, 26, 9, 30).getTime());
    assert.equal(pc.correctionInstant('2026-09-26', '23:15', NIGHT_SHIFT).getTime(), pcAt(2026, 9, 26, 23, 15).getTime());
    assert.equal(pc.correctionInstant('2026-09-26', '05:30', NIGHT_SHIFT).getTime(), pcAt(2026, 9, 27, 5, 30).getTime());
    // Just before the start stays on the day (and is then refused as too early).
    assert.equal(pc.correctionInstant('2026-09-26', '21:45', NIGHT_SHIFT).getTime(), pcAt(2026, 9, 26, 21, 45).getTime());
    assert.equal(pc.correctionInstant('2026-09-26', '24:00', DAY_SHIFT), null);
    assert.equal(pc.correctionInstant('2026-09-26', '9:5', DAY_SHIFT), null);
});

test('correction: punch-in must be earlier than recorded and not before the shift', () => {
    const now = pcAt(2026, 9, 26, 12, 0);
    const att = dayRow({ punchIn: pcAt(2026, 9, 26, 10, 0) });
    const ask = (h, m, shift = DAY_SHIFT) => pc.correctionProblem({ field: 'punchIn', requested: pcAt(2026, 9, 26, h, m), attendance: att, shift, now });
    assert.equal(ask(9, 30), null);                       // the owner's case
    assert.match(ask(10, 0), /before your punch-in \(10:00 AM\)/);
    assert.match(ask(10, 15), /before your punch-in/);
    assert.match(ask(9, 0), /shift starts at 9:30 AM/);
    assert.equal(ask(6, 0, null), null);                  // no shift, no bound
    assert.match(pc.correctionProblem({ field: 'punchIn', requested: pcAt(2026, 9, 26, 9, 30), attendance: dayRow({}), shift: DAY_SHIFT, now }), /no punch-in on this day/);
    assert.match(pc.correctionProblem({ field: 'punchIn', requested: pcAt(2026, 9, 26, 9, 30), attendance: null, shift: DAY_SHIFT, now }), /ask your admin/);
});

test('correction: punch-out after punch-in, not future, not past shift end', () => {
    const att = dayRow({ punchIn: pcAt(2026, 9, 26, 9, 30), punchOut: pcAt(2026, 9, 26, 20, 0) });
    const now = pcAt(2026, 9, 26, 21, 0);
    const ask = (h, m, a = att, n = now) => pc.correctionProblem({ field: 'punchOut', requested: pcAt(2026, 9, 26, h, m), attendance: a, shift: DAY_SHIFT, now: n });
    assert.equal(ask(18, 30), null);
    assert.match(ask(19, 0), /shift ends at 6:30 PM/);
    assert.match(ask(9, 0), /after you punched in \(9:30 AM\)/);
    assert.match(ask(18, 0, att, pcAt(2026, 9, 26, 17, 0)), /has not come yet/);
    const same = dayRow({ punchIn: pcAt(2026, 9, 26, 9, 30), punchOut: pcAt(2026, 9, 26, 18, 0) });
    assert.match(ask(18, 0, same), /already 6:00 PM/);
    const lunch = dayRow({ punchIn: pcAt(2026, 9, 26, 9, 30), lunchOutTime: pcAt(2026, 9, 26, 14, 0) });
    assert.match(ask(13, 30, lunch), /lunch break ended \(2:00 PM\)/);
});

test('correction: a night shift is bounded by its own occurrence', () => {
    const att = dayRow({ punchIn: pcAt(2026, 9, 26, 22, 40) });
    const now = pcAt(2026, 9, 27, 9, 0);
    const out = (d, h, m) => pc.correctionProblem({ field: 'punchOut', requested: pcAt(2026, 9, d, h, m), attendance: att, shift: NIGHT_SHIFT, now });
    assert.equal(out(27, 5, 30), null);
    assert.match(out(27, 6, 30), /shift ends at 6:00 AM/);
    const inn = pc.correctionProblem({ field: 'punchIn', requested: pcAt(2026, 9, 26, 22, 0), attendance: att, shift: NIGHT_SHIFT, now });
    assert.equal(inn, null);
    const early = pc.correctionProblem({ field: 'punchIn', requested: pcAt(2026, 9, 26, 21, 45), attendance: att, shift: NIGHT_SHIFT, now });
    assert.match(early, /shift starts at 10:00 PM/);
    // The approval day bound stretches past midnight only for a night shift.
    assert.ok(pc.correctionDayEnd(pcAt(2026, 9, 26, 0, 0), NIGHT_SHIFT, 0).getTime() === pcAt(2026, 9, 27, 6, 0).getTime());
    assert.ok(pc.correctionDayEnd(pcAt(2026, 9, 26, 0, 0), DAY_SHIFT, 0).getTime() < pcAt(2026, 9, 27, 0, 0).getTime());
});

test('correction: day window and the punch-out target session', () => {
    const now = pcAt(2026, 9, 26, 12, 0);
    assert.equal(pc.windowProblem(pcAt(2026, 9, 26, 0, 0), now, 7), null);
    assert.equal(pc.windowProblem(pcAt(2026, 9, 20, 0, 0), now, 7), null);
    assert.match(pc.windowProblem(pcAt(2026, 9, 19, 0, 0), now, 7), /last 7 days/);
    assert.match(pc.windowProblem(pcAt(2026, 9, 27, 0, 0), now, 7), /future/);
    const s1 = { punchIn: pcAt(2026, 9, 26, 9, 30), punchOut: pcAt(2026, 9, 26, 13, 0) };
    const s2 = { punchIn: pcAt(2026, 9, 26, 14, 0), punchOut: pcAt(2026, 9, 26, 18, 30), closeReason: 'shift_end' };
    assert.equal(pc.punchOutTarget({ shifts: [s2, s1] }), s2);
    assert.equal(pc.recordedPunchOut({ shifts: [s1, s2] }).getTime(), s2.punchOut.getTime());
    // A punch-out for a two-session day must be after the LAST session began.
    const att = dayRow({ punchIn: s1.punchIn, punchOut: s2.punchOut, shifts: [s1, s2] });
    assert.match(pc.correctionProblem({ field: 'punchOut', requested: pcAt(2026, 9, 26, 13, 30), attendance: att, shift: DAY_SHIFT, now: pcAt(2026, 9, 26, 20, 0) }), /after you punched in \(2:00 PM\)/);
});

// ═════════════════════════════════════════════════════════════════════════════
//  OTA update check: never offer a bundle older than the APK's own version
// ═════════════════════════════════════════════════════════════════════════════

section('ota version guard');

const { parseVersion, isOlderThanApk } = require('../src/utils/ota_version');

test('ota: versions are read numerically, ignoring a prefix and a suffix', () => {
    assert.deepEqual(parseVersion('1.9.6'), [1, 9, 6]);
    assert.deepEqual(parseVersion('v1.9.6'), [1, 9, 6]);
    assert.deepEqual(parseVersion('1.9.6-staging'), [1, 9, 6]);
    assert.equal(parseVersion('builtin'), null);
    assert.equal(parseVersion(undefined), null);
});

test('ota: a release older than the APK is not offered (the live 1.9.6 vs 1.9.5 downgrade)', () => {
    assert.equal(isOlderThanApk('1.9.5', '1.9.6'), true);
    assert.equal(isOlderThanApk('1.9.5', '1.9.6-staging'), true);
    assert.equal(isOlderThanApk('1.6.9', '1.9.0'), true);
});

test('ota: numeric, not alphabetical (1.10.0 is newer than 1.9.6)', () => {
    assert.equal(isOlderThanApk('1.9.6', '1.10.0'), true);
    assert.equal(isOlderThanApk('1.10.0', '1.9.6'), false);
});

test('ota: an equal or newer release is still offered, so a rollback to a bundle as new as the APK works', () => {
    assert.equal(isOlderThanApk('1.9.6', '1.9.6'), false);
    assert.equal(isOlderThanApk('1.9.6', '1.9.6-staging'), false);
    assert.equal(isOlderThanApk('1.9.7', '1.9.6'), false);
    assert.equal(isOlderThanApk('2.0', '1.9.6'), false);
});

test('ota: with nothing to compare, behaviour is unchanged (the release is offered)', () => {
    assert.equal(isOlderThanApk('1.9.5', undefined), false);
    assert.equal(isOlderThanApk('1.9.5', 'unknown'), false);
    assert.equal(isOlderThanApk('builtin', '1.9.6'), false);
});

// ═════════════════════════════════════════════════════════════════════════════
//  Biometric taps are stored on the SERVER's clock, whatever the terminal's says
// ═════════════════════════════════════════════════════════════════════════════

section('device clock -> server time');

const { observeServerOffset, toServerTime, recordClockSkew } = require('../src/utils/device_clock');
const { parseDeviceTimestamp } = require('../src/utils/attendance_helpers');

const MIN = 60 * 1000;
// An instant from an IST wall time on 2026-10-06.
const clockIst = (hh, mm, ss = 0) => new Date(Date.UTC(2026, 9, 6, hh, mm, ss) - IST_OFFSET_MS);
// What a terminal whose clock is `behindMin` minutes slow stamps for that instant.
const terminalStamp = (instant, behindMin) => new Date(instant.getTime() - behindMin * MIN);
// One ATTLOG batch arriving at `receivedAt`: learn from all of it (newest first,
// as pushData does), then convert each tap.
function deliver(device, stamps, receivedAt) {
    [...stamps].sort((a, b) => b - a).forEach((t) => observeServerOffset(device, t, receivedAt));
    return stamps.map((t) => toServerTime(device, t));
}

test('clock: UTC terminal, live tap -- machine shows 10:32, stored 16:02 (the server time)', () => {
    const device = {};
    // The terminal's text "10:32" is read as 10:32 IST, which is 5h30m early.
    const stamp = parseDeviceTimestamp('2026-10-06 10:32:00', clockIst(16, 2, 2), 0);
    const [stored] = deliver(device, [stamp], clockIst(16, 2, 2));
    assert.equal(istHHMM(stored), '16:02');
});

test('clock: UTC terminal, offline tap -- tapped 10:45, delivered 11:12 -- stored 10:45, not late', () => {
    const device = {};
    deliver(device, [terminalStamp(clockIst(9, 30), 330)], clockIst(9, 30, 1)); // a live tap earlier
    const [stored] = deliver(device, [terminalStamp(clockIst(10, 45), 330)], clockIst(11, 12));
    assert.equal(istHHMM(stored), '10:45');
});

test('clock: correct-clock terminal, offline tap -- still the time it was made', () => {
    const device = {};
    deliver(device, [clockIst(9, 30)], clockIst(9, 30, 1));
    const [stored] = deliver(device, [clockIst(10, 45)], clockIst(11, 12));
    assert.equal(istHHMM(stored), '10:45');
});

test('clock: a 20-tap backlog ending with a live tap keeps every tap at its own time', () => {
    const device = {};
    const taps = Array.from({ length: 20 }, (_, i) => terminalStamp(clockIst(9, 50 + Math.floor(i / 2)), 330));
    taps.push(terminalStamp(clockIst(11, 12), 330)); // tapped just after the wifi came back
    const stored = deliver(device, taps, clockIst(11, 12, 3));
    assert.equal(istHHMM(stored[0]), '09:50');
    assert.equal(istHHMM(stored[19]), '09:59');
    assert.equal(istHHMM(stored[20]), '11:12');
});

test('clock: a held-back burst never moves a learned offset (no "slow clock" from a backlog)', () => {
    const device = {};
    deliver(device, [clockIst(9, 0)], clockIst(9, 0, 1));
    const before = device.serverOffsetMs;
    const burst = Array.from({ length: 20 }, (_, i) => clockIst(9, 50 + Math.floor(i / 2)));
    const stored = deliver(device, burst, clockIst(11, 12));
    assert.equal(device.serverOffsetMs, before);
    assert.equal(istHHMM(stored[0]), '09:50');
});

test('clock: no tap is ever stored after it arrived', () => {
    const device = {};
    const stored = deliver(device, [clockIst(9, 50), clockIst(9, 58)], clockIst(11, 12));
    for (const s of stored) assert.ok(s.getTime() <= clockIst(11, 12).getTime());
});

test('clock: a clock put right (330 -> 0) is followed on the very next live tap', () => {
    const device = {};
    deliver(device, [terminalStamp(clockIst(9, 0), 330)], clockIst(9, 0));
    const [stored] = deliver(device, [clockIst(10, 0)], clockIst(10, 0, 1));
    assert.equal(istHHMM(stored), '10:00');
    assert.ok(Math.abs(device.serverOffsetMs) < MIN);
});

test('clock: a clock that fell behind (0 -> 330) is followed once live taps agree over 30 min', () => {
    const device = {};
    deliver(device, [clockIst(9, 0)], clockIst(9, 0));
    deliver(device, [terminalStamp(clockIst(10, 0), 330)], clockIst(10, 0));
    deliver(device, [terminalStamp(clockIst(10, 15), 330)], clockIst(10, 15));
    const [stored] = deliver(device, [terminalStamp(clockIst(10, 31), 330)], clockIst(10, 31));
    assert.equal(istHHMM(stored), '10:31');
});

test('clock: ...but three agreeing taps arriving together (a backlog) do not move it', () => {
    const device = {};
    deliver(device, [clockIst(9, 0)], clockIst(9, 0));
    const before = device.serverOffsetMs;
    deliver(device, [clockIst(9, 50), clockIst(9, 50, 30), clockIst(9, 51)], clockIst(11, 12));
    assert.equal(device.serverOffsetMs, before);
});

test('clock: an offset nothing has confirmed for 7 days is relearned', () => {
    const device = {};
    deliver(device, [terminalStamp(clockIst(9, 0), 330)], clockIst(9, 0));
    const weekLater = new Date(clockIst(9, 0).getTime() + 8 * 24 * 60 * MIN);
    observeServerOffset(device, new Date(weekLater.getTime() - 5 * MIN), weekLater);
    assert.ok(Math.abs(device.serverOffsetMs - 5 * MIN) < 1000);
});

test('clock: a manual Clock correction still wins over the learned offset', () => {
    const device = { clockOffsetMinutes: 330, serverOffsetMs: 0 };
    assert.equal(istHHMM(toServerTime(device, terminalStamp(clockIst(16, 2), 330))), '16:02');
});

test('clock: recordClockSkew (the clock alert) still records each tap', () => {
    const device = { clockSkewSamples: [] };
    recordClockSkew(device, terminalStamp(clockIst(16, 2), 330), clockIst(16, 2));
    assert.equal(device.clockSkewSamples[0].minutes, 330);
});

// ═════════════════════════════════════════════════════════════════════════════
//  Per-employee lock: a double tap must not run two read-then-write handlers at once
// ═════════════════════════════════════════════════════════════════════════════

section('employee lock');

const { withEmployeeLock, serialisePerUser, queuedKeys } = require('../src/utils/employee_lock');
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const asyncTests = [];
function atest(name, fn) { asyncTests.push({ name, fn }); }

atest('lock: two actions for one person never overlap, and run in arrival order', async () => {
    const log = [];
    let running = 0, peak = 0;
    const job = (id, ms) => () => withEmployeeLock('emp-1', async () => {
        running++; peak = Math.max(peak, running); log.push(`start ${id}`);
        await nap(ms); log.push(`end ${id}`); running--; return id;
    });
    const results = await Promise.all([job('A', 30)(), job('B', 5)(), job('C', 5)()]);
    assert.deepEqual(results, ['A', 'B', 'C']);
    assert.equal(peak, 1, 'two actions ran at the same time');
    assert.deepEqual(log, ['start A', 'end A', 'start B', 'end B', 'start C', 'end C']);
});

atest('lock: different people are not held up by each other', async () => {
    let running = 0, peak = 0;
    const job = (key) => withEmployeeLock(key, async () => { running++; peak = Math.max(peak, running); await nap(25); running--; });
    await Promise.all([job('emp-1'), job('emp-2'), job('emp-3')]);
    assert.equal(peak, 3);
});

atest('lock: an action that throws does not block the next one, and its error reaches its own caller', async () => {
    const first = withEmployeeLock('emp-err', async () => { throw new Error('boom'); });
    const second = withEmployeeLock('emp-err', async () => 'ran');
    await assert.rejects(first, /boom/);
    assert.equal(await second, 'ran');
});

atest('lock: the second of two identical creates sees the first one (the double-tap case)', async () => {
    const rows = [];
    const create = () => withEmployeeLock('emp-dup', async () => {
        const exists = rows.length > 0;          // the "read"
        await nap(10);                           // time between read and write
        if (exists) return 'already there';
        rows.push('row'); return 'created';      // the "write"
    });
    const out = await Promise.all([create(), create(), create()]);
    assert.deepEqual(out, ['created', 'already there', 'already there']);
    assert.equal(rows.length, 1);
});

atest('lock: the same three calls WITHOUT the lock make three rows (proves the test catches the bug)', async () => {
    const rows = [];
    const create = async () => { const exists = rows.length > 0; await nap(10); if (exists) return 'already there'; rows.push('row'); return 'created'; };
    await Promise.all([create(), create(), create()]);
    assert.equal(rows.length, 3);
});

atest('lock: a stuck action stops holding the queue after the safety limit', async () => {
    process.env.EMPLOYEE_LOCK_MAX_HOLD_MS = '40';
    delete require.cache[require.resolve('../src/utils/employee_lock')];
    const fresh = require('../src/utils/employee_lock');
    const stuck = fresh.withEmployeeLock('emp-stuck', () => nap(400));
    const t0 = Date.now();
    const next = fresh.withEmployeeLock('emp-stuck', async () => 'ran');
    assert.equal(await next, 'ran');
    assert.ok(Date.now() - t0 < 300, `next action waited ${Date.now() - t0} ms behind a stuck one`);
    await stuck;
    delete process.env.EMPLOYEE_LOCK_MAX_HOLD_MS;
    delete require.cache[require.resolve('../src/utils/employee_lock')];
});

atest('lock: nothing is left queued once everything has finished', async () => {
    await withEmployeeLock('emp-clean', async () => nap(5));
    await nap(20);
    assert.equal(queuedKeys(), 0);
});

atest('lock: an Express handler is wrapped per signed-in user, and a request with no user just runs', async () => {
    const calls = [];
    const wrapped = serialisePerUser(async (req) => { calls.push(req.userId || 'none'); await nap(5); return 'ok'; }, 'punch');
    assert.equal(await wrapped({ userId: 'u1' }, {}), 'ok');
    assert.equal(await wrapped({}, {}), 'ok');
    assert.deepEqual(calls, ['u1', 'none']);
});

// ═════════════════════════════════════════════════════════════════════════════
//  Summary
// ═════════════════════════════════════════════════════════════════════════════

// The lock tests are asynchronous, so they run here, one after another, before the totals.
(async () => {
    for (const t of asyncTests) {
        try {
            await t.fn();
            passed++;
            console.log(`  PASS  ${t.name}`);
        } catch (e) {
            failed++;
            console.error(`  FAIL  ${t.name}`);
            console.error(`    ${e.message}`);
        }
    }
    console.log(`\n============================================`);
    console.log(`  ${passed} passed, ${failed} failed (TZ=${process.env.TZ || 'system default'})`);
    console.log(`============================================`);

    process.exitCode = failed > 0 ? 1 : 0;
})();
