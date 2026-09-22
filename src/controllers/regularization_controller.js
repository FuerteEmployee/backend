const mongoose = require('mongoose');
const Regularization = require('../models/Regularization');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Settings = require('../models/Settings');
const { calculateAndSaveSalary } = require('./salary_controller');
const { isLatePunchIn, determineHalfDayStatus, stripGradingRemarks, istStartOfDay, istEndOfDay, istDateKey, istTimeOnDate, parseIstWallClock } = require('../utils/attendance_helpers');
const {
    computeWorkedMs,
    computeSessionWorkMs,
    computeSessionGrossMs,
    syncRootPunchOut,
} = require('../utils/shift_status');

// How far back an EMPLOYEE may reach when requesting their own correction.
// Overridable per tenant via Settings.attendance.correctionWindowDays.
const DEFAULT_CORRECTION_WINDOW_DAYS = 7;

exports.getRegularizations = async (req, res) => {
    try {
        const query = { adminId: new mongoose.Types.ObjectId(req.adminId) };

        if (req.user && req.user.role === 'employee') {
            query.employeeId = new mongoose.Types.ObjectId(req.userId);
        } else if (req.query.employeeId) {
            query.employeeId = new mongoose.Types.ObjectId(req.query.employeeId);
        }
        if (req.query.status) query.status = req.query.status;

        const regularizations = await Regularization.find(query)
            .populate('employeeId', 'name phone')
            .sort({ createdAt: -1 })
            .lean();

        if (!regularizations.length) return res.json([]);

        // Attach what the record CURRENTLY says, so a reviewer can see the claim
        // and the thing it would replace side by side.
        //
        // A pending request has no attendanceId yet (it is only linked on
        // approval), so the row has to be found by employee and day. One query
        // for the whole page rather than one per request: this list is the
        // admin's review queue and can be long.
        const days = regularizations.map((r) => ({
            adminId: r.adminId,
            employeeId: r.employeeId?._id || r.employeeId,
            date: { $gte: istStartOfDay(r.date), $lte: istEndOfDay(r.date) },
        }));

        const rows = await Attendance.find({ $or: days })
            .select('employeeId date punchIn punchOut shifts')
            .lean();

        const byKey = new Map();
        for (const a of rows) byKey.set(`${a.employeeId}_${istDateKey(a.date)}`, a);

        const withCurrent = regularizations.map((r) => {
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

        res.json(withCurrent);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.submitRegularization = async (req, res) => {
    try {
        const employeeId = (req.user && req.user.role === 'employee') ? req.userId : req.body.employeeId;
        if (!employeeId) {
            return res.status(400).json({ message: 'Employee ID is required' });
        }
        if (!req.body.date) {
            return res.status(400).json({ message: 'Date is required' });
        }
        if (!req.body.reason) {
            return res.status(400).json({ message: 'Reason is required' });
        }

        const day = istStartOfDay(new Date(req.body.date));
        if (!day || Number.isNaN(day.getTime())) {
            return res.status(400).json({ message: 'Date is not a valid date' });
        }

        const isEmployee = (req.user && req.user.role === 'employee');

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

            // One open request per day. A second pending row for the same day
            // gives the admin two answers to one question, and whichever they
            // approve second silently overwrites the first.
            const existing = await Regularization.findOne({
                adminId: req.adminId,
                employeeId,
                status: 'pending',
                date: { $gte: istStartOfDay(day), $lte: istEndOfDay(day) },
            });
            if (existing) {
                return res.status(409).json({
                    message: 'You already have a correction request awaiting approval for this date.',
                });
            }
        }

        const regularization = await Regularization.create({
            adminId: req.adminId,
            employeeId,
            submittedBy: req.userId,
            date: day,
            // Parsed as IST, not left for Mongoose to cast against the host
            // timezone -- see parseIstWallClock. A datetime-local value carries
            // no offset, so casting it on a UTC server shifted every corrected
            // time by 5h30m and pushed late punch-outs onto the next day.
            requestedPunchIn: parseIstWallClock(req.body.requestedPunchIn),
            requestedPunchOut: parseIstWallClock(req.body.requestedPunchOut),
            requestedLunchInTime: parseIstWallClock(req.body.requestedLunchInTime),
            requestedLunchOutTime: parseIstWallClock(req.body.requestedLunchOutTime),
            requestedStatus: req.body.requestedStatus || null,
            reason: req.body.reason,
        });

        const populated = await regularization.populate('employeeId', 'name phone');
        res.status(201).json(populated);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.approveRegularization = async (req, res) => {
    try {
        const regularization = await Regularization.findOne({
            _id: req.params.id,
            adminId: req.adminId,
        });
        if (!regularization) return res.status(404).json({ message: 'Regularization request not found' });
        if (regularization.status !== 'pending') {
            return res.status(400).json({ message: `Cannot approve request with status: ${regularization.status}` });
        }

        // Approve-with-an-edit. An admin who knows the employee left at 18:45
        // should not have to reject a request for 19:00 and ask them to file it
        // again. The employee's original claim is not lost: it stays on the
        // request until this overwrites it, and the value that was actually
        // applied is the one the audit then shows.
        for (const field of ['requestedPunchIn', 'requestedPunchOut', 'requestedLunchInTime', 'requestedLunchOutTime']) {
            if (req.body[field]) {
                const when = parseIstWallClock(req.body[field]);
                if (!when) {
                    return res.status(400).json({ message: `${field} is not a valid time` });
                }
                regularization[field] = when;
            }
        }
        if (req.body.requestedStatus) regularization.requestedStatus = req.body.requestedStatus;

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
        {
            const dayStart = istStartOfDay(new Date(regularization.date));
            const dayEnd = istEndOfDay(new Date(regularization.date));
            const onDay = (d) => d >= dayStart && d <= dayEnd;

            for (const [field, label] of [
                ['requestedPunchIn', 'Punch in'],
                ['requestedPunchOut', 'Punch out'],
                ['requestedLunchInTime', 'Lunch in'],
                ['requestedLunchOutTime', 'Lunch out'],
            ]) {
                const v = regularization[field];
                if (!v) continue;
                if (!onDay(new Date(v))) {
                    return res.status(400).json({
                        message: `${label} (${new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}) is not on `
                            + `${istDateKey(regularization.date)}. A correction must stay on the day it corrects.`,
                    });
                }
            }

            const pairs = [
                ['requestedPunchIn', 'requestedPunchOut', 'Punch out must be after punch in'],
                ['requestedLunchInTime', 'requestedLunchOutTime', 'Lunch out must be after lunch in'],
            ];
            for (const [a, b, msg] of pairs) {
                if (regularization[a] && regularization[b]
                    && new Date(regularization[b]) <= new Date(regularization[a])) {
                    return res.status(400).json({ message: msg });
                }
            }
        }

        const [user, settings] = await Promise.all([
            User.findById(regularization.employeeId).populate('shiftId'),
            Settings.findOne({ adminId: req.adminId }),
        ]);

        // Match by same-day range, not exact equality: regularization.date may
        // have been persisted by pre-IST-fix code (local/UTC midnight) while
        // the real Attendance record is bucketed at IST midnight — an exact
        // match would miss it and create a duplicate record for the day.
        const regDayStart = istStartOfDay(regularization.date);
        const regDayEnd = istEndOfDay(regularization.date);

        let attendance = await Attendance.findOne({
            adminId: req.adminId,
            employeeId: regularization.employeeId,
            date: { $gte: regDayStart, $lte: regDayEnd },
        });
        if (!attendance) {
            attendance = new Attendance({
                adminId: req.adminId,
                employeeId: regularization.employeeId,
                date: regDayStart,
            });
        }

        if (regularization.requestedLunchInTime) attendance.lunchInTime = regularization.requestedLunchInTime;
        if (regularization.requestedLunchOutTime) attendance.lunchOutTime = regularization.requestedLunchOutTime;

        // Write through to shifts[], not just the root.
        //
        // allSessions() treats shifts[] as authoritative the moment it is
        // populated and ignores the root entirely. Assigning only the root --
        // which is what this did -- left the session still holding the old
        // system-written time, so on every modern row the approved correction
        // was computed away and PAYROLL NEVER SAW IT. The admin watched the
        // request go green and nothing changed.
        const sessions = attendance.shifts || [];
        // The session this correction is about: the one the system closed, else
        // the day's final session. Never by array index -- shifts[] is not
        // stored in chronological order.
        const target = sessions.filter((s) => s && s.punchIn).sort((a, b) => {
            const aSys = a.closeReason === 'shift_end' ? 1 : 0;
            const bSys = b.closeReason === 'shift_end' ? 1 : 0;
            if (aSys !== bSys) return bSys - aSys;
            return new Date(b.punchOut || b.punchIn) - new Date(a.punchOut || a.punchIn);
        })[0];

        // Snapshot what we are about to overwrite, before overwriting it.
        if (regularization.requestedPunchOut && !regularization.originalPunchOut) {
            regularization.originalPunchOut = target?.punchOut || attendance.punchOut || null;
        }

        if (regularization.requestedPunchIn) {
            attendance.punchIn = regularization.requestedPunchIn;
            if (target) target.punchIn = regularization.requestedPunchIn;
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
            if (wasLate) attendance.wasLate = true;

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
        await attendance.save();

        regularization.status = 'approved';
        regularization.adminRemark = req.body.adminRemark || regularization.adminRemark;
        regularization.reviewedBy = req.userId;
        regularization.reviewedAt = new Date();
        regularization.attendanceId = attendance._id;
        await regularization.save();

        const populated = await regularization.populate('employeeId', 'name phone');
        res.json(populated);

        if (user) {
            calculateAndSaveSalary(req.adminId, user, regularization.date.getMonth() + 1, regularization.date.getFullYear()).catch(err => {
                console.error('Regularization approval salary sync error:', err);
            });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.rejectRegularization = async (req, res) => {
    try {
        const regularization = await Regularization.findOne({
            _id: req.params.id,
            adminId: req.adminId,
        });
        if (!regularization) return res.status(404).json({ message: 'Regularization request not found' });
        if (regularization.status !== 'pending') {
            return res.status(400).json({ message: `Cannot reject request with status: ${regularization.status}` });
        }

        regularization.status = 'rejected';
        regularization.adminRemark = req.body.adminRemark || regularization.adminRemark;
        regularization.reviewedBy = req.userId;
        regularization.reviewedAt = new Date();
        await regularization.save();

        const populated = await regularization.populate('employeeId', 'name phone');
        res.json(populated);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
