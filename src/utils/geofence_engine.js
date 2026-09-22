// ─────────────────────────────────────────────────────────────────────────────
// Acting on a geofence decision.
//
// utils/geofence_window.js decides; this file is the only thing allowed to DO
// something about it. The split is deliberate: the decision is pure and can be
// tested exhaustively against fabricated windows in milliseconds, while this
// side owns the database, the audit row and the irreversible act of closing
// somebody's session.
//
// Four properties this file must keep:
//
//  1. Every evaluation is ACCOUNTED FOR, including the ones that do nothing --
//     an engine that logs only its closures cannot be shown to be working
//     correctly, since silence is indistinguishable from being broken. That
//     does not mean every evaluation gets its own row: an unchanged steady
//     state (sitting at a desk all day, or abstaining for the same reason
//     throughout a signal-poor building) is collapsed to one fresh row per
//     ROUTINE_THROTTLE_MS rather than one per ~45s sync tick, or the
//     collection grows by roughly 640 rows/employee/day. A TRANSITION -- the
//     decision or reason actually changing -- and a real `punched_out` are
//     never throttled; those are exactly the rows worth seeing.
//
//  2. Shadow mode is enforced HERE, after a full decision, never by skipping
//     the evaluation. A shadow run whose engine took a shortcut proves nothing
//     about the engine that later runs for real.
//
//  3. The close mirrors the manual punch-out exactly -- same session handling,
//     same worked-time function, same grading, same event log. If it diverged,
//     a day closed by the engine would pay differently from the identical day
//     closed by a person, which is the bug this whole subsystem exists to
//     avoid creating.
//
//  4. A single evaluation never closes anything. Even one that clears every
//     guard in geofence_window.js -- enough distinct, accurate, recent fixes,
//     none of them a repeated coordinate -- can still describe one bad moment
//     rather than a real departure. advanceConfirmation() requires the SAME
//     exit to be independently re-confirmed GEOFENCE_CONFIRMATIONS times,
//     each backed by evidence newer than the last, spanning at least
//     MIN_CONFIRMATION_SPAN_MS -- so re-evaluating identical fixes a second
//     later proves nothing, and only genuinely new evidence can advance a
//     round. This applies in shadow mode too: shadow exists to prove out what
//     the ARMED engine would do, and the armed engine requires this.
// ─────────────────────────────────────────────────────────────────────────────

const Attendance = require('../models/Attendance');
const Tracking = require('../models/Tracking');
const Settings = require('../models/Settings');
const User = require('../models/User');
const GeofenceAudit = require('../models/GeofenceAudit');
const GeofencePendingExit = require('../models/GeofencePendingExit');

const {
    evaluateExit, isFieldRole, WINDOW_MS, GEOFENCE_CONFIRMATIONS, MIN_CONFIRMATION_SPAN_MS,
    GEOFENCE_UNAMBIGUOUS_FACTOR, GEOFENCE_PENDING_STALE_MS,
} = require('./geofence_window');
const { istStartOfDay, istEndOfDay, istDateKey } = require('./attendance_helpers');
const { computeWorkedMs, computeSessionWorkMs, computeSessionGrossMs, gradeDay, openSessionIndex, allSessions, syncRootPunchOut, MAX_SESSIONS } = require('./shift_status');
const { isTrustworthyFix, nearestBranchDistance } = require('./distance');
const { logAttendanceEvent } = require('./attendance_event_logger');
const { sendAutoPunchOutNotice } = require('../jobs/notify');

/**
 * How long an UNCHANGED steady state may go unrecorded before a fresh row is
 * written anyway -- long enough that an ordinary 8h desk day does not write
 * roughly 640 rows (one per ~45s native sync tick), short enough that "is the
 * engine still alive for this employee" stays answerable within a few
 * minutes rather than going quiet for the rest of the day.
 */
const ROUTINE_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Write the audit row -- unless an identical row for this employee was
 * already written within ROUTINE_THROTTLE_MS, in which case the steady state
 * is already covered and a duplicate would only add volume, not information.
 *
 * A TRANSITION always writes immediately: if the new (decision, reason) pair
 * differs from the employee's last row, that is new information regardless of
 * timing. A `punched_out` decision is never throttled either way -- it is
 * rare, and shadow or real, it is always worth a row of its own.
 *
 * Never throws -- a failure to record the reasoning must not also prevent
 * (or undo) the decision itself.
 */
async function recordAudit(row) {
    try {
        if (row.decision !== 'punched_out') {
            const last = await GeofenceAudit.findOne({ adminId: row.adminId, employeeId: row.employeeId })
                .sort({ createdAt: -1 })
                .select('decision reason createdAt')
                .lean();
            if (last && last.decision === row.decision && last.reason === row.reason) {
                const ageMs = Date.now() - new Date(last.createdAt).getTime();
                if (ageMs < ROUTINE_THROTTLE_MS) return; // steady state -- already covered
            }
        }
        await GeofenceAudit.create(row);
    } catch (err) {
        console.error('[geofence] audit write failed:', err.message);
    }
}

/**
 * Advance (or start) this employee's multi-round exit confirmation.
 *
 * A single evaluation saying "outside" -- even one that has passed the
 * repeated-coordinate and newest-fixes guards -- can still be one bad moment
 * rather than a real departure: a delivery van idling just past the fence, a
 * fix that wandered through a dead zone. Requiring GEOFENCE_CONFIRMATIONS
 * independent rounds, each backed by evidence newer than the last, spanning
 * at least MIN_CONFIRMATION_SPAN_MS in total, is what makes re-evaluating the
 * SAME fixes a second later prove nothing -- only genuinely new evidence can
 * advance a round.
 *
 * Persisted rather than kept in memory: this app has no long-lived process
 * to hold it (Vercel serverless), and even a long-running host may run
 * several instances. The state has to survive between one evaluation and the
 * next in the database, not in a variable.
 *
 * @returns {{confirmed: boolean, rounds: number, lastInsideAt: Date|null}}
 */
async function advanceConfirmation({ adminId, employeeId, now, verdict }) {
    const newestFixMs = new Date(now).getTime() - (verdict.evidence.newestFixAgeMs || 0);
    const newestFixAt = new Date(newestFixMs);

    let pending = await GeofencePendingExit.findOne({ adminId, employeeId });

    // A sequence that has gone quiet is abandoned rather than resumed. Rounds
    // have to be CONTINUOUS: two rounds banked this morning must not combine
    // with one blip this afternoon, where the hours between them would satisfy
    // the span requirement on their own.
    if (pending && Date.now() - new Date(pending.lastEvaluatedAt).getTime() > GEOFENCE_PENDING_STALE_MS) {
        await GeofencePendingExit.deleteOne({ _id: pending._id });
        pending = null;
    }

    if (!pending) {
        pending = await GeofencePendingExit.create({
            adminId, employeeId,
            since: now,
            rounds: 1,
            lastFixTimestamp: newestFixAt,
            lastEvaluatedAt: now,
            lastInsideAt: verdict.lastInsideAt || null,
        });
    } else {
        // Only genuinely NEW evidence -- a fix newer than what the previous
        // round already used -- may advance a round. Without this, two
        // evaluations firing moments apart (a retry, or the sync interval
        // overlapping a manual trigger) would double-count the same fixes as
        // two independent confirmations.
        const isNewRound = newestFixMs > new Date(pending.lastFixTimestamp).getTime();

        if (isNewRound) pending.rounds += 1;
        pending.lastFixTimestamp = newestFixAt;
        pending.lastEvaluatedAt = now;

        // Each round can only push lastInsideAt FORWARD, never back: a later
        // round has visibility a round 1 did not, and if it reveals a more
        // recent inside reading, that is a truer boundary than what round 1
        // saw.
        if (verdict.lastInsideAt) {
            const candidate = new Date(verdict.lastInsideAt).getTime();
            const current = pending.lastInsideAt ? new Date(pending.lastInsideAt).getTime() : -Infinity;
            if (candidate > current) pending.lastInsideAt = verdict.lastInsideAt;
        }

        await pending.save();
    }

    // An exit far beyond the threshold needs one round, not three.
    //
    // The five fixes behind a single round have already survived the accuracy
    // gate, the distinct-position floor, the repeated-coordinate check and the
    // 90-second span. At more than GEOFENCE_UNAMBIGUOUS_FACTOR x the threshold
    // there is no reading of that evidence in which the employee is at their
    // desk. Marginal exits — where every wrong punch-out has ever happened —
    // keep the full three-round requirement.
    const unambiguous = Number.isFinite(verdict.evidence.thresholdM)
        && Number.isFinite(verdict.evidence.distanceM)
        && verdict.evidence.distanceM > verdict.evidence.thresholdM * GEOFENCE_UNAMBIGUOUS_FACTOR;

    const roundsNeeded = unambiguous ? 1 : GEOFENCE_CONFIRMATIONS;
    const spanNeeded = unambiguous ? 0 : MIN_CONFIRMATION_SPAN_MS;

    const spanMs = new Date(now).getTime() - new Date(pending.since).getTime();
    const confirmed = pending.rounds >= roundsNeeded && spanMs >= spanNeeded;

    if (confirmed) {
        // The sequence is spent -- clear it so the NEXT exit (a new session,
        // a new day) starts counting from round 1 again rather than
        // inheriting a stale round count.
        await GeofencePendingExit.deleteOne({ adminId, employeeId });
    }

    return { confirmed, rounds: pending.rounds, needed: roundsNeeded, unambiguous, lastInsideAt: pending.lastInsideAt };
}

/**
 * Clear any in-progress exit confirmation for this employee.
 *
 * Called whenever the evidence no longer supports an exit -- back inside, an
 * abstention, a suppression -- mirroring the reference's clearFixes(). Without
 * this, a brief step outside that resolves itself (an exit that never reached
 * enough rounds) would leave a stale partial count sitting in the database,
 * ready to combine with an UNRELATED later exit and confirm too quickly.
 */
async function clearConfirmation(adminId, employeeId) {
    try {
        await GeofencePendingExit.deleteOne({ adminId, employeeId });
    } catch (err) {
        console.error('[geofence] failed to clear pending exit:', err.message);
    }
}

/**
 * Evaluate one employee's open session and close it if they have demonstrably
 * left. Safe to call often; it is cheap when there is nothing to do.
 *
 * @param {Object}  opts
 * @param {ObjectId} opts.adminId
 * @param {ObjectId} opts.employeeId
 * @param {Date}    [opts.now]
 * @param {boolean} [opts.force]  Ignore the tenant's enabled flag (used by the
 *                                shadow-run report, which always evaluates).
 * @returns {Object} the decision, for logging/tests
 */
async function evaluateEmployee({ adminId, employeeId, now = new Date(), force = false }) {
    const dayKey = istDateKey(now);
    const base = { adminId, employeeId, dayKey };

    const [user, settings] = await Promise.all([
        User.findById(employeeId).populate('shiftId branchId branchIds departmentId').lean(),
        Settings.findOne({ adminId }).lean(),
    ]);

    if (!user) return { decision: 'suppressed', reason: 'not_punched_in' };

    const cfg = settings?.attendance?.geofenceAutoPunchOut || {};

    // "Armed" means the engine may actually CLOSE a session for real -- the
    // same definition the promotion gate in geofence_controller.js already
    // uses (`arming = enabled === true && shadowMode === false`). Anything
    // short of that is shadow: the engine still evaluates and still writes
    // the audit trail the shadow report needs, it just never touches an
    // Attendance document.
    //
    // This USED to return here, before evaluating anything, whenever
    // `enabled` was false -- which is the field's own default. So a tenant
    // who had never touched this setting produced ZERO shadow data, and the
    // promotion gate (which requires 7 days / 3 employees / 50 decisions of
    // shadow evidence before allowing a real arm) could never be satisfied
    // without first blindly flipping `enabled` to true -- exactly the leap of
    // faith shadow mode exists to avoid. Evaluation must never be gated on
    // the same flag that gates the act; only the act may be.
    const armed = force || (cfg.enabled === true && cfg.shadowMode === false);
    const shadow = !armed;

    // Field staff are exempt: their job IS being away from the branch, and
    // punching them out on arrival at a customer is the worst failure here.
    if (isFieldRole(user)) {
        // Built only from fields that actually exist on the User schema.
        // `user.designation` does not -- Mongoose strict mode drops it, so
        // reading it here always produced `undefined`. geofence_window.js's
        // isFieldRole() already carries this exact lesson in a comment; this
        // was the one place it hadn't been applied.
        const exemptReason = user.geofenceExempt
            ? 'marked exempt by an admin'
            : user.departmentId?.name || user.departmentId?.departmentName
                ? `${user.departmentId.name || user.departmentId.departmentName} department`
                : user.attendanceExceptions?.remotePunch
                    ? 'granted remote punching'
                    : 'exempt';
        await recordAudit({
            ...base, decision: 'suppressed', reason: 'role_exempt', shadow,
            narrative: `${user.name} works off-site (${exemptReason}) — exempt from auto punch-out.`,
        });
        return { decision: 'suppressed', reason: 'role_exempt' };
    }

    // Auto punch-out is opted INTO per department. An employee whose department
    // has not enabled it is still evaluated -- the audit trail records what
    // WOULD have happened -- but the day is never closed.
    //
    // No department, or one that has not enabled it, both mean "not enabled".
    // Defaulting the other way would let a newly created department inherit the
    // power to end somebody's shift without anyone choosing that.
    const dept = user.departmentId;
    if (!dept || dept.autoPunchOutEnabled !== true) {
        await recordAudit({
            ...base,
            decision: 'suppressed',
            reason: 'department_disabled',
            shadow,
            narrative: dept
                ? `Auto punch-out is not enabled for the ${dept.name} department.`
                : `${user.name} has no department, so no auto punch-out policy applies.`,
        });
        return { decision: 'suppressed', reason: 'department_disabled' };
    }

    let attendance = await Attendance.findOne({
        adminId, employeeId, date: { $gte: istStartOfDay(now), $lte: istEndOfDay(now) },
    });

    // A night worker who punched in at 22:00 and is still on shift at 02:00 has
    // their open session on YESTERDAY'S row, because attendance is bucketed by
    // the IST day the session STARTED. Looking only at today makes them read as
    // not punched in, so the fence silently stops watching the very people most
    // likely to be away from a branch at that hour.
    if (!attendance || !attendance.punchIn || openSessionIndex(attendance) === -1) {
        const prevDay = new Date(istStartOfDay(now).getTime() - 1);
        const prev = await Attendance.findOne({
            adminId, employeeId,
            date: { $gte: istStartOfDay(prevDay), $lte: istEndOfDay(prevDay) },
        });
        if (prev && prev.punchIn && openSessionIndex(prev) !== -1) attendance = prev;
    }

    if (!attendance || !attendance.punchIn) {
        return { decision: 'suppressed', reason: 'not_punched_in', skipped: true };
    }

    const openIdx = openSessionIndex(attendance);
    if (openIdx === -1) {
        return { decision: 'suppressed', reason: 'already_closed', skipped: true };
    }

    // A day declared Work From Home is not measured against any fence.
    //
    // Every other exemption here is a property of the PERSON -- geofenceExempt,
    // remotePunch, the department name -- resolved by isFieldRole() long before
    // this point. WFH is a property of the DAY, so it cannot be known until the
    // attendance row is in hand, which is why the check lives down here rather
    // than beside the others.
    //
    // Without it, an office employee who declares one day remote is watched by
    // the engine from their own home and punched out the moment the confirmation
    // window agrees they are 400m from a branch they never went to. That is the
    // single worst outcome this subsystem can produce: a closure that is
    // correct by every measurement and wrong about what was being measured.
    // Fails toward inaction, like every other ambiguity here.
    if (attendance.isWFH) {
        await recordAudit({
            ...base, decision: 'suppressed', reason: 'work_from_home', shadow,
            attendanceId: attendance._id,
            narrative: `${user.name} is working from home today — exempt from auto punch-out.`,
        });
        return { decision: 'suppressed', reason: 'work_from_home' };
    }

    const sessions = allSessions(attendance);
    const openSession = sessions[openIdx];
    const punchInAt = openSession?.punchIn || attendance.punchIn;

    // A confirmation sequence belongs to ONE session. If the open session began
    // after the pending exit started, that pending is a leftover from a session
    // that has already ended and must not contribute rounds to this one.
    //
    // This closes a hole opened by making clearConfirmation fire only on an
    // 'inside' verdict: a suppression (grace_period, on_lunch, no_branch) no
    // longer clears, and GRACE_MS is 60s while GEOFENCE_PENDING_STALE_MS is
    // 120s — so someone who punched out while away and punched straight back in
    // could inherit the previous session's accumulated rounds and be punched
    // out again almost immediately. The reference implementation avoids this by
    // clearing pending state on punch-in; doing it here instead covers every
    // punch path (app, biometric, reconciliation) rather than just one.
    const staleSession = await GeofencePendingExit.findOne({ adminId, employeeId }).lean();
    if (staleSession && new Date(staleSession.since) < new Date(punchInAt)) {
        await clearConfirmation(adminId, employeeId);
    }

    // On lunch = lunch started and not yet ended. Stepping out for lunch is
    // exactly the thing the fence must not react to.
    const onLunch = !!attendance.lunchInTime && !attendance.lunchOutTime;

    const branches = [user.branchId, ...(user.branchIds || [])].filter(Boolean);

    // `cached: true` fixes are excluded from the DECISION but still exist in
    // the collection for the map and the audit trail. A coordinate the phone
    // re-sent unchanged is one observation re-delivered; letting it occupy a
    // slot in the deciding set is how a single stale reading captures a
    // decision.
    const fixes = await Tracking.find({
        adminId, employeeId,
        timestamp: { $gte: new Date(punchInAt) },
        cached: { $ne: true },
    })
        .sort({ timestamp: 1 })
        .lean();

    const verdict = evaluateExit({
        fixes,
        branches,
        fallbackRadius: settings?.attendance?.officeRadius || 3000,
        now,
        punchInAt,
        onLunch,
    });

    const auditRow = {
        ...base,
        decision: verdict.decision,
        reason: verdict.reason,
        narrative: verdict.narrative,
        shadow,
        branchId: verdict.evidence.branchId,
        radiusM: verdict.evidence.radiusM,
        thresholdM: verdict.evidence.thresholdM,
        medoidLat: verdict.evidence.medoidLat,
        medoidLng: verdict.evidence.medoidLng,
        distanceM: verdict.evidence.distanceM,
        fixesInWindow: verdict.evidence.fixesInWindow,
        trustworthyFixes: verdict.evidence.trustworthyFixes,
        distinctPositions: verdict.evidence.distinctPositions,
        windowSpanMs: verdict.evidence.windowSpanMs,
        worstAccuracyM: verdict.evidence.worstAccuracyM,
        newestFixAgeMs: verdict.evidence.newestFixAgeMs,
    };

    if (!verdict.outside) {
        // ONLY a positive "they are inside" verdict invalidates an exit in
        // progress. An abstention means the evidence was inconclusive -- a
        // coarse fix, a repeated coordinate, a burst that has not landed yet --
        // which is not the same as evidence that they came back.
        //
        // This used to clear on ANY non-outside verdict, and that discarded
        // real progress: on 2026-09-15 a genuine 901 m departure banked 102
        // seconds of confirmed rounds, then one duplicate GPS row produced a
        // single `repeated_coordinate` abstention and wiped the sequence 18
        // seconds before it would have fired. Quiet sequences are aged out by
        // GEOFENCE_PENDING_STALE_MS in advanceConfirmation instead, which is
        // what the reference implementation does.
        if (verdict.decision === 'inside') {
            await clearConfirmation(adminId, employeeId);
        }
        await recordAudit(auditRow);
        return verdict;
    }

    // ── One round of a possible exit ─────────────────────────────────────────
    // A single "outside" verdict is not a confirmed exit -- see
    // advanceConfirmation(). This applies in shadow mode too: the shadow run
    // exists to prove out what the ARMED engine would do, and the armed
    // engine requires GEOFENCE_CONFIRMATIONS rounds, so shadow data that
    // skipped this step would not describe production behaviour.
    const confirmation = await advanceConfirmation({ adminId, employeeId, now, verdict });

    if (!confirmation.confirmed) {
        await recordAudit({
            ...auditRow,
            decision: 'suppressed',
            reason: 'confirming',
            shadow,
            narrative:
                `${verdict.narrative} — round ${confirmation.rounds}/${confirmation.needed}` +
                (confirmation.unambiguous ? ' (unambiguous distance)' : '') +
                ', awaiting independent confirmation before acting.',
        });
        return { decision: 'suppressed', reason: 'confirming', rounds: confirmation.rounds };
    }

    // Use the confirmation sequence's own lastInsideAt -- the most recent
    // demonstrably-inside moment seen across every round, which can be later
    // (and is always at least as informed) as the single round's own value.
    verdict.lastInsideAt = confirmation.lastInsideAt;

    // ── Confirmed exit ──────────────────────────────────────────────────────
    if (shadow) {
        // The whole point of the shadow run: say exactly what WOULD have
        // happened, change nothing.
        await recordAudit({
            ...auditRow,
            narrative: `[SHADOW — no action taken] ${verdict.narrative}`,
            sessionNumber: openIdx + 1,
        });
        return { ...verdict, shadow: true, closed: false };
    }

    const closed = await closeSession({
        attendance, user, settings, openIdx, now, verdict,
    });

    await recordAudit({
        ...auditRow,
        attendanceId: attendance._id,
        sessionNumber: openIdx + 1,
        closedAt: closed.at,
    });

    // Tell the employee the same hour, not on their payslip three weeks later.
    // Fire-and-forget: a notification failure must not roll back a decision
    // that is already recorded and already audited.
    // Name the branch the decision was measured against. The employee needs to
    // know WHICH site they were judged to have left -- on a multi-branch tenant
    // "you left your branch" is not actionable.
    const decidedBranch = branches.find(
        (b) => String(b._id) === String(verdict.evidence.branchId),
    );

    sendAutoPunchOutNotice({
        employee: user,
        attendance,
        branchName: decidedBranch?.branchName || null,
        distanceM: verdict.evidence.distanceM,
        closedAt: closed.at,
    }).catch((e) => console.error('[geofence] auto punch-out notice failed:', e.message));

    return { ...verdict, shadow: false, closed: true, closedAt: closed.at };
}

/**
 * Close the open session the way a manual punch-out would.
 *
 * The close time is the moment of the LAST TRUSTED FIX INSIDE the fence, not
 * "now". Using now would credit the employee for the walk home, and using the
 * deciding fix would dock them for the whole confirmation window -- the window
 * exists to be sure, and the employee should not pay for our caution. Falling
 * back to now only when there is no such fix.
 */
async function closeSession({ attendance, user, settings, openIdx, now, verdict }) {
    const sessions = attendance.shifts || [];
    const session = sessions[openIdx];

    let closeAt = verdict.lastInsideAt ? new Date(verdict.lastInsideAt) : new Date(now);

    // Never before the session opened -- a clock skew or an odd window must not
    // produce a session that ends before it starts.
    const openedAt = new Date(session?.punchIn || attendance.punchIn);
    if (closeAt < openedAt) closeAt = new Date(now);

    if (session) {
        session.punchOut = closeAt;
        session.closeReason = 'auto_geofence';
        session.punchOutSource = 'system';
        session.punchOutLocation = verdict.evidence.medoidLat != null
            ? `${verdict.evidence.medoidLat.toFixed(5)}, ${verdict.evidence.medoidLng.toFixed(5)}`
            : null;
        session.punchOutCoordinates = verdict.evidence.medoidLat != null
            ? { lat: verdict.evidence.medoidLat, lng: verdict.evidence.medoidLng }
            : null;
        session.punchOutDistance = verdict.evidence.distanceM;
    }

    // The root mirrors the day's FINAL punch-out, whichever session that is.
    // Keying on index 0 left the root null every time a later session was the
    // one being closed, and a null root reads as "still open" to the nightly
    // close job, the on-duty stat, and the next punch-in attempt.
    if (!sessions.length) {
        attendance.punchOut = closeAt;
        attendance.punchOutDistance = verdict.evidence.distanceM;
        attendance.punchOutLocation = session?.punchOutLocation || null;
        attendance.punchOutCoordinates = session?.punchOutCoordinates || null;
    } else {
        syncRootPunchOut(attendance);
    }

    // An engine close is final, not provisional: it is a deliberate decision
    // with evidence behind it, unlike a device's generic in/out toggle.
    attendance.punchOutIsProvisional = false;

    attendance.autoPunchOut = true;
    attendance.autoPunchOutReason = verdict.narrative;
    attendance.calculatedDistance = verdict.evidence.distanceM;
    attendance.geoStatus = 'auto_exit';

    attendance.totalWorkMs = computeWorkedMs(attendance, user.shiftId, settings);
    for (const s of sessions) {
        s.workMs = computeSessionWorkMs(s, attendance, user.shiftId);
        // The measured duration next to the credited one. A session outside the
        // shift window credits zero, and without this the time it represents
        // leaves no trace at all for the reviewer the grade below sends it to.
        s.grossMs = computeSessionGrossMs(s);
    }

    // Same grading the manual path applies, and only ever downgrading.
    const grade = gradeDay(attendance, user.shiftId, settings);
    if (grade === 'half-day' && attendance.status === 'present') {
        attendance.status = 'half-day';
    }
    if (grade === 'absent') attendance.status = 'absent';

    // A day this engine closed that still measures as nothing is OUR failure to
    // reconstruct, not the employee's absence -- they have a punch-in on record.
    // gradeDay already works this out; the geofence path used to compute the
    // verdict and then discard it, so a 52-minute session that clamped to zero
    // was stored as an ordinary half-day and never reached a human.
    if (grade === 'needs_review') attendance.status = 'needs_review';

    const note = ' | Auto punch-out (left branch geo-fence)';
    if (!String(attendance.remarks || '').includes(note.trim())) {
        attendance.remarks = (attendance.remarks || '') + note;
    }

    await attendance.save();

    logAttendanceEvent({
        adminId: attendance.adminId,
        employeeId: attendance.employeeId,
        type: 'auto-punch-out',
        at: closeAt,
        source: 'system',
        sessionNumber: openIdx + 1,
        lat: verdict.evidence.medoidLat,
        lng: verdict.evidence.medoidLng,
        distanceFromBranch: verdict.evidence.distanceM,
        closeReason: 'auto_geofence',
    });

    return { at: closeAt };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Replaying the engine over a late-arriving backlog
// ─────────────────────────────────────────────────────────────────────────────

/** How far apart replayed evaluations sit. Matches the live 45s sync tick. */
const REPLAY_TICK_MS = Number(process.env.GEOFENCE_REPLAY_TICK_MS) || 45 * 1000;

/**
 * Ceiling on replayed evaluations, ~90 minutes of backlog at the tick above.
 *
 * A phone that was off for two days would otherwise walk thousands of
 * evaluations, each doing several queries, inside one upload request.
 */
const REPLAY_MAX_STEPS = Number(process.env.GEOFENCE_REPLAY_MAX_STEPS) || 120;

/**
 * Re-run the engine across the period a backlog describes.
 *
 * An employee who leaves the fence while their phone has no signal is invisible
 * to the live engine: the fixes proving they left only arrive once they are
 * back, and by then `MAX_FIX_AGE_MS` (correctly) rejects them as stale. One
 * real case: out to 415 m for 12.7 minutes, every fix delivered in a single
 * batch 9-24 minutes late, not one audit row written.
 *
 * Rather than relax that staleness gate -- which exists so a backlog can never
 * punch out somebody who is visibly back at their desk -- this replays the
 * SAME engine at the instants the evidence is actually about. `evaluateExit`
 * derives its entire window from `now` (`windowStart = now - WINDOW_MS`, the
 * age gate, the grace period) and only ever looks at fixes at or before it, so
 * evaluating at a past instant sees exactly what the live engine would have
 * seen then, and nothing it could not have known.
 *
 * That is the whole point: no second implementation of "did they leave", no
 * separate thresholds to keep in step. The same judge, shown the evidence at
 * the time it describes.
 *
 * Stepping rather than evaluating once is required, not cosmetic: a closure
 * needs GEOFENCE_CONFIRMATIONS rounds advanced by genuinely new fixes and
 * separated by MIN_CONFIRMATION_SPAN_MS, which a single call can never satisfy.
 */
async function replayEmployee({ adminId, employeeId, from, to }) {
    const startMs = new Date(from).getTime();
    const endMs = new Date(to).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
        return { steps: 0, closed: false, reopened: false };
    }

    let closedAt = null;
    let steps = 0;
    let truncated = false;

    for (let t = startMs; t <= endMs; t += REPLAY_TICK_MS) {
        if (steps >= REPLAY_MAX_STEPS) { truncated = true; break; }
        steps += 1;

        // Not wrapped per-step on purpose: if one evaluation throws, the
        // sequence after it is built on a state we no longer understand, and
        // guessing our way forward is worse than stopping.
        const result = await evaluateEmployee({ adminId, employeeId, now: new Date(t) });

        if (result?.closed) {
            closedAt = result.closedAt || new Date(t);
            break; // the session is shut; anything later belongs to the return
        }
        // Nothing left to decide for this session.
        if (result?.skipped && result.reason === 'already_closed') break;
    }

    if (truncated) {
        console.warn(
            `[geofence] replay hit the ${REPLAY_MAX_STEPS}-step cap for employee ${employeeId}; ` +
            'backlog older than the cap was not replayed',
        );
    }

    const reopened = closedAt
        ? await reopenOnReturn({ adminId, employeeId, closedAt, until: new Date(endMs) })
        : false;

    return { steps, closed: !!closedAt, closedAt, reopened, truncated };
}

/**
 * Start a new session where the backlog shows the employee came back.
 *
 * Closing without this is the expensive half of the same mistake the engine is
 * built to avoid. The replay establishes that somebody left at 15:57 -- but the
 * same backlog usually shows them back at their desk at 16:13, and they have
 * been working ever since. Ending the day at 15:57 and stopping there would
 * take those hours off them for a return we can see in the record.
 *
 * Both edges come from real fixes. The close is the last demonstrably-inside
 * moment; this is the first demonstrably-inside moment after it.
 */
async function reopenOnReturn({ adminId, employeeId, closedAt, until }) {
    const attendance = await Attendance.findOne({
        adminId, employeeId,
        date: { $gte: istStartOfDay(closedAt), $lte: istEndOfDay(closedAt) },
    });
    if (!attendance) return false;

    // Someone punched in again themselves in the meantime — the real thing
    // always wins over a reconstruction.
    if (openSessionIndex(attendance) !== -1) return false;

    const sessions = attendance.shifts || [];
    if (sessions.length >= MAX_SESSIONS) {
        console.warn(`[geofence] replay: session cap reached for ${employeeId}, not reopening`);
        return false;
    }

    const [user, settings] = await Promise.all([
        User.findById(employeeId).populate('shiftId branchId branchIds').lean(),
        Settings.findOne({ adminId }).lean(),
    ]);
    if (!user) return false;

    const branches = [user.branchId, ...(user.branchIds || [])].filter(Boolean);
    if (!branches.length) return false;

    const fixes = await Tracking.find({
        adminId, employeeId,
        timestamp: { $gt: new Date(closedAt), $lte: new Date(until) },
        cached: { $ne: true },
    }).sort({ timestamp: 1 }).lean();

    // The same trustworthiness bar the decision to close had to clear. A return
    // established by a reading we would not have punched someone out on is not
    // established at all.
    const fallbackRadius = settings?.attendance?.officeRadius || 3000;
    const back = fixes.find((f) => {
        // Takes the accuracy, not the fix — same call shape geofence_window
        // uses. Passing the object would be truthy for every reading and the
        // accuracy gate would silently never apply.
        if (!isTrustworthyFix(f.accuracy)) return false;
        const { distance, radius } = nearestBranchDistance(
            f.latitude, f.longitude, branches, fallbackRadius,
        );
        return distance != null && distance <= radius;
    });
    if (!back) return false;

    attendance.shifts.push({
        punchIn: new Date(back.timestamp),
        punchOut: null,
        punchInSource: 'system',
        punchInCoordinates: { lat: back.latitude, lng: back.longitude },
        punchInAccuracy: back.accuracy ?? null,
    });

    const note = ' | Session reopened from offline history (employee returned)';
    if (!String(attendance.remarks || '').includes(note.trim())) {
        attendance.remarks = (attendance.remarks || '') + note;
    }

    syncRootPunchOut(attendance);
    await attendance.save();

    logAttendanceEvent({
        adminId, employeeId,
        type: 'punch-in',
        at: new Date(back.timestamp),
        source: 'system',
        sessionNumber: attendance.shifts.length,
    });

    return true;
}

module.exports = {
    evaluateEmployee,
    closeSession,
    recordAudit,
    replayEmployee,
    REPLAY_TICK_MS,
    REPLAY_MAX_STEPS,
};
