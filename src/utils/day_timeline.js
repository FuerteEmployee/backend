// ─────────────────────────────────────────────────────────────────────────────
// One employee-day, one timeline.
//
// A day can be punched three ways at random: the phone app (explicit: the person
// chose "punch out"), the fingerprint machine and the face kiosk (generic: "I
// was here"). Every one of those lands in the same attendance row, so the row is
// rebuilt from ALL of them together every time any of them arrives:
//
//   · fixed events -- what the app, an admin, or a job wrote -- keep their own
//     meaning. They are facts this module never changes;
//   · taps take their meaning from where they sit among everything else that
//     happened that day.
//
// Reading the taps on their own was the bug: punch in on the phone, punch out on
// the machine, and the machine's single tap read as a punch-in (ignored, the app
// owns it), so the day stayed open until the 04:00 job closed it at shift end.
// And deciding a tap's meaning at the moment it ARRIVES (the old sequence mode)
// turned a tap held by an offline machine into a new punch-in sitting inside a
// later session.
//
// Pure: plain values in and out, no database, no clock. Every rule below is
// pinned by test/attendance_review.test.js.
// ─────────────────────────────────────────────────────────────────────────────

const ACTIONS = ['punch-in', 'lunch-in', 'lunch-out', 'punch-out'];

/**
 * The machine's count rule for the i-th of n events: first = punch-in,
 * last = punch-out, exactly four = in / lunch start / lunch end / out, and any
 * other middle event carries no meaning. Lunch is read ONLY at exactly four:
 * with three, or five-plus, which middle events bounded a real break is
 * unknowable, and a wrong break length feeds straight into half-day and pay.
 */
function countAction(index, total) {
    if (total === 0) return null;
    if (index === 0) return 'punch-in';
    if (index === total - 1 && total > 1) return 'punch-out';
    if (total === 4 && index === 1) return 'lunch-in';
    if (total === 4 && index === 2) return 'lunch-out';
    return null;
}

const time = (e) => new Date(e.at).getTime();

/**
 * Time order, with a fixed event before a tap at the same instant: when the app
 * and a machine agree to the millisecond, the explicit meaning should lead.
 */
function ordered(events) {
    return [...(events || [])]
        .filter((e) => e && e.at && !Number.isNaN(time(e)))
        .sort((a, b) => (time(a) - time(b)) || ((a.kind === 'fixed' ? 0 : 1) - (b.kind === 'fixed' ? 0 : 1)));
}

/**
 * Count rule with fixed events present.
 *
 * First try the plain rule across ALL events. When every fixed event already
 * sits where the rule would put its own action, the rule holds and taps simply
 * fill the remaining positions: phone in + one tap = in/out; three taps + a
 * phone punch-out = in/lunch/lunch/out.
 *
 * When a fixed event disagrees with its position (phone in, phone Start Lunch,
 * then a face sighting), the rule cannot hold, and taps fill only the gaps the
 * fixed events leave open. The day is cut into stretches at each fixed
 * punch-in / punch-out, and each stretch of taps is read on its own:
 *
 *   · while the person is OUT (before the app's punch-in, between an app
 *     punch-out and the next punch-in, after the app's punch-out): two or more
 *     taps are a session of their own -- first in, last out -- and a single tap
 *     is only "seen". One tap is never enough to reopen a day the app closed
 *     (the tap on the way out of the building), nor to move the app's start;
 *   · while the person is IN: the first tap after a fixed lunch start with no
 *     fixed lunch end ends it, the last tap before a fixed lunch end with no
 *     fixed lunch start starts it, and -- only after the day's last fixed event
 *     -- the last tap is the punch-out;
 *   · a day with no fixed punch-in at all starts at its first tap;
 *   · every other tap is "seen": listed, never counted.
 */
function countRuleActions(events) {
    const n = events.length;
    const positional = events.map((_, i) => countAction(i, n));
    const fixedAgree = events.every((e, i) => e.kind !== 'fixed' || e.action === positional[i]);
    if (fixedAgree) return events.map((e, i) => (e.kind === 'fixed' ? e.action : positional[i]));

    const actions = events.map((e) => (e.kind === 'fixed' ? e.action : null));
    const hasFixedIn = events.some((e) => e.kind === 'fixed' && e.action === 'punch-in');
    const lastFixed = events.reduce((acc, e, i) => (e.kind === 'fixed' ? i : acc), -1);

    // In or out at each point, as the fixed events say. A day the app never
    // started is started by its first tap.
    let state = 'out';
    let started = false;
    const segments = []; // runs of consecutive taps with the state they fall in
    let run = null;
    events.forEach((e, i) => {
        if (e.kind === 'fixed') {
            run = null;
            if (e.action === 'punch-in') { state = 'in'; started = true; }
            if (e.action === 'punch-out') state = 'out';
            return;
        }
        if (!hasFixedIn && !started) {
            actions[i] = 'punch-in';
            state = 'in';
            started = true;
            return;
        }
        if (!run) { run = { state, taps: [], trailing: false }; segments.push(run); }
        run.taps.push(i);
    });
    segments.forEach((seg) => { seg.trailing = seg.taps[0] > lastFixed; });

    for (const seg of segments) {
        if (seg.state === 'out') {
            if (seg.taps.length >= 2) {
                actions[seg.taps[0]] = 'punch-in';
                actions[seg.taps[seg.taps.length - 1]] = 'punch-out';
            }
            continue;
        }
        // IN: lunch gaps first, then the day's close.
        const before = (i) => events.slice(0, i).filter((x) => x.kind === 'fixed');
        const after = (i) => events.slice(i + 1).filter((x) => x.kind === 'fixed');
        const firstTap = seg.taps[0];
        const lastTap = seg.taps[seg.taps.length - 1];
        const lunchStartedBefore = before(firstTap).some((x) => x.action === 'lunch-in');
        const lunchEndedBefore = before(firstTap).some((x) => x.action === 'lunch-out');
        const lunchEndsAfter = after(lastTap).some((x) => x.action === 'lunch-out');
        const lunchStartsAfter = after(lastTap).some((x) => x.action === 'lunch-in');
        if (lunchStartedBefore && !lunchEndedBefore && !lunchEndsAfter) {
            actions[firstTap] = 'lunch-out';
        } else if (lunchEndsAfter && !lunchStartedBefore && !lunchStartsAfter) {
            const pick = seg.taps.length >= 2 || !seg.trailing ? lastTap : null;
            if (pick !== null) actions[pick] = 'lunch-in';
        }
        if (seg.trailing && actions[lastTap] === null) actions[lastTap] = 'punch-out';
    }
    return actions;
}

/**
 * Sequence rule: a company's own tap order (Settings.attendance.punchSequence),
 * e.g. [punch-in, lunch-in, lunch-out, punch-out]. Each tap takes the step after
 * the last one done, counting what the app did too, so a lunch started on the
 * phone is not asked for again by the machine. Once every step is done,
 * `afterLast: 'toggle'` alternates in/out for a second shift and 'ignore' leaves
 * further taps as "seen".
 *
 * Applied to the timeline in TAP-TIME order, never arrival order: that is the
 * whole fix for a tap that reaches the server late.
 */
function sequenceRuleActions(events, { steps, afterLast }) {
    const list = Array.isArray(steps) && steps.length ? steps : ACTIONS;
    let done = -1;
    let open = false;
    return events.map((e) => {
        let action;
        if (e.kind === 'fixed') {
            action = e.action;
            done = Math.max(done, list.indexOf(action));
        } else if (done < list.length - 1) {
            done += 1;
            action = list[done];
        } else {
            action = afterLast === 'toggle' ? (open ? 'punch-out' : 'punch-in') : null;
        }
        if (action === 'punch-in') open = true;
        if (action === 'punch-out') open = false;
        return action;
    });
}

/**
 * Build the day.
 *
 * @param {Array<{kind:'tap'|'fixed', at: Date, action?: string}>} events
 *        fixed events carry their own action; anything else is passed through
 * @param {{mode:'count'} | {mode:'sequence', steps:string[], afterLast:'ignore'|'toggle'}} rule
 * @returns {{
 *   events: object[],                 // the input, in timeline order
 *   labels: (string|null)[],          // final meaning of each event
 *   sessions: {in:number|null, out:number|null}[],  // indexes into `events`
 *   lunchIn: number|null, lunchOut: number|null,
 * }}
 *
 * Structure rules, in the order events happened:
 *   · punch-in opens a session; a second punch-in while one is open is "seen",
 *     except that a fixed punch-in replaces an open session's tap start -- the
 *     app's explicit start wins over a machine's reading of the same arrival;
 *   · punch-out closes the open session; with none open, a fixed punch-out
 *     replaces the previous session's tap close -- an app punch-out overrides a
 *     machine's provisional one -- and a tap punch-out is "seen";
 *   · lunch is day-level and read once.
 */
function buildDay(rawEvents, rule = { mode: 'count' }) {
    const events = ordered(rawEvents);
    const actions = events.length === 0
        ? []
        : (rule && rule.mode === 'sequence' ? sequenceRuleActions(events, rule) : countRuleActions(events));

    const labels = [...actions];
    const sessions = [];
    let open = null;
    let lunchIn = null;
    let lunchOut = null;
    const isTap = (i) => i !== null && i !== undefined && events[i].kind !== 'fixed';

    events.forEach((e, i) => {
        const a = actions[i];
        const fixed = e.kind === 'fixed';
        if (a === 'punch-in') {
            if (open === null) {
                sessions.push({ in: i, out: null });
                open = sessions.length - 1;
            } else if (fixed && isTap(sessions[open].in)) {
                labels[sessions[open].in] = null;
                sessions[open].in = i;
            } else if (!fixed) {
                labels[i] = null;
            }
        } else if (a === 'punch-out') {
            if (open !== null) {
                sessions[open].out = i;
                open = null;
            } else {
                const last = sessions[sessions.length - 1];
                if (fixed && last && isTap(last.out)) {
                    labels[last.out] = null;
                    last.out = i;
                } else if (fixed && !last) {
                    sessions.push({ in: null, out: i });
                } else if (!fixed) {
                    labels[i] = null;
                }
            }
        } else if (a === 'lunch-in') {
            if (lunchIn === null && (fixed || open !== null)) lunchIn = i;
            else if (!fixed) labels[i] = null;
        } else if (a === 'lunch-out') {
            if (lunchOut === null && (fixed || lunchIn !== null)) lunchOut = i;
            else if (!fixed) labels[i] = null;
        }
    });

    return { events, labels, sessions, lunchIn, lunchOut };
}

module.exports = { buildDay, countAction, countRuleActions, sequenceRuleActions, ACTIONS };
