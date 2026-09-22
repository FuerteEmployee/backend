// ─────────────────────────────────────────────────────────────────────────────
// Turning a day of raw GPS fixes into a route a human can read.
//
// A phone that never leaves a desk still reports a fix every ~30s, and each one
// lands somewhere slightly different. Drawn literally, that is a scribble; summed
// literally, it is kilometres. Observed 2026-09-18: a handset that sat on a table
// all morning produced 567 fixes, a 304 m bounding box and "11.62 km travelled",
// while a second stationary phone produced 2.58 km inside a 44 m box.
//
// This is PRESENTATION ONLY. The raw fixes are never modified, never deleted and
// never hidden from the geofence engine, which does its own medoid/distinct
// reasoning over the unsmoothed data and must keep seeing exactly what the device
// reported. Smoothing the engine's input would change who gets punched out; that
// decision is not this file's to make.
//
// Two stages, because one is not enough:
//
//   1. WINDOW MEDOID. Fixes are grouped into short time windows and each window
//      collapses to its medoid -- the observed point with the smallest total
//      distance to the others in that window. A burst of drifted readings is
//      outvoted by the majority that sit at the real location, and the medoid is
//      always a real reading rather than an average of a cluster and an outlier.
//      This is the same reasoning geofence_window.js uses, for the same reason.
//
//   2. ANCHOR. Consecutive medoids closer together than the threshold are treated
//      as the same place: no line segment, no distance. The threshold is the
//      larger of a floor and the fix's own reported accuracy, so a poorly located
//      fix has to move further before it counts as movement.
//
// Calibrated on 2026-09-18 against four real days with known ground truth:
//
//   phone on a desk all day   11.63 km raw -> 0.67 km
//   stationary (44 m box)      2.58 km raw -> 0.00 km, one point
//   moved less than 100 m     11.19 km raw -> 0.38 km
//   genuinely left, 711 m out  1.90 km raw -> 0.73 km, preserved
//
// The last row is the constraint that matters. Filtering hard enough to force the
// desk phone to exactly zero also erased a real 711 m departure in testing --
// and a route that loses a journey somebody actually made is worse than one that
// still shows a little jitter, because it would be used to argue they never left.
// ─────────────────────────────────────────────────────────────────────────────

const { calculateDistance } = require('./distance');

/** Seconds of fixes collapsed into a single representative point. */
const WINDOW_MS = (Number(process.env.TRACK_SMOOTH_WINDOW_S) || 180) * 1000;

/**
 * Minimum separation, in metres, before two points count as different places.
 * Raised per-fix to that fix's own reported accuracy.
 */
const FLOOR_M = Number(process.env.TRACK_SMOOTH_FLOOR_M) || 40;

const dist = (a, b) => calculateDistance(a.latitude, a.longitude, b.latitude, b.longitude);

/** Confidence below which Play Services is guessing rather than reporting. */
const MIN_ACTIVITY_CONFIDENCE = Number(process.env.TRACK_STILL_CONFIDENCE) || 60;

/**
 * Did the DEVICE'S SENSORS say it was not moving when this fix was taken?
 *
 * Only ever true for `activitySource: 'sensor'`. A 'speed' label is derived from
 * GPS velocity, which on a stationary handset comes from the same drift it would
 * be used to suppress -- trusting it would let noise certify itself as noise,
 * and (worse) let a genuinely walking employee be labelled stationary and have
 * their journey erased. A missing or low-confidence reading is not evidence of
 * stillness and is treated as unknown.
 */
function sensorSaysStill(fix) {
    if (!fix || fix.activitySource !== 'sensor') return false;
    if (fix.activityType !== 'still') return false;
    const c = Number(fix.activityConfidence);
    return Number.isFinite(c) && c >= MIN_ACTIVITY_CONFIDENCE;
}

/**
 * The observed point with the smallest total distance to every other.
 *
 * Not a mean, and not a per-axis median: a mean is dragged toward an outlier and
 * lands somewhere the phone never was, and a per-axis median can take its lat
 * from one fix and its lng from another, inventing a coordinate that was never
 * observed. Every point this returns is a reading that actually happened.
 */
function medoid(points) {
    if (points.length <= 2) return points[0];
    let best = points[0];
    let bestTotal = Infinity;
    for (const a of points) {
        let total = 0;
        for (const b of points) {
            if (a !== b) total += dist(a, b);
        }
        if (total < bestTotal) {
            bestTotal = total;
            best = a;
        }
    }
    return best;
}

/** Group by time window, keep one representative point per window. */
function windowMedoids(points, windowMs = WINDOW_MS) {
    const out = [];
    let bucket = [];
    let start = null;

    for (const p of points) {
        const t = new Date(p.timestamp).getTime();
        if (Number.isNaN(t)) continue;
        if (start === null) start = t;
        if (t - start > windowMs) {
            if (bucket.length) out.push(medoid(bucket));
            bucket = [];
            start = t;
        }
        bucket.push(p);
    }
    if (bucket.length) out.push(medoid(bucket));
    return out;
}

/**
 * Drop points that have not meaningfully moved away from the last kept one.
 *
 * Returns the retained points and the distance between them, in metres.
 */
function anchorFilter(points, floorM = FLOOR_M) {
    if (!points.length) return { path: [], distanceM: 0 };

    let anchor = points[0];
    const path = [anchor];
    let distanceM = 0;

    for (let i = 1; i < points.length; i++) {
        const f = points[i];

        // The accelerometer says the phone did not move. Whatever the
        // coordinates claim, this is drift -- drop it outright rather than
        // letting a threshold argue with a measurement. This is the gate that
        // gets a phone left on a desk all day to a genuine zero, and it is the
        // one thing the old GPS-speed label could never provide.
        if (sensorSaysStill(f)) continue;

        const threshold = Math.max(floorM, f.accuracy || 0);
        const d = dist(anchor, f);
        if (d <= threshold) continue;
        distanceM += d;
        anchor = f;
        path.push(anchor);
    }

    return { path, distanceM };
}

/**
 * Smooth a day's fixes into a drawable route and a credible distance.
 *
 * @param {Array} points  Tracking docs, ascending by timestamp.
 * @returns {{ path: Array, distanceM: number, rawDistanceM: number, rawCount: number }}
 */
function smoothTrack(points, { windowMs = WINDOW_MS, floorM = FLOOR_M } = {}) {
    const list = Array.isArray(points) ? points : [];
    let rawDistanceM = 0;
    for (let i = 1; i < list.length; i++) rawDistanceM += dist(list[i - 1], list[i]);

    if (list.length < 3) {
        return { path: list, distanceM: rawDistanceM, rawDistanceM, rawCount: list.length };
    }

    const { path, distanceM } = anchorFilter(windowMedoids(list, windowMs), floorM);
    return { path, distanceM, rawDistanceM, rawCount: list.length };
}

module.exports = {
    smoothTrack, windowMedoids, anchorFilter, medoid, sensorSaysStill,
    WINDOW_MS, FLOOR_M, MIN_ACTIVITY_CONFIDENCE,
};
