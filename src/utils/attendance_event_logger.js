const AttendanceEvent = require('../models/AttendanceEvent');
const { istDateKey } = require('./attendance_helpers');

/**
 * Record one punch in the append-only event log.
 *
 * Deliberately fire-and-forget and deliberately NOT awaited by callers: the
 * punch is the thing that matters, and a logging failure must never turn a
 * successful punch into an error the employee sees. A dropped evidence row
 * costs an admin some context; a failed punch costs someone their day.
 *
 * Never throws. The catch is the contract.
 */
function logAttendanceEvent({
    adminId,
    employeeId,
    type,
    at,
    source = 'app',
    sessionNumber = 1,
    lat = null,
    lng = null,
    accuracy = null,
    distanceFromBranch = null,
    closeReason = null,
}) {
    try {
        if (!adminId || !employeeId || !type) return;

        const when = at ? new Date(at) : new Date();
        if (Number.isNaN(when.getTime())) return;

        // Normalise accuracy here so no caller can accidentally persist 0 as
        // "perfect" — 0 is what the shipped app sends for "unreported".
        const accN = Number(accuracy);
        const acc = Number.isFinite(accN) && accN > 0 ? accN : null;

        AttendanceEvent.create({
            adminId,
            employeeId,
            dayKey: istDateKey(when),
            type,
            source,
            at: when,
            sessionNumber,
            lat: Number.isFinite(Number(lat)) ? Number(lat) : null,
            lng: Number.isFinite(Number(lng)) ? Number(lng) : null,
            accuracy: acc,
            distanceFromBranch: Number.isFinite(Number(distanceFromBranch)) ? Number(distanceFromBranch) : null,
            closeReason,
        }).catch((err) => {
            console.error('[attendance-event] write failed:', err.message);
        });
    } catch (err) {
        // Synchronous failure (bad input) — still must not reach the caller.
        console.error('[attendance-event] logger threw:', err.message);
    }
}

module.exports = { logAttendanceEvent };
