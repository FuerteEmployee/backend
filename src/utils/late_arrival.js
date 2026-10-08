// A machine tap that reached the server well after it was made.
//
// Biometric terminals keep taps while they are offline and push them when the
// network returns; the tap keeps its own time (tap time, not receive time). A
// tap that arrives after the day has moved on -- someone punched out on the
// phone meanwhile -- can then land as an odd extra session. Recording when it
// actually arrived lets every screen say "recorded offline, sent later"
// instead of leaving people to guess.
//
// Normal pushes arrive within seconds; LATE_ARRIVAL_SECONDS (default 120)
// keeps ordinary network delay from being flagged.

const LATE_ARRIVAL_MS = Math.max(30, Number(process.env.LATE_ARRIVAL_SECONDS) || 120) * 1000;

/**
 * The arrival time to store for a tap made at `tapTime` and received at
 * `receivedAt`, or null when it arrived on time (or the times are unusable).
 */
function lateArrival(tapTime, receivedAt = new Date()) {
    const tap = tapTime instanceof Date ? tapTime : (tapTime ? new Date(tapTime) : null);
    const got = receivedAt instanceof Date ? receivedAt : (receivedAt ? new Date(receivedAt) : null);
    if (!tap || !got || Number.isNaN(tap.getTime()) || Number.isNaN(got.getTime())) return null;
    return got.getTime() - tap.getTime() >= LATE_ARRIVAL_MS ? got : null;
}

module.exports = { lateArrival, LATE_ARRIVAL_MS };
