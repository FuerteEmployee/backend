// ─────────────────────────────────────────────────────────────────────────────
// One way in for every "I was here" tap: the fingerprint machine (iclock) and
// the face kiosk (lens routes) both end here.
//
// Store the raw tap, then rebuild the employee's whole day from every tap plus
// everything the app already wrote (utils/punch_reconcile.js). The caller holds
// the per-employee lock (`punch:<id>`, utils/employee_lock.js) around this call:
// the debounce check, the store and the rebuild read then write.
// ─────────────────────────────────────────────────────────────────────────────

const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Settings = require('../models/Settings');
const PunchLog = require('../models/PunchLog');
const punchReconcile = require('./punch_reconcile');
const { istDateKey, istStartOfDay } = require('./attendance_helpers');
const { workDayKey, lateOutDayStart } = require('./working_day');

/**
 * Which day a tap is filed under: the day its shift occurrence STARTED (see
 * utils/working_day.js). Grouping by calendar day split a night worker's 22:00
 * and 06:00 taps into two days, each a lone punch-in. A tap shortly after a
 * night shift ends still belongs to that night, if that night has taps at all.
 */
async function tapDayKey(adminId, employeeId, tapTime) {
    const me = await User.findById(employeeId).select('shiftId').populate('shiftId').lean();
    let dayKey = workDayKey(me?.shiftId, tapTime);
    const lateOut = lateOutDayStart(me?.shiftId, tapTime);
    if (lateOut) {
        const nightKey = istDateKey(lateOut);
        if (await PunchLog.exists({ adminId, employeeId, dayKey: nightKey, discarded: { $ne: true }, source: { $ne: 'app' } })) {
            dayKey = nightKey;
        }
    }
    return dayKey;
}

/**
 * The phone/admin/job punch on this day closest to `tapTime`, if it is inside
 * `gap`; else null.
 *
 * The double-tap window used to be measured between taps only. Someone who
 * punched in on the phone and then walked past the face kiosk 40 s later got a
 * 40-second day (the face became the punch-out), and a face seen 30 s after
 * "Start Lunch" on the phone ended lunch there and then. The phone already
 * refuses its own punches that close to the last one (workMinGapSeconds,
 * lunchMinGapSeconds); this is the same rule for the machine and the kiosk.
 * A held tap that lands just BEFORE a phone punch is the same person punching
 * twice, so the distance is absolute.
 */
async function nearFixedPunch(adminId, employeeId, dayKey, tapTime, gap) {
    const [y, m, d] = dayKey.split('-').map(Number);
    const dayStart = istStartOfDay(new Date(Date.UTC(y, m - 1, d, 12)));
    const row = await Attendance.findOne({ adminId, employeeId, date: dayStart }).lean();
    if (!row) return null;
    // Passing this tap lets a 04:00 shift-end placeholder give way to it, as
    // the rebuild would: that close is not a punch anyone made.
    const { events } = punchReconcile.fixedEventsFromRow(row, [{ deviceTime: tapTime }]);
    let best = null;
    for (const e of events) {
        const dist = Math.abs(tapTime - e.at);
        if (dist < gap && (!best || dist < best.dist)) best = { at: e.at, action: e.action, dist };
    }
    return best;
}

/**
 * Store one tap and rebuild the day.
 *
 * Three rejections, all of which still store the tap rather than dropping it, so
 * "I tapped and it didn't count" is answerable from the data:
 *  - `debounced` -- inside the company's double-tap window (punchDebounceSeconds)
 *    of another machine/face tap
 *  - `near_punch` -- inside that same window of a phone, admin or job punch on
 *    that day (see nearFixedPunch)
 *  - `duplicate` -- the unique {serialNumber, pin, deviceTime} index caught a
 *    resent tap. Durable across restarts, so a machine re-pushing its buffer or
 *    a kiosk retrying a tap can never count it twice.
 *
 * @param {object} p
 * @param {string|ObjectId} p.adminId
 * @param {string|ObjectId} p.employeeId
 * @param {Date}   p.tapTime       when the tap happened, on the server's clock
 * @param {'biometric'|'lens'} p.source
 * @param {string} p.serialNumber  the machine's serial, or 'LENS-<kioskId>'
 * @param {string} p.pin           the machine PIN, or the employee id for a kiosk
 * @param {object} [p.settings]    the company's Settings, when already loaded
 * @param {number} [p.score]       face kiosk only: match confidence
 * @returns {{recorded:boolean, reason?:string, tapTime:Date, dayKey:string, tapCount?:number, attendance?:object}}
 */
async function recordTap({ adminId, employeeId, tapTime, source, serialNumber, pin, settings, score = null }) {
    const cfg = settings || await Settings.findOne({ adminId }).select('attendance').lean();
    const dayKey = await tapDayKey(adminId, employeeId, tapTime);

    // The same tap sent again (a machine re-pushing its buffer, a kiosk
    // retrying after a timeout) is a duplicate, not a second tap inside the
    // double-tap window: answered as such, so the sender knows it already counted.
    if (await PunchLog.exists({ serialNumber, pin: String(pin), deviceTime: tapTime })) {
        return { recorded: false, reason: 'duplicate', tapTime, dayKey };
    }

    const gap = punchReconcile.debounceMs(cfg);
    if (gap > 0) {
        const last = await PunchLog.findOne({ adminId, employeeId, dayKey, discarded: { $ne: true }, source: { $ne: 'app' } })
            .sort({ deviceTime: -1 })
            .select('deviceTime')
            .lean();

        // Absolute difference, not just "newer than", so a backlog line that
        // lands next to an already-recorded tap is caught too.
        if (last && Math.abs(tapTime - new Date(last.deviceTime)) < gap) {
            await PunchLog.create({
                adminId, employeeId, dayKey, deviceTime: tapTime,
                serialNumber, pin: String(pin), source, score,
                discarded: true, discardReason: 'debounced',
            }).catch((err) => {
                if (err.code !== 11000) throw err;
            });
            return { recorded: false, reason: 'debounced', tapTime, dayKey, lastTapTime: new Date(last.deviceTime) };
        }
    }

    if (gap > 0) {
        const near = await nearFixedPunch(adminId, employeeId, dayKey, tapTime, gap);
        if (near) {
            await PunchLog.create({
                adminId, employeeId, dayKey, deviceTime: tapTime,
                serialNumber, pin: String(pin), source, score,
                discarded: true, discardReason: 'near_punch',
            }).catch((err) => {
                if (err.code !== 11000) throw err;
            });
            return { recorded: false, reason: 'near_punch', tapTime, dayKey, lastTapTime: near.at, nearAction: near.action };
        }
    }

    try {
        await PunchLog.create({
            adminId, employeeId, dayKey, deviceTime: tapTime,
            serialNumber, pin: String(pin), source, score,
        });
    } catch (err) {
        if (err.code === 11000) return { recorded: false, reason: 'duplicate', tapTime, dayKey };
        throw err;
    }

    const attendance = await punchReconcile.reconcileDay({
        Attendance, PunchLog, User, Settings, adminId, employeeId, dayKey,
    });

    return {
        recorded: true,
        tapTime,
        dayKey,
        attendance,
        tapCount: attendance ? await PunchLog.countDocuments({ adminId, employeeId, dayKey, discarded: { $ne: true }, source: { $ne: 'app' } }) : 0,
    };
}

/**
 * After the app changes a day, re-read that day's taps against it, so a
 * machine or face punch-out that was only provisional gives way to the app's,
 * and a tap that now has a different meaning gets it. No-op for a day with no
 * taps: an app-only day is never touched.
 *
 * @returns the rebuilt Attendance, or null when the day has no taps
 */
async function rebuildAfterAppPunch(attendance) {
    if (!attendance || !attendance.date) return null;
    const dayKey = istDateKey(attendance.date);
    const hasTaps = await PunchLog.exists({
        adminId: attendance.adminId, employeeId: attendance.employeeId, dayKey,
        discarded: { $ne: true }, source: { $ne: 'app' },
    });
    if (!hasTaps) return null;
    return punchReconcile.reconcileDay({
        Attendance, PunchLog, User, Settings,
        adminId: attendance.adminId, employeeId: attendance.employeeId, dayKey,
    });
}

module.exports = { recordTap, tapDayKey, rebuildAfterAppPunch };
