const { istDateKey } = require('./attendance_helpers');

/**
 * Leave balances: how much of each leave type's quota (LeaveType.totalDays) an
 * employee has used, has waiting, and has left.
 *
 * The quota applies per PERIOD, chosen by the tenant in
 * Settings.leave.balancePeriod:
 *
 *   'lifetime'        every approved/pending leave ever taken counts. This is
 *                     how balances worked before the setting existed, and it
 *                     stays the default so nobody's balance moves on deploy.
 *   'calendar_year'   1 Jan - 31 Dec.
 *   'financial_year'  1 Apr - 31 Mar (the Indian financial year).
 *
 * Period edges are IST calendar days, read with istDateKey, so the host's own
 * timezone never decides which year a leave falls in. A leave that crosses an
 * edge counts only its working days inside the period. There is no
 * carry-forward: unused days do not roll into the next period.
 *
 * Pure except for the `countPart` callback, which the controller supplies
 * (counting working days needs festivals and the employee's weekly offs).
 */

const BALANCE_PERIODS = ['lifetime', 'calendar_year', 'financial_year'];

/** The period containing `now`, as inclusive IST 'YYYY-MM-DD' keys. */
function resolveBalancePeriod(type, now = new Date()) {
    const [y, m] = istDateKey(now).split('-').map(Number);
    if (type === 'calendar_year') {
        return { type, start: `${y}-01-01`, end: `${y}-12-31` };
    }
    if (type === 'financial_year') {
        const startYear = m >= 4 ? y : y - 1;
        return { type, start: `${startYear}-04-01`, end: `${startYear + 1}-03-31` };
    }
    return { type: 'lifetime', start: null, end: null };
}

/**
 * Where a leave sits against the period, by IST calendar day:
 *   { inside: 'all' } | { inside: 'none' } | { inside: 'part', from, to }
 * `from`/`to` are the IST day keys of the part inside the period.
 *
 * Read with istDateKey because leaves are stored two ways -- 'YYYY-MM-DD' at
 * UTC midnight, older rows at IST midnight (18:30 UTC the day before) -- and
 * both resolve to the right IST day that way.
 */
function leaveOverlap(leave, period) {
    if (!period || !period.start) return { inside: 'all' };
    const s = istDateKey(leave.startDate);
    const e = istDateKey(leave.endDate || leave.startDate);
    if (e < period.start || s > period.end) return { inside: 'none' };
    if (s >= period.start && e <= period.end) return { inside: 'all' };
    return {
        inside: 'part',
        from: s < period.start ? period.start : s,
        to: e > period.end ? period.end : e,
    };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Per-type balances.
 *
 * `leaves` may include any status; only approved (used) and pending (held
 * against the balance, shown separately so "left" is explained) count.
 * `countPart(leave, fromKey, toKey)` returns the working days of `leave`
 * between two IST day keys; it is only called for a leave crossing a period
 * edge, and its answer is capped at the leave's own stored duration.
 */
async function computeLeaveBalances({ leaveTypes, leaves, period, countPart }) {
    const tally = new Map(leaveTypes.map((t) => [String(t._id), { used: 0, pending: 0 }]));

    for (const leave of leaves) {
        if (leave.status !== 'approved' && leave.status !== 'pending') continue;
        const bucket = tally.get(String(leave.leaveTypeId?._id || leave.leaveTypeId));
        if (!bucket) continue; // a deleted type: nothing to show it against

        const where = leaveOverlap(leave, period);
        if (where.inside === 'none') continue;

        let days = Number(leave.duration) || 0;
        if (where.inside === 'part' && countPart) {
            const inside = Number(await countPart(leave, where.from, where.to)) || 0;
            days = Math.min(days, inside);
        }
        if (leave.status === 'approved') bucket.used += days;
        else bucket.pending += days;
    }

    return leaveTypes.map((t) => {
        const { used, pending } = tally.get(String(t._id));
        const total = Number(t.totalDays) || 0;
        return {
            leaveTypeId: String(t._id),
            leaveName: t.leaveName,
            code: t.code,
            colorCode: t.colorCode,
            total,
            used: round2(used),
            pending: round2(pending),
            remaining: Math.max(0, round2(total - used - pending)),
        };
    });
}

module.exports = { BALANCE_PERIODS, resolveBalancePeriod, leaveOverlap, computeLeaveBalances };
