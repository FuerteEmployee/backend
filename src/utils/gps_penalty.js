// GPS-off penalty: when an employee's phone reports GPS switched off while
// they are on duty, for longer than the company's grace, it becomes a penalty
// row (models/GpsPenalty.js) that an admin approves or waives before payroll
// deducts it (Settings.attendance.gpsOffPenalty).
//
// The evidence is the native tracker's own gps_off / gps_on reports
// (TrackerEvent). Those exist only for people whose tracking is on and whose
// phone runs the tracker, and they are the phone's word about itself -- which
// is why a person approves each penalty by default.
//
// The decision (gpsOffIncidents, worstPerDay) is pure and unit tested. The
// sync (syncGpsPenalties) owns the database.

const { istDateKey, istStartOfDay, istEndOfDay } = require('./attendance_helpers');
const { allSessions } = require('./shift_status');

const MIN = 60 * 1000;

/**
 * Stretches of GPS-off that fall inside on-duty sessions, each at least
 * `graceMinutes` long. A stretch still open (GPS off, not back on) runs to the
 * end of the session; while the session itself is still open it is not
 * counted yet, because it has not finished.
 *
 * events:   [{ type: 'gps_off' | 'gps_on', at }]
 * sessions: [{ punchIn, punchOut }]  (punchOut null = still on duty)
 */
function gpsOffIncidents(events, sessions, { graceMinutes = 10 } = {}) {
    const sorted = (events || [])
        .filter((e) => (e.type === 'gps_off' || e.type === 'gps_on') && e.at)
        .map((e) => ({ type: e.type, t: new Date(e.at).getTime() }))
        .filter((e) => Number.isFinite(e.t))
        .sort((a, b) => a.t - b.t);

    // GPS-off stretches: from the first off to the next on. An on without an
    // off before it, and a repeated off, add nothing.
    const offs = [];
    let from = null;
    for (const e of sorted) {
        if (e.type === 'gps_off') { if (from === null) from = e.t; continue; }
        if (from !== null) { offs.push([from, e.t]); from = null; }
    }
    if (from !== null) offs.push([from, Infinity]);

    const graceMs = Math.max(0, Number(graceMinutes) || 0) * MIN;
    const out = [];
    for (const s of sessions || []) {
        if (!s?.punchIn) continue;
        const a = new Date(s.punchIn).getTime();
        const b = s.punchOut ? new Date(s.punchOut).getTime() : null;
        if (!Number.isFinite(a)) continue;
        for (const [offAt, onAt] of offs) {
            const start = Math.max(a, offAt);
            let end = onAt;
            if (b !== null) end = Math.min(end, b);
            else if (onAt === Infinity) continue; // still on duty and still off: not finished
            if (end - start < graceMs || end <= start) continue;
            out.push({ offAt: new Date(start), onAt: new Date(end), minutes: Math.round((end - start) / MIN) });
        }
    }
    return out;
}

/** At most one penalty a day: the longest stretch, keyed by its IST day. */
function worstPerDay(incidents) {
    const byDay = new Map();
    for (const i of incidents) {
        const dayKey = istDateKey(i.offAt);
        const cur = byDay.get(dayKey);
        if (!cur || i.minutes > cur.minutes) byDay.set(dayKey, { ...i, dayKey });
    }
    return [...byDay.values()].sort((x, y) => x.offAt - y.offAt);
}

/**
 * Brings the GpsPenalty rows of one company (optionally one employee) for
 * [from, to] in line with the phones' reports. New incidents are added as
 * pending (approved with autoApprove); a pending row whose evidence changed is
 * updated, and one whose evidence is gone is removed. Rows an admin already
 * decided are never touched. Does nothing while the penalty is switched off.
 */
async function syncGpsPenalties(adminId, { from, to, employeeId = null, settings = null } = {}) {
    const Settings = require('../models/Settings');
    const Attendance = require('../models/Attendance');
    const TrackerEvent = require('../models/TrackerEvent');
    const GpsPenalty = require('../models/GpsPenalty');

    const cfg = (settings || await Settings.findOne({ adminId }).select('attendance.gpsOffPenalty').lean())?.attendance?.gpsOffPenalty;
    if (!cfg || cfg.enabled !== true) return { enabled: false, added: 0 };

    const start = istStartOfDay(from);
    const end = istEndOfDay(to);
    const who = employeeId ? { employeeId } : {};
    const [rows, events, existing] = await Promise.all([
        Attendance.find({ adminId, ...who, date: { $gte: start, $lte: end } }).select('employeeId date punchIn punchOut shifts').lean(),
        // A day earlier: GPS may already have been off at punch-in.
        TrackerEvent.find({ adminId, ...who, type: { $in: ['gps_off', 'gps_on'] }, at: { $gte: new Date(start.getTime() - 24 * 60 * MIN), $lte: end } })
            .select('employeeId type at').lean(),
        GpsPenalty.find({ adminId, ...who, dayKey: { $gte: istDateKey(start), $lte: istDateKey(end) } }).lean(),
    ]);

    const eventsBy = new Map();
    for (const e of events) {
        const k = String(e.employeeId);
        if (!eventsBy.has(k)) eventsBy.set(k, []);
        eventsBy.get(k).push(e);
    }
    const sessionsBy = new Map();
    for (const r of rows) {
        const k = String(r.employeeId);
        if (!sessionsBy.has(k)) sessionsBy.set(k, []);
        sessionsBy.get(k).push(...allSessions(r));
    }

    const found = new Map(); // `${employeeId}|${dayKey}` -> incident
    for (const [emp, sessions] of sessionsBy) {
        const evs = eventsBy.get(emp);
        if (!evs) continue;
        for (const i of worstPerDay(gpsOffIncidents(evs, sessions, { graceMinutes: cfg.graceMinutes }))) {
            found.set(`${emp}|${i.dayKey}`, { ...i, employeeId: emp });
        }
    }

    let added = 0;
    const ops = [];
    for (const [key, i] of found) {
        const prev = existing.find((p) => `${p.employeeId}|${p.dayKey}` === key);
        if (prev && prev.status !== 'pending') continue;
        if (prev && prev.minutes === i.minutes && +prev.offAt === +i.offAt) continue;
        if (!prev) added++;
        ops.push({
            updateOne: {
                // An existing row is only ever updated while still pending.
                filter: { adminId, employeeId: i.employeeId, dayKey: i.dayKey, ...(prev ? { status: 'pending' } : {}) },
                update: {
                    $set: { offAt: i.offAt, onAt: i.onAt, minutes: i.minutes },
                    $setOnInsert: {
                        amount: Number(cfg.amount) || 0,
                        status: cfg.autoApprove === true ? 'approved' : 'pending',
                    },
                },
                upsert: !prev,
            },
        });
    }
    const gone = existing.filter((p) => p.status === 'pending' && !found.has(`${p.employeeId}|${p.dayKey}`)).map((p) => p._id);
    if (gone.length) ops.push({ deleteMany: { filter: { _id: { $in: gone }, status: 'pending' } } });
    if (ops.length) {
        try {
            await GpsPenalty.bulkWrite(ops, { ordered: false });
        } catch (err) {
            // Two syncs at once both inserting the same day: the unique index
            // keeps one row, which is the correct end state.
            if (err?.code !== 11000 && !(err?.writeErrors || []).every((w) => w.code === 11000)) throw err;
        }
    }
    return { enabled: true, added, removed: gone.length };
}

/** Approved penalties for one employee's pay month, as a single amount. */
async function approvedPenaltyTotal(adminId, employeeId, year, month) {
    const GpsPenalty = require('../models/GpsPenalty');
    const prefix = `${year}-${String(month).padStart(2, '0')}-`;
    const rows = await GpsPenalty.find({ adminId, employeeId, status: 'approved', dayKey: { $regex: `^${prefix}` } }).select('amount').lean();
    return { count: rows.length, amount: rows.reduce((s, r) => s + (r.amount || 0), 0) };
}

module.exports = { gpsOffIncidents, worstPerDay, syncGpsPenalties, approvedPenaltyTotal };
