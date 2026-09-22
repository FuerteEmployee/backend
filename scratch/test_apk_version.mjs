/**
 * evaluateApk / parseVersionCode — the gate that decides whether an employee
 * is allowed to punch.
 *
 *   node scratch/test_apk_version.mjs
 *
 * Pure logic, no DB. Mirrors botcrm-frontend-/src/lib/apk-update.ts.
 *
 * Two properties matter more than the rest and both have cost a product
 * somewhere: comparing on versionCode rather than the name (so "1.10" beats
 * "1.9"), and never blocking on a reading we did not actually get.
 */
import assert from 'node:assert/strict';

// ── mirror of src/lib/apk-update.ts ──────────────────────────────────────────
const UP_TO_DATE = { release: null, installedCode: null, outdated: false, blocking: false };

function parseVersionCode(build) {
    if (build == null) return null;
    const n = Number(String(build).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
}

function evaluateApk(release, installedCode) {
    if (!release) return UP_TO_DATE;
    if (installedCode == null) return { ...UP_TO_DATE, release: null };
    const outdated = release.versionCode > installedCode;
    return {
        release: outdated ? release : null,
        installedCode,
        outdated,
        blocking: outdated && release.mandatory === true,
    };
}

// ── harness ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const test = (name, fn) => {
    try { fn(); pass++; console.log(`  PASS  ${name}`); }
    catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
const rel = (versionName, versionCode, mandatory = false) => ({ versionName, versionCode, mandatory });

console.log('- version ordering -');

test('a higher versionCode is an update', () => {
    const s = evaluateApk(rel('1.9', 9), 8);
    assert.equal(s.outdated, true);
    assert.equal(s.release.versionName, '1.9');
});

test('the same versionCode is not an update', () => {
    assert.equal(evaluateApk(rel('1.8', 8), 8).outdated, false);
});

test('a device AHEAD of the published build is not an update', () => {
    // Happens to whoever is testing the next build before it is published.
    assert.equal(evaluateApk(rel('1.8', 8), 9).outdated, false);
});

test('1.10 beats 1.9 — the reason this compares codes, not names', () => {
    // As strings, "1.10" < "1.9". A name comparison would tell the NEWEST
    // install it was out of date and, if mandatory, stop it punching.
    assert.ok('1.10' < '1.9', 'precondition: string ordering really is wrong here');
    assert.equal(evaluateApk(rel('1.10', 10), 9).outdated, true);
    assert.equal(evaluateApk(rel('1.9', 9), 10).outdated, false);
});

console.log('\n- never block on a reading we did not get -');

test('an unknown installed version never blocks, even for a mandatory build', () => {
    const s = evaluateApk(rel('2.0', 20, true), null);
    assert.equal(s.blocking, false);
    assert.equal(s.release, null, 'and it does not nag either');
});

test('an unparseable build string reads as unknown, not as zero', () => {
    // Zero would compare as infinitely out of date and lock the employee out.
    for (const bad of [null, undefined, '', '   ', 'abc', '0', '-3', '1.8']) {
        assert.equal(parseVersionCode(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
    assert.equal(parseVersionCode('8'), 8);
    assert.equal(parseVersionCode(' 12 '), 12);
});

test('no published release blocks nothing', () => {
    assert.equal(evaluateApk(null, 8).blocking, false);
});

console.log('\n- mandatory -');

test('mandatory + outdated blocks', () => {
    assert.equal(evaluateApk(rel('1.9', 9, true), 8).blocking, true);
});

test('mandatory but already up to date does NOT block', () => {
    const s = evaluateApk(rel('1.9', 9, true), 9);
    assert.equal(s.blocking, false);
    assert.equal(s.outdated, false);
});

test('outdated but not mandatory prompts without blocking', () => {
    const s = evaluateApk(rel('1.9', 9, false), 8);
    assert.equal(s.outdated, true);
    assert.equal(s.blocking, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
