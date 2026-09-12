// ─────────────────────────────────────────────────────────────────────────────
// The geofence decision: has this employee actually LEFT the branch?
//
// This is the most dangerous code in the product. Everything else here records
// what a person did; this decides something on their behalf, and a wrong
// decision ends their working day early and takes money off their payslip. So
// the governing rule, inherited from the reference implementation that learned
// it the hard way, is:
//
//                    WHEN UNSURE, STAY PUNCHED IN.
//
// Every ambiguity resolves toward inaction. Leaving someone punched in when
// they have gone home costs an admin thirty seconds of correction; punching
// someone out while they are at their desk costs them their afternoon and
// their trust in the system. Those errors are not symmetric and this file does
// not treat them as though they are.
//
// The decision is never taken on a single fix. A phone indoors will happily
// report a position several hundred metres away -- Android falls back to
// wifi/cell-tower trilateration and reports it with the same API and the same
// confidence as a real GPS lock. The reference's incident log is blunt about
// the cost: one phantom coordinate appeared 76 times and produced 29 wrong
// auto punch-outs across 4 employees, because the accuracy gate was set to
// 100 m -- which is exactly the figure Android reports for that fallback.
//
// So a closure requires a WINDOW of evidence that agrees with itself:
//   - enough fixes,                      (one bad reading cannot decide)
//   - spread over enough time,           (a momentary glitch cannot decide)
//   - from enough distinct positions,    (a single stuck coordinate repeated
//                                         many times is one observation, not
//                                         many -- this is the 76x case)
//   - each accurate enough to trust,     (excludes the wifi fallback entirely)
//   - and recent enough to still be true.(a stale queue flush is not "now")
//
// Only when all of those hold, and the MEDOID of the window is beyond
// radius + exit buffer, does the employee count as gone.
// ─────────────────────────────────────────────────────────────────────────────

const {
    calculateDistance,
    exitBufferM,
    isTrustworthyFix,
    GEOFENCE_MIN_ACCURACY_M,
} = require('./distance');

// ── Thresholds ───────────────────────────────────────────────────────────────
// Carried over from the reference, where each of these was paid for by an
// incident. Env-overridable so a site with genuinely different conditions can
// be tuned without a deploy, but the defaults are the researched values and
// should not be lowered casually.

/** Fixes required in the window before any closure is possible. */
const MIN_FIXES = Number(process.env.GEOFENCE_MIN_FIXES) || 5;

/** The window must span at least this long (ms). Defeats a momentary glitch. */
const MIN_SPAN_MS = Number(process.env.GEOFENCE_MIN_SPAN_MS) || 90 * 1000;

/**
 * Distinct positions required among those fixes.
 *
 * This is the guard against the stuck-coordinate failure. A phone that reports
 * the SAME wrong position 76 times satisfies MIN_FIXES and MIN_SPAN_MS
 * trivially, and every one of those readings is the same single observation.
 * Requiring genuinely different points means the evidence has to look like a
 * person who moved, not like a radio that got stuck.
 */
const MIN_DISTINCT = Number(process.env.GEOFENCE_MIN_DISTINCT) || 3;

/** Two fixes closer than this count as the same position. */
const DISTINCT_EPSILON_M = Number(process.env.GEOFENCE_DISTINCT_EPSILON_M) || 15;

/**
 * Quiet period after a punch-in during which no closure can happen (ms).
 *
 * Someone who has just walked through the door still has the car park's fix in
 * flight. Without this the system can punch a person out seconds after they
 * punched in, which reads as pure malfunction.
 */
const GRACE_MS = Number(process.env.GEOFENCE_GRACE_MS) || 60 * 1000;

/**
 * How old the newest fix may be and still support a decision (ms).
 *
 * The background tracker queues fixes offline and flushes them on reconnect.
 * Those points are true history but they are not evidence about NOW, and
 * closing a session on a twenty-minute-old reading is the single most common
 * shape of a wrong auto punch-out.
 */
const MAX_FIX_AGE_MS = Number(process.env.GEOFENCE_MAX_FIX_AGE_MS) || 10 * 60 * 1000;

/** How far back the window reaches (ms). */
const WINDOW_MS = Number(process.env.GEOFENCE_WINDOW_MS) || 15 * 60 * 1000;

/**
 * How many independent evaluations must each say "outside" before a session
 * actually closes.
 *
 * A single evaluation -- even one that passes every guard above -- can still
 * describe one bad moment rather than a real departure. Requiring the SAME
 * exit to be re-confirmed this many times, each backed by fixes newer than
 * the previous round's, is what makes re-evaluating the identical evidence a
 * second later prove nothing: only genuinely new fixes can advance a round.
 */
const GEOFENCE_CONFIRMATIONS = Number(process.env.GEOFENCE_CONFIRMATIONS) || 3;

/** Minimum total time the confirmation sequence must span (ms). */
const MIN_CONFIRMATION_SPAN_MS = Number(process.env.GEOFENCE_MIN_CONFIRMATION_SPAN_MS) || 120 * 1000;

/** Roles whose work is legitimately away from a branch. */
const FIELD_ROLE_PATTERNS = (process.env.GEOFENCE_FIELD_ROLES ||
    'field,sales,marketing,delivery,driver,technician,site')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/**
 * Is this employee exempt from auto punch-out because their job is outdoors?
 *
 * Checked against designation/department text rather than a dedicated flag so
 * it works on tenants who never set one. A false positive here is harmless --
 * it only means the engine declines to act -- while a false negative punches a
 * salesperson out the moment they reach a customer.
 */
function isFieldRole(user) {
    if (!user) return false;

    // The reliable mechanism: an explicit flag an admin sets.
    if (user.geofenceExempt === true) return true;

    // An employee already granted remote punching has, by definition, been told
    // they may work away from a branch. Punching them out for doing so would
    // contradict a decision the admin has already made.
    if (user.attendanceExceptions?.overrideGlobal && user.attendanceExceptions?.remotePunch) return true;

    // Department name as a convenience only. NOTE: `designation` and `jobTitle`
    // were consulted here and DO NOT EXIST on the User schema -- Mongoose strict
    // mode drops them, so those reads were always undefined and this function
    // exempted nobody. Only fields that genuinely exist may be read.
    const dept = String(
        user.departmentId?.name || user.departmentId?.departmentName || '',
    ).toLowerCase();

    if (!dept) return false;
    return FIELD_ROLE_PATTERNS.some((p) => dept.includes(p));
}

/**
 * The medoid of a set of points: the observed point with the smallest total
 * distance to all the others.
 *
 * NOT the mean, and not a per-axis median. A mean is dragged toward an outlier
 * and lands somewhere the phone never was -- average a tight cluster at the
 * desk with one wifi phantom 400 m away and you get a point 200 m out, which is
 * outside the fence while the employee never left it. A per-axis median can
 * likewise produce a lat from one fix and a lng from another, i.e. a coordinate
 * that was never observed. The medoid is always a real reading, which is what
 * makes it safe to justify a decision with.
 */
function medoid(points) {
    if (!points.length) return null;
    if (points.length === 1) return points[0];

    let best = points[0];
    let bestTotal = Infinity;
    for (const a of points) {
        let total = 0;
        for (const b of points) {
            if (a === b) continue;
            total += calculateDistance(a.latitude, a.longitude, b.latitude, b.longitude);
        }
        if (total < bestTotal) {
            bestTotal = total;
            best = a;
        }
    }
    return best;
}

/** How many of these points are meaningfully different places? */
function countDistinct(points, epsilonM = DISTINCT_EPSILON_M) {
    const kept = [];
    for (const p of points) {
        const dup = kept.some(
            (k) => calculateDistance(k.latitude, k.longitude, p.latitude, p.longitude) <= epsilonM,
        );
        if (!dup) kept.push(p);
    }
    return kept.length;
}

/**
 * Decide whether the evidence supports closing this session.
 *
 * PURE: no database, no clock of its own, no side effects. Everything it needs
 * arrives as arguments, which is what makes the thresholds testable without a
 * mongod and without waiting fifteen minutes for a window to fill.
 *
 * @param {Object}   input
 * @param {Array}    input.fixes      Tracking docs, any order. {latitude, longitude, accuracy, timestamp}
 * @param {Array}    input.branches   The employee's fenced branches.
 * @param {number}   input.fallbackRadius  Tenant default radius (m).
 * @param {Date}     input.now        Evaluation instant.
 * @param {Date}     input.punchInAt  Start of the open session.
 * @param {boolean}  input.onLunch    True while the employee is on a break.
 *
 * @returns {{outside: boolean, reason: string, decision: string, narrative: string, evidence: Object}}
 */
function evaluateExit({ fixes, branches, fallbackRadius = 3000, now, punchInAt, onLunch = false }) {
    const nowMs = new Date(now).getTime();

    const evidence = {
        fixesInWindow: 0,
        trustworthyFixes: 0,
        distinctPositions: 0,
        windowSpanMs: 0,
        worstAccuracyM: null,
        newestFixAgeMs: null,
        medoidLat: null,
        medoidLng: null,
        distanceM: null,
        radiusM: null,
        thresholdM: null,
        branchId: null,
    };

    const abstain = (reason, narrative) => ({
        outside: false, decision: 'abstained', reason, narrative, evidence,
    });
    const suppress = (reason, narrative) => ({
        outside: false, decision: 'suppressed', reason, narrative, evidence,
    });

    // ── Suppressions: rules that forbid acting, whatever the evidence says ──
    if (onLunch) {
        return suppress('on_lunch', 'On a lunch break — stepping out is expected, so the fence does not apply.');
    }

    const fenced = (branches || []).filter(
        (b) => b && b.geoFenceEnabled !== false && b.latitude != null && b.longitude != null,
    );
    if (!fenced.length) {
        // NOT a fall-through to punching out. A branch with no coordinates, or
        // with the fence switched off, means "we cannot judge" -- and in the
        // reference this exact path once fell through to a closure.
        return suppress('no_branch', 'No fenced branch with coordinates — nothing to measure against.');
    }

    if (punchInAt && nowMs - new Date(punchInAt).getTime() < GRACE_MS) {
        return suppress(
            'grace_period',
            `Punched in less than ${Math.round(GRACE_MS / 1000)}s ago — fixes from the way in are still arriving.`,
        );
    }

    // ── Gather the window ───────────────────────────────────────────────────
    const windowStart = nowMs - WINDOW_MS;
    const inWindow = (fixes || [])
        .filter((f) => {
            if (!f || f.latitude == null || f.longitude == null) return false;
            const t = new Date(f.timestamp).getTime();
            if (!Number.isFinite(t)) return false;
            // A fix captured before this session opened describes a different
            // day, or the walk in. It is not evidence about this session.
            if (punchInAt && t < new Date(punchInAt).getTime()) return false;
            return t >= windowStart && t <= nowMs;
        })
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    evidence.fixesInWindow = inWindow.length;

    const trusted = inWindow.filter((f) => isTrustworthyFix(f.accuracy));
    evidence.trustworthyFixes = trusted.length;
    if (inWindow.length) {
        evidence.worstAccuracyM = Math.max(
            ...inWindow.map((f) => (Number.isFinite(Number(f.accuracy)) ? Number(f.accuracy) : 0)),
        );
        const newest = new Date(inWindow[inWindow.length - 1].timestamp).getTime();
        evidence.newestFixAgeMs = nowMs - newest;
        evidence.windowSpanMs = newest - new Date(inWindow[0].timestamp).getTime();
    }

    if (!inWindow.length) {
        // NOTHING arrived. Distinct from "the fixes were poor": a silent phone
        // means tracking stopped, the battery died, or the employee force-quit
        // the app -- an operational problem with an operational fix, whereas
        // poor accuracy means the fence may need recalibrating. Collapsing the
        // two hides a fleet that has quietly stopped reporting behind a reason
        // that reads like normal GPS noise.
        //
        // It abstains either way: silence is never evidence that somebody left.
        return abstain(
            'no_fixes',
            `No location received in the last ${Math.round(WINDOW_MS / 60000)} minutes — ` +
            'tracking may have stopped on this device.',
        );
    }

    if (!trusted.length) {
        return abstain(
            'no_trustworthy_fix',
            `No fix accurate enough to act on (need ≤${GEOFENCE_MIN_ACCURACY_M}m; ` +
            `${inWindow.length} fix(es) seen, worst ${evidence.worstAccuracyM ?? 'unknown'}m).`,
        );
    }

    if (trusted.length < MIN_FIXES) {
        return abstain(
            'too_few_fixes',
            `Only ${trusted.length} usable fix(es); ${MIN_FIXES} are required before anyone is punched out.`,
        );
    }

    // Recompute the span over TRUSTED fixes -- the span that matters is the one
    // the decision actually rests on, not the one including readings we threw away.
    const tFirst = new Date(trusted[0].timestamp).getTime();
    const tLast = new Date(trusted[trusted.length - 1].timestamp).getTime();
    evidence.windowSpanMs = tLast - tFirst;
    evidence.newestFixAgeMs = nowMs - tLast;

    if (evidence.newestFixAgeMs > MAX_FIX_AGE_MS) {
        return abstain(
            'stale_fixes',
            `Newest usable fix is ${Math.round(evidence.newestFixAgeMs / 60000)} min old — ` +
            'too stale to say where the employee is now.',
        );
    }

    if (evidence.windowSpanMs < MIN_SPAN_MS) {
        return abstain(
            'window_too_short',
            `Evidence spans only ${Math.round(evidence.windowSpanMs / 1000)}s; ` +
            `${Math.round(MIN_SPAN_MS / 1000)}s are required.`,
        );
    }

    evidence.distinctPositions = countDistinct(trusted);
    if (evidence.distinctPositions < MIN_DISTINCT) {
        return abstain(
            'too_few_distinct_positions',
            `${trusted.length} fixes but only ${evidence.distinctPositions} distinct position(s) — ` +
            'a repeated identical reading is one observation, not many.',
        );
    }

    // The DECIDING set is the newest MIN_FIXES trusted fixes, not every trusted
    // fix in the window. A 15-minute window can hold dozens of points; deciding
    // on all of them lets old inside-positions drag the centre back and dilutes
    // the newest evidence with history that may no longer be true.
    const deciding = trusted.slice(-MIN_FIXES);

    // Every one of the deciding fixes must be a DIFFERENT position -- not just
    // "at least MIN_DISTINCT among however many trusted fixes exist overall".
    // This is the guard the coarser distinctPositions check above cannot
    // provide: three identical readings of a wifi phantom plus two real desk
    // fixes clears MIN_DISTINCT (3) on the whole window, and the medoid of
    // that five-point set is pulled onto the phantom by its own repetition --
    // this is precisely the shape of the reference's worst incident (one
    // phantom coordinate, repeated, produced 29 wrong auto punch-outs across 4
    // employees). Requiring the deciding set itself to be fully distinct closes
    // that path: a repeated reading among the fixes actually used to decide is
    // one observation re-delivered, not independent confirmation.
    if (countDistinct(deciding) < deciding.length) {
        return abstain(
            'repeated_coordinate',
            'A coordinate repeats among the fixes deciding this exit — one stuck reading, not independent evidence.',
        );
    }

    // ── The measurement ─────────────────────────────────────────────────────
    const centre = medoid(deciding);
    evidence.medoidLat = centre.latitude;
    evidence.medoidLng = centre.longitude;

    let nearest = null;
    let nearestDist = Infinity;
    for (const b of fenced) {
        const d = calculateDistance(centre.latitude, centre.longitude, b.latitude, b.longitude);
        if (d < nearestDist) {
            nearestDist = d;
            nearest = b;
        }
    }

    const radius = nearest.radius > 0 ? nearest.radius : fallbackRadius;
    const threshold = radius + exitBufferM(radius);

    evidence.branchId = nearest._id || null;
    evidence.radiusM = radius;
    evidence.thresholdM = Math.round(threshold);
    evidence.distanceM = Math.round(nearestDist);

    if (nearestDist <= radius) {
        return {
            outside: false,
            decision: 'inside',
            reason: 'within_fence',
            narrative: `Inside ${nearest.branchName || 'the branch'} — ${Math.round(nearestDist)}m from it (radius ${radius}m).`,
            evidence,
        };
    }

    if (nearestDist <= threshold) {
        // Between the radius and the exit threshold: outside the fence but
        // inside the buffer that exists precisely so that standing at the
        // boundary does not flicker someone in and out all day.
        return abstain(
            'within_buffer',
            `${Math.round(nearestDist)}m from the branch — past the ${radius}m radius but still ` +
            `inside the ${Math.round(threshold)}m exit threshold.`,
        );
    }

    if (nearestDist <= threshold * 3) {
        // Marginal exit: outside the buffer, but close enough that GPS drift could
        // be responsible. Require a longer window (120s) to be sure.
        if (evidence.windowSpanMs < 120 * 1000) {
            return abstain(
                'marginal_window_too_short',
                `Marginal exit (${Math.round(nearestDist)}m, limit ${Math.round(threshold)}m) requires 120s of evidence to confirm; got ${Math.round(evidence.windowSpanMs / 1000)}s.`
            );
        }
    }

    // When was the employee last demonstrably INSIDE? That instant, not now, is
    // when their session should end: "now" credits them for the walk home, and
    // the deciding fix docks them for the whole confirmation window -- the
    // window exists so WE can be certain, and they should not pay for it.
    let lastInsideAt = null;
    const allTrusted = (fixes || []).filter((f) => isTrustworthyFix(f.accuracy));
    for (const f of allTrusted) {
        const d = calculateDistance(f.latitude, f.longitude, nearest.latitude, nearest.longitude);
        if (d <= radius) {
            // Keep the latest timestamp before window start or in window.
            const t = new Date(f.timestamp).getTime();
            if (punchInAt && t >= new Date(punchInAt).getTime() && t <= nowMs) {
                if (!lastInsideAt || t > new Date(lastInsideAt).getTime()) {
                    lastInsideAt = f.timestamp;
                }
            }
        }
    }

    return {
        outside: true,
        decision: 'punched_out',
        reason: 'confirmed_exit',
        lastInsideAt,
        narrative:
            `Measured ${Math.round(nearestDist)}m from ${nearest.branchName || 'the branch'} ` +
            `(limit ${Math.round(threshold)}m), from ${trusted.length} fixes at ` +
            `${evidence.distinctPositions} distinct positions over ` +
            `${Math.round(evidence.windowSpanMs / 60000)} min.`,
        evidence,
    };
}

module.exports = {
    evaluateExit,
    isFieldRole,
    medoid,
    countDistinct,
    MIN_FIXES,
    MIN_SPAN_MS,
    MIN_DISTINCT,
    DISTINCT_EPSILON_M,
    GRACE_MS,
    MAX_FIX_AGE_MS,
    WINDOW_MS,
    FIELD_ROLE_PATTERNS,
    GEOFENCE_CONFIRMATIONS,
    MIN_CONFIRMATION_SPAN_MS,
};
