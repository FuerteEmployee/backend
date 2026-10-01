const mongoose = require('mongoose');
const Ticket = require('../models/Ticket');
const Regularization = require('../models/Regularization');
const Subscription = require('../models/Subscription');
const Settings = require('../models/Settings');
const User = require('../models/User');
const { istDateKey, istMonthRange, istStartOfDay, istEndOfDay } = require('../utils/attendance_helpers');
const {
    fmtDay,
    dayFromKey,
    occurrenceOnDay,
    correctionInstant,
    punchOutTarget,
    recordedPunchOut,
    windowProblem,
    correctionProblem,
} = require('../utils/punch_correction');
const {
    approveCore,
    rejectCore,
    attachCurrentPunches,
    findOverlappingPending,
    findDayRow,
} = require('./regularization_controller');

// What an employee may raise. 'Leave' and 'Correction' are legacy -- the
// portal no longer offers them -- but older installed builds may still send
// them, so they stay accepted. Old Correction tickets still display.
const EMPLOYEE_TICKET_TYPES = ['Query', 'Complaint', 'Correction', 'Leave'];
// "Forgot to punch in / out": a ticket that is also an attendance correction.
const CORRECTION_TYPES = {
    ForgotPunchIn: { field: 'punchIn', requestedField: 'requestedPunchIn', label: 'Forgot to punch in' },
    ForgotPunchOut: { field: 'punchOut', requestedField: 'requestedPunchOut', label: 'Forgot to punch out' },
};
const MAX_REASON_LENGTH = 2000;
// A correction's reason is the Regularization's reason, and the admin reads it
// in the Corrections queue -- same cap as the reject remark there.
const MAX_CORRECTION_REASON = 300;
const MAX_REMARK_LENGTH = 1000;
const DEFAULT_CORRECTION_WINDOW_DAYS = 7;
const TICKET_STATUSES = ['pending', 'approved', 'rejected'];

// The role as re-read from the database by `protect`, not the JWT's copy.
const roleOf = (req) => req.currentUser?.role || req.user?.role;
const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id)) && /^[a-f0-9]{24}$/i.test(String(id));

// The routes' checkPermission() restricts sub-admins only; employees pass
// straight through it. Answering and deleting tickets is HR's side of the
// desk, so it is refused here -- otherwise an employee could mark their own
// ticket "Resolved" with a remark of their choosing, or delete a co-worker's.
function refuseEmployee(req, res) {
    if (roleOf(req) !== 'employee') return false;
    res.status(403).json({ message: 'Only HR or an admin can answer or remove tickets.' });
    return true;
}

// Deciding a correction rewrites attendance and pay, which the Attendance
// module's own route guards with attendance.edit. The Tickets page must not be
// a way round that for a sub-admin who only holds tickets.edit.
function refuseWithoutAttendanceEdit(req, res) {
    if (roleOf(req) !== 'subadmin') return false;
    if (req.currentUser?.permissions?.attendance?.edit) return false;
    res.status(403).json({ message: 'Access denied: approving a punch correction needs edit permission for attendance' });
    return true;
}

function correctionWindowDays(settings) {
    return Number(settings?.attendance?.correctionWindowDays) > 0
        ? Number(settings.attendance.correctionWindowDays)
        : DEFAULT_CORRECTION_WINDOW_DAYS;
}

/** 400 when the tenant's plan caps tickets at 50 a month and this month is full. */
async function monthlyLimitReached(adminId) {
    if (!adminId) return false;
    const subscription = await Subscription.findOne({ adminId }).populate('planId');
    if (!subscription || !subscription.planId) return false;
    const limitVal = subscription.planId.modules?.get?.('tickets') ?? subscription.planId.modules?.['tickets'];
    // Only the '50/mo' option carries a cap. The value is not guaranteed to be
    // a string -- a plan built before the select existed stores a boolean --
    // and calling .includes on `true` threw, which refused EVERY ticket with
    // "limitVal.includes is not a function" shown to the employee.
    if (!(typeof limitVal === 'string' && limitVal.includes('50'))) return false;
    // The IST month, not the server's: on a UTC host the old boundary started
    // the month at 05:30 IST on the 1st.
    const [y, m] = istDateKey().split('-').map(Number);
    const { start: startOfMonth } = istMonthRange(y, m);
    const currentCount = await Ticket.countDocuments({
        adminId,
        createdAt: { $gte: startOfMonth },
        // Punch corrections do not use up the helpdesk allowance: the
        // missed-punch-out prompt files the same kind of request with no cap,
        // and a full helpdesk must not stop someone fixing their attendance.
        type: { $nin: Object.keys(CORRECTION_TYPES) },
    });
    return currentCount >= 50;
}

/**
 * What the new-ticket form needs to explain the rules for one day: the
 * recorded punches, the shift window, the allowed range of days, and whether a
 * request is already waiting. The caller's own day only (req.userId).
 */
exports.getCorrectionContext = async (req, res) => {
    try {
        if (roleOf(req) !== 'employee') {
            return res.status(403).json({ message: 'Only employees can ask to fix their punches.' });
        }
        const now = new Date();
        const settings = await Settings.findOne({ adminId: req.adminId }).lean();
        const windowDays = correctionWindowDays(settings);
        const today = istDateKey(now);
        const earliest = istDateKey(new Date(now.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000));

        const dayKey = typeof req.query.date === 'string' ? req.query.date : today;
        const day = dayFromKey(dayKey);
        if (!day) return res.status(400).json({ message: 'Please pick a day.' });

        const me = await User.findOne({ _id: req.userId, adminId: req.adminId })
            .select('shiftId').populate('shiftId', 'name startTime endTime').lean();
        const shift = me?.shiftId || null;
        const occ = occurrenceOnDay(shift, day);
        const row = await findDayRow(req.adminId, req.userId, day);
        const target = row ? punchOutTarget(row) : null;

        const pending = await Regularization.find({
            adminId: req.adminId,
            employeeId: req.userId,
            status: 'pending',
            date: { $gte: istStartOfDay(day), $lte: istEndOfDay(day) },
        }).select('requestedPunchIn requestedPunchOut').lean();

        res.json({
            date: dayKey,
            today,
            earliest,
            windowDays,
            now,
            outOfWindow: windowProblem(day, now, windowDays),
            hasAttendance: !!row,
            punchIn: row?.punchIn || null,
            punchOut: row ? recordedPunchOut(row) : null,
            // The punch-out must come after THIS (the session it corrects).
            lastSessionPunchIn: target?.punchIn || row?.punchIn || null,
            lunchOutTime: row?.lunchOutTime || null,
            shift: shift && occ
                ? {
                    name: shift.name,
                    startTime: shift.startTime,
                    endTime: shift.endTime,
                    overnight: occ.overnight,
                    start: occ.start,
                    end: occ.end,
                }
                : null,
            pendingPunchIn: pending.some((p) => p.requestedPunchIn),
            pendingPunchOut: pending.some((p) => p.requestedPunchOut),
        });
    } catch (error) {
        console.error('getCorrectionContext error:', error);
        res.status(500).json({ message: 'Could not load this day. Please try again.' });
    }
};

/**
 * "Forgot to punch in / Forgot to punch out".
 *
 * Creates the Regularization that an admin approves (through the one
 * approveRegularization path, from either page) and a Ticket that is the
 * employee's view of it, linked both ways. The rules live in
 * utils/punch_correction.js; this only gathers the facts and stores.
 */
async function createCorrectionTicket(req, res, type) {
    const spec = CORRECTION_TYPES[type];
    if (roleOf(req) !== 'employee') {
        return res.status(400).json({ message: 'Only employees can raise this kind of ticket.' });
    }
    const dayKey = typeof req.body.date === 'string' ? req.body.date.trim() : '';
    const time = typeof req.body.time === 'string' ? req.body.time.trim() : '';
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (req.body.reason !== undefined && req.body.reason !== null && typeof req.body.reason !== 'string') {
        return res.status(400).json({ message: 'Please write your reason as text.' });
    }
    if (reason.length > MAX_CORRECTION_REASON) {
        return res.status(400).json({ message: `Please keep your reason under ${MAX_CORRECTION_REASON} letters.` });
    }

    const day = dayFromKey(dayKey);
    if (!day) return res.status(400).json({ message: 'Please pick the day.' });

    const now = new Date();
    const [settings, me] = await Promise.all([
        Settings.findOne({ adminId: req.adminId }).lean(),
        User.findOne({ _id: req.userId, adminId: req.adminId, role: 'employee' }).populate('shiftId').lean(),
    ]);
    if (!me) return res.status(404).json({ message: 'Your account was not found.' });
    const shift = me.shiftId || null;

    const outside = windowProblem(day, now, correctionWindowDays(settings));
    if (outside) return res.status(400).json({ message: outside });

    const requested = correctionInstant(dayKey, time, shift);
    if (!requested) return res.status(400).json({ message: 'Please pick the time.' });

    const attendance = await findDayRow(req.adminId, req.userId, day);
    if (!attendance) {
        // The approval path could create a day, but a punch-in with nothing
        // else is an open day that never closes and pays nothing. A whole
        // missing day is the admin's to add.
        return res.status(400).json({
            message: 'There is no attendance on this day. Please ask your admin to add it.',
        });
    }

    const problem = correctionProblem({ field: spec.field, requested, attendance, shift, now });
    if (problem) return res.status(400).json({ message: problem });

    const dup = await findOverlappingPending(req.adminId, req.userId, day, { [spec.requestedField]: requested });
    if (dup) {
        return res.status(409).json({
            message: spec.field === 'punchIn'
                ? `You already asked to change your punch-in for ${fmtDay(day)}. Please wait for your admin to answer.`
                : `You already asked to change your punch-out for ${fmtDay(day)}. Please wait for your admin to answer.`,
        });
    }

    const recordedTime = spec.field === 'punchIn' ? attendance.punchIn : recordedPunchOut(attendance);

    const regularization = await Regularization.create({
        adminId: req.adminId,
        employeeId: req.userId,
        submittedBy: req.userId,
        date: istStartOfDay(day),
        [spec.requestedField]: requested,
        reason: reason || spec.label,
    });

    let ticket;
    try {
        ticket = await Ticket.create({
            adminId: req.adminId,
            employeeId: req.userId,
            type,
            reason: reason || spec.label,
            regularizationId: regularization._id,
            correction: {
                field: spec.field,
                date: istStartOfDay(day),
                requestedTime: requested,
                recordedTime: recordedTime || null,
            },
        });
    } catch (err) {
        // Never leave a correction the employee cannot see.
        await Regularization.deleteOne({ _id: regularization._id });
        throw err;
    }
    regularization.ticketId = ticket._id;
    await regularization.save();

    return res.status(201).json(ticket);
}

exports.createTicket = async (req, res) => {
    try {
        const type = typeof req.body.type === 'string' ? req.body.type.trim() : '';
        if (CORRECTION_TYPES[type]) return await createCorrectionTicket(req, res, type);

        // What a ticket is about and nothing else, for every role. Spreading
        // req.body let an employee file a ticket already "approved", with an
        // "Admin Remark" they wrote themselves, which their screen then showed
        // as HR's answer.
        const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
        if (roleOf(req) === 'employee' && !EMPLOYEE_TICKET_TYPES.includes(type)) {
            return res.status(400).json({ message: 'Please choose what your ticket is about.' });
        }
        if (!type || type.length > 60) {
            return res.status(400).json({ message: 'Please choose what your ticket is about.' });
        }
        if (!reason) {
            return res.status(400).json({ message: 'Please write what you need help with.' });
        }
        if (reason.length > MAX_REASON_LENGTH) {
            return res.status(400).json({ message: `Please keep your message under ${MAX_REASON_LENGTH} letters.` });
        }

        if (await monthlyLimitReached(req.adminId)) {
            return res.status(400).json({
                message: `Ticket monthly limit reached (maximum 50 tickets per month allowed on your plan). Please upgrade your plan to raise more.`
            });
        }

        // The same ticket again within a minute is the same tap (a double tap made two
        // identical tickets, measured 2026-09-30). Answer with the existing one.
        const repeated = await Ticket.findOne({
            adminId: req.adminId,
            employeeId: req.userId,
            type,
            reason,
            createdAt: { $gte: new Date(Date.now() - 60 * 1000) },
        }).sort({ createdAt: -1 });
        if (repeated) return res.status(200).json(repeated);

        const ticket = await Ticket.create({
            type,
            reason,
            adminId: req.adminId,
            employeeId: req.userId
        });
        res.status(201).json(ticket);
    } catch (error) {
        console.error('createTicket error:', error);
        res.status(400).json({ message: error.message });
    }
};

exports.updateTicketStatus = async (req, res) => {
    if (refuseEmployee(req, res)) return;
    try {
        if (!isValidId(req.params.id)) return res.status(404).json({ message: 'Ticket not found' });
        const status = typeof req.body.status === 'string' ? req.body.status : '';
        if (!TICKET_STATUSES.includes(status)) {
            return res.status(400).json({ message: 'Status must be pending, approved or rejected.' });
        }
        if (req.body.adminRemark !== undefined && req.body.adminRemark !== null && typeof req.body.adminRemark !== 'string') {
            return res.status(400).json({ message: 'The remark must be text.' });
        }
        const adminRemark = typeof req.body.adminRemark === 'string' ? req.body.adminRemark.trim() : '';
        if (adminRemark.length > MAX_REMARK_LENGTH) {
            return res.status(400).json({ message: `Please keep the remark under ${MAX_REMARK_LENGTH} letters.` });
        }

        // Scoped to the caller's tenant -- a bare findById would let any
        // admin/subadmin update any other tenant's ticket by guessing its id.
        const ticket = await Ticket.findOne({ _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) });
        if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

        // A punch-correction ticket is decided through the correction itself,
        // with the SAME code the Attendance page uses -- there is no second
        // copy of the grading. The correction then mirrors its status back
        // onto this ticket (syncLinkedTicket).
        if (ticket.regularizationId) {
            if (refuseWithoutAttendanceEdit(req, res)) return;
            if (status === 'pending') {
                return res.status(400).json({ message: 'A decided correction cannot be reopened. Ask the employee to raise a new one.' });
            }
            const core = status === 'approved' ? approveCore : rejectCore;
            const result = await core(req, ticket.regularizationId, { adminRemark });
            if (result.code >= 400) return res.status(result.code).json(result.payload);
            const fresh = await Ticket.findById(ticket._id).populate('employeeId', 'name phone');
            return res.json(fresh);
        }

        // Decided atomically, from the status the ticket is in now. A plain
        // read-set-save let an Approve and a Reject clicked together both
        // succeed (the last one won), and any decision could be overwritten
        // later. Approve/Reject move only a PENDING ticket; "pending" reopens
        // only a decided one. The same answer twice is the same click.
        const from = status === 'pending' ? { $ne: 'pending' } : 'pending';
        const set = { status };
        const unset = {};
        if (adminRemark) set.adminRemark = adminRemark; else unset.adminRemark = 1;
        const updated = await Ticket.findOneAndUpdate(
            { _id: ticket._id, adminId: ticket.adminId, status: from },
            { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
            { new: true },
        ).populate('employeeId', 'name phone');
        if (!updated) {
            const now = await Ticket.findById(ticket._id).populate('employeeId', 'name phone');
            if (now && now.status === status) return res.json(now);
            return res.status(409).json({ message: `This ticket was already ${now?.status || 'changed'}. Refresh to see the latest.` });
        }
        res.json(updated);
    } catch (error) {
        console.error('updateTicketStatus error:', error);
        res.status(400).json({ message: error.message });
    }
};

/**
 * Tickets with their correction attached: the request's current state and,
 * for a reviewer, what the attendance day says right now ("Punched 10:00 AM
 * -> asks for 9:30 AM").
 */
async function withCorrections(tickets, { forReviewer }) {
    const regIds = tickets.map((t) => t.regularizationId).filter(Boolean);
    if (!regIds.length) return tickets;
    let regs = await Regularization.find({ _id: { $in: regIds } })
        .select('adminId employeeId date requestedPunchIn requestedPunchOut requestedLunchInTime requestedLunchOutTime requestedStatus reason status adminRemark reviewedAt originalPunchIn originalPunchOut createdAt ticketId')
        .lean();
    if (forReviewer) regs = await attachCurrentPunches(regs);
    const byId = new Map(regs.map((r) => [String(r._id), r]));
    return tickets.map((t) => ({
        ...t,
        regularization: t.regularizationId ? byId.get(String(t.regularizationId)) || null : null,
    }));
}

exports.getTickets = async (req, res) => {
    try {
        const query = { adminId: req.adminId };
        const isEmployee = roleOf(req) === 'employee';
        // An employee only ever sees their own; an admin sees the tenant's.
        if (isEmployee) query.employeeId = req.userId;

        const tickets = await Ticket.find(query)
            .populate('employeeId', 'name phone')
            .sort({ createdAt: -1 })
            .lean();
        res.json(await withCorrections(tickets, { forReviewer: !isEmployee }));
    } catch (error) {
        console.error('getTickets error:', error);
        res.status(500).json({ message: 'Could not load tickets. Please try again.' });
    }
};

exports.deleteTicket = async (req, res) => {
    if (refuseEmployee(req, res)) return;
    try {
        if (!isValidId(req.params.id)) return res.status(404).json({ message: 'Ticket not found' });
        const ticket = await Ticket.findOne({
            _id: req.params.id,
            adminId: new mongoose.Types.ObjectId(req.adminId),
        });
        if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

        if (ticket.regularizationId) {
            const reg = await Regularization.findOne({ _id: ticket.regularizationId, adminId: req.adminId });
            // Deleting the ticket of a correction still waiting would leave the
            // correction live in Attendance -> Corrections with nothing on the
            // employee's side to show its answer. Decide it first.
            if (reg && reg.status === 'pending') {
                return res.status(409).json({ message: 'Approve or reject this punch correction first, then delete the ticket.' });
            }
            // A decided correction stays as the attendance record's audit;
            // only the link back to this ticket goes.
            if (reg) await Regularization.updateOne({ _id: reg._id }, { $set: { ticketId: null } });
        }

        await Ticket.deleteOne({ _id: ticket._id });
        res.json({ message: 'Ticket removed' });
    } catch (error) {
        console.error('deleteTicket error:', error);
        res.status(500).json({ message: 'Could not delete the ticket. Please try again.' });
    }
};

exports.getMyTickets = async (req, res) => {
    try {
        const tickets = await Ticket.find({
            adminId: req.adminId,
            employeeId: req.userId
        })
            .populate('employeeId', 'name')
            .sort({ createdAt: -1 })
            .lean();
        res.json(await withCorrections(tickets, { forReviewer: false }));
    } catch (error) {
        console.error('getMyTickets error:', error);
        res.status(500).json({ message: 'Could not load your tickets. Please try again.' });
    }
};
const { serialisePerUser } = require('../utils/employee_lock');

// Creates for one person run one at a time, so the duplicate checks see the first request.
exports.createTicket = serialisePerUser(exports.createTicket, 'create');
