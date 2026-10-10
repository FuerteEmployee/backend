// ─────────────────────────────────────────────────────────────────────────────
// Day-level reconciliation of raw biometric taps.
//
// The older approach in punch_sequence.js decides what a tap means at the
// moment it arrives. That can never satisfy "the last tap of the day is the
// punch-out", because when a tap lands there is no way to know whether another
// one is coming. So instead: persist every tap (see models/PunchLog.js) and
// re-derive the whole day from the full set each time a new one arrives.
//
// A useful side effect is that the pipeline becomes self-correcting. A terminal
// that lost network and flushes six hours of backlog at once used to stamp
// every one of those punches with the moment the network returned; now it just
// triggers a re-derivation using the real tap times.
//
// punch_sequence.js still wins when a tenant has explicitly configured a
// sequence — this is the behaviour for everyone else, which is the default.
// ─────────────────────────────────────────────────────────────────────────────

const { istStartOfDay, istDateKey, applyPunchRounding, isLatePunchIn, determineHalfDayStatus, stripGradingRemarks } = require('./attendance_helpers');
const { computeWorkedMs, computeSessionWorkMs, computeSessionGrossMs, gradeDay } = require('./shift_status');
const { lateArrival } = require('./late_arrival');
const { buildDay } = require('./day_timeline');
const { resolveConfig: resolveSequence } = require('./punch_sequence');
// Safe to require directly: salary_controller pulls only models and utils, so
// there is no cycle back into this file or into attendance_controller.
const { calculateAndSaveSalary } = require('../controllers/salary_controller');

const DEFAULT_DEBOUNCE_SECONDS = 120;

/**
 * How close together two taps have to be before the second is treated as an
 * accidental repeat. Someone arriving at 09:30 who presses twice should get one
 * punch-in, not a punch-in and an instant "lunch break started".
 */
function debounceMs(settings) {
    const raw = settings?.attendance?.punchDebounceSeconds;
    const seconds = Number.isFinite(Number(raw)) ? Number(raw) : DEFAULT_DEBOUNCE_SECONDS;
    // 0 disables it deliberately; cap so a typo can't swallow a whole shift.
    return Math.max(0, Math.min(3600, seconds)) * 1000;
}

/**
 * Interpret a day's accepted taps.
 *
 * The count decides the shape, per the configured product rule:
 *   1 tap   → punch-in only; the day is still open
 *   2 taps  → punch-in, punch-out
 *   4 taps  → punch-in, lunch-in, lunch-out, punch-out
 *   any other count ≥ 2 → punch-in (first), punch-out (last), the rest listed
 *
 * Lunch is inferred **only** at exactly four taps. With three, or five-plus,
 * which of the middle taps bounded a real break is genuinely unknowable, and
 * guessing would feed a wrong break length straight into the half-day and
 * payroll maths. Those taps are still returned in `extras` so the UI can show
 * every one of them with its time.
 *
 * Pure function — takes and returns plain values, no database access, so the
 * rule can be tested exhaustively on its own.
 *
 * @param {Array<{deviceTime: Date}>} taps  accepted taps, ascending by time
 */
function derive(taps) {
    const ordered = [...(taps || [])]
        .filter((t) => t && t.deviceTime)
        .sort((a, b) => new Date(a.deviceTime) - new Date(b.deviceTime));

    const n = ordered.length;
    const result = { punchIn: null, lunchIn: null, lunchOut: null, punchOut: null, extras: [], tapCount: n };

    if (n === 0) return result;

    result.punchIn = ordered[0].deviceTime;
    if (n === 1) return result;

    result.punchOut = ordered[n - 1].deviceTime;

    if (n === 4) {
        result.lunchIn = ordered[1].deviceTime;
        result.lunchOut = ordered[2].deviceTime;
        return result;
    }

    // 3 taps, or 5+: first and last are the day's bounds, everything between is
    // informational only.
    result.extras = ordered.slice(1, n - 1).map((t) => t.deviceTime);
    return result;
}

/**
 * Which action, if any, the derivation assigned to each tap — written back onto
 * the PunchLog rows so the expandable list can label them.
 */
function actionForIndex(index, total) {
    if (total === 0) return null;
    if (index === 0) return 'punch-in';
    if (index === total - 1 && total > 1) return 'punch-out';
    if (total === 4 && index === 1) return 'lunch-in';
    if (total === 4 && index === 2) return 'lunch-out';
    return null;
}

// Channels that only say "I was here". Every other source on a session end
// (app, admin, system) is an explicit decision the rebuild keeps as it is.
const TAP_SOURCES = new Set(['biometric', 'lens']);

const plain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : { ...(doc || {}) });

// The per-END fields of a session, so an end the rebuild keeps can be carried
// across whole: its time, channel, location, photo, accuracy and late flag.
const endFields = (end) => {
    const p = end === 'in' ? 'punchIn' : 'punchOut';
    return [p, `${p}Source`, `${p}Location`, `${p}Coordinates`, `${p}Accuracy`, `${p}Distance`, `${p}ReceivedAt`, `${p}TapId`];
};

/**
 * The explicit events already in the row, as fixed points of the timeline.
 *
 * A session end is fixed unless the rebuild itself can reproduce it from a
 * tap: one carrying a tap id, or (rows written before tap ids existed) the
 * first punch-in / last punch-out listed in `derivedFields`. Anything else --
 * an app punch, an admin edit, an auto punch-out, a machine punch written by
 * the old sequence path with no tap behind it -- cannot be re-derived, so it is
 * kept exactly as it is. Losing a punch is the one outcome a rebuild must never
 * produce.
 *
 * The 04:00 job's shift-end close is the exception: it is a stand-in for a
 * punch-out nobody made, so a real tap after that session started replaces it.
 */
function fixedEventsFromRow(attendance, taps) {
    const owned = new Set(attendance.derivedFields || []);
    const sessions = (Array.isArray(attendance.shifts) ? attendance.shifts : []).filter(Boolean).map(plain);
    const lastIdx = sessions.length - 1;
    const events = [];

    const reproducible = (s, end, si) => {
        // The source decides first: an end an admin edited, a correction
        // approved, or a job closed is theirs from then on, even though it
        // still carries the tap id of the reading it replaced. Checking the
        // tap id alone let the next tap undo an admin's correction (10 Oct,
        // qa/channel-matrix/edits-survive.cjs).
        const source = s[end === 'in' ? 'punchInSource' : 'punchOutSource'];
        if (!TAP_SOURCES.has(source)) return false;
        if (s[end === 'in' ? 'punchInTapId' : 'punchOutTapId']) return true;
        return end === 'in' ? (si === 0 && owned.has('punchIn')) : (si === lastIdx && owned.has('punchOut'));
    };

    sessions.forEach((s, si) => {
        if (s.punchIn && !reproducible(s, 'in', si)) {
            events.push({ kind: 'fixed', at: new Date(s.punchIn), action: 'punch-in', ref: { si, end: 'in' } });
        }
        if (s.punchOut && !reproducible(s, 'out', si)) {
            const placeholder = s.closeReason === 'shift_end'
                && taps.some((t) => new Date(t.deviceTime) > new Date(s.punchIn || 0));
            if (!placeholder) {
                events.push({ kind: 'fixed', at: new Date(s.punchOut), action: 'punch-out', ref: { si, end: 'out' } });
            }
        }
    });

    // Day-level values the sessions do not show: a row with no session array,
    // and an app punch-out that overrode a machine's provisional one (the app
    // path writes it to the day and leaves the machine-closed session alone).
    const sameTime = (a, b) => a && b && +new Date(a) === +new Date(b);
    if (attendance.punchIn && !owned.has('punchIn') && !sessions.some((s) => sameTime(s.punchIn, attendance.punchIn))) {
        events.push({ kind: 'fixed', at: new Date(attendance.punchIn), action: 'punch-in', ref: { root: true, end: 'in' } });
    }
    if (attendance.punchOut && !owned.has('punchOut') && !attendance.punchOutIsProvisional
        && !sessions.some((s) => sameTime(s.punchOut, attendance.punchOut))) {
        events.push({ kind: 'fixed', at: new Date(attendance.punchOut), action: 'punch-out', ref: { root: true, end: 'out' } });
    }
    if (attendance.lunchInTime && !owned.has('lunchInTime')) {
        events.push({ kind: 'fixed', at: new Date(attendance.lunchInTime), action: 'lunch-in', ref: { lunch: 'in' } });
    }
    if (attendance.lunchOutTime && !owned.has('lunchOutTime')) {
        events.push({ kind: 'fixed', at: new Date(attendance.lunchOutTime), action: 'lunch-out', ref: { lunch: 'out' } });
    }
    return { events, sessions };
}

/**
 * Rebuild and persist one employee's attendance for one IST day, from every
 * tap the machines and face kiosks recorded PLUS everything the app, admins and
 * jobs already wrote. utils/day_timeline.js decides; this writes.
 *
 * Explicit values are never changed. The app sends a real action ("punch out"),
 * which is a stronger signal than anything read from a tap's position, so an
 * employee who punches in on the phone and taps out on the machine keeps their
 * real 09:30 start -- and the machine tap now closes the day instead of being
 * read as a second punch-in and dropped.
 *
 * Does nothing for a day with no taps: an app-only day is never touched.
 *
 * @returns the saved Attendance document, or null when there is nothing to write
 */
async function reconcileDay({ Attendance, PunchLog, User, Settings, adminId, employeeId, dayKey }) {
    const taps = await PunchLog.find({ adminId, employeeId, dayKey, discarded: { $ne: true }, source: { $ne: 'app' } })
        .sort({ deviceTime: 1 })
        .lean();

    if (taps.length === 0) return null;

    const [y, m, d] = dayKey.split('-').map(Number);
    const dayStart = istStartOfDay(new Date(Date.UTC(y, m - 1, d, 12)));

    const [user, settings] = await Promise.all([
        User.findById(employeeId).populate('shiftId').lean(),
        Settings.findOne({ adminId }).lean(),
    ]);

    const shift = user?.shiftId || null;

    let attendance = await Attendance.findOne({ adminId, employeeId, date: dayStart });
    if (!attendance) {
        attendance = new Attendance({
            adminId,
            employeeId,
            date: dayStart,
            status: 'present',
            source: TAP_SOURCES.has(taps[0].source) ? taps[0].source : 'biometric',
            derivedFields: [],
        });
    }

    // The company's own tap order, when it set one, applied in tap-time order.
    const seq = resolveSequence(settings);
    const rule = seq.enabled ? { mode: 'sequence', steps: seq.steps, afterLast: seq.afterLast } : { mode: 'count' };

    const { events: fixed, sessions: oldSessions } = fixedEventsFromRow(attendance, taps);
    const tapEvents = taps.map((t) => ({ kind: 'tap', at: new Date(t.deviceTime), tap: t }));
    const day = buildDay([...fixed, ...tapEvents], rule);

    // One END of a rebuilt session, from whichever event made it.
    const endFrom = (idx, end) => {
        if (idx === null || idx === undefined) return null;
        const ev = day.events[idx];
        const p = end === 'in' ? 'punchIn' : 'punchOut';
        if (ev.kind === 'fixed') {
            if (ev.ref && ev.ref.si !== undefined) {
                const s = oldSessions[ev.ref.si] || {};
                const out = {};
                for (const k of endFields(end)) out[k] = s[k] === undefined ? null : s[k];
                if (end === 'out') out.closeReason = s.closeReason || 'manual';
                out.fromTap = false;
                return out;
            }
            // A day-level value: the app wrote it.
            return { [p]: new Date(ev.at), [`${p}Source`]: 'app', ...(end === 'out' ? { closeReason: 'manual' } : {}), fromTap: false };
        }
        const t = ev.tap;
        const label = end === 'in' ? 'Punch In' : 'Punch Out';
        return {
            [p]: applyPunchRounding(new Date(t.deviceTime), label, settings),
            [`${p}Source`]: TAP_SOURCES.has(t.source) ? t.source : 'biometric',
            [`${p}ReceivedAt`]: lateArrival(t.deviceTime, t.receivedAt || t.createdAt),
            [`${p}TapId`]: t._id,
            ...(end === 'out' ? { closeReason: 'device' } : {}),
            fromTap: true,
        };
    };

    const rebuilt = day.sessions.map((s) => {
        const inEnd = endFrom(s.in, 'in');
        const outEnd = endFrom(s.out, 'out');
        const session = {};
        if (inEnd) { const { fromTap, ...rest } = inEnd; Object.assign(session, rest); }
        if (outEnd) { const { fromTap, ...rest } = outEnd; Object.assign(session, rest); }
        else { session.punchOut = null; session.closeReason = null; }
        return { session, inFromTap: !!inEnd?.fromTap, outFromTap: !!outEnd?.fromTap };
    }).filter((r) => r.session.punchIn || r.session.punchOut);

    const first = rebuilt[0] || null;
    const lastS = rebuilt[rebuilt.length - 1] || null;
    const nowOwned = [];

    attendance.shifts = rebuilt.map((r) => r.session);
    attendance.punchIn = first?.session.punchIn || null;
    if (first?.inFromTap) nowOwned.push('punchIn');
    attendance.punchOut = lastS?.session.punchOut || null;
    if (lastS?.session.punchOut && lastS.outFromTap) nowOwned.push('punchOut');

    // Lunch is day-level and read once; a tap-made end is ours, an app one is not.
    const lunchAt = (idx) => (idx === null ? null : new Date(day.events[idx].at));
    attendance.lunchInTime = lunchAt(day.lunchIn);
    attendance.lunchOutTime = lunchAt(day.lunchOut);
    if (day.lunchIn !== null && day.events[day.lunchIn].kind !== 'fixed') nowOwned.push('lunchInTime');
    if (day.lunchOut !== null && day.events[day.lunchOut].kind !== 'fixed') nowOwned.push('lunchOutTime');

    attendance.derivedFields = nowOwned;
    // A tap-made punch-out is provisional: the machine or camera only knows the
    // person was there, so the last tap so far may not be the end of the day.
    attendance.punchOutIsProvisional = nowOwned.includes('punchOut');

    // Worked time through the SAME function the live punch-out path uses.
    // This was a local gross-minus-break sum with no shift clamp and no
    // configured-minimum lunch, so one identical day graded differently
    // depending on whether the app or the terminal happened to close it.
    attendance.totalWorkMs = computeWorkedMs(attendance, shift, settings);
    for (const sess of (attendance.shifts || [])) {
        sess.workMs = computeSessionWorkMs(sess, attendance, shift);
        sess.grossMs = computeSessionGrossMs(sess);
    }

    // Status, recomputed the same way the live punch-out and regularization
    // paths do it, so all three agree.
    if (!attendance.isWFH) {
        let status = 'present';
        if (shift && isLatePunchIn(attendance.punchIn, shift, settings)) status = 'late';

        if (attendance.punchIn && attendance.punchOut) {
            // Every re-derivation regrades the whole day from scratch, so the
            // previous derivation's grading remarks are superseded and must go
            // with it -- otherwise a day re-derived after a backlog flush keeps
            // the verdict it had when only the first tap was known.
            attendance.remarks = stripGradingRemarks(attendance.remarks);

            const { status: finalStatus, remarksAppend } = determineHalfDayStatus({
                punchIn: attendance.punchIn,
                punchOut: attendance.punchOut,
                totalWorkMs: attendance.totalWorkMs,
                lunchInTime: attendance.lunchInTime,
                lunchOutTime: attendance.lunchOutTime,
                isWFH: attendance.isWFH,
                shift,
            }, settings);

            // A half-day verdict outranks 'late'; otherwise keep the late flag,
            // which determineHalfDayStatus has no notion of and would flatten
            // back to 'present'. Same precedence the live punch-out path uses.
            if (finalStatus === 'half-day') {
                status = 'half-day';
                if (remarksAppend && !String(attendance.remarks || '').includes(remarksAppend.trim())) {
                    attendance.remarks = (attendance.remarks || '') + remarksAppend;
                }
            }
        }

        // Same hours-based downgrade the live punch-out applies, so a day
        // closed by a terminal cannot be graded Full when the identical day
        // closed by the app would be Half. Only ever downgrades.
        const hoursGrade = gradeDay(attendance, shift, settings);
        if (hoursGrade === 'half-day' && status === 'present') {
            status = 'half-day';
            const note = ' | Short hours across sessions';
            if (!String(attendance.remarks || '').includes(note.trim())) {
                attendance.remarks = (attendance.remarks || '') + note;
            }
        }

        attendance.status = status;
    }

    await attendance.save();

    // Label each tap with its meaning in the rebuilt day, so the expandable
    // list can show "punch in / punch out / (seen)" beside each time.
    const ops = [];
    day.events.forEach((e, i) => {
        if (e.kind !== 'tap') return;
        ops.push({ updateOne: { filter: { _id: e.tap._id }, update: { $set: { derivedAction: day.labels[i] || null } } } });
    });
    if (ops.length) await PunchLog.bulkWrite(ops, { ordered: false });

    // Keep payroll in step, the same way the live punch-out, leave approval and
    // regularization paths do. This path writes Attendance directly instead of
    // going through punchOut(), so without this a biometric-only day would
    // never trigger the recalculation and the payslip would lag the attendance.
    //
    // Only once the day has both ends: re-running this on every intermediate
    // tap would recompute a whole month of salary several times a day per
    // employee for no benefit. Fire-and-forget with a catch — a payroll
    // recalculation failure must not make the terminal think the tap failed.
    if (attendance.punchIn && attendance.punchOut && user) {
        const [year, month] = dayKey.split('-').map(Number);
        Promise.resolve()
            .then(() => calculateAndSaveSalary(adminId, user, month, year))
            .catch((err) => console.error(`[reconcile] salary sync failed for ${employeeId} ${dayKey}:`, err.message));
    }

    return attendance;
}

module.exports = { derive, actionForIndex, debounceMs, reconcileDay, DEFAULT_DEBOUNCE_SECONDS, istDateKey };
