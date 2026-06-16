/**
 * Calculates the distance between two points in meters using the Haversine formula.
 * @param {number} lat1 - Latitude of first point
 * @param {number} lon1 - Longitude of first point
 * @param {number} lat2 - Latitude of second point
 * @param {number} lon2 - Longitude of second point
 * @returns {number} - Distance in meters
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return Infinity;

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
 * Returns the distance (meters) to the CLOSEST branch among a list of branches.
 * Used for multi-branch employees: they may punch in at any of their branches.
 * @param {number} lat - Latitude of the user
 * @param {number} lng - Longitude of the user
 * @param {Array<{latitude:number, longitude:number}>} branches - Populated branch docs
 * @returns {number} - Distance in meters to the nearest branch (Infinity if none valid)
 */
function nearestBranchDistance(lat, lng, branches) {
    if (!Array.isArray(branches) || branches.length === 0) return Infinity;
    return branches.reduce((min, b) => {
        if (!b || b.latitude == null || b.longitude == null) return min;
        const d = calculateDistance(lat, lng, b.latitude, b.longitude);
        return d < min ? d : min;
    }, Infinity);
}

module.exports = { calculateDistance, nearestBranchDistance };
