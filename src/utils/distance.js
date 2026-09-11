/**
 * Calculates the distance between two points in meters using the Haversine formula.
 * @param {number} lat1 - Latitude of first point
 * @param {number} lon1 - Longitude of first point
 * @param {number} lat2 - Latitude of second point
 * @param {number} lon2 - Longitude of second point
 * @returns {number} - Distance in meters
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Infinity;

    const R = 6371e3; // Earth's radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
        Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in meters
}

/**
 * Returns the distance (meters) and effective allowed radius of the CLOSEST branch among a list of branches.
 * Used for multi-branch employees: they may punch in at any of their branches.
 * @param {number} lat - Latitude of the user
 * @param {number} lng - Longitude of the user
 * @param {Array<{latitude:number, longitude:number, radius?:number}>} branches - Populated branch docs
 * @param {number} [fallbackRadius=3000] - Global fallback radius if branch radius is unset
 * @returns {{ distance: number, radius: number }} - Distance and allowed radius of the nearest branch
 */
function nearestBranchDistance(lat, lng, branches, fallbackRadius = 3000) {
    if (!Array.isArray(branches) || branches.length === 0) {
        return { distance: Infinity, radius: fallbackRadius };
    }
    let minDistance = Infinity;
    let minRadius = fallbackRadius;

    for (const b of branches) {
        if (!b || b.latitude == null || b.longitude == null) continue;
        const d = calculateDistance(lat, lng, b.latitude, b.longitude);
        if (d < minDistance) {
            minDistance = d;
            minRadius = (b.radius != null && b.radius > 0) ? b.radius : fallbackRadius;
        }
    }

    return { distance: minDistance, radius: minRadius };
}


// Accuracy gate for a fix that is allowed to influence a geofence decision.
// Ported from the reference implementation, where this was the single most
// expensive number in the system: it was 100, which is *exactly* what Android
// reports for a wifi/cell-tower fallback position. One such phantom coordinate
// appeared 76 times and caused 29 wrong auto punch-outs across 4 employees.
//
// Must stay comfortably below exitBufferM(), or a fix sitting at the gate's own
// uncertainty can cross the fence on measurement error alone.
const GEOFENCE_MIN_ACCURACY_M = Number(process.env.GEOFENCE_MIN_ACCURACY_M) || 35;

// The worst accuracy a punch is accepted on. Deliberately far looser than the
// decision gate above: this is a RETRY, not a denial -- the employee is stood
// there trying to punch, and refusing outright over a poor signal is worse than
// letting a slightly fuzzy fix through.
const PUNCH_MAX_ACCURACY_M = Number(process.env.PUNCH_MAX_ACCURACY_M) || 150;

/**
 * Extra margin beyond the radius before an employee counts as having LEFT.
 *
 * The entry and exit thresholds must not be the same number. With one
 * threshold, somebody standing at the boundary is ejected the instant after
 * being allowed in, and flickers in and out all day.
 *
 * Scales with the radius so a small branch is not dominated by the buffer, and
 * is floored at the accuracy gate: without that floor a 40 m branch had a 60 m
 * exit threshold while admitting +/-35 m fixes, so a reading taken at the desk
 * could clear it on noise alone.
 *
 *   40 m branch  -> +35 m    100 m -> +50 m    500 m -> +50 m
 */
function exitBufferM(radiusM) {
    const scaled = Math.min(50, Math.max(20, Math.round((radiusM || 0) * 0.5)));
    return Math.max(GEOFENCE_MIN_ACCURACY_M, scaled);
}

/**
 * Is this fix good enough to base a geofence decision on?
 *
 * Unknown accuracy is NOT good accuracy. Writing `!acc || acc <= LIMIT` skips
 * the comparison entirely for null/undefined/NaN/0 and treats an unreported
 * reading as perfect -- the exact inversion of what it means. Excluding
 * unknowns biases toward leaving someone punched in, which is the correct
 * direction to be wrong in.
 */
function isTrustworthyFix(accuracy) {
    if (accuracy == null) return false;
    const acc = Number(accuracy);
    if (!Number.isFinite(acc)) return false;
    // Zero (or negative) is treated as UNKNOWN, not as a perfect fix.
    //
    // The reference implementation only guards against null, relying on
    // clients storing null when accuracy is unreported. That is not safe here:
    // the shipped app used `pos.coords.accuracy || 0`, so every APK already in
    // the field coerces an absent reading to 0 and will keep doing so until
    // clients install an update. A real GPS fix never reports 0 m uncertainty,
    // so a 0 is always a buggy client, never a good reading.
    if (acc <= 0) return false;
    return acc <= GEOFENCE_MIN_ACCURACY_M;
}

module.exports = {
    exitBufferM,
    isTrustworthyFix,
    GEOFENCE_MIN_ACCURACY_M,
    PUNCH_MAX_ACCURACY_M, calculateDistance, nearestBranchDistance };
