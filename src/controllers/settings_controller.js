const mongoose = require('mongoose');
const Settings = require('../models/Settings');
const User = require('../models/User');
const Shift = require('../models/Shift');

// Flattens plain nested objects into Mongo dot-path keys (e.g.
// { attendance: { officeRadius: 500 } } -> { 'attendance.officeRadius': 500 })
// so a $set only touches the fields actually present in the request instead of
// replacing the whole nested sub-document and wiping out sibling fields that a
// different settings tab owns (e.g. Settings' Attendance tab vs
// attendance-config.tsx both writing to `settings.attendance`).
// Arrays are left as atomic leaf values — merging them by index would be more
// surprising than useful (e.g. `attendance.workDays`, `attendance.punchSequence.steps`).
function flattenForSet(obj, prefix = '') {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            Object.assign(out, flattenForSet(value, path));
        } else {
            out[path] = value;
        }
    }
    return out;
}

/**
 * Paths this endpoint must never write.
 *
 * `attendance.geofenceAutoPunchOut` is the auto punch-out mode. Its only door
 * is PUT /geofence/mode, which refuses to arm the engine until the promotion
 * gate passes. Writing it here skipped that gate entirely, and the Biometric
 * page used to send the whole attendance block back on save, so a stale copy
 * could quietly re-arm an engine someone had just disarmed.
 *
 * The rest stop a body from re-pointing the document at another tenant or
 * smuggling an update operator through the spread below.
 */
const PROTECTED_ROOTS = ['adminId', '_id', '__v', 'createdAt', 'updatedAt', 'attendance.geofenceAutoPunchOut'];

function isWritablePath(path) {
    if (path.startsWith('$') || path.includes('.$')) return false;
    return !PROTECTED_ROOTS.some((root) => path === root || path.startsWith(`${root}.`));
}

// ── Validation ──────────────────────────────────────────────────────────────
// Mongoose alone turned "abc" in a number box into "Cast to Number failed for
// value \"abc\" (type string) at path \"attendance.lateGrace\"", accepted
// -500 minutes of grace, and accepted an empty work-day list -- which
// isWeeklyOff reads as "every day is a weekly off", so payroll then paid every
// day as a paid off day. Each rule below names the field the way the Settings
// page labels it, so the message tells an admin what to fix.

const LABELS = {
    companyName: 'Company name',
    address: 'Address',
    email: 'Email',
    phone: 'Phone number',
    'attendance.officeRadius': 'Company default fence radius',
    'attendance.reqHours': 'Standard day',
    'attendance.reqMins': 'Standard day minutes',
    'attendance.halfDayHours': 'Half-day credit',
    'attendance.lateGrace': 'Late arrival grace',
    'attendance.earlyGrace': 'Early departure grace',
    'attendance.lunchGrace': 'Lunch grace',
    'attendance.minLunch': 'Company default lunch',
    'attendance.maxLunch': 'Longest lunch before it is flagged',
    'attendance.otThreshold': 'Overtime daily threshold',
    'attendance.weeklyOT': 'Overtime weekly cap',
    'attendance.otMultiplier': 'Overtime pay multiplier',
    'attendance.correctionWindowDays': 'Correction window',
    'attendance.punchDebounceSeconds': 'Machine double-tap window',
    'attendance.lunchMinGapSeconds': 'Shortest lunch break',
    'attendance.workMinGapSeconds': 'Shortest work stretch',
    'attendance.trackingMode': 'Location tracking',
    'attendance.punchInGraceAfterShiftEndMins': 'Late punch-in window',
    'attendance.roundingInterval': 'Round punches to',
    'attendance.halfDayRules.minHours': 'Half-day minimum hours',
    'attendance.halfDayRules.cutoffTime': 'Late cut-off',
    'attendance.workDays': 'Work days',
    'payroll.rounding.precision': 'Decimal places',
    'payroll.holidayWorkBonusMultiplier': 'Holiday work multiplier',
    salaryTemplates: 'Pay templates',
};

function labelFor(path) {
    if (LABELS[path]) return LABELS[path];
    if (path.startsWith('payroll.bucketWeights.')) {
        return `Pay weight for ${path.split('.').pop().replace(/([A-Z])/g, ' $1').toLowerCase()}`;
    }
    const last = path.split('.').pop();
    const words = last.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

// [min, max, integerOnly, unit]
const NUMBER_RULES = {
    'attendance.officeRadius': [50, 100000, false, 'metres'],
    'attendance.reqHours': [1, 24, false, 'hours'],
    'attendance.reqMins': [0, 59, true, 'minutes'],
    'attendance.halfDayHours': [0, 24, false, 'hours'],
    'attendance.lateGrace': [0, 240, false, 'minutes'],
    'attendance.earlyGrace': [0, 240, false, 'minutes'],
    'attendance.lunchGrace': [0, 240, false, 'minutes'],
    'attendance.minLunch': [0, 480, false, 'minutes'],
    'attendance.maxLunch': [0, 600, false, 'minutes'],
    // 0 is not "off" for the next two: salary_controller reads `|| 9` and
    // `|| 45`, so 0 silently became 9 hours and 45 hours.
    'attendance.otThreshold': [1, 24, false, 'hours'],
    'attendance.weeklyOT': [1, 168, false, 'hours'],
    'attendance.otMultiplier': [0, 10, false, ''],
    // Readers treat 0 as "use 7", so 0 is refused rather than misread.
    'attendance.correctionWindowDays': [1, 90, true, 'days'],
    'attendance.punchDebounceSeconds': [0, 3600, true, 'seconds'],
    'attendance.lunchMinGapSeconds': [0, 3600, true, 'seconds'],
    'attendance.workMinGapSeconds': [0, 3600, true, 'seconds'],
    'attendance.punchInGraceAfterShiftEndMins': [0, 720, true, 'minutes'],
    'attendance.roundingInterval': [0, 60, true, 'minutes'],
    'attendance.halfDayRules.minHours': [0, 24, false, 'hours'],
    'payroll.rounding.precision': [0, 4, true, ''],
    'payroll.holidayWorkBonusMultiplier': [0, 10, false, ''],
};

const STRING_MAX = { companyName: 120, address: 500, email: 254, phone: 20 };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9][0-9 ()-]{5,18}$/;
const WORK_DAYS = ['M', 'T', 'W', 'Th', 'F', 'Sa', 'Su'];
const ROUNDING_TARGETS = ['Punch In', 'Punch Out', 'Lunch In', 'Lunch Out'];
const MAX_TEMPLATES = 50;

class SettingsInputError extends Error {}
const fail = (message) => { throw new SettingsInputError(message); };

function asNumber(path, value) {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) fail(`${labelFor(path)} must be a number.`);
    const rule = NUMBER_RULES[path] || (path.startsWith('payroll.bucketWeights.') ? [0, 1, false, ''] : null)
        || (/^attendance\.notifications\.\w+Mins$/.test(path) ? [0, 240, true, 'minutes'] : [0, 1e9, false, '']);
    const [min, max, integer, unit] = rule;
    if (integer && !Number.isInteger(n)) fail(`${labelFor(path)} must be a whole number.`);
    if (n < min || n > max) fail(`${labelFor(path)} must be between ${min} and ${max}${unit ? ` ${unit}` : ''}.`);
    return n;
}

function asBoolean(path, value) {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return fail(`${labelFor(path)} must be on or off.`);
}

function asStringArray(path, value, allowed) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) fail(`${labelFor(path)} must be a list.`);
    if (allowed) {
        const bad = value.find((v) => !allowed.includes(v));
        if (bad !== undefined) fail(`"${bad}" is not a valid choice for ${labelFor(path).toLowerCase()}.`);
    }
    return [...new Set(value)];
}

function validateTemplates(value) {
    if (!Array.isArray(value)) fail('Pay templates must be a list.');
    if (value.length > MAX_TEMPLATES) fail(`You can keep at most ${MAX_TEMPLATES} pay templates.`);
    const seen = new Set();
    return value.map((t) => {
        if (!t || typeof t !== 'object' || Array.isArray(t)) fail('Each pay template needs a name.');
        const name = typeof t.name === 'string' ? t.name.trim() : '';
        if (!name) fail('Each pay template needs a name.');
        if (name.length > 60) fail('A pay template name can be at most 60 characters.');
        const key = name.toLowerCase();
        if (seen.has(key)) fail(`There are two pay templates called "${name}". Use a different name.`);
        seen.add(key);
        const components = t.components && typeof t.components === 'object' && !Array.isArray(t.components) ? t.components : {};
        for (const [compKey, comp] of Object.entries(components)) {
            if (!comp || typeof comp !== 'object') continue;
            for (const field of ['percentage', 'amount']) {
                if (comp[field] === undefined || comp[field] === null || comp[field] === '') continue;
                const n = Number(comp[field]);
                if (!Number.isFinite(n) || n < 0) fail(`"${name}": ${compKey.toUpperCase()} must be zero or more.`);
                if (field === 'percentage' && n > 100) fail(`"${name}": ${compKey.toUpperCase()} cannot be more than 100%.`);
                if (field === 'amount' && n > 1e7) fail(`"${name}": ${compKey.toUpperCase()} cannot be more than 1,00,00,000.`);
            }
        }
        return { ...(t._id && mongoose.Types.ObjectId.isValid(t._id) ? { _id: t._id } : {}), name, components };
    });
}

/**
 * Checks and normalises every writable path. Returns the $set object, or
 * throws SettingsInputError with a message for the admin. Paths the schema
 * does not declare are dropped here (strict mode would drop them anyway),
 * which also drops things like `companyName.x` smuggled under a string field.
 */
async function buildSet(flat, adminId) {
    const set = {};
    for (const [path, raw] of Object.entries(flat)) {
        if (!isWritablePath(path)) continue;

        if (path === 'salaryTemplates') { set[path] = validateTemplates(raw); continue; }
        // Owned by the Leads page; left to the schema's own rules.
        if (path === 'leadFields') { set[path] = raw; continue; }

        const schemaType = Settings.schema.path(path);
        if (!schemaType) continue;
        const type = schemaType.instance;

        if (path === 'attendance.defaultShiftId') {
            if (raw === '' || raw === null || raw === undefined) { set[path] = null; continue; }
            if (!mongoose.Types.ObjectId.isValid(raw)) fail('Choose a default shift from the list.');
            const owned = await Shift.exists({ _id: raw, adminId });
            if (!owned) fail('That default shift does not exist any more. Choose another one.');
            set[path] = raw;
            continue;
        }

        if (type === 'Number') { set[path] = asNumber(path, raw); continue; }
        if (type === 'Boolean') { set[path] = asBoolean(path, raw); continue; }

        if (type === 'String') {
            if (raw === undefined) continue;
            if (raw === null) {
                if (schemaType.enumValues && schemaType.enumValues.length) fail(`Choose a value for ${labelFor(path).toLowerCase()}.`);
                set[path] = '';
                continue;
            }
            if (typeof raw !== 'string' && typeof raw !== 'number') fail(`${labelFor(path)} must be text.`);
            const value = String(raw).trim();
            const choices = schemaType.enumValues && schemaType.enumValues.length ? schemaType.enumValues : null;
            if (choices && !choices.includes(value)) fail(`"${value}" is not a valid choice for ${labelFor(path).toLowerCase()}.`);
            if (STRING_MAX[path] && value.length > STRING_MAX[path]) fail(`${labelFor(path)} can be at most ${STRING_MAX[path]} characters.`);
            if (path === 'email' && value && !EMAIL_RE.test(value)) fail('Enter a valid email address, like name@company.com.');
            if (path === 'phone' && value && !PHONE_RE.test(value)) fail('Enter a valid phone number, digits only (a leading + is fine).');
            if (/^attendance\.(punchIn|punchOut|earliestIn|latestOut|lunchIn|lunchOut)$/.test(path) || path === 'attendance.halfDayRules.cutoffTime') {
                if (!TIME_RE.test(value)) fail(`${labelFor(path)} must be a time like 09:30.`);
            }
            if (!choices && value.length > 500) fail(`${labelFor(path)} is too long.`);
            set[path] = value;
            continue;
        }

        if (type === 'Array') {
            if (path === 'attendance.workDays') {
                const days = asStringArray(path, raw, WORK_DAYS);
                // An empty list reads as "every day is a weekly off" everywhere
                // downstream (isWeeklyOff), so it is refused, not stored.
                if (days.length === 0) fail('Pick at least one work day.');
                set[path] = WORK_DAYS.filter((d) => days.includes(d));
            } else if (path === 'attendance.roundingAppliedTo') {
                set[path] = asStringArray(path, raw, ROUNDING_TARGETS);
            } else if (path === 'attendance.punchSequence.steps') {
                // Order matters and a repeat is an error validateSteps reports,
                // so these are not de-duplicated like the other lists.
                if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) fail('Punch sequence steps must be a list.');
                set[path] = raw;
            } else {
                set[path] = asStringArray(path, raw, null);
            }
            continue;
        }
        // Anything else the schema declares (none today) goes through as-is
        // and meets Mongoose's own validators.
        set[path] = raw;
    }
    return set;
}

function parseJsonField(updateData, key) {
    if (typeof updateData[key] !== 'string') return;
    try {
        updateData[key] = JSON.parse(updateData[key]);
    } catch {
        fail('Some settings could not be read. Reload the page and try again.');
    }
}

exports.getSettings = async (req, res) => {
    try {
        let settings = await Settings.findOne({ adminId: req.adminId });

        // If no settings exist yet, create default settings from User profile
        if (!settings) {
            const user = await User.findById(req.adminId);
            settings = await Settings.create({
                adminId: req.adminId,
                companyName: user?.companyName || '',
                companyLogo: user?.companyLogo || '',
                address: user?.address || '',
                email: user?.email || '',
                phone: user?.phone || ''
            });
        }

        res.json(settings);
    } catch (error) {
        res.status(500).json({ message: 'Could not load settings. Please try again.' });
    }
};

exports.updateSettings = async (req, res) => {
    try {
        const updateData = { ...req.body };
        delete updateData.companyLogo; // only an uploaded file may set the logo

        // Handle file upload for company logo
        if (req.file) {
            updateData.companyLogo = req.file.path;
        }

        // Handle nested fields if they are sent as strings (common with multipart/form-data)
        for (const key of ['notifications', 'appearance', 'attendance', 'leave', 'employeeSelfService', 'payroll', 'branchSettings', 'salaryTemplates']) {
            parseJsonField(updateData, key);
        }

        const set = await buildSet(flattenForSet(updateData), req.adminId);
        if (req.file) set.companyLogo = req.file.path;

        // Reject an unworkable punch sequence here rather than letting it fail
        // silently at 9am on the floor. The downstream handlers have hard
        // preconditions (lunch-out needs an existing lunch-in; nothing records
        // after punch-out), so only certain orderings can actually execute.
        // Checked against what the sequence WILL be after this save, so
        // switching it on alone (steps not sent) still checks the stored steps.
        if ('attendance.punchSequence.enabled' in set || 'attendance.punchSequence.steps' in set) {
            const stored = await Settings.findOne({ adminId: req.adminId }).select('attendance.punchSequence').lean();
            const enabled = 'attendance.punchSequence.enabled' in set
                ? set['attendance.punchSequence.enabled']
                : !!stored?.attendance?.punchSequence?.enabled;
            const steps = set['attendance.punchSequence.steps'] || stored?.attendance?.punchSequence?.steps
                || ['punch-in', 'lunch-in', 'lunch-out', 'punch-out'];
            if (enabled) {
                const { validateSteps } = require('../utils/punch_sequence');
                const check = validateSteps(steps);
                if (!check.ok) {
                    return res.status(400).json({ message: check.message });
                }
            }
        }

        if (Object.keys(set).length === 0) {
            return res.status(400).json({ message: 'Nothing to save.' });
        }

        const settings = await Settings.findOneAndUpdate(
            { adminId: req.adminId },
            { $set: set },
            { new: true, upsert: true, runValidators: true }
        );

        res.json(settings);
    } catch (error) {
        if (error instanceof SettingsInputError) {
            return res.status(400).json({ message: error.message });
        }
        if (error?.name === 'ValidationError' || error?.name === 'CastError') {
            return res.status(400).json({ message: 'One of the values could not be saved. Check the form and try again.' });
        }
        console.error('[settings] update failed:', error);
        res.status(500).json({ message: 'Could not save settings. Please try again.' });
    }
};

exports.getFeatureToggles = async (req, res) => {
    try {
        // Absent keys (and tenants with no subscription at all) resolve to the
        // shared defaults, so a feature added later is visible without a backfill.
        const { getTenantFeatureToggles } = require('../utils/feature_toggles');
        res.json(await getTenantFeatureToggles(req.adminId));
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Exported for the path-filter check in qa/; not route handlers.
exports.isWritablePath = isWritablePath;
exports.buildSet = buildSet;
exports.SettingsInputError = SettingsInputError;
