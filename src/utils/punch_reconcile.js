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

const { istStartOfDay, istDateKey, applyPunchRounding, isLatePunchIn, determineHalfDayStatus } = require('./attendance_helpers');
const { computeWorkedMs, computeSessionWorkMs, gradeDay } = require('./shift_status');
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

/**
 * Re-derive and persist one employee's attendance for one IST day.
 *
 * Fields explicitly set by the app are never overwritten. The app sends a real
 * action ("punch out"), which is a stronger signal than anything positional
 * inference can produce, so an employee who punches in on their phone and taps
 * out on the terminal keeps their real 09:30 start. `derivedFields` records
 * which fields the previous reconciliation owns, which is what makes that
 * distinction possible without a second source-of-truth flag per field.
 *
 * @returns the saved Attendance document, or null when there is nothing to write
 */
async function reconcileDay({ Attendance, PunchLog, User, Settings, adminId, employeeId, dayKey }) {
    const taps = await PunchLog.find({ adminId, employeeId, dayKey, discarded: { $ne: true } })
        .sort({ deviceTime: 1 })
        .lean();

    if (taps.length === 0) return null;

    const derived = derive(taps);
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
            source: 'biometric',
            derivedFields: [],
        });
    }

    const owned = new Set(attendance.derivedFields || []);
    const nowOwned = [];

    // Only write a field when it is empty, or when the last reconciliation is
    // the thing that put a value there. A value we don't own came from the app.
    const put = (field, value, roundLabel) => {
        const current = attendance[field];
        if (current && !owned.has(field)) return; // explicit app value — leave it
        if (!value) return;
        attendance[field] = roundLabel ? applyPunchRounding(new Date(value), roundLabel, settings) : new Date(value);
        nowOwned.push(field);
    };

    put('punchIn', derived.punchIn, 'Punch In');
    put('lunchInTime', derived.lunchIn);
    put('lunchOutTime', derived.lunchOut);
    put('punchOut', derived.punchOut, 'Punch Out');

    attendance.derivedFields = nowOwned;

    // A device-set punch-out is provisional: the terminal only reports that
    // somebody was recognised, so the last tap so far may not be the real end
    // of day. An explicit app punch-out (which we would not own) is final.
    attendance.punchOutIsProvisional = attendance.punchOut ? nowOwned.includes('punchOut') : false;

    // ── Sessions ────────────────────────────────────────────────────────────
    // Reconciliation must NEVER flatten a day the app has already split into
    // several sessions. Rebuilding shifts[] from the two derived endpoints
    // deleted sessions 2..n outright -- which is precisely the day this whole
    // system exists to support: punched in on the phone, lunch on the camera,
    // out on the terminal. The raw taps stay authoritative for the tap list;
    // the session array belongs to whichever channel actually opened it.
    const existing = Array.isArray(attendance.shifts) ? attendance.shifts.filter(Boolean) : [];
    const deviceSource = attendance.source === 'lens' ? 'lens' : 'biometric';

    if (existing.length > 1) {
        // Multi-session day: touch only the ends this derivation owns.
        if (nowOwned.includes('punchIn') && existing[0]) {
            existing[0].punchIn = attendance.punchIn;
            existing[0].punchInSource = deviceSource;
        }
        if (nowOwned.includes('punchOut')) {
            const last = existing[existing.length - 1];
            if (last) {
                last.punchOut = attendance.punchOut;
                last.punchOutSource = deviceSource;
                last.closeReason = 'device';
            }
        }
        attendance.shifts = existing;
    } else if (attendance.punchIn) {
        const prev = existing[0]
            ? (typeof existing[0].toObject === 'function' ? existing[0].toObject() : existing[0])
            : {};
        attendance.shifts = [{
            ...prev,
            punchIn: attendance.punchIn,
            punchOut: attendance.punchOut || null,
            punchInSource: nowOwned.includes('punchIn') ? deviceSource : (prev.punchInSource || 'app'),
            punchOutSource: attendance.punchOut
                ? (nowOwned.includes('punchOut') ? deviceSource : (prev.punchOutSource || 'app'))
                : null,
            closeReason: attendance.punchOut
                ? (nowOwned.includes('punchOut') ? 'device' : (prev.closeReason || 'manual'))
                : null,
        }];
    }

    // Worked time through the SAME function the live punch-out path uses.
    // This was a local gross-minus-break sum with no shift clamp and no
    // configured-minimum lunch, so one identical day graded differently
    // depending on whether the app or the terminal happened to close it.
    attendance.totalWorkMs = computeWorkedMs(attendance, shift, settings);
    for (const sess of (attendance.shifts || [])) {
        sess.workMs = computeSessionWorkMs(sess, attendance, shift);
    }

    // Status, recomputed the same way the live punch-out and regularization
    // paths do it, so all three agree.
    if (!attendance.isWFH) {
        let status = 'present';
        if (shift && isLatePunchIn(attendance.punchIn, shift, settings)) status = 'late';

        if (attendance.punchIn && attendance.punchOut) {
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

    // Label each tap with the current interpretation so the expandable list can
    // show "punch in / punch out / (extra)" beside each time.
    const ops = taps.map((tap, i) => ({
        updateOne: {
            filter: { _id: tap._id },
            update: { $set: { derivedAction: actionForIndex(i, taps.length) } },
        },
    }));
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
