const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Leave = require('../models/Leave');
const Festival = require('../models/Festival');
const Settings = require('../models/Settings');
const Regularization = require('../models/Regularization');
const Shift = require('../models/Shift');
require('../models/Branch'); // populated below; registered here so the util stands alone
const { isWeeklyOff, istStartOfDay, istEndOfDay, istDateKey, istCalendarDate, istShiftOccurrence } = require('./attendance_helpers');
const { workDayStart, lateOutDayStart } = require('./working_day');

// Moved here from attendance_controller.js (2026-09-26) so the admin dashboard
// counts people with the same rules as the Attendance page. classifyDay()
// behaves exactly as it did there: for one day it issues the same six queries
// and runs the same loop. qa/admin-dashboard/classify-equivalence.cjs compares
// it against a verbatim copy of the old function.

const GRADED_PRESENT = ['present', 'late', 'wfh', 'half-day', 'needs_review'];

const BUCKETS = ['present', 'late', 'wfh', 'halfDay', 'needsReview', 'onLeave', 'weeklyOff', 'holiday', 'absent'];

/**
 * Who is where on one IST day, for the Attendance page's cards and its
 * Absent Today list -- one classification so the two can never disagree.
 *
 * They did: the card counted `active - graded rows` while the list showed
 * "active employees with no row at all", so an explicit 'absent' row (written by
 * the close job or Mark Absent) counted in the card and vanished from the list.
 * Neither excluded anyone on approved leave, on their weekly off, or on a
 * holiday, so on a Sunday the whole company read as absent.
 *
 * Each ACTIVE employee lands in exactly one bucket, in this order:
 *   graded row (present / late / wfh / half-day / needs_review) -> that grade
 *   approved leave covering the day                             -> onLeave
 *   an explicit 'absent' row                                    -> absent
 *   a holiday (Festival)                                        -> holiday
 *   their weekly off (employee > shift > company work days)     -> weeklyOff
 *   otherwise                                                   -> absent
 * so the buckets always add up to the active headcount. Rows belonging to
 * inactive employees are not counted at all.
 *
 * classifyDays() does the same for several days with one set of queries (the
 * dashboard's 7-day chart and month totals). The result for each day is what
 * classifyDay() would return for it on its own.
 *
 * Besides the counts, each day carries `lateIds` and `onDutyIds`: the
 * employees behind `lateArrivals` and `onDuty`. They add nothing to the
 * classification; classifyCurrentDay() needs them to move a night-shift
 * worker between days.
 *
 * Option `fromJoiningDate` (off by default, and off for classifyDay): leave
 * an employee out of every day before their joining date. Someone who had not
 * joined yet was not absent -- without it a past month read everyone who
 * joined later as absent for all of it. Payroll starts from the same date.
 */
async function classifyDays(adminId, whens, { fromJoiningDate = false } = {}) {
    if (!Array.isArray(whens) || whens.length === 0) return [];

    const days = whens.map((when) => {
        const cal = istCalendarDate(when);
        return {
            dayStart: istStartOfDay(when),
            dayEnd: istEndOfDay(when),
            dayKey: istDateKey(when),
            cal,
            dayName: cal.toLocaleDateString('en-US', { weekday: 'long' }),
        };
    });
    const rangeStart = new Date(Math.min(...days.map((d) => d.dayStart.getTime())));
    const rangeEnd = new Date(Math.max(...days.map((d) => d.dayEnd.getTime())));
    const keys = days.map((d) => d.dayKey).sort();
    const firstKey = keys[0];
    const lastKey = keys[keys.length - 1];

    const [employees, records, leaves, festivals, settings, pendingRegularizations] = await Promise.all([
        User.find({ adminId, role: 'employee', status: 'active' })
            .select(fromJoiningDate ? 'name phone shiftId branchId weeklyHolidays joiningDate' : 'name phone shiftId branchId weeklyHolidays')
            .populate('shiftId', 'name workDays')
            .populate('branchId', 'branchName')
            .lean(),
        Attendance.find({ adminId, date: { $gte: rangeStart, $lte: rangeEnd } })
            .select('employeeId status punchIn punchOut wasLate punchOutIsProvisional date')
            .lean(),
        Leave.find({ adminId, status: 'approved', startDate: { $lte: rangeEnd }, endDate: { $gte: rangeStart } })
            .select('employeeId dayPortion startDate endDate')
            .lean(),
        Festival.find({ adminId, startDate: { $lte: lastKey }, endDate: { $gte: firstKey } }).select('name startDate endDate').lean(),
        Settings.findOne({ adminId }).select('attendance.workDays').lean(),
        Regularization.countDocuments({ adminId, status: 'pending' }),
    ]);

    return days.map(({ dayStart, dayEnd, dayKey, cal, dayName }) => {
        // For a single day every filter below is a no-op: the query above was
        // exactly this day's, so these keep every row it returned, in order.
        const dayRecords = records.filter((r) => r.date && r.date >= dayStart && r.date <= dayEnd);
        const dayLeaves = leaves.filter((l) => l.startDate && l.endDate && l.startDate <= dayEnd && l.endDate >= dayStart);
        const dayFestivals = festivals.filter((f) => typeof f.startDate === 'string' && typeof f.endDate === 'string'
            && f.startDate <= dayKey && f.endDate >= dayKey);

        // Several rows for one employee-day can exist (pre-IST-fix duplicates);
        // the most informative one wins: a graded row over an 'absent' one.
        const recordBy = new Map();
        for (const r of dayRecords) {
            const k = String(r.employeeId);
            const prev = recordBy.get(k);
            if (!prev || (!GRADED_PRESENT.includes(prev.status) && GRADED_PRESENT.includes(r.status))) recordBy.set(k, r);
        }
        const leaveBy = new Map(dayLeaves.map((l) => [String(l.employeeId), l]));
        const holiday = dayFestivals[0]?.name || null;

        const out = { present: [], late: [], wfh: [], halfDay: [], needsReview: [], onLeave: [], weeklyOff: [], holiday: [], absent: [] };
        let lateArrivals = 0;
        let onDuty = 0;
        const lateIds = new Set();
        const onDutyIds = new Set();
        for (const e of employees) {
            if (fromJoiningDate && e.joiningDate && istDateKey(e.joiningDate) > dayKey) continue;
            const k = String(e._id);
            const rec = recordBy.get(k);
            if (rec && (GRADED_PRESENT.includes(rec.status) || (rec.punchIn && rec.status !== 'absent'))) {
                const bucket = rec.status === 'half-day' ? 'halfDay'
                    : rec.status === 'needs_review' ? 'needsReview'
                        : rec.status === 'wfh' ? 'wfh'
                            : rec.status === 'late' ? 'late' : 'present';
                out[bucket].push(e);
                if (rec.status === 'late' || rec.wasLate) { lateArrivals++; lateIds.add(k); }
                if (rec.punchIn && (!rec.punchOut || rec.punchOutIsProvisional)) { onDuty++; onDutyIds.add(k); }
                continue;
            }
            const leave = leaveBy.get(k);
            if (leave) { out.onLeave.push({ ...e, leavePortion: leave.dayPortion || 'full' }); continue; }
            if (rec && rec.status === 'absent') { out.absent.push(e); continue; }
            if (holiday) { out.holiday.push(e); continue; }
            const off = isWeeklyOff(dayName, cal.getDate(), e.weeklyHolidays, settings?.attendance?.workDays, e.shiftId?.workDays);
            if (off) { out.weeklyOff.push(e); continue; }
            out.absent.push(e);
        }

        return { dayKey, holiday, employees, out, lateArrivals, onDuty, pendingRegularizations, lateIds, onDutyIds };
    });
}

/** One IST day. Unchanged behaviour from its time in attendance_controller. */
async function classifyDay(adminId, when = new Date()) {
    const [day] = await classifyDays(adminId, [when]);
    return day;
}

/**
 * Right now, with each person counted on the day their shift is filed under.
 *
 * classifyDay() reads the IST calendar day. A night-shift worker on
 * 22:00-06:00 who punched in at 22:00 on the 10th has their row dated the 10th
 * (see utils/working_day.js), so at 02:00 on the 11th the calendar day shows
 * them absent while they are at work. Here, anyone on an overnight shift whose
 * current occurrence began yesterday is counted from YESTERDAY's
 * classification instead -- and so is someone just past the end of that night
 * who is still punched in on it (the late punch-out margin).
 *
 * A graded row on today's calendar date always wins, so a row opened after
 * midnight by older code is not lost. Day-shift staff are never moved.
 *
 * Returns the classifyDay() shape plus `movedToShiftDay`, the number of people
 * counted from yesterday. `opts` is passed to classifyDays().
 */
async function classifyCurrentDay(adminId, now = new Date(), opts = {}) {
    const yesterday = new Date(istStartOfDay(now).getTime() - 1);
    const [[prev, today], shifts] = await Promise.all([
        classifyDays(adminId, [yesterday, now], opts),
        Shift.find({ adminId }).select('startTime endTime').lean(),
    ]);
    const shiftById = new Map(shifts.map((s) => [String(s._id), s]));

    const bucketOf = (day) => {
        const m = new Map();
        for (const b of BUCKETS) for (const e of day.out[b]) m.set(String(e._id), b);
        return m;
    };
    const todayBucket = bucketOf(today);
    const graded = new Set(['present', 'late', 'wfh', 'halfDay', 'needsReview']);

    const moved = new Set();
    for (const e of today.employees) {
        const k = String(e._id);
        const shiftId = e.shiftId?._id || e.shiftId;
        const shift = shiftId ? shiftById.get(String(shiftId)) : null;
        if (!shift || !istShiftOccurrence(shift, now)?.overnight) continue;
        if (graded.has(todayBucket.get(k))) continue;
        if (istDateKey(workDayStart(shift, now)) === prev.dayKey) { moved.add(k); continue; }
        const lateOut = lateOutDayStart(shift, now);
        if (lateOut && istDateKey(lateOut) === prev.dayKey && prev.onDutyIds.has(k)) moved.add(k);
    }
    if (moved.size === 0) return { ...today, movedToShiftDay: 0 };

    const out = {};
    for (const b of BUCKETS) {
        out[b] = [
            ...today.out[b].filter((e) => !moved.has(String(e._id))),
            ...prev.out[b].filter((e) => moved.has(String(e._id))),
        ];
    }
    const pick = (todaySet, prevSet) => new Set([
        ...[...todaySet].filter((k) => !moved.has(k)),
        ...[...prevSet].filter((k) => moved.has(k)),
    ]);
    const lateIds = pick(today.lateIds, prev.lateIds);
    const onDutyIds = pick(today.onDutyIds, prev.onDutyIds);

    return {
        ...today,
        out,
        lateIds,
        onDutyIds,
        lateArrivals: lateIds.size,
        onDuty: onDutyIds.size,
        movedToShiftDay: moved.size,
    };
}

module.exports = { classifyDay, classifyDays, classifyCurrentDay, GRADED_PRESENT, BUCKETS };
