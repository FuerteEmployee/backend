const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const GeofenceAudit = require('../models/GeofenceAudit');
const Settings = require('../models/Settings');
const User = require('../models/User');
const { istStartOfDay, istEndOfDay, istDateKey } = require('../utils/attendance_helpers');
const { computeWorkedMs, computeSessionWorkMs, gradeDay } = require('../utils/shift_status');
const { logAttendanceEvent } = require('../utils/attendance_event_logger');

// ─────────────────────────────────────────────────────────────────────────────
// Admin-facing surface for the geofence engine: the audit trail, the promotion
// gate, and the undo.
//
// The undo is the important one, and it deliberately ships BEFORE the engine is
// ever allowed to close a real session. A feature that acts on someone's behalf
// without a one-click reversal puts the admin in the position of editing
// punch times by hand to repair a decision the software made -- which is both
// slower than the mistake and impossible to audit afterwards.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/geofence/audit?employeeId=&date=YYYY-MM-DD
 *
 * Every decision the engine took, including the ones where it did nothing.
 * The abstentions are the point: they are how you tell a correctly-cautious
 * engine apart from one that is silently broken.
 */
exports.getAudit = async (req, res) => {
    try {
        const { employeeId, date, decision, limit } = req.query;
        const query = { adminId: new mongoose.Types.ObjectId(req.adminId) };

        if (employeeId) query.employeeId = new mongoose.Types.ObjectId(employeeId);
        if (date) query.dayKey = date;
        if (decision) query.decision = decision;

        const rows = await GeofenceAudit.find(query)
            .populate('employeeId', 'name phone')
            .populate('branchId', 'branchName')
            .sort({ createdAt: -1 })
            .limit(Math.min(Number(limit) || 200, 1000))
            .lean();

        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * GET /api/geofence/shadow-report?days=14
 *
 * What WOULD have happened, and whether the tenant has earned the right to arm
 * the engine for real.
 *
 * The promotion criteria are deliberately stated as numbers rather than left to
 * judgement, because the failure mode here is social: somebody sees the feature
 * working in a demo, flips it on, and discovers the thresholds were wrong by
 * taking money off a payslip. `readyToArm` is the answer to "have we actually
 * watched this long enough".
 */
exports.getShadowReport = async (req, res) => {
    try {
        const days = Math.min(Number(req.query.days) || 14, 90);
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const adminId = new mongoose.Types.ObjectId(req.adminId);

        const rows = await GeofenceAudit.find({ adminId, createdAt: { $gte: since } })
            .populate('employeeId', 'name')
            .lean();

        const byReason = {};
        for (const r of rows) byReason[r.reason] = (byReason[r.reason] || 0) + 1;

        const wouldHaveClosed = rows.filter((r) => r.decision === 'punched_out');
        const distinctEmployees = new Set(rows.map((r) => String(r.employeeId?._id || r.employeeId)));
        const distinctDays = new Set(rows.map((r) => r.dayKey));

        // A decision taken on a fix that was already stale is the classic shape
        // of a wrong auto punch-out, so it is surfaced separately rather than
        // buried in the totals.
        const staleDecisions = wouldHaveClosed.filter((r) => (r.newestFixAgeMs || 0) > 5 * 60 * 1000);

        const settings = await Settings.findOne({ adminId }).lean();
        const cfg = settings?.attendance?.geofenceAutoPunchOut || {};

        // Every criterion must hold. These are the numbers the promotion gate
        // in updateAutoPunchOutMode enforces -- the report and the gate must
        // never disagree, so both read this same object.
        const criteria = {
            observedDays: { value: distinctDays.size, required: 7, ok: distinctDays.size >= 7 },
            employeesSeen: { value: distinctEmployees.size, required: 3, ok: distinctEmployees.size >= 3 },
            decisionsRecorded: { value: rows.length, required: 50, ok: rows.length >= 50 },
            wouldHaveClosed: {
                value: wouldHaveClosed.length,
                required: 1,
                ok: wouldHaveClosed.length >= 1,
                note: 'At least one real exit must have been detected, or nothing has been proven except that the engine is quiet.',
            },
            noStaleDecisions: {
                value: staleDecisions.length,
                required: 0,
                ok: staleDecisions.length === 0,
                note: 'A closure decided on a fix older than 5 minutes is the classic wrong auto punch-out.',
            },
        };

        res.json({
            windowDays: days,
            // There is no engine-level 'off' any more (see the P0 fix in
            // geofence_engine.js): every tenant is evaluated and every
            // decision recorded, specifically so the criteria below are
            // always answerable without an admin first blindly opting in.
            // `enabled` alone no longer distinguishes anything at this layer
            // -- only `enabled && !shadowMode` (armed for real) does.
            mode: cfg.enabled === true && cfg.shadowMode === false ? 'enforcing' : 'shadow',
            totals: {
                decisions: rows.length,
                wouldHaveClosed: wouldHaveClosed.length,
                abstained: rows.filter((r) => r.decision === 'abstained').length,
                inside: rows.filter((r) => r.decision === 'inside').length,
                suppressed: rows.filter((r) => r.decision === 'suppressed').length,
            },
            byReason,
            criteria,
            readyToArm: Object.values(criteria).every((c) => c.ok),
            samples: wouldHaveClosed.slice(0, 25).map((r) => ({
                employee: r.employeeId?.name,
                dayKey: r.dayKey,
                distanceM: r.distanceM,
                thresholdM: r.thresholdM,
                fixes: r.trustworthyFixes,
                distinct: r.distinctPositions,
                fixAgeMs: r.newestFixAgeMs,
                narrative: r.narrative,
            })),
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * PUT /api/geofence/mode   { enabled, shadowMode }
 *
 * The promotion gate.
 *
 * Arming the engine for real is refused unless the shadow evidence supports it.
 * This exists because "shadow mode" as a bare boolean is a config value someone
 * can flip by accident, or in a hurry, or because a demo looked convincing --
 * and the cost of flipping it early is somebody's pay. Turning it back OFF is
 * always allowed instantly: the safe direction never needs a gate.
 */
exports.updateAutoPunchOutMode = async (req, res) => {
    try {
        const { enabled, shadowMode, acknowledgeRisk } = req.body;
        const adminId = new mongoose.Types.ObjectId(req.adminId);

        const settings = await Settings.findOne({ adminId });
        if (!settings) return res.status(404).json({ message: 'Settings not found for this tenant.' });

        const arming = enabled === true && shadowMode === false;
        const currentlyArmed = settings.attendance?.geofenceAutoPunchOut?.shadowMode === false
            && settings.attendance?.geofenceAutoPunchOut?.enabled === true;

        if (arming && !currentlyArmed) {
            const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const rows = await GeofenceAudit.find({ adminId, createdAt: { $gte: since } }).lean();

            const distinctDays = new Set(rows.map((r) => r.dayKey)).size;
            const distinctEmployees = new Set(rows.map((r) => String(r.employeeId))).size;
            const closures = rows.filter((r) => r.decision === 'punched_out');
            const stale = closures.filter((r) => (r.newestFixAgeMs || 0) > 5 * 60 * 1000).length;

            const failures = [];
            if (distinctDays < 7) failures.push(`only ${distinctDays} of the required 7 days observed`);
            if (distinctEmployees < 3) failures.push(`only ${distinctEmployees} of the required 3 employees seen`);
            if (rows.length < 50) failures.push(`only ${rows.length} of the required 50 decisions recorded`);
            if (closures.length < 1) failures.push('no real exit has been detected yet, so nothing has been proven');
            if (stale > 0) failures.push(`${stale} decision(s) rested on a fix older than 5 minutes`);

            if (failures.length && acknowledgeRisk !== true) {
                return res.status(409).json({
                    message: 'The shadow run has not yet met the criteria for enabling automatic punch-out.',
                    failures,
                    hint: 'Review GET /api/geofence/shadow-report. If you accept the risk deliberately, resend with acknowledgeRisk: true.',
                });
            }
        }

        settings.attendance = settings.attendance || {};
        settings.attendance.geofenceAutoPunchOut = {
            enabled: enabled === true,
            // Any value other than an explicit false leaves shadow mode ON.
            // Defaulting the safe way round means a malformed request can never
            // arm the engine by omission.
            shadowMode: shadowMode === false ? false : true,
        };
        await settings.save();

        res.json({ ok: true, autoPunchOut: settings.attendance.geofenceAutoPunchOut });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * POST /api/geofence/revert/:attendanceId
 *
 * Undo an auto punch-out.
 *
 * Two modes, because the two real situations are different:
 *  - reopen  : the employee never left; put them back on duty.
 *  - correct : they did leave, but at a different time; set that time.
 *
 * Either way the day is re-graded through the SAME functions the live punch
 * paths use, so a reverted day cannot end up graded by a third set of rules.
 */
exports.revertAutoPunchOut = async (req, res) => {
    try {
        const { attendanceId } = req.params;
        const { mode = 'reopen', punchOut, reason } = req.body;

        const attendance = await Attendance.findOne({
            _id: attendanceId,
            adminId: new mongoose.Types.ObjectId(req.adminId),
        });
        if (!attendance) return res.status(404).json({ message: 'Attendance record not found.' });

        if (!attendance.autoPunchOut) {
            return res.status(400).json({ message: 'This day was not closed by the geofence engine; nothing to revert.' });
        }

        const sessions = attendance.shifts || [];
        const idx = sessions.findIndex((s) => s.closeReason === 'auto_geofence');
        const session = idx >= 0 ? sessions[idx] : sessions[sessions.length - 1];

        const user = await User.findById(attendance.employeeId).populate('shiftId').lean();
        const settings = await Settings.findOne({ adminId: attendance.adminId }).lean();

        if (mode === 'correct') {
            const when = new Date(punchOut);
            if (Number.isNaN(when.getTime())) {
                return res.status(400).json({ message: 'A valid punchOut time is required to correct the record.' });
            }
            const openedAt = new Date(session?.punchIn || attendance.punchIn);
            if (when < openedAt) {
                return res.status(400).json({ message: 'The punch-out cannot be earlier than the punch-in.' });
            }
            if (session) {
                session.punchOut = when;
                session.closeReason = 'admin';
                session.punchOutSource = 'admin';
            }
            if (idx <= 0) attendance.punchOut = when;
        } else {
            // Reopen: the engine was wrong, the employee never left.
            if (session) {
                session.punchOut = null;
                session.closeReason = null;
                session.punchOutSource = null;
                session.punchOutDistance = null;
                session.punchOutCoordinates = null;
                session.punchOutLocation = null;
                session.workMs = null;
            }
            if (idx <= 0) {
                attendance.punchOut = null;
                attendance.punchOutCoordinates = null;
                attendance.punchOutLocation = null;
                attendance.punchOutDistance = null;
            }
        }

        // Clear the geofence verdict either way -- the day is no longer one the
        // engine decided, and leaving the flag set would keep showing the
        // employee an auto punch-out banner for a decision that was undone.
        attendance.autoPunchOut = false;
        attendance.autoPunchOutReason = null;
        attendance.calculatedDistance = null;
        attendance.geoStatus = null;

        attendance.remarks = String(attendance.remarks || '')
            .replace(' | Auto punch-out (left branch geo-fence)', '')
            .trim() || null;
        const note = ` | Auto punch-out reverted by admin${reason ? `: ${reason}` : ''}`;
        attendance.remarks = (attendance.remarks || '') + note;

        attendance.totalWorkMs = computeWorkedMs(attendance, user?.shiftId, settings);
        for (const s of sessions) s.workMs = computeSessionWorkMs(s, attendance, user?.shiftId);

        // gradeDay returns null while the day is open, which is exactly right
        // for a reopen: an in-progress day has no status to store.
        const grade = gradeDay(attendance, user?.shiftId, settings);
        if (grade) attendance.status = grade;

        await attendance.save();

        logAttendanceEvent({
            adminId: attendance.adminId,
            employeeId: attendance.employeeId,
            type: mode === 'correct' ? 'punch-out' : 'punch-in',
            at: mode === 'correct' ? new Date(punchOut) : (session?.punchIn || attendance.punchIn),
            source: 'admin',
            sessionNumber: (idx >= 0 ? idx : sessions.length - 1) + 1,
            closeReason: 'admin',
        });

        res.json({ ok: true, mode, attendance });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
