// ─────────────────────────────────────────────────────────────────────────────
// Approximate location from the phone's network address, for when GPS is off.
//
// With location services switched off the phone can tell us nothing about where
// it is -- but it still talks to the API, and every request carries the public
// address it came from. Looked up in an offline city database, that address
// gives a CITY, sometimes. It is the coarsest evidence the product holds:
//
//   On Wi-Fi (an office, a hotel, a dhaba) the address belongs to a local
//   broadband line and the city is usually right.
//
//   On mobile data it usually is NOT. Indian carriers put millions of phones
//   behind a handful of gateways, so the address is the gateway's: every Jio
//   test address tried on 2026-11-04 resolved to Navi Mumbai (Ghansoli), Jio's
//   hub, whatever state the phone was in.
//
// So nothing here is ever a decision input. It is stored apart from GPS fixes
// (models/ApproxLocation.js, never the Tracking collection), so the geofence
// engine, route smoothing and "km travelled" cannot see it. And each reading is
// checked against the last real GPS fix: if reaching it would need an
// impossible speed, it is marked implausible and shown as "probably the
// carrier's hub", not as where the parcel is.
//
// Lookups run on this server against the DB-IP Lite database (CC BY 4.0,
// attribution "IP geolocation by DB-IP", https://db-ip.com). No address is sent
// to any third party.
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const net = require('net');
const { calculateDistance } = require('./distance');
const { isLoopbackOrPrivate } = require('./client_ip');

/** How far "this city" can be from the truth. DB-IP Lite gives no radius. */
const IP_ACCURACY_M = 25_000;

/**
 * Faster than this between the last GPS fix and an IP reading means the reading
 * cannot be where the phone is. Set to a delivery vehicle's realistic average
 * over a trip, stops included, not its top speed on an open highway.
 */
const MAX_PLAUSIBLE_KMPH = Number(process.env.IP_LOCATION_MAX_KMPH) || 80;

/** Closer than this to the last GPS fix is consistent whatever the speed. */
const PLAUSIBLE_RADIUS_M = 50_000;

// The databases are ~65 MB each in memory, so each opens on first use only:
// a server whose employees never switch GPS off never pays for them.
const readers = { 4: null, 6: null };
async function reader(family) {
    if (!readers[family]) {
        const maxmind = require('maxmind');
        const file = require.resolve(`@ip-location-db/dbip-city-mmdb/dbip-city-ipv${family}.mmdb`);
        readers[family] = maxmind.open(path.resolve(file)).catch((err) => {
            readers[family] = null; // let the next call retry
            throw err;
        });
    }
    return readers[family];
}

/**
 * City-level position of a public address, or null.
 *
 * Never throws: a missing database or a malformed address must not fail the
 * request that happened to carry it.
 */
async function lookupIp(ip) {
    try {
        const family = net.isIP(String(ip || ''));
        if (!family || isLoopbackOrPrivate(ip)) return null;
        const row = (await reader(family)).get(ip);
        const lat = Number(row?.latitude);
        const lng = Number(row?.longitude);
        if (!row || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return {
            city: row.city || null,
            region: row.state1 || null,
            country: row.country_code || null,
            latitude: lat,
            longitude: lng,
        };
    } catch (err) {
        console.error('[ip-location] lookup failed:', err.message);
        return null;
    }
}

/**
 * Could the phone really be at `reading`, given where GPS last put it?
 *
 * null when there is no GPS fix to compare with: unknown, not implausible.
 */
function isPlausible(reading, lastGps) {
    if (!lastGps) return null;
    const distanceM = calculateDistance(lastGps.latitude, lastGps.longitude, reading.latitude, reading.longitude);
    if (distanceM <= PLAUSIBLE_RADIUS_M) return true;
    const hours = (new Date(reading.timestamp) - new Date(lastGps.timestamp)) / 3_600_000;
    if (hours <= 0) return false;
    return distanceM / 1000 / hours <= MAX_PLAUSIBLE_KMPH;
}

/** Throttle for the 30 s attendance poll: at most one reading per window. */
const POLL_EVERY_MS = (Number(process.env.IP_LOCATION_EVERY_MIN) || 10) * 60 * 1000;

/** GPS newer than this means it is working, and an IP reading adds nothing. */
const GPS_FRESH_MS = 5 * 60 * 1000;

/**
 * Should this request produce a reading? Pure, so the throttle is testable.
 *
 * last: { at, ip } of this employee's previous reading, or undefined.
 * A changed address always records (the phone moved network); `gps_off` skips
 * the GPS check because the phone has just said GPS is gone.
 */
function shouldRecord({ last, ip, trigger, lastGpsAt, now }) {
    if (!ip) return false;
    if (trigger !== 'gps_off' && lastGpsAt && now - new Date(lastGpsAt).getTime() < GPS_FRESH_MS) return false;
    if (!last) return true;
    if (last.ip !== ip) return true;
    return now - last.at >= (trigger === 'gps_off' ? 60 * 1000 : POLL_EVERY_MS);
}

module.exports = {
    lookupIp,
    isPlausible,
    shouldRecord,
    IP_ACCURACY_M,
    POLL_EVERY_MS,
    GPS_FRESH_MS,
};
