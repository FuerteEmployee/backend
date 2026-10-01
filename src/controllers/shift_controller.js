const Shift = require('../models/Shift');
const User = require('../models/User');
const Settings = require('../models/Settings');
const { getPlanLimit } = require('../utils/plan_limits');
const mongoose = require('mongoose');
const { serialisePerTenant } = require('../utils/employee_lock');

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WORK_DAYS = ['M', 'T', 'W', 'Th', 'F', 'Sa', 'Su'];
const LUNCH_MODES = ['inherit', 'none', 'fixed_window', 'fixed_duration', 'from_punches'];
const MAX_NAME_LENGTH = 60;
const DAY_MINS = 24 * 60;

// An employee who has left keeps their assignment on record, but nothing
// punches for them, so they never block a delete. Missing status reads as
// active: that is the schema default. Same rule as branches and departments.
const ACTIVE_EMPLOYEE = { role: 'employee', status: { $ne: 'inactive' } };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const toMins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const fmtMins = (m) => {
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (h && r) return `${h}h ${r}m`;
    return h ? `${h}h` : `${r}m`;
};
const to12h = (hhmm) => {
    const h = Number(hhmm.slice(0, 2));
    return `${h % 12 || 12}:${hhmm.slice(3, 5)} ${h >= 12 ? 'PM' : 'AM'}`;
};

/** Minutes from start to end, crossing midnight when end is not after start. */
function spanMins(startTime, endTime) {
    const a = toMins(startTime);
    const b = toMins(endTime);
    return b <= a ? b + DAY_MINS - a : b - a;
}

/** A whole number of minutes, or an error sentence. */
function readMinutes(raw, label, { allowNull = false } = {}) {
    if (raw === null || raw === '' || raw === undefined) {
        return allowNull ? { value: null } : { value: 0 };
    }
    const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
    if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `${label} must be a number of minutes.` };
    if (value < 0) return { error: `${label} cannot be less than 0 minutes.` };
    if (!Number.isInteger(value)) return { error: `${label} must be a whole number of minutes.` };
    return { value };
}

/**
 * Reject a lunch policy that cannot be applied, at save time, and return it
 * with only the fields its mode uses.
 *
 * A half-configured mode (fixed_window with no times, fixed_duration with no
 * length) resolves back to `inherit` at read time so attendance never halts --
 * but an admin who picked "1pm to 2pm" and left the times blank has not got
 * what they chose, and silently giving them the tenant default is how a payroll
 * surprise arrives a month later. Same reasoning as validateSteps() on the
 * punch sequence: refuse it here, where somebody is looking at the screen.
 *
 * `inherit` stays accepted: it is the schema default, every shift saved before
 * per-shift lunch existed carries it, and the page offers it back for exactly
 * those shifts so opening and saving one never changes what it deducts.
 *
 * Returns { lunch } or { error }.
 */
function readLunch(lunch) {
    if (lunch === null || typeof lunch !== 'object' || Array.isArray(lunch)) {
        return { error: 'Choose how lunch is handled for this shift.' };
    }
    const mode = lunch.mode || 'inherit';
    if (!LUNCH_MODES.includes(mode)) return { error: 'Choose how lunch is handled for this shift.' };

    if (mode === 'fixed_window') {
        const startTime = String(lunch.startTime || '').trim();
        const endTime = String(lunch.endTime || '').trim();
        if (!HHMM.test(startTime)) return { error: 'Set the lunch start time, like 13:00.' };
        if (!HHMM.test(endTime)) return { error: 'Set the lunch end time, like 14:00.' };
        if (startTime === endTime) return { error: 'Lunch start and end cannot be the same time.' };
        return { lunch: { mode, startTime, endTime } };
    }

    if (mode === 'fixed_duration') {
        const d = readMinutes(lunch.durationMins, 'Lunch length');
        if (d.error) return { error: d.error };
        if (d.value <= 0) return { error: 'Lunch length must be more than 0 minutes.' };
        if (d.value > 12 * 60) return { error: 'Lunch length cannot be more than 12 hours.' };
        return { lunch: { mode, durationMins: d.value } };
    }

    if (mode === 'from_punches') {
        const mn = readMinutes(lunch.minMins, 'The shortest lunch counted', { allowNull: true });
        if (mn.error) return { error: mn.error };
        const mx = readMinutes(lunch.maxMins, 'The longest lunch counted', { allowNull: true });
        if (mx.error) return { error: mx.error };
        if (mx.value !== null && mx.value <= 0) return { error: 'The longest lunch counted must be more than 0 minutes, or left blank.' };
        if (mn.value !== null && mx.value !== null && mx.value < mn.value) {
            return { error: 'The longest lunch counted cannot be less than the shortest.' };
        }
        if ((mn.value || 0) > 12 * 60 || (mx.value || 0) > 12 * 60) return { error: 'Lunch cannot be counted as more than 12 hours.' };
        return { lunch: { mode, minMins: mn.value, maxMins: mx.value } };
    }

    return { lunch: { mode } };
}

/**
 * The fields an admin may set on a shift, validated, in plain words.
 *
 * Only these are copied. The update used to hand req.body straight to
 * findOneAndUpdate, so a body carrying `adminId` (or `{"$set":{"adminId":..}}`)
 * moved the shift into another company, and the create stored whatever
 * arrived: "25:99" as a start time, a negative grace, a blank name. A shift
 * with unusable times silently stops grading anyone on it -- every day of
 * theirs lands in needs_review -- so it is refused here instead.
 *
 * `partial` is for updates: fields absent from the body are left alone.
 */
function readShiftInput(body = {}, { partial = false } = {}) {
    const data = {};
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;

    if (has('name') || !partial) {
        const name = body.name == null ? '' : String(body.name).trim();
        if (!name) return { error: 'Enter a shift name.' };
        if (name.length > MAX_NAME_LENGTH) return { error: `The shift name is too long (${MAX_NAME_LENGTH} characters at most).` };
        data.name = name;
    }

    for (const [key, label] of [['startTime', 'start time'], ['endTime', 'end time']]) {
        if (!has(key) && partial) continue;
        const value = body[key] == null ? '' : String(body[key]).trim();
        if (!HHMM.test(value)) return { error: `Set the shift ${label} as hours and minutes, like 09:30.` };
        data[key] = value;
    }

    for (const [key, label] of [['halfDayLatePunchInMin', 'Late grace'], ['halfDayEarlyPunchOutMin', 'Early grace']]) {
        if (!has(key)) continue;
        const m = readMinutes(body[key], label);
        if (m.error) return { error: m.error };
        data[key] = m.value;
    }

    if (has('workDays')) {
        if (body.workDays === null) {
            data.workDays = null; // no override: the company's work days apply
        } else if (!Array.isArray(body.workDays)) {
            return { error: 'Pick the working days for this shift.' };
        } else {
            if (body.workDays.some((d) => !WORK_DAYS.includes(d))) return { error: 'Pick the working days for this shift.' };
            // An empty list does not mean "no working days": isWeeklyOff treats
            // it as "no override" and falls back to the company's days, so what
            // the admin sees saved and what is applied would disagree.
            if (body.workDays.length === 0) return { error: 'Pick at least one working day.' };
            data.workDays = WORK_DAYS.filter((d) => body.workDays.includes(d));
        }
    }

    if (has('lunch')) {
        const l = readLunch(body.lunch);
        if (l.error) return { error: l.error };
        data.lunch = l.lunch;
    }

    return { data };
}

/**
 * Checks that need several fields at once, run on the shift as it will be
 * saved (stored values merged with the incoming ones).
 */
function crossCheck(shift) {
    const { startTime, endTime } = shift;
    if (!HHMM.test(String(startTime || '')) || !HHMM.test(String(endTime || ''))) return null;

    // Same start and end resolves as a 24-hour overnight shift in
    // istShiftOccurrence, which nobody picking "9:00 to 9:00" meant.
    if (startTime === endTime) {
        return 'The start and end time cannot be the same. For a shift that runs all day, switch on 24 Hours Shift.';
    }
    const span = spanMins(startTime, endTime);

    const lunch = shift.lunch || {};
    let lunchMins = 0;
    if (lunch.mode === 'fixed_window' && HHMM.test(String(lunch.startTime || '')) && HHMM.test(String(lunch.endTime || ''))) {
        // Measured from the shift start, so a night shift's 02:00 lunch reads
        // as inside a 22:00-06:00 shift, and a 13:00 lunch as outside it.
        const from = (toMins(lunch.startTime) - toMins(startTime) + DAY_MINS) % DAY_MINS;
        const len = (toMins(lunch.endTime) - toMins(lunch.startTime) + DAY_MINS) % DAY_MINS;
        if (from + len > span) {
            return `The lunch break (${to12h(lunch.startTime)} to ${to12h(lunch.endTime)}) must fall inside the shift (${to12h(startTime)} to ${to12h(endTime)}).`;
        }
        lunchMins = len;
    } else if (lunch.mode === 'fixed_duration' && Number(lunch.durationMins) > 0) {
        lunchMins = Number(lunch.durationMins);
        if (lunchMins >= span) return `The lunch break (${fmtMins(lunchMins)}) must be shorter than the shift (${fmtMins(span)}).`;
    }

    const graceIn = Math.max(0, Number(shift.halfDayLatePunchInMin) || 0);
    const graceOut = Math.max(0, Number(shift.halfDayEarlyPunchOutMin) || 0);
    if (graceIn + graceOut + lunchMins >= span) {
        return `Late grace, early grace and lunch add up to ${fmtMins(graceIn + graceOut + lunchMins)}, which leaves no working time in this ${fmtMins(span)} shift. Lower them.`;
    }
    return null;
}

// A Mongoose error, or anything else unexpected, never reaches the admin
// verbatim ("Cast to ObjectId failed for value ..."): validation problems keep
// their (schema-written) message, the rest become a plain retry.
function sendError(res, error, action) {
    if (error && error.name === 'ValidationError' && error.errors) {
        const first = Object.values(error.errors)[0];
        return res.status(400).json({ message: first?.message || 'Please check the form and try again.' });
    }
    console.error(`[shift] ${action} failed:`, error);
    return res.status(500).json({ message: `Could not ${action} the shift. Please try again.` });
}

async function findDuplicateName(adminId, name, excludeId) {
    const existing = await Shift.find({ adminId }, 'name').lean();
    return existing.find((s) => String(s._id) !== String(excludeId || '') && sameName(s.name, name)) || null;
}

const duplicateMessage = (s) => `A shift called "${String(s.name).trim()}" already exists. Use a different name.`;

const limitMessage = (limit) => `Your plan allows ${plural(limit, 'shift', 'shifts')}, and ${limit === 1 ? 'it is' : `all ${limit} are`} in use. Ask your provider to upgrade the plan to add more.`;

exports.getShifts = async (req, res) => {
    try {
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const [shifts, counts] = await Promise.all([
            Shift.find({ adminId }),
            // How many employees point at each shift, as primary OR one of
            // several -- what decides whether it may be deleted (see
            // deleteShift), so the page can say so before the click.
            User.aggregate([
                { $match: { adminId, role: 'employee' } },
                {
                    $project: {
                        active: { $ne: ['$status', 'inactive'] },
                        ids: {
                            $setUnion: [
                                { $cond: [{ $ifNull: ['$shiftId', false] }, ['$shiftId'], []] },
                                { $ifNull: ['$shiftIds', []] },
                            ],
                        },
                    },
                },
                { $unwind: '$ids' },
                {
                    $group: {
                        _id: '$ids',
                        employees: { $sum: 1 },
                        activeEmployees: { $sum: { $cond: ['$active', 1, 0] } },
                    },
                },
            ]),
        ]);
        const byId = new Map(counts.map((c) => [String(c._id), c]));
        res.json(shifts.map((s) => {
            const c = byId.get(String(s._id));
            return { ...s.toObject(), employees: c?.employees || 0, activeEmployees: c?.activeEmployees || 0 };
        }));
    } catch (error) {
        sendError(res, error, 'load');
    }
};

/**
 * GET /shifts/usage: how many shifts the tenant has against the plan cap, so
 * the page can say "N of M used" and disable New Shift at the limit instead of
 * letting the admin fill in the whole form and then refusing it.
 */
exports.getShiftUsage = async (req, res) => {
    try {
        const [limit, used] = await Promise.all([
            getPlanLimit(req.adminId, 'shifts'),
            Shift.countDocuments({ adminId: req.adminId }),
        ]);
        res.json({ used, limit });
    } catch (error) {
        sendError(res, error, 'load');
    }
};

exports.createShift = async (req, res) => {
    try {
        const adminId = new mongoose.Types.ObjectId(req.adminId);

        // Plan cap (super admin -> plan -> shifts: 'none' | '2 shifts' |
        // 'unlimited'). This used to be `limitVal.includes('2')`, which threw
        // on a boolean plan value (every create failed with a raw TypeError)
        // and would have read "12 shifts" as a cap of two.
        const limit = await getPlanLimit(req.adminId, 'shifts');
        if (limit !== null) {
            const used = await Shift.countDocuments({ adminId });
            if (used >= limit) {
                return res.status(400).json({ message: limitMessage(limit), limitReached: true, limit, used });
            }
        }

        // A body with no lunch block at all (the employee form's quick-add
        // sends none) keeps the schema default, exactly as before.
        const { data, error } = readShiftInput(req.body);
        if (error) return res.status(400).json({ message: error });
        const crossError = crossCheck(data);
        if (crossError) return res.status(400).json({ message: crossError });

        // Two shifts with the same name make every shift picker ambiguous
        // (employee form, attendance filter and the assign dialog show names).
        const duplicate = await findDuplicateName(adminId, data.name);
        if (duplicate) return res.status(409).json({ message: duplicateMessage(duplicate) });

        const shift = await Shift.create({ ...data, adminId });

        // Two saves racing past the count above can both land. Re-count after
        // the insert and undo this one if it went over.
        if (limit !== null) {
            const after = await Shift.countDocuments({ adminId });
            if (after > limit) {
                await Shift.deleteOne({ _id: shift._id, adminId });
                return res.status(400).json({ message: limitMessage(limit), limitReached: true, limit, used: limit });
            }
        }

        res.status(201).json({ ...shift.toObject(), employees: 0, activeEmployees: 0 });
    } catch (error) {
        sendError(res, error, 'create');
    }
};

exports.updateShift = async (req, res) => {
    try {
        // A malformed id is simply a shift that does not exist here; letting it
        // reach the query produced a raw CastError.
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Shift not found' });
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const current = await Shift.findOne({ _id: req.params.id, adminId }).lean();
        if (!current) return res.status(404).json({ message: 'Shift not found' });

        const { data, error } = readShiftInput(req.body, { partial: true });
        if (error) return res.status(400).json({ message: error });

        // Only when the schedule itself is being changed, so a rename of a
        // legacy shift is never refused over values nobody touched.
        const scheduleKeys = ['startTime', 'endTime', 'halfDayLatePunchInMin', 'halfDayEarlyPunchOutMin', 'lunch'];
        if (scheduleKeys.some((k) => k in data)) {
            const crossError = crossCheck({ ...current, ...data });
            if (crossError) return res.status(400).json({ message: crossError });
        }

        if (data.name !== undefined && !sameName(data.name, current.name)) {
            const duplicate = await findDuplicateName(adminId, data.name, current._id);
            if (duplicate) return res.status(409).json({ message: duplicateMessage(duplicate) });
        }

        if (Object.keys(data).length === 0) return res.json(current);

        const shift = await Shift.findOneAndUpdate(
            { _id: current._id, adminId },
            { $set: data },
            { new: true, runValidators: true }
        );
        if (!shift) return res.status(404).json({ message: 'Shift not found' });
        res.json(shift);
    } catch (error) {
        sendError(res, error, 'update');
    }
};

exports.deleteShift = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Shift not found' });
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const shift = await Shift.findOne({ _id: req.params.id, adminId });
        if (!shift) return res.status(404).json({ message: 'Shift not found' });

        // The company default is what new employees are put on. Deleting it
        // left Settings pointing at nothing, and the employee form then
        // pre-filled a shift that no longer exists.
        const settings = await Settings.findOne({ adminId }, 'attendance.defaultShiftId').lean();
        if (settings?.attendance?.defaultShiftId && String(settings.attendance.defaultShiftId) === String(shift._id)) {
            return res.status(409).json({
                message: 'This is the company\'s default shift for new employees. Choose another default shift in Settings > Attendance first, then delete it.',
                isDefault: true,
            });
        }

        // Refuse while anyone active still works it.
        //
        // Deleting used to succeed and leave those employees pointing at a
        // shift that no longer exists. Populate then returns null, so they have
        // no shift at all: nobody on it can be marked late, and every day they
        // work is graded needs_review (gradeDay has nothing to measure against)
        // -- unpaid until someone sorts it out by hand. The dialog also
        // promised to "unassign all employees", which it never did.
        const assigned = { adminId, $or: [{ shiftId: shift._id }, { shiftIds: shift._id }] };
        const activeEmployees = await User.countDocuments({ ...assigned, ...ACTIVE_EMPLOYEE });
        if (activeEmployees > 0) {
            return res.status(409).json({
                message: `${plural(activeEmployees, 'active employee is', 'active employees are')} still on this shift. Move them to another shift first, then delete it.`,
                activeEmployees,
            });
        }

        await Shift.deleteOne({ _id: shift._id, adminId });

        // Clean up references on the (inactive) employees left, so no one
        // points at a deleted shift if they are ever reactivated.
        await User.updateMany({ adminId, shiftIds: shift._id }, { $pull: { shiftIds: shift._id } });
        const affected = await User.find({ adminId, shiftId: shift._id }, 'shiftId shiftIds');
        for (const u of affected) {
            await User.updateOne(
                { _id: u._id, adminId },
                { $set: { shiftId: (u.shiftIds && u.shiftIds.length > 0) ? u.shiftIds[0] : null } }
            );
        }

        res.json({ message: 'Shift removed' });
    } catch (error) {
        sendError(res, error, 'delete');
    }
};

// Exported for the unit test in the QA harness; not used by routes.
exports._internal = { readShiftInput, readLunch, crossCheck, spanMins };

// Same-instant creates queue per company (utils/employee_lock.js serialisePerTenant):
// the duplicate check above reads then writes, so two requests arriving together
// both passed it and both created.
exports.createShift = serialisePerTenant(exports.createShift, 'create');
