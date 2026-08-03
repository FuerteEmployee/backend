// ─────────────────────────────────────────────────────────────────────────────
// Admin-configurable punch sequence.
//
// A biometric terminal reports only "somebody was recognised" — it carries no
// notion of what the tap MEANS. The default behaviour just toggles: no open
// record → punch in, open record → punch out. That can't express a working day
// with a lunch break, where four taps mean in / leave for lunch / back / out.
//
// This module lets a tenant declare that mapping: steps[0] is what the 1st tap
// of the day does, steps[1] the 2nd, and so on.
//
// ── Naming, because it is genuinely confusing ──
// In this codebase 'lunch-in' means the employee has gone IN TO lunch (the break
// STARTS) and 'lunch-out' means they have come OUT OF lunch (back to work).
// attendance_controller.lunchOut refuses to run without an existing lunchInTime,
// and the half-day calculation computes the break as lunchOut − lunchIn, so
// lunch-in strictly precedes lunch-out. The UI shows plain-English labels.
// ─────────────────────────────────────────────────────────────────────────────

const ACTIONS = ['punch-in', 'lunch-in', 'lunch-out', 'punch-out'];

const ACTION_LABELS = {
    'punch-in': 'Punch in',
    'lunch-in': 'Lunch break starts',
    'lunch-out': 'Back from lunch',
    'punch-out': 'Punch out',
};

// Which Attendance field each action fills. Used to tell whether a step has
// already happened today, whatever recorded it — the device, the mobile app or
// the BOTLens camera. That keeps the sequence correct even when an employee
// punches in on their phone and out on the machine.
const IS_DONE = {
    'punch-in': (a) => !!(a && a.punchIn),
    'lunch-in': (a) => !!(a && a.lunchInTime),
    'lunch-out': (a) => !!(a && a.lunchOutTime),
    'punch-out': (a) => !!(a && a.punchOut),
};

const DEFAULT_STEPS = ['punch-in', 'lunch-in', 'lunch-out', 'punch-out'];

/**
 * Is this an ordering the downstream handlers can actually execute?
 *
 * The handlers have hard preconditions (lunchOut throws without a lunchInTime;
 * everything refuses to run once punchOut is set), so an arbitrary ordering
 * would produce a day that silently stops recording. Rejecting bad orders at
 * configuration time is far kinder than failing at 9am on the factory floor.
 *
 * @returns {{ok: true}|{ok: false, message: string}}
 */
function validateSteps(steps) {
    if (!Array.isArray(steps) || steps.length === 0) {
        return { ok: false, message: 'Add at least one step to the punch sequence.' };
    }
    if (steps.length > 8) {
        return { ok: false, message: 'A punch sequence can have at most 8 steps.' };
    }

    const unknown = steps.find((s) => !ACTIONS.includes(s));
    if (unknown) {
        return { ok: false, message: `"${unknown}" is not a valid punch step.` };
    }

    const seen = new Set();
    for (const s of steps) {
        if (seen.has(s)) {
            return { ok: false, message: `"${ACTION_LABELS[s]}" appears more than once. Each step can only be used once.` };
        }
        seen.add(s);
    }

    if (steps[0] !== 'punch-in') {
        return { ok: false, message: 'The first punch of the day must be "Punch in".' };
    }

    const lunchIn = steps.indexOf('lunch-in');
    const lunchOut = steps.indexOf('lunch-out');
    if (lunchOut !== -1 && lunchIn === -1) {
        return { ok: false, message: '"Back from lunch" needs "Lunch break starts" earlier in the sequence.' };
    }
    if (lunchOut !== -1 && lunchOut < lunchIn) {
        return { ok: false, message: '"Back from lunch" must come after "Lunch break starts".' };
    }

    const punchOut = steps.indexOf('punch-out');
    if (punchOut !== -1 && punchOut !== steps.length - 1) {
        return { ok: false, message: '"Punch out" has to be the last step — nothing can be recorded after it.' };
    }

    return { ok: true };
}

/**
 * Read the tenant's sequence config, falling back to safe defaults.
 * Returns { enabled, steps, afterLast }.
 */
function resolveConfig(settings) {
    const cfg = (settings && settings.attendance && settings.attendance.punchSequence) || {};
    const steps = Array.isArray(cfg.steps) && cfg.steps.length ? cfg.steps : DEFAULT_STEPS;

    // A config that somehow got saved invalid must never stop attendance being
    // recorded — treat it as disabled and let the legacy toggle take over.
    const valid = validateSteps(steps).ok;

    return {
        enabled: cfg.enabled === true && valid,
        steps: valid ? steps : DEFAULT_STEPS,
        afterLast: cfg.afterLast === 'toggle' ? 'toggle' : 'ignore',
        configInvalid: cfg.enabled === true && !valid,
    };
}

/**
 * Decide what this tap means.
 *
 * Walks the configured steps in order and returns the first one that hasn't
 * happened yet today. Walking in order is what guarantees each handler's
 * precondition is satisfied before it runs — 'lunch-out' can never be selected
 * before 'lunch-in' has filled lunchInTime.
 *
 * @param {Object|null} attendance  today's Attendance doc, or null if none yet
 * @param {Object} config           from resolveConfig()
 * @returns {string|null}  an action name, or null when the day is complete
 */
function nextAction(attendance, config) {
    for (const step of config.steps) {
        if (!IS_DONE[step](attendance)) return step;
    }
    return null;
}

/**
 * Human-readable preview of a sequence, for the settings UI and logs.
 * e.g. "1st → Punch in, 2nd → Lunch break starts, …"
 */
function describeSteps(steps) {
    const ordinal = (n) => ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'][n] || `${n + 1}th`;
    return steps.map((s, i) => `${ordinal(i)} → ${ACTION_LABELS[s] || s}`).join(', ');
}

module.exports = {
    ACTIONS,
    ACTION_LABELS,
    DEFAULT_STEPS,
    validateSteps,
    resolveConfig,
    nextAction,
    describeSteps,
};
