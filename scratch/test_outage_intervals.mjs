/**
 * buildOutageIntervals — pairing on/off events into outages with durations.
 *
 *   node scratch/test_outage_intervals.mjs
 *
 * Pure logic, no DB, no network. Lives here because the backend is the only
 * place in this repo with a working `node <file>` test convention; the function
 * under test is the frontend's, mirrored below.
 *
 * The three cases that matter are the ones where an edge is UNKNOWN. A
 * fabricated duration on a support page shown to a client is worse than an
 * admitted gap, so each of those must come back null rather than guessed.
 */
import assert from 'node:assert/strict';

// ── mirror of botcrm-frontend-/src/services/client-service.ts ────────────────
const OUTAGE_PAIRS = [
    { kind: 'network', down: 'network_off', up: 'network_on' },
    { kind: 'gps', down: 'gps_off', up: 'gps_on' },
    { kind: 'airplane', down: 'airplane_on', up: 'airplane_off' },
];

function buildOutageIntervals(events) {
    const ordered = [...events].sort((a, b) => +new Date(a.at) - +new Date(b.at));
    const out = [];

    for (const { kind, down, up } of OUTAGE_PAIRS) {
        const relevant = ordered.filter((e) => e.type === down || e.type === up);
        let openedAt = null;
        let seenDown = false;

        for (const e of relevant) {
            if (e.type === down) {
                if (!seenDown) { openedAt = e.at; seenDown = true; }
                continue;
            }
            if (!seenDown) {
                out.push({ kind, start: null, end: e.at, durationMs: null, startedBeforeWindow: true, stillOpen: false });
                continue;
            }
            out.push({
                kind, start: openedAt, end: e.at,
                durationMs: openedAt ? +new Date(e.at) - +new Date(openedAt) : null,
                startedBeforeWindow: false, stillOpen: false,
            });
            openedAt = null;
            seenDown = false;
        }

        if (seenDown && openedAt) {
            out.push({ kind, start: openedAt, end: null, durationMs: null, startedBeforeWindow: false, stillOpen: true });
        }
    }

    return out.sort((a, b) => +new Date(b.start ?? b.end ?? 0) - +new Date(a.start ?? a.end ?? 0));
}

// ── harness ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const test = (name, fn) => {
    try { fn(); pass++; console.log(`  PASS  ${name}`); }
    catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
const ev = (type, at) => ({ type, at });
const MIN = 60 * 1000;

console.log('- pairing -');

test('a clean off -> on pair yields one outage with a duration', () => {
    const r = buildOutageIntervals([
        ev('network_off', '2026-09-16T14:22:00Z'),
        ev('network_on', '2026-09-16T15:07:00Z'),
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, 'network');
    assert.equal(r[0].durationMs, 45 * MIN);
    assert.equal(r[0].stillOpen, false);
    assert.equal(r[0].startedBeforeWindow, false);
});

test('events arriving NEWEST FIRST (as the API returns them) still pair', () => {
    const r = buildOutageIntervals([
        ev('network_on', '2026-09-16T15:07:00Z'),
        ev('network_off', '2026-09-16T14:22:00Z'),
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0].durationMs, 45 * MIN);
});

console.log('\n- unknown edges are never guessed -');

test('a trailing off has no end and no duration', () => {
    const r = buildOutageIntervals([ev('network_off', '2026-09-16T14:22:00Z')]);
    assert.equal(r.length, 1);
    assert.equal(r[0].end, null);
    assert.equal(r[0].durationMs, null, 'an open outage must not be given a length');
    assert.equal(r[0].stillOpen, true);
});

test('a leading on has no start and no duration', () => {
    const r = buildOutageIntervals([ev('network_on', '2026-09-16T09:00:00Z')]);
    assert.equal(r.length, 1);
    assert.equal(r[0].start, null);
    assert.equal(r[0].durationMs, null);
    assert.equal(r[0].startedBeforeWindow, true);
});

test('a repeated off keeps the FIRST timestamp, not the latest', () => {
    const r = buildOutageIntervals([
        ev('network_off', '2026-09-16T14:00:00Z'),
        ev('network_off', '2026-09-16T14:30:00Z'),
        ev('network_on', '2026-09-16T15:00:00Z'),
    ]);
    assert.equal(r.length, 1, 'a repeat is not a second outage');
    assert.equal(r[0].durationMs, 60 * MIN, 'the outage began at the first off');
});

console.log('\n- kinds are tracked independently -');

test('overlapping network and GPS outages do not pair with each other', () => {
    const r = buildOutageIntervals([
        ev('network_off', '2026-09-16T10:00:00Z'),
        ev('gps_off', '2026-09-16T10:30:00Z'),
        ev('network_on', '2026-09-16T11:00:00Z'),
        ev('gps_on', '2026-09-16T12:00:00Z'),
    ]);
    assert.equal(r.length, 2);
    assert.equal(r.find((x) => x.kind === 'network').durationMs, 60 * MIN);
    assert.equal(r.find((x) => x.kind === 'gps').durationMs, 90 * MIN);
});

test('airplane mode is inverted — ON starts the outage', () => {
    const r = buildOutageIntervals([
        ev('airplane_on', '2026-09-16T08:00:00Z'),
        ev('airplane_off', '2026-09-16T09:00:00Z'),
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, 'airplane');
    assert.equal(r[0].durationMs, 60 * MIN);
});

test('unrelated event types are ignored entirely', () => {
    const r = buildOutageIntervals([
        ev('service_stop', '2026-09-16T10:00:00Z'),
        ev('doze_on', '2026-09-16T10:05:00Z'),
        ev('battery', '2026-09-16T10:06:00Z'),
    ]);
    assert.equal(r.length, 0);
});

test('an empty list is not an error', () => {
    assert.deepEqual(buildOutageIntervals([]), []);
});

console.log('\n- real staging shape -');

test("Bharat's 16-17 Sep GPS outage reads as one ~7h45m interval", () => {
    const r = buildOutageIntervals([
        ev('gps_off', '2026-09-16T17:46:03Z'),  // 23:16 IST
        ev('gps_on', '2026-09-17T01:30:57Z'),   // 07:00 IST
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, 'gps');
    assert.equal(Math.round(r[0].durationMs / MIN), 465); // 7h 44m 54s
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
