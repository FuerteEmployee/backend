const mongoose = require('mongoose');
const Regularization = require('../models/Regularization');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Settings = require('../models/Settings');
const Ticket = require('../models/Ticket');
const { calculateAndSaveSalary } = require('./salary_controller');
const { isLatePunchIn, determineHalfDayStatus, stripGradingRemarks, istStartOfDay, istEndOfDay, istDateKey, istTimeOnDate, parseIstWallClock } = require('../utils/attendance_helpers');
const {
    computeWorkedMs,
    computeSessionWorkMs,
    computeSessionGrossMs,
    syncRootPunchOut,
    gradeDay,
} = require('../utils/shift_status');
const {
    punchOutTarget,
    recordedPunchOut,
    correctionProblem,
    correctionDayEnd,
} = require('../utils/punch_correction');
const { LATE_OUT_MARGIN_MS } = require('../utils/working_day');
const { withEmployeeLock } = require('../utils/employee_lock');

// How far back an EMPLOYEE may reach when requesting their own correction.
// Overridable per tenant via Settings.attendance.correctionWindowDays.
const DEFAULT_CORRECTION_WINDOW_DAYS = 7;

const REQUESTED_TIME_FIELDS = [
    ['requestedPunchIn', 'Punch in'],
    ['requestedPunchOut', 'Punch out'],
    ['requestedLunchInTime', 'Lunch in'],
    ['requestedLunchOutTime', 'Lunch out'],
];
const REQUESTABLE_STATUSES = ['present', 'absent', 'half-day', 'late', 'wfh'];
const MAX_REASON_LENGTH = 500;
const MAX_REMARK_LENGTH = 300;

// The role as re-read from the database by `protect`, not the JWT's copy.
const roleOf = (req) => req.currentUser?.role || req.user?.role;

/**
 * A corrected time must land on the day it corrects, and out must come after
 * in. Returns an error message, or null. Shared by submit and approve, so a
 * request that could never be approved is refused when it is made -- while the
 * employee is still there to fix it -- instead of when the admin clicks Approve.
 */
function requestedTimesProblem(date, reg, shift = null) {
    const dayStart = istStartOfDay(new Date(date));
    // A night shift's day runs past midnight: the 10th's 22:00-06:00 shift
    // ends on the 11th, and that punch-out is still the 10th's. Day shifts
    // (and no shift) keep the plain IST-day bound.
    const dayEnd = correctionDayEnd(date, shift, LATE_OUT_MARGIN_MS);
    for (const [field, label] of REQUESTED_TIME_FIELDS) {
        const v = reg[field];
        if (!v) continue;
        const t = new Date(v);
        if (t < dayStart || t > dayEnd) {
            return `${label} (${t.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}) is not on `
                + `${istDateKey(date)}. A correction must stay on the day it corrects.`;
        }
    }
    const pairs = [
        ['requestedPunchIn', 'requestedPunchOut', 'Punch out must be after punch in'],
        ['requestedLunchInTime', 'requestedLunchOutTime', 'Lunch out must be after lunch in'],
    ];
    for (const [a, b, msg] of pairs) {
        if (reg[a] && reg[b] && new Date(reg[b]) <= new Date(reg[a])) return msg;
    }
    return null;
}

/**
 * Attach what each request's attendance row CURRENTLY says, so a reviewer can
 * see the claim and the thing it would replace side by side.
 *
 * A pending request has no attendanceId yet (it is only linked on approval),
 * so the row has to be found by employee and day. One query for the whole page
 * rather than one per request: this list is the admin's review queue and can
 * be long. Also used by the Tickets page for "Forgot to punch in/out" tickets.
 *
 * `regs` are lean Regularization objects (employeeId may be populated).
 */
async function attachCurrentPunches(regs) {
    if (!regs.length) return [];
    const days = regs.map((r) => ({
        adminId: r.adminId,
        employeeId: r.employeeId?._id || r.employeeId,
        date: { $gte: istStartOfDay(r.date), $lte: istEndOfDay(r.date) },
    }));

    const rows = await Attendance.find({ $or: days })
        .select('employeeId date punchIn punchOut shifts')
        .lean();

    const byKey = new Map();
    for (const a of rows) byKey.set(`${a.employeeId}_${istDateKey(a.date)}`, a);

    return regs.map((r) => {
        const a = byKey.get(`${r.employeeId?._id || r.employeeId}_${istDateKey(r.date)}`);
        const closed = (a?.shifts || []).filter((s) => s?.punchOut);
        const final = closed.sort((x, y) => new Date(y.punchOut) - new Date(x.punchOut))[0];
        return {
            ...r,
            currentPunchIn: a?.punchIn || null,
            currentPunchOut: final?.punchOut || a?.punchOut || null,
            currentCloseReason: final?.closeReason || null,
        };
    });
}

exports.attachCurrentPunches = attachCurrentPunches;

exports.getRegularizations = async (req, res) => {
    try {
        const query = { adminId: new mongoose.Types.ObjectId(req.adminId) };

        if (roleOf(req) === 'employee') {
            query.employeeId = new mongoose.Types.ObjectId(req.userId);
        } else if (req.query.employeeId) {
            if (!mongoose.Types.ObjectId.isValid(String(req.query.employeeId))) {
                return res.status(400).json({ message: 'employeeId is not a valid id' });
            }
            query.employeeId = new mongoose.Types.ObjectId(String(req.query.employeeId));
        }
        if (req.query.status) {
            if (!['pending', 'approved', 'rejected'].includes(String(req.query.status))) {
                return res.status(400).json({ message: 'status must be pending, approved or rejected' });
            }
            query.status = String(req.query.status);
        }

        const regularizations = await Regularization.find(query)
            .populate('employeeId', 'name phone')
            .sort({ createdAt: -1 })
            .lean();

        res.json(await attachCurrentPunches(regularizations));
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * A pending request for the same employee-day that asks about any of the same
 * punches (or a status). `requested` holds the requested* fields, null when
 * not asked.
 */
async function findOverlappingPending(adminId, employeeId, day, requested, requestedStatus = null) {
    const touches = REQUESTED_TIME_FIELDS
        .filter(([f]) => requested[f])
        .map(([f]) => ({ [f]: { $ne: null } }));
    if (requestedStatus) touches.push({ requestedStatus: { $ne: null } });
    if (!touches.length) return null;
    return Regularization.findOne({
        adminId,
        employeeId,
        status: 'pending',
        date: { $gte: istStartOfDay(day), $lte: istEndOfDay(day) },
        $or: touches,
    });
}

/**
 * The employee's attendance row for one IST day, by range (an older row may sit
 * at a non-IST midnight). When there are two -- the duplicate the IST fix was
 * about -- the one with a punch-in wins.
 */
async function findDayRow(adminId, employeeId, day) {
    const rows = await Attendance.find({
        adminId,
        employeeId,
        date: { $gte: istStartOfDay(day), $lte: istEndOfDay(day) },
    }).sort({ date: 1 });
    return rows.find((r) => r.punchIn) || rows[0] || null;
}

exports.findOverlappingPending = findOverlappingPending;
exports.findDayRow = findDayRow;

exports.submitRegularization = async (req, res) => {
    try {
        const isEmployee = roleOf(req) === 'employee';
        const employeeId = isEmployee ? req.userId : req.body.employeeId;
        if (!employeeId) {
            return res.status(400).json({ message: 'Employee ID is required' });
        }
        if (!req.body.date) {
            return res.status(400).json({ message: 'Date is required' });
        }
        const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
        if (!reason) {
            return res.status(400).json({ message: 'Reason is required' });
        }
        if (reason.length > MAX_REASON_LENGTH) {
            return res.status(400).json({ message: `Reason can be at most ${MAX_REASON_LENGTH} characters` });
        }

        const day = istStartOfDay(new Date(req.body.date));
        if (!day || Number.isNaN(day.getTime())) {
            return res.status(400).json({ message: 'Date is not a valid date' });
        }

        // An admin files on someone's behalf, so the id comes from the body --
        // and has to be one of THIS tenant's employees. It was never checked:
        // approving a request filed for another company's employee wrote an
        // attendance row and a salary record for them under this tenant.
        if (!isEmployee && !mongoose.Types.ObjectId.isValid(String(employeeId))) {
            return res.status(400).json({ message: 'Employee ID is not a valid id' });
        }
        // Loaded for everyone now, for the shift: a night shift's punch-out
        // lands on the next calendar day and is still this day's.
        const emp = await User.findOne({ _id: employeeId, adminId: req.adminId, role: 'employee' })
            .select('_id shiftId').populate('shiftId').lean();
        if (!emp) return res.status(404).json({ message: 'Employee not found' });
        const shift = emp.shiftId || null;

        // A requested STATUS is the admin's lever, not the employee's. Approval
        // applies it verbatim ("explicit admin intent wins"), and the review
        // screens do not show it -- so an employee posting requestedStatus
        // 'present' for a day they never worked had it written on approval.
        let requestedStatus = null;
        if (!isEmployee && req.body.requestedStatus) {
            if (!REQUESTABLE_STATUSES.includes(req.body.requestedStatus)) {
                return res.status(400).json({ message: `requestedStatus must be one of: ${REQUESTABLE_STATUSES.join(', ')}` });
            }
            requestedStatus = req.body.requestedStatus;
        }

        const requested = {};
        for (const [field, label] of REQUESTED_TIME_FIELDS) {
            const raw = req.body[field];
            if (raw === undefined || raw === null || raw === '') { requested[field] = null; continue; }
            // Parsed as IST, not left for Mongoose to cast against the host
            // timezone -- see parseIstWallClock. A datetime-local value carries
            // no offset, so casting it on a UTC server shifted every corrected
            // time by 5h30m and pushed late punch-outs onto the next day.
            const when = parseIstWallClock(raw);
            if (!when) return res.status(400).json({ message: `${label} is not a valid time` });
            requested[field] = when;
        }
        if (!requestedStatus && !REQUESTED_TIME_FIELDS.some(([f]) => requested[f])) {
            return res.status(400).json({ message: 'Say what should change: give at least one corrected time.' });
        }
        const timesProblem = requestedTimesProblem(day, requested, shift);
        if (timesProblem) return res.status(400).json({ message: timesProblem });
        const latest = Date.now() + 60 * 1000;
        if (REQUESTED_TIME_FIELDS.some(([f]) => requested[f] && requested[f].getTime() > latest)) {
            return res.status(400).json({ message: 'A corrected time cannot be in the future.' });
        }

        // Both rules below apply to EMPLOYEE self-service only. An admin
        // correcting a six-month-old row, or filing a second request after
        // rejecting the first, is doing their job -- these guards exist to stop
        // an employee quietly rewriting history, not to police the admin.
        if (isEmployee) {
            const settings = await Settings.findOne({ adminId: req.adminId }).lean();
            const windowDays = Number(settings?.attendance?.correctionWindowDays) > 0
                ? Number(settings.attendance.correctionWindowDays)
                : DEFAULT_CORRECTION_WINDOW_DAYS;

            const earliest = istStartOfDay(new Date(Date.now() - (windowDays - 1) * 24 * 60 * 60 * 1000));
            if (day < earliest) {
                return res.status(400).json({
                    message: `Corrections can only be requested for the last ${windowDays} days. Ask your admin to correct older records.`,
                });
            }
            if (day > istEndOfDay(new Date())) {
                return res.status(400).json({ message: 'Cannot request a correction for a future date.' });
            }

            // One open request per day PER FIELD. A second pending row asking
            // about the same punch gives the admin two answers to one
            // question, and whichever they approve second silently overwrites
            // the first. A punch-in request and a punch-out request for the
            // same day touch different fields and are both allowed, which is
            // what "Forgot to punch in" and the missed-punch-out prompt need.
            const existing = await findOverlappingPending(req.adminId, employeeId, day, requested);
            if (existing) {
                return res.status(409).json({
                    message: 'You already have a correction request awaiting approval for this date.',
                });
            }

            // An employee asking to move their ARRIVAL gets the same rules as
            // the "Forgot to punch in" ticket: earlier than the recorded
            // punch-in, not before the shift starts. Without this the ticket's
            // rules could be sidestepped by posting here directly. No existing
            // employee screen sends a punch-in here (the missed-punch-out
            // prompt sends only a punch-out), so no caller changes.
            if (requested.requestedPunchIn) {
                const row = await findDayRow(req.adminId, employeeId, day);
                const problem = correctionProblem({
                    field: 'punchIn',
                    requested: requested.requestedPunchIn,
                    attendance: row,
                    shift,
                    now: new Date(),
                });
                if (problem) return res.status(400).json({ message: problem });
            }
        }

        // The admin's double tap. The rules above are employee-only, so two
        // identical requests from the admin were both stored, and approving the
        // second silently overwrote the first. A repeat of the same request
        // within a minute is the same tap: answer with the one already filed.
        if (!isEmployee) {
            const recent = await findOverlappingPending(req.adminId, employeeId, day, requested, requestedStatus);
            if (recent && Date.now() - new Date(recent.createdAt).getTime() < 60 * 1000) {
                const same = await recent.populate('employeeId', 'name phone');
                return res.status(200).json(same);
            }
        }

        const regularization = await Regularization.create({
            adminId: req.adminId,
            employeeId,
            submittedBy: req.userId,
            date: day,
            ...requested,
            requestedStatus,
            reason,
        });

        const populated = await regularization.populate('employeeId', 'name phone');
        res.status(201).json(populated);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const reply = (code, payload) => ({ code, payload });

// How long a decision claim holds. Long enough for any approval (a few
// queries), short enough that a crashed request cannot lock a correction for
// good: a stale claim is simply taken over.
const CLAIM_TTL_MS = 2 * 60 * 1000;

/**
 * Atomically mark a pending request as being decided, using `reviewedAt` as the
 * lock (it is null until a decision). Returns the claim time, or null when
 * someone else holds a fresh claim.
 */
async function claimForDecision(regularization) {
    const now = new Date();
    const res = await Regularization.updateOne(
        {
            _id: regularization._id,
            status: 'pending',
            $or: [{ reviewedAt: null }, { reviewedAt: { $lt: new Date(now.getTime() - CLAIM_TTL_MS) } }],
        },
        { $set: { reviewedAt: now } },
    );
    return res.modifiedCount ? now : null;
}

/** Undo a claim when the decision did not go through (a validation refusal). */
async function releaseClaim(regularization, claimedAt) {
    try {
        await Regularization.updateOne(
            { _id: regularization._id, status: 'pending', reviewedAt: claimedAt },
            { $set: { reviewedAt: null } },
        );
    } catch (err) {
        console.error('Regularization claim release error:', err);
    }
}

/**
 * Mirror a decision onto the "Forgot to punch in/out" ticket the request came
 * from, so deciding on either page updates the other. The employee reads the
 * ticket: its status, the admin's remark, and the time actually applied (the
 * admin may have approved with an edited time).
 *
 * A failure here must not undo an approval that has already been written, so
 * it is logged rather than thrown.
 */
async function syncLinkedTicket(regularization) {
    if (!regularization.ticketId) return;
    try {
        const ticket = await Ticket.findOne({ _id: regularization.ticketId, adminId: regularization.adminId });
        if (!ticket) return;
        ticket.status = regularization.status;
        ticket.adminRemark = regularization.adminRemark || undefined;
        if (regularization.status === 'approved' && ticket.correction?.field) {
            ticket.correction.appliedTime = ticket.correction.field === 'punchIn'
                ? regularization.requestedPunchIn
                : regularization.requestedPunchOut;
        }
        await ticket.save();
    } catch (err) {
        console.error('Regularization -> ticket sync error:', err);
    }
}

async function approveCore(req, id, body = {}) {
    try {
        if (!mongoose.Types.ObjectId.isValid(String(id))) {
            return reply(404, { message: 'Regularization request not found' });
        }
        const adminRemark = typeof body.adminRemark === 'string' ? body.adminRemark.trim() : '';
        if (adminRemark.length > MAX_REMARK_LENGTH) {
            return reply(400, { message: `Remark can be at most ${MAX_REMARK_LENGTH} characters` });
        }
        const regularization = await Regularization.findOne({
            _id: id,
            adminId: req.adminId,
        });
        if (!regularization) return reply(404, { message: 'Regularization request not found' });
        if (regularization.status !== 'pending') {
            return reply(400, { message: `This request was already ${regularization.status}.` });
        }

        // One decision at a time. A correction can now be decided from two
        // pages (Tickets and Attendance -> Corrections), so two admins can
        // click at once; without a claim both approvals would write the day,
        // or one would approve while the other rejects. See claimForDecision.
        const claimedAt = await claimForDecision(regularization);
        if (!claimedAt) return reply(409, { message: 'Someone else is deciding this request right now. Please refresh.' });
        let decided = false;
        try {

            // Approve-with-an-edit. An admin who knows the employee left at 18:45
            // should not have to reject a request for 19:00 and ask them to file it
            // again. The employee's original claim is not lost: it stays on the
            // request until this overwrites it, and the value that was actually
            // applied is the one the audit then shows.
            for (const field of ['requestedPunchIn', 'requestedPunchOut', 'requestedLunchInTime', 'requestedLunchOutTime']) {
                if (body[field]) {
                    const when = parseIstWallClock(body[field]);
                    if (!when) {
                        return reply(400, { message: `${field} is not a valid time` });
                    }
                    regularization[field] = when;
                }
            }
            if (body.requestedStatus) {
                if (!REQUESTABLE_STATUSES.includes(body.requestedStatus)) {
                    return reply(400, { message: `requestedStatus must be one of: ${REQUESTABLE_STATUSES.join(', ')}` });
                }
                regularization.requestedStatus = body.requestedStatus;
            }

            // A corrected time must land on the day it corrects, and out must come
            // after in.
            //
            // Approval writes punchIn/punchOut DIRECTLY onto the attendance row
            // (this path deliberately bypasses punchIn()/punchOut()), and the only
            // validation was `Number.isNaN` -- i.e. "does it parse". Three requests
            // pending on 2026-09-17 asked for a punch-out at IST midnight of the
            // FOLLOWING day, and one at 01:00 the day after that. Approving any of
            // them would have stored a punch-out ~24h after the punch-in. The shift
            // clamp bounds the pay damage, but the stored day is then simply wrong
            // and gradeDay runs on it.
            const [user, settings] = await Promise.all([
                // Tenant-scoped: a request filed for another company's employee
                // (possible before submit checked the id) must not be applied here.
                User.findOne({ _id: regularization.employeeId, adminId: req.adminId }).populate('shiftId'),
                Settings.findOne({ adminId: req.adminId }),
            ]);
            if (!user) return reply(404, { message: 'That employee is not in your company.' });

            {
                // The shift, so a night shift's after-midnight punch-out is still
                // accepted as this day's.
                const problem = requestedTimesProblem(regularization.date, regularization, user.shiftId);
                if (problem) return reply(400, { message: problem });
            }

            // Match by same-day range, not exact equality: regularization.date may
            // have been persisted by pre-IST-fix code (local/UTC midnight) while
            // the real Attendance record is bucketed at IST midnight — an exact
            // match would miss it and create a duplicate record for the day.
            const regDayStart = istStartOfDay(regularization.date);

            let attendance = await findDayRow(req.adminId, regularization.employeeId, regularization.date);
            if (!attendance) {
                attendance = new Attendance({
                    adminId: req.adminId,
                    employeeId: regularization.employeeId,
                    date: regDayStart,
                });
            }

            // Write through to shifts[], not just the root.
            //
            // allSessions() treats shifts[] as authoritative the moment it is
            // populated and ignores the root entirely. Assigning only the root --
            // which is what this did -- left the session still holding the old
            // system-written time, so on every modern row the approved correction
            // was computed away and PAYROLL NEVER SAW IT. The admin watched the
            // request go green and nothing changed.
            const sessions = attendance.shifts || [];
            // The session a PUNCH-OUT correction is about: the one the system
            // closed, else the day's final session. Never by array index --
            // shifts[] is not stored in chronological order.
            // Shared with the ticket's submit-time check (utils/punch_correction).
            const target = punchOutTarget(attendance);

            // Snapshot what we are about to overwrite, before overwriting it.
            if (regularization.requestedPunchOut && !regularization.originalPunchOut) {
                regularization.originalPunchOut = recordedPunchOut(attendance);
            }
            if (regularization.requestedPunchIn && !regularization.originalPunchIn) {
                regularization.originalPunchIn = attendance.punchIn || null;
            }

            // The day's own record of what changed, from what, and who said so.
            // Built before anything is overwritten. Pay reads only the punch
            // fields; this is kept for reference and shown, never paid from.
            const approvedAt = new Date();
            const correctionLog = [];
            const logChange = (field, from, to) => {
                if (!to) return;
                if (from && new Date(from).getTime() === new Date(to).getTime()) return;
                correctionLog.push({
                    field,
                    from: from || null,
                    to,
                    regularizationId: regularization._id,
                    approvedBy: req.userId,
                    approvedByName: req.currentUser?.name || null,
                    approvedAt,
                });
            };
            logChange('punchIn', attendance.punchIn, regularization.requestedPunchIn);
            logChange('punchOut', recordedPunchOut(attendance), regularization.requestedPunchOut);
            logChange('lunchInTime', attendance.lunchInTime, regularization.requestedLunchInTime);
            logChange('lunchOutTime', attendance.lunchOutTime, regularization.requestedLunchOutTime);

            if (regularization.requestedLunchInTime) attendance.lunchInTime = regularization.requestedLunchInTime;
            if (regularization.requestedLunchOutTime) attendance.lunchOutTime = regularization.requestedLunchOutTime;

            if (regularization.requestedPunchIn) {
                attendance.punchIn = regularization.requestedPunchIn;
                // A punch-IN correction is about the day's arrival, which is what
                // the root punchIn holds: the EARLIEST session. It used to go to
                // the punch-out target (the last session), so on a two-session day
                // the root said 09:30 while session 1 kept the old time and session
                // 2 started at 09:30 -- the hours were computed from neither.
                const first = sessions.filter((s) => s && s.punchIn)
                    .sort((a, b) => new Date(a.punchIn) - new Date(b.punchIn))[0];
                if (first) first.punchIn = regularization.requestedPunchIn;
            }
            if (regularization.requestedPunchOut) {
                if (target) {
                    target.punchOut = regularization.requestedPunchOut;
                    // It is no longer a system guess, so stop it reading as one --
                    // otherwise the day keeps showing the "auto-closed at shift end"
                    // marker after a human has corrected and approved it.
                    target.closeReason = 'regularized';
                    target.punchOutSource = 'admin';
                }
                if (!sessions.length) attendance.punchOut = regularization.requestedPunchOut;
            }
            if (sessions.length) syncRootPunchOut(attendance);

            // A requested punch-in after the punch-out already on the day (or the
            // reverse) validated on its own but produced a negative session.
            for (const s of sessions) {
                if (s && s.punchIn && s.punchOut && new Date(s.punchOut) <= new Date(s.punchIn)) {
                    return reply(400, { message: 'That correction would end a session before it starts. Check the punch in and punch out times.' });
                }
            }
            if (!sessions.length && attendance.punchIn && attendance.punchOut && attendance.punchOut <= attendance.punchIn) {
                return reply(400, { message: 'Punch out must be after punch in' });
            }

            // An approved time is explicit. Device day-reconciliation must stop
            // treating these fields as its own, or the next terminal tap re-derives
            // them and silently undoes the approval.
            const corrected = [
                regularization.requestedPunchIn && 'punchIn',
                regularization.requestedPunchOut && 'punchOut',
                regularization.requestedLunchInTime && 'lunchInTime',
                regularization.requestedLunchOutTime && 'lunchOutTime',
            ].filter(Boolean);
            attendance.derivedFields = (attendance.derivedFields || []).filter((f) => !corrected.includes(f));
            if (regularization.requestedPunchOut) attendance.punchOutIsProvisional = false;

            // Same arithmetic as every other close path. This was a raw
            // punchOut - punchIn, which ignored lunch, the shift clamp and every
            // session but the first, so a regularized day disagreed with an
            // identical day closed any other way.
            attendance.totalWorkMs = computeWorkedMs(attendance, user?.shiftId, settings);
            for (const s of sessions) {
                s.workMs = computeSessionWorkMs(s, attendance, user?.shiftId);
                s.grossMs = computeSessionGrossMs(s);
            }

            if (regularization.requestedStatus) {
                // Explicit admin intent always wins over the derived calculation.
                attendance.status = regularization.requestedStatus;
            } else if (attendance.punchIn) {
                const wasLate = user?.shiftId ? isLatePunchIn(attendance.punchIn, user.shiftId, settings) : false;
                // Re-derived when the arrival itself was corrected: moving a 09:50
                // punch-in to 09:30 must stop the day reading as late.
                if (regularization.requestedPunchIn) attendance.wasLate = wasLate;
                else if (wasLate) attendance.wasLate = true;

                if (attendance.punchOut) {
                    const { status, remarksAppend } = determineHalfDayStatus({
                        punchIn: attendance.punchIn,
                        punchOut: attendance.punchOut,
                        totalWorkMs: attendance.totalWorkMs,
                        lunchInTime: attendance.lunchInTime,
                        lunchOutTime: attendance.lunchOutTime,
                        isWFH: attendance.isWFH,
                        shift: user?.shiftId,
                    }, settings);
                    attendance.status = status;
                    // The approved correction changes the times the grade was
                    // derived from, so the previous grade's remarks no longer
                    // describe this day. Everything a human wrote survives.
                    attendance.remarks = stripGradingRemarks(attendance.remarks);
                    if (status === 'half-day' && remarksAppend) attendance.remarks = (attendance.remarks || '') + remarksAppend;
                    // The punch-out path's hours-across-sessions downgrade, which this
                    // path skipped -- so a corrected multi-session day could grade
                    // 'present' here and 'half-day' had it closed normally.
                    const hoursGrade = gradeDay(attendance, user?.shiftId, settings);
                    if (hoursGrade === 'half-day' && attendance.status === 'present') {
                        attendance.status = 'half-day';
                        const note = ' | Short hours across sessions';
                        if (!String(attendance.remarks || '').includes(note.trim())) attendance.remarks = (attendance.remarks || '') + note;
                    }
                } else {
                    // Punch-in regularized, no punch-out yet: the day is still OPEN
                    // and therefore has no final grade.
                    //
                    // This used to force 'half-day' whenever the punch-in was past
                    // `halfDayLatePunchInMin`. That was the last copy of the rule
                    // that a late arrival is half a day by itself, which it no
                    // longer is -- the day is graded on hours against the shift's
                    // bar when it closes, and those hours are not knowable yet.
                    // Writing a verdict here would be a guess that the close then
                    // has to overturn, and `gradeDay` deliberately returns null for
                    // an open day for exactly this reason.
                    //
                    // 'late' is not a verdict, it is an observation about the
                    // arrival, and it survives the close via `wasLate`.
                    attendance.status = wasLate ? 'late' : 'present';
                }
            }

            attendance.remarks = (attendance.remarks ? attendance.remarks + ' | ' : '') + `Regularized: ${regularization.reason}`;
            for (const entry of correctionLog) attendance.corrections.push(entry);
            await attendance.save();

            regularization.status = 'approved';
            regularization.adminRemark = adminRemark || regularization.adminRemark;
            regularization.reviewedBy = req.userId;
            regularization.reviewedAt = approvedAt;
            regularization.attendanceId = attendance._id;
            await regularization.save();
            decided = true;

            await syncLinkedTicket(regularization);
            const populated = await regularization.populate('employeeId', 'name phone');

            if (user) {
                // The IST month. regularization.date is IST midnight -- 18:30 UTC the
                // day before -- so getMonth() on a UTC host named the PREVIOUS
                // month for a correction on the 1st, re-synced the wrong payslip and
                // left the right one stale.
                const [y, m] = istDateKey(regularization.date).split('-').map(Number);
                calculateAndSaveSalary(req.adminId, user, m, y).catch(err => {
                    console.error('Regularization approval salary sync error:', err);
                });
            }
            return reply(200, populated);
        } finally {
            if (!decided) await releaseClaim(regularization, claimedAt);
        }
    } catch (error) {
        return reply(500, { message: error.message });
    }
}

async function rejectCore(req, id, body = {}) {
    try {
        if (!mongoose.Types.ObjectId.isValid(String(id))) {
            return reply(404, { message: 'Regularization request not found' });
        }
        const adminRemark = typeof body.adminRemark === 'string' ? body.adminRemark.trim() : '';
        if (adminRemark.length > MAX_REMARK_LENGTH) {
            return reply(400, { message: `Reason can be at most ${MAX_REMARK_LENGTH} characters` });
        }
        const regularization = await Regularization.findOne({
            _id: id,
            adminId: req.adminId,
        });
        if (!regularization) return reply(404, { message: 'Regularization request not found' });
        if (regularization.status !== 'pending') {
            return reply(400, { message: `This request was already ${regularization.status}.` });
        }
        const claimedAt = await claimForDecision(regularization);
        if (!claimedAt) return reply(409, { message: 'Someone else is deciding this request right now. Please refresh.' });

        regularization.status = 'rejected';
        regularization.adminRemark = adminRemark || regularization.adminRemark;
        regularization.reviewedBy = req.userId;
        regularization.reviewedAt = new Date();
        try {
            await regularization.save();
        } catch (err) {
            await releaseClaim(regularization, claimedAt);
            throw err;
        }

        await syncLinkedTicket(regularization);
        const populated = await regularization.populate('employeeId', 'name phone');
        return reply(200, populated);
    } catch (error) {
        return reply(500, { message: error.message });
    }
}


/**
 * The express handlers are thin wrappers so the Tickets page can run the SAME
 * decision (ticket_controller calls approveCore / rejectCore) -- there is one
 * copy of the grading, not two.
 */
// One person's correction requests run one at a time, keyed on the person the
// request is FOR: two same-instant taps used to both pass the pending check
// above and store two requests, and an admin filing on someone's behalf could
// race that person. The key matches the "Forgot to punch" ticket's lock
// (ticket_controller createTicket, scope 'create'), so the two paths queue too.
const submitUnlocked = exports.submitRegularization;
exports.submitRegularization = (req, res, next) => {
    const target = roleOf(req) === 'employee' ? req.userId : req.body?.employeeId;
    if (!target) return submitUnlocked(req, res, next);
    return withEmployeeLock(`create:${target}`, () => submitUnlocked(req, res, next));
};

exports.approveCore = approveCore;
exports.rejectCore = rejectCore;

exports.approveRegularization = async (req, res) => {
    const r = await approveCore(req, req.params.id, req.body || {});
    res.status(r.code).json(r.payload);
};

exports.rejectRegularization = async (req, res) => {
    const r = await rejectCore(req, req.params.id, req.body || {});
    res.status(r.code).json(r.payload);
};
