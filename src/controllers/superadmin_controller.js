const User = require('../models/User');
const Plan = require('../models/Plan');
const Subscription = require('../models/Subscription');
const Invoice = require('../models/Invoice');
const AlertRule = require('../models/AlertRule');
const PlanFeature = require('../models/PlanFeature');
const Attendance = require('../models/Attendance');
const Leave = require('../models/Leave');
const Ticket = require('../models/Ticket');
const Branch = require('../models/Branch');
const Department = require('../models/Department');
const Expense = require('../models/Expense');
const mongoose = require('mongoose');
const { encrypt: encryptSecret, decrypt: decryptSecret } = require('../utils/reversible_crypto');
const { friendlyMongooseError } = require('../utils/mongoose_errors');
const { istStartOfDay, istEndOfDay, istDateKey, istMonthRange } = require('../utils/attendance_helpers');
const { FEATURE_KEYS, resolveFeatureToggles } = require('../utils/feature_toggles');

// ─── OVERVIEW / DASHBOARD ────────────────────────────────────────────────────
//
// Every figure here is computed from the same "book" of companies, so the
// cards add up to each other and to the Customers page:
//  - a company IS an admin user. A subscription whose admin no longer exists
//    (an "orphan") is not a company: it is reported separately and counted
//    nowhere else, so a deleted customer cannot keep inflating MRR or the
//    active count;
//  - money comes from the plan's CURRENT price through mrrFor(plan, cycle),
//    the same rule the Customers page saves. Subscription.mrr is only written
//    when a tenant is edited, so it goes stale when a plan's price changes,
//    and the old sum used the monthly price for annual customers too;
//  - seats and employees are counted live from the users collection, never
//    from the stored Subscription.employeesUsed;
//  - "this month" and "today" are IST calendar boundaries, independent of the
//    server's own timezone.

// Status buckets the Overview shows. They are exhaustive, so they sum to the
// number of companies: a trial past its end date is refused by
// checkSubscription and counts as ended, and a company with no subscription
// at all is a legacy tenant the gates let through as 'free'.
const OVERVIEW_BUCKETS = ['active', 'grace', 'trial', 'paused', 'expired', 'noPlan'];

function istMonthStartOf(date = new Date()) {
    const [y, m] = istDateKey(date).split('-').map(Number);
    return istMonthRange(y, m).start;
}

function bucketOf(sub, now) {
    if (!sub) return 'noPlan';
    if (sub.status === 'trial') return sub.trialEndDate && new Date(sub.trialEndDate) < now ? 'expired' : 'trial';
    if (sub.status === 'expired' || sub.status === 'cancelled') return 'expired';
    return OVERVIEW_BUCKETS.includes(sub.status) ? sub.status : 'expired';
}

// When a company that is currently ended stopped: its last expired/cancelled
// history event, or the end of a trial that ran out without one.
function endedAt(sub) {
    const ev = [...(sub?.history || [])].reverse().find((h) => h.action === 'expired' || h.action === 'cancelled');
    if (ev?.date) return new Date(ev.date);
    if (sub?.status === 'trial' && sub.trialEndDate) return new Date(sub.trialEndDate);
    return null;
}

async function loadCompanyBook(now = new Date()) {
    const [admins, subs, plans] = await Promise.all([
        User.find({ role: 'admin' }).select('name companyName phone isActive createdAt').lean(),
        Subscription.find({}).select('adminId planId status billingCycle trialEndDate currentPeriodEnd history featureToggles createdAt').lean(),
        Plan.find({}).select('name slug color price annualPrice maxEmployees isActive modules').lean(),
    ]);
    const planById = new Map(plans.map((p) => [String(p._id), p]));
    const subByAdmin = new Map(subs.map((s) => [String(s.adminId), s]));
    const adminIds = admins.map((a) => a._id);
    const adminSet = new Set(adminIds.map(String));
    const counts = await employeeCountsFor(adminIds);

    const companies = admins.map((a) => {
        const sub = subByAdmin.get(String(a._id)) || null;
        const plan = sub ? planById.get(String(sub.planId)) || null : null;
        const bucket = bucketOf(sub, now);
        const c = counts.get(String(a._id));
        return {
            admin: a,
            sub,
            plan,
            bucket,
            mrr: bucket === 'active' ? mrrFor(plan, sub.billingCycle) : 0,
            employees: c?.total || 0,
            activeEmployees: c?.active || 0,
        };
    });
    const orphans = subs.filter((s) => !adminSet.has(String(s.adminId)));
    return { companies, orphans, plans, planById, adminIds, adminSet };
}

const companyName = (a) => a?.companyName || a?.name || 'Unnamed company';

exports.getOverview = async (req, res) => {
    try {
        const now = new Date();
        const monthStart = istMonthStartOf(now);
        const { companies, orphans, plans, planById, adminIds } = await loadCompanyBook(now);

        const byBucket = Object.fromEntries(OVERVIEW_BUCKETS.map((b) => [b, 0]));
        for (const c of companies) byBucket[c.bucket] += 1;

        const mrr = companies.reduce((sum, c) => sum + c.mrr, 0);
        const soon = new Date(now.getTime() + 7 * MS_DAY);
        const expiringTrials = companies.filter((c) => c.bucket === 'trial' && c.sub.trialEndDate && new Date(c.sub.trialEndDate) <= soon).length;
        const newThisMonth = companies.filter((c) => c.admin.createdAt && new Date(c.admin.createdAt) >= monthStart).length;
        const churnedThisMonth = companies.filter((c) => {
            if (c.bucket !== 'expired') return false;
            const at = endedAt(c.sub);
            return at && at >= monthStart && at <= now;
        }).length;

        const totalEmployees = companies.reduce((s, c) => s + c.employees, 0);
        const activeEmployees = companies.reduce((s, c) => s + c.activeEmployees, 0);

        const Device = require('../models/Device');
        const { QUIET_MINUTES } = require('../jobs/device_health');
        const quietCutoff = new Date(now.getTime() - QUIET_MINUTES * 60 * 1000);
        const todayStart = istStartOfDay(now);
        const todayEnd = istEndOfDay(now);
        const inCompanies = { adminId: { $in: adminIds } };

        const [
            attendanceToday,
            pendingLeaves,
            openTickets,
            failedPayments,
            overdueInvoices,
            unassignedEmployees,
            machinesTotal,
            machinesOnline,
        ] = await Promise.all([
            Attendance.countDocuments({ ...inCompanies, date: { $gte: todayStart, $lte: todayEnd } }),
            Leave.countDocuments({ ...inCompanies, status: 'pending' }),
            Ticket.countDocuments({ ...inCompanies, status: 'pending' }),
            Invoice.countDocuments({ ...inCompanies, status: 'failed' }),
            Invoice.countDocuments({ ...inCompanies, status: 'pending', dueDate: { $lt: now } }),
            User.countDocuments({ role: 'employee', adminId: { $nin: adminIds } }),
            Device.countDocuments({ ...inCompanies, status: 'active' }),
            Device.countDocuments({ ...inCompanies, status: 'active', lastSeenAt: { $gte: quietCutoff } }),
        ]);

        // Paying companies (active + grace) per plan. Trials have their own
        // card. A switched-off plan still appears while anyone is on it, or its
        // customers would vanish from the totals.
        const perPlan = new Map();
        for (const c of companies) {
            if (!c.plan || (c.bucket !== 'active' && c.bucket !== 'grace')) continue;
            const row = perPlan.get(String(c.plan._id)) || { count: 0, mrr: 0 };
            row.count += 1;
            row.mrr += c.mrr;
            perPlan.set(String(c.plan._id), row);
        }
        const planDistribution = plans
            .filter((p) => p.isActive || perPlan.has(String(p._id)))
            .map((p) => ({
                plan: { _id: p._id, name: p.name, slug: p.slug, color: p.color, isActive: p.isActive },
                count: perPlan.get(String(p._id))?.count || 0,
                mrr: perPlan.get(String(p._id))?.mrr || 0,
            }));

        // The latest events across every company, newest first (the old list
        // took the last event of the ten most recently touched subscriptions,
        // so the order it showed was not the order things happened).
        const events = [];
        for (const c of companies) {
            for (const h of c.sub?.history || []) {
                if (!h.date) continue;
                const plan = planById.get(String(h.toPlan || c.sub.planId)) || c.plan;
                events.push({
                    adminId: c.admin._id,
                    company: companyName(c.admin),
                    phone: c.admin.phone || '',
                    event: h.action,
                    plan: plan?.name || 'No plan',
                    planColor: plan?.color || '#888',
                    mrr: c.mrr,
                    employees: c.employees,
                    status: c.bucket,
                    date: h.date,
                });
            }
        }
        events.sort((a, b) => new Date(b.date) - new Date(a.date));

        res.json({
            stats: {
                totalTenants: companies.length,
                activeTenants: byBucket.active,
                grace: byBucket.grace,
                trials: byBucket.trial,
                expiringTrials,
                paused: byBucket.paused,
                expired: byBucket.expired,
                noPlan: byBucket.noPlan,
                mrr,
                arr: mrr * 12,
                newThisMonth,
                churnedThisMonth,
                failedPayments,
                overdueInvoices,
                totalEmployees,
                activeEmployees,
                inactiveEmployees: totalEmployees - activeEmployees,
                unassignedEmployees,
                attendanceToday,
                pendingLeaves,
                openTickets,
                machinesTotal,
                machinesOnline,
                machineQuietMinutes: QUIET_MINUTES,
                orphanSubscriptions: orphans.length,
            },
            planDistribution,
            orphans: orphans.map((s) => ({
                _id: s._id,
                status: s.status,
                plan: planById.get(String(s.planId))?.name || null,
                createdAt: s.createdAt,
            })),
            recentActivity: events.slice(0, 8),
            monthStart,
            generatedAt: now,
        });
    } catch (error) {
        console.error('Overview error:', error);
        res.status(500).json({ message: 'Could not load the overview. Please try again.' });
    }
};

// ─── TENANTS ─────────────────────────────────────────────────────────────────
//
// A tenant IS an admin user plus its Subscription. Everything below acts on a
// whole company, so every input is checked before anything is written, bodies
// are read field by field (never spread), and a malformed or unknown id is a
// plain 404 rather than a CastError.

const MS_DAY = 24 * 60 * 60 * 1000;
const SUB_STATUSES = ['active', 'trial', 'grace', 'paused', 'expired', 'cancelled'];
const BILLING_CYCLES = ['monthly', 'annual'];
const TENANT_SORTS = ['recent', 'name', 'renewal', 'employees'];
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const TENANT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The admin's login ID. Stored as exactly ten digits because login-request
// looks the number up verbatim (the same rule as employees and sub-admins).
const TENANT_PHONE_RE = /^\d{10}$/;
// Shown to the tenant's admin at login while the company is switched off.
const TENANT_OFF_REASON = "Your company's B.O.T account has been switched off. Please contact B.O.T support to turn it back on.";
// Subscription.history has no 'trial'/'active' action; map a status change to
// the action the schema accepts, or save() fails validation.
const STATUS_HISTORY_ACTION = {
    active: 'reactivated', trial: 'trial_started', grace: 'grace',
    paused: 'paused', expired: 'expired', cancelled: 'cancelled',
};
// Everything a tenant owns, keyed by adminId. Loaded lazily so the dormant
// modules' models (not otherwise required at boot) are still covered.
const TENANT_DATA_MODELS = [
    'Announcement', 'Asset', 'AssetCategory', 'Attendance', 'AttendanceEvent', 'Branch',
    'ClientDevice', 'ClientError', 'Department', 'Expense', 'Festival', 'GeofenceAudit',
    'GeofencePendingExit', 'HrPolicy', 'Invoice', 'JobPosting', 'Lead', 'Leave', 'LeaveType',
    'LoginSession', 'OtaCheckin', 'PerformanceReview', 'Project', 'PunchLog', 'Regularization',
    'Salary', 'Settings', 'Shift', 'Ticket', 'TrackerEvent', 'Tracking', 'Training',
    'HealthFinding', 'FaceProfile', 'LensKiosk',
];

const isObjectId = (v) => typeof v === 'string' && OBJECT_ID_RE.test(v);
const periodDaysFor = (cycle) => (cycle === 'annual' ? 365 : 30);
// A period or trial ends at the close of an IST calendar day rather than at
// whatever clock time the super admin clicked, so "ends 29 Oct" means all of
// 29 Oct, on any host timezone (istEndOfDay does not read the OS zone).
const periodEndFrom = (base, days) => istEndOfDay(new Date(base.getTime() + days * MS_DAY));
const seatLimitOf = (plan) => {
    const max = plan?.maxEmployees;
    return max === null || max === undefined || max === '' || Number.isNaN(Number(max)) ? null : Number(max);
};
const mrrFor = (plan, cycle) => (!plan ? 0 : cycle === 'annual'
    ? Math.round((plan.annualPrice || plan.price * 12) / 12)
    : plan.price || 0);
const deadlineOf = (sub) => (sub.status === 'trial' ? sub.trialEndDate
    : sub.status === 'grace' ? (sub.graceEndDate || sub.currentPeriodEnd)
        : sub.currentPeriodEnd) || null;

// "98765 43210", "+91 98765 43210" and "09876543210" all become 9876543210.
function normalizeTenantPhone(raw) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    let digits = String(raw).replace(/[\s\-().]/g, '');
    if (/^\+?91\d{10}$/.test(digits)) digits = digits.slice(-10);
    else if (/^0\d{10}$/.test(digits)) digits = digits.slice(1);
    return TENANT_PHONE_RE.test(digits) ? digits : null;
}

// 'YYYY-MM-DD' (what the date picker sends) is read as an IST calendar day and
// becomes the end of that day. A full timestamp is accepted and rounded to the
// end of its IST day. Returns null for anything that is not a real date.
function parseTenantDay(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const v = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const noon = new Date(`${v}T12:00:00+05:30`);
        if (Number.isNaN(noon.getTime()) || istDateKey(noon) !== v) return null; // 2026-02-31
        return istEndOfDay(noon);
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : istEndOfDay(d);
}

// Whole number in [min, max], or undefined when absent; NaN signals invalid.
function wholeNumberField(value, min, max) {
    if (value === undefined || value === null || value === '') return undefined;
    const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
    return Number.isInteger(n) && n >= min && n <= max ? n : NaN;
}

async function findTenantAdmin(id, select) {
    if (!isObjectId(id)) return null;
    const q = User.findOne({ _id: id, role: 'admin' });
    if (select) q.select(select);
    return q;
}

// Live employee counts per tenant. Subscription.employeesUsed is only synced
// on create/delete and nightly, so it drifts; the tenant's own Employees page
// counts live, and this matches it (every employee takes a seat, active or not).
async function employeeCountsFor(adminIds) {
    if (!adminIds.length) return new Map();
    const rows = await User.aggregate([
        { $match: { role: 'employee', adminId: { $in: adminIds } } },
        {
            $group: {
                _id: '$adminId',
                total: { $sum: 1 },
                // Employee deactivation sets status 'inactive'; isActive is the
                // tenant flag and stays true on employees, so it can't be used.
                active: { $sum: { $cond: [{ $eq: ['$status', 'inactive'] }, 0, 1] } },
            },
        },
    ]);
    return new Map(rows.map((r) => [String(r._id), r]));
}

// Shape of the admin user inside a list row: identity only. BOTLens
// credentials are served by the detail view alone.
const TENANT_ADMIN_FIELDS = 'name phone email companyName isActive status createdAt';

exports.getTenants = async (req, res) => {
    try {
        const q = req.query || {};
        const search = typeof q.search === 'string' ? q.search.trim().slice(0, 100) : '';
        const status = typeof q.status === 'string' && q.status ? q.status : 'all';
        if (status !== 'all' && !SUB_STATUSES.includes(status)) {
            return res.status(400).json({ message: 'Unknown status filter.' });
        }
        const page = Math.max(1, parseInt(q.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
        const sort = TENANT_SORTS.includes(q.sort) ? q.sort : 'recent';

        // Plan filter only; status is applied after so the tab counts can be
        // reported for the current search.
        const baseFilter = {};
        if (q.plan !== undefined && q.plan !== '') {
            if (!isObjectId(q.plan)) return res.status(400).json({ message: 'Invalid plan id' });
            baseFilter.planId = new mongoose.Types.ObjectId(q.plan);
        }

        const subs = await Subscription.find(baseFilter)
            .select('-history -remindersSent')
            .populate('adminId', TENANT_ADMIN_FIELDS)
            .populate('planId', 'name slug color price annualPrice maxEmployees isActive')
            .sort({ updatedAt: -1 })
            .lean();

        const counts = await employeeCountsFor(subs.map((s) => s.adminId?._id).filter(Boolean));
        for (const s of subs) {
            const c = s.adminId ? counts.get(String(s.adminId._id)) : null;
            s.employeesUsed = c?.total || 0;
            s.activeEmployees = c?.active || 0;
            s.seatLimit = seatLimitOf(s.planId);
            s.deadline = deadlineOf(s);
            // A subscription whose admin user no longer exists (deleted
            // outside this page). Shown so the numbers add up, but it has no
            // company to manage.
            s.orphan = !s.adminId;
            // The effective set (stored choices over defaults), so the Feature
            // toggles dialog shows what the tenant actually gets.
            s.featureToggles = resolveFeatureToggles(s.featureToggles);
        }

        // Search on the populated fields; user input is escaped because it is
        // fed into a RegExp.
        let searchMatched = subs;
        if (search) {
            const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(safe, 'i');
            searchMatched = subs.filter((s) =>
                regex.test(s.adminId?.name || '') ||
                regex.test(s.adminId?.phone || '') ||
                regex.test(s.adminId?.email || '') ||
                regex.test(s.adminId?.companyName || '')
            );
        }

        const statusCounts = { all: searchMatched.length };
        for (const st of SUB_STATUSES) statusCounts[st] = 0;
        for (const s of searchMatched) statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;

        let filtered = status === 'all' ? searchMatched : searchMatched.filter((s) => s.status === status);

        const time = (d) => (d ? new Date(d).getTime() : Infinity);
        if (sort === 'name') {
            filtered = [...filtered].sort((a, b) => (a.adminId?.name || '￿').localeCompare(b.adminId?.name || '￿', 'en', { sensitivity: 'base' }));
        } else if (sort === 'renewal') {
            filtered = [...filtered].sort((a, b) => time(a.deadline) - time(b.deadline));
        } else if (sort === 'employees') {
            filtered = [...filtered].sort((a, b) => b.employeesUsed - a.employeesUsed);
        }

        const total = filtered.length;
        const start = (page - 1) * limit;
        res.json({
            tenants: filtered.slice(start, start + limit),
            totalPages: Math.max(1, Math.ceil(total / limit)),
            currentPage: page,
            limit,
            total,
            totalAll: searchMatched.length,
            statusCounts,
        });
    } catch (error) {
        console.error('Get tenants error:', error);
        res.status(500).json({ message: 'Could not load customers. Please try again.' });
    }
};

exports.getTenant = async (req, res) => {
    try {
        const admin = await findTenantAdmin(req.params.id, `${TENANT_ADMIN_FIELDS} inactiveReason botlensEmail botlensPasswordEnc`);
        if (!admin) return res.status(404).json({ message: 'Customer not found.' });
        const adminId = admin._id;

        const sub = await Subscription.findOne({ adminId })
            .populate('planId')
            .populate('history.fromPlan', 'name slug')
            .populate('history.toPlan', 'name slug')
            .lean();
        if (!sub) return res.status(404).json({ message: 'This customer has no subscription record.' });

        const todayStart = istStartOfDay();
        const todayEnd = istEndOfDay();

        const [
            counts,
            subAdminCount,
            branchCount,
            departmentCount,
            pendingLeaves,
            openTickets,
            totalExpenses,
            attendanceToday,
        ] = await Promise.all([
            employeeCountsFor([adminId]),
            User.countDocuments({ adminId, role: 'subadmin' }),
            Branch.countDocuments({ adminId }),
            Department.countDocuments({ adminId }),
            Leave.countDocuments({ adminId, status: 'pending' }),
            Ticket.countDocuments({ adminId, status: 'pending' }),
            Expense.aggregate([
                { $match: { adminId } },
                { $group: { _id: null, total: { $sum: '$amount' } } },
            ]),
            Attendance.countDocuments({ adminId, date: { $gte: todayStart, $lte: todayEnd } }),
        ]);
        const c = counts.get(String(adminId));

        // Plan features for module status display
        const features = await PlanFeature.find({ isActive: true }).sort({ order: 1 }).lean();

        const a = admin.toObject();
        // The super admin can read the BOTLens pair back by design (it is
        // stored reversibly for that reason). Only this detail view sends it;
        // the list never does.
        a.botlensPassword = decryptSecret(a.botlensPasswordEnc);
        delete a.botlensPasswordEnc;

        res.json({
            ...sub,
            adminId: a,
            featureToggles: resolveFeatureToggles(sub.featureToggles),
            employeesUsed: c?.total || 0,
            // Employees not deactivated (status 'inactive'). This used to
            // filter on isActive, which is the tenant flag and stays true on
            // a deactivated employee, so everyone counted as active.
            activeEmployees: c?.active || 0,
            inactiveEmployees: (c?.total || 0) - (c?.active || 0),
            seatLimit: seatLimitOf(sub.planId),
            deadline: deadlineOf(sub),
            subAdminCount,
            branchCount,
            departmentCount,
            pendingLeaves,
            openTickets,
            totalExpenses: totalExpenses[0]?.total || 0,
            attendanceToday,
            features,
        });
    } catch (error) {
        console.error('Get tenant error:', error);
        res.status(500).json({ message: 'Could not load this customer. Please try again.' });
    }
};

const UPDATE_TENANT_FIELDS = ['planId', 'status', 'billingCycle', 'trialEndDate', 'bannerThresholdDays', 'note', 'email', 'password', 'renew', 'acceptOverSeats'];

exports.updateTenant = async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        // Whitelist: anything else (including $-operators) is refused rather
        // than silently ignored, so a caller learns it did nothing.
        const unknown = Object.keys(body).filter((k) => !UPDATE_TENANT_FIELDS.includes(k));
        if (unknown.length) {
            return res.status(400).json({ message: `These fields can't be changed here: ${unknown.join(', ')}.` });
        }
        const { planId, status, billingCycle, trialEndDate, bannerThresholdDays, note, email, password, renew, acceptOverSeats } = body;

        const admin = await findTenantAdmin(req.params.id);
        if (!admin) return res.status(404).json({ message: 'Customer not found.' });
        const sub = await Subscription.findOne({ adminId: admin._id }).populate('planId');
        if (!sub) return res.status(404).json({ message: 'This customer has no subscription record.' });

        // ── Validate everything before writing anything ──
        if (planId !== undefined && !isObjectId(planId)) return res.status(400).json({ message: 'Please choose a plan.' });
        if (status !== undefined && !SUB_STATUSES.includes(status)) return res.status(400).json({ message: 'Unknown status.' });
        if (billingCycle !== undefined && !BILLING_CYCLES.includes(billingCycle)) return res.status(400).json({ message: 'Billing cycle must be monthly or annual.' });
        if (renew !== undefined && typeof renew !== 'boolean') return res.status(400).json({ message: 'Renew must be true or false.' });
        if (acceptOverSeats !== undefined && typeof acceptOverSeats !== 'boolean') return res.status(400).json({ message: 'acceptOverSeats must be true or false.' });
        if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 300)) return res.status(400).json({ message: 'The note must be text of up to 300 characters.' });
        const banner = wholeNumberField(bannerThresholdDays, 0, 365);
        if (Number.isNaN(banner)) return res.status(400).json({ message: 'Banner days must be a whole number from 0 to 365.' });

        let botlensEmail;
        if (email !== undefined && email !== null) {
            if (typeof email !== 'string') return res.status(400).json({ message: 'Please enter a valid BOTLens email, or leave it blank.' });
            const e = email.trim();
            if (e && (e.length > 254 || !TENANT_EMAIL_RE.test(e))) return res.status(400).json({ message: 'Please enter a valid BOTLens email, or leave it blank.' });
            botlensEmail = e || null;
        }
        if (password !== undefined && password !== null && password !== '' && (typeof password !== 'string' || password.length > 128)) {
            return res.status(400).json({ message: 'The BOTLens password must be text of up to 128 characters.' });
        }

        const now = new Date();
        const cleanNote = typeof note === 'string' ? note.trim() : '';
        const wasStatus = sub.status;
        const nextStatus = status || wasStatus;

        let newPlan = null;
        if (planId && planId !== String(sub.planId?._id || '')) {
            newPlan = await Plan.findById(planId);
            if (!newPlan) return res.status(404).json({ message: 'Plan not found.' });
            if (newPlan.isActive === false) return res.status(400).json({ message: 'This plan is switched off. Choose another plan.' });
            // Seats come from the plan. Moving a company onto a plan smaller
            // than its workforce is allowed, but only knowingly: nobody is
            // removed, the admin just can't add anyone until under the cap.
            const limit = seatLimitOf(newPlan);
            if (limit !== null && acceptOverSeats !== true) {
                const used = await User.countDocuments({ adminId: admin._id, role: 'employee' });
                if (used > limit) {
                    return res.status(409).json({
                        message: `This company has ${used} employees, but ${newPlan.name} allows ${limit}. Pick a bigger plan, or confirm the switch: nobody is removed, but they can't add employees until they are within the limit.`,
                        overSeats: { used, limit },
                    });
                }
            }
        }

        let newTrialEnd = null;
        if (trialEndDate !== undefined && trialEndDate !== null && trialEndDate !== '') {
            if (nextStatus !== 'trial') return res.status(400).json({ message: 'A trial end date only applies while the customer is on a trial.' });
            newTrialEnd = parseTenantDay(trialEndDate);
            if (!newTrialEnd) return res.status(400).json({ message: 'Please pick a valid trial end date.' });
            if (newTrialEnd <= now) return res.status(400).json({ message: 'The trial end date must be today or later.' });
            if (newTrialEnd.getTime() - now.getTime() > 366 * MS_DAY) return res.status(400).json({ message: 'A trial can run for at most a year from today.' });
        }
        if (nextStatus === 'trial' && wasStatus !== 'trial' && !newTrialEnd) {
            return res.status(400).json({ message: 'Pick the date the trial should end.' });
        }
        if (renew === true && nextStatus !== 'active') {
            return res.status(400).json({ message: 'Set the status to Active to renew.' });
        }

        // ── Apply ──
        const periodLapsed = !sub.currentPeriodEnd || new Date(sub.currentPeriodEnd) <= now;

        if (newPlan) {
            const oldPlan = sub.planId;
            const action = (newPlan.price || 0) >= (oldPlan?.price || 0) ? 'upgraded' : 'downgraded';
            sub.history.push({
                action,
                fromPlan: oldPlan?._id,
                toPlan: newPlan._id,
                date: now,
                note: cleanNote || `Plan changed from ${oldPlan?.name || 'none'} to ${newPlan.name} by super admin`,
            });
            sub.planId = newPlan._id;
        }
        const planNow = newPlan || sub.planId;

        if (status && status !== wasStatus) {
            sub.history.push({
                action: STATUS_HISTORY_ACTION[status],
                toPlan: planNow?._id || planNow,
                date: now,
                note: cleanNote || `Status changed from ${wasStatus} to ${status} by super admin`,
            });
            sub.status = status;
        }
        if (billingCycle) sub.billingCycle = billingCycle;
        if (banner !== undefined) sub.bannerThresholdDays = banner;

        if (nextStatus === 'trial') {
            if (wasStatus !== 'trial') {
                sub.trialStartDate = now;
                sub.currentPeriodStart = now;
            }
            if (newTrialEnd) {
                if (wasStatus === 'trial') {
                    sub.history.push({
                        action: 'renewed',
                        toPlan: planNow?._id || planNow,
                        date: now,
                        note: cleanNote || `Trial end set to ${istDateKey(newTrialEnd)} by super admin`,
                    });
                }
                sub.trialEndDate = newTrialEnd;
                sub.currentPeriodEnd = newTrialEnd;
                sub.graceEndDate = undefined;
                sub.remindersSent = [];
            }
        }

        const periodDays = periodDaysFor(sub.billingCycle);
        if (renew === true) {
            // "Renew now": one period on top of max(now, current end), so an
            // early renewal adds to the time already paid for instead of
            // truncating it. This is the ONLY way saving extends a period.
            // A trial end is not paid time, so converting a trial counts from now.
            const fromNow = periodLapsed || wasStatus === 'trial';
            const base = fromNow ? now : new Date(sub.currentPeriodEnd);
            if (fromNow) sub.currentPeriodStart = now;
            sub.currentPeriodEnd = periodEndFrom(base, periodDays);
            sub.graceEndDate = undefined;
            sub.remindersSent = [];
            sub.history.push({
                action: 'renewed',
                toPlan: planNow?._id || planNow,
                date: now,
                note: cleanNote || `Renewed by super admin to ${istDateKey(sub.currentPeriodEnd)}`,
            });
        } else if (nextStatus === 'active' && wasStatus !== 'active' && (periodLapsed || wasStatus === 'trial')) {
            // Switching to active with no paid time left (from expired, grace,
            // cancelled, or a trial converting to paid) starts a first period;
            // otherwise the tenant would be pushed straight back into grace.
            // A paused tenant with time left keeps its existing end date, and
            // an already-active one is never extended without "Renew now".
            sub.currentPeriodStart = now;
            sub.currentPeriodEnd = periodEndFrom(now, periodDays);
            sub.graceEndDate = undefined;
            sub.remindersSent = [];
        }

        // Only an active subscription contributes recurring revenue.
        const effectivePlan = newPlan || (await Plan.findById(sub.planId));
        sub.mrr = sub.status === 'active' ? mrrFor(effectivePlan, sub.billingCycle) : 0;

        await sub.save();

        // The admin user: BOTLens credentials, and reactivation. A company
        // switched off by "Deactivate" has its admin marked inactive too; moving
        // it to any status but cancelled has to switch the admin back on, or
        // "reactivate from the Manage dialog" leaves nobody able to sign in.
        const adminSet = {};
        if (botlensEmail !== undefined && botlensEmail !== (admin.botlensEmail || null)) adminSet.botlensEmail = botlensEmail;
        if (typeof password === 'string' && password) adminSet.botlensPasswordEnc = encryptSecret(password);
        // Only on an actual status change (or leaving cancelled): editing the
        // banner days of a company must never switch its admin back on.
        const statusMoved = wasStatus === 'cancelled' || (status && status !== wasStatus);
        const reactivated = sub.status !== 'cancelled' && statusMoved && (admin.isActive === false || admin.status === 'inactive');
        if (reactivated) Object.assign(adminSet, { isActive: true, status: 'active', inactiveReason: '' });
        if (Object.keys(adminSet).length) await User.updateOne({ _id: admin._id, role: 'admin' }, { $set: adminSet });

        const updated = await Subscription.findById(sub._id)
            .select('-remindersSent')
            .populate('adminId', TENANT_ADMIN_FIELDS)
            .populate('planId')
            .lean();
        res.json({ ...updated, deadline: deadlineOf(updated), featureToggles: resolveFeatureToggles(updated.featureToggles), reactivated });
    } catch (error) {
        console.error('Update tenant error:', error);
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

exports.createTenant = async (req, res) => {
    let admin = null;
    try {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const { name, phone, email, planId, billingCycle = 'monthly', bannerThresholdDays, status = 'trial', trialDays } = body;

        // ── Validate everything before creating anything ──
        if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
            return res.status(400).json({ message: 'Please enter the company name (2 to 100 characters).' });
        }
        const cleanPhone = normalizeTenantPhone(phone);
        if (!cleanPhone) return res.status(400).json({ message: "Please enter the admin's 10-digit mobile number." });
        let cleanEmail;
        if (email !== undefined && email !== null && email !== '') {
            if (typeof email !== 'string' || email.trim().length > 254 || !TENANT_EMAIL_RE.test(email.trim())) {
                return res.status(400).json({ message: 'Please enter a valid email address, or leave it blank.' });
            }
            cleanEmail = email.trim();
        }
        if (!isObjectId(planId)) return res.status(400).json({ message: 'Please choose a plan.' });
        if (!['trial', 'active'].includes(status)) return res.status(400).json({ message: 'A new customer starts either on a free trial or as active.' });
        if (!BILLING_CYCLES.includes(billingCycle)) return res.status(400).json({ message: 'Billing cycle must be monthly or annual.' });
        const banner = wholeNumberField(bannerThresholdDays, 0, 365);
        if (Number.isNaN(banner)) return res.status(400).json({ message: 'Banner days must be a whole number from 0 to 365.' });
        const days = status === 'trial' ? wholeNumberField(trialDays, 1, 365) : undefined;
        if (Number.isNaN(days)) return res.status(400).json({ message: 'Trial length must be a whole number of days from 1 to 365.' });

        const plan = await Plan.findById(planId);
        if (!plan) return res.status(404).json({ message: 'Plan not found.' });
        if (plan.isActive === false) return res.status(400).json({ message: 'This plan is switched off. Choose another plan.' });

        // The phone is the login ID across every tenant and role.
        if (await User.exists({ phone: cleanPhone })) {
            return res.status(409).json({ message: `This phone number (${cleanPhone}) is already registered. Please use a different phone number.` });
        }

        const now = new Date();
        const cleanName = name.trim();
        admin = await User.create({
            name: cleanName,
            phone: cleanPhone,
            ...(cleanEmail ? { email: cleanEmail } : {}),
            role: 'admin',
            isActive: true,
            status: 'active',
        });

        const common = {
            adminId: admin._id,
            planId: plan._id,
            billingCycle,
            bannerThresholdDays: banner ?? 7,
            currentPeriodStart: now,
            employeesUsed: 0,
        };
        let subDoc;
        if (status === 'active') {
            subDoc = {
                ...common,
                status: 'active',
                currentPeriodEnd: periodEndFrom(now, periodDaysFor(billingCycle)),
                mrr: mrrFor(plan, billingCycle),
                history: [{ action: 'created', toPlan: plan._id, date: now, note: 'Created active by super admin' }],
            };
        } else {
            const trialLen = days ?? (plan.trialDays || 14);
            const trialEnd = periodEndFrom(now, trialLen);
            subDoc = {
                ...common,
                status: 'trial',
                trialStartDate: now,
                trialEndDate: trialEnd,
                currentPeriodEnd: trialEnd,
                mrr: 0,
                history: [{ action: 'trial_started', toPlan: plan._id, date: now, note: `Trial (${trialLen}d) created by super admin` }],
            };
        }
        const sub = await Subscription.create(subDoc);

        const result = await Subscription.findById(sub._id)
            .populate('adminId', TENANT_ADMIN_FIELDS)
            .populate('planId', 'name slug color price maxEmployees')
            .lean();
        res.status(201).json(result);
    } catch (error) {
        // Never leave an admin without a subscription behind (it would be a
        // company the Customers page cannot see or manage).
        if (admin) await User.deleteOne({ _id: admin._id, role: 'admin' }).catch(() => {});
        console.error('Create tenant error:', error);
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

exports.deactivateTenant = async (req, res) => {
    try {
        // Only a tenant admin: this used to accept any user id, including an
        // employee or the super admin's own.
        const admin = await findTenantAdmin(req.params.id);
        if (!admin) return res.status(404).json({ message: 'Customer not found.' });

        await User.updateOne(
            { _id: admin._id, role: 'admin' },
            { $set: { isActive: false, status: 'inactive', inactiveReason: TENANT_OFF_REASON } },
        );

        const sub = await Subscription.findOne({ adminId: admin._id });
        if (sub && sub.status !== 'cancelled') {
            sub.history.push({ action: 'cancelled', toPlan: sub.planId, date: new Date(), note: 'Deactivated by super admin' });
            sub.status = 'cancelled';
            sub.mrr = 0;
            await sub.save();
        }

        res.json({ message: 'Customer deactivated', admin: { _id: admin._id, name: admin.name, isActive: false } });
    } catch (error) {
        console.error('Deactivate tenant error:', error);
        res.status(500).json({ message: 'Could not deactivate this customer. Please try again.' });
    }
};

exports.deleteTenant = async (req, res) => {
    try {
        // Confirm this really is a tenant BEFORE deleting anything.
        const admin = await findTenantAdmin(req.params.id);
        if (!admin) return res.status(404).json({ message: 'Customer not found.' });
        const adminId = admin._id; // an ObjectId: every filter below is this one tenant

        // Data first, the admin and subscription last: if anything fails
        // part-way, the company still exists and the delete can be retried.
        const deleted = {};
        for (const name of TENANT_DATA_MODELS) {
            const Model = require(`../models/${name}`);
            const r = await Model.deleteMany({ adminId });
            if (r.deletedCount) deleted[name] = r.deletedCount;
        }
        // Advance requests are keyed by companyId, not adminId.
        const AdvanceSalaryRequest = require('../models/AdvanceSalaryRequest');
        const adv = await AdvanceSalaryRequest.deleteMany({ companyId: adminId });
        if (adv.deletedCount) deleted.AdvanceSalaryRequest = adv.deletedCount;

        // Biometric machines are physical inventory with a platform-wide
        // serial, so they are released rather than deleted: back to
        // unassigned, claimable by whoever owns the machine next.
        const Device = require('../models/Device');
        const { invalidateDeviceCache } = require('../utils/device_registry');
        const devices = await Device.find({ adminId }).select('serialNumber').lean();
        if (devices.length) {
            await Device.updateMany({ adminId }, {
                $set: { adminId: null, status: 'unassigned', label: '', claimedBy: null, claimedAt: null, claimedVia: null, recentUnresolved: [], offlineAlertedAt: null },
            });
            devices.forEach((d) => invalidateDeviceCache(d.serialNumber));
            deleted.DeviceReleased = devices.length;
        }

        // Employees AND sub-admins, then the subscription, then the admin.
        const staff = await User.deleteMany({ adminId, role: { $in: ['employee', 'subadmin'] } });
        if (staff.deletedCount) deleted.User = staff.deletedCount;
        const subDel = await Subscription.deleteMany({ adminId });
        if (subDel.deletedCount) deleted.Subscription = subDel.deletedCount;
        await User.deleteOne({ _id: adminId, role: 'admin' });
        deleted.Admin = 1;

        res.json({ message: 'Customer permanently deleted', deleted });
    } catch (error) {
        console.error('Delete tenant error:', error);
        res.status(500).json({ message: 'Could not finish deleting this customer. Some of its data may already be gone; please try again to finish.' });
    }
};


// ─── PLANS ───────────────────────────────────────────────────────────────────
//
// A plan decides what every company on it can use, and a change reaches those
// companies on their very next request (checkModuleAccess and getPlanLimit read
// the plan on every call; nothing caches it). So bodies are read field by
// field, never spread, and a module value must be one the catalog offers.
//
// Edits MERGE modules rather than replace the map. The builder only knows the
// active catalog, and a replace silently dropped everything else: the seeded Pro
// plan stores the legacy keys expensesAssets / crmLeads, so saving its price
// from the edit dialog switched Expenses, Assets and Leads off for its tenants
// and capped their branches and shifts at 2.

// A company counts as "on" a plan while its subscription can still be used or
// resumed. Expired and cancelled ones can only come back through the Customers
// page, which picks the plan again.
const PLAN_LIVE_STATUSES = ['active', 'trial', 'grace', 'paused'];
const PLAN_PRICE_MAX = 1000000;        // ₹10,00,000 a month
const PLAN_ANNUAL_MAX = 12000000;      // ₹1,20,00,000 a year
const PLAN_SEATS_MAX = 100000;
const PLAN_COLOR_RE = /^#[0-9a-f]{6}$/i;
const PLAN_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLAN_FIELDS = ['name', 'slug', 'price', 'annualPrice', 'maxEmployees', 'trialDays', 'color', 'isFeatured', 'isActive', 'modules', 'acceptOverSeats'];
// Read-only fields a client may echo back from GET /plans; ignored.
const PLAN_ECHO_FIELDS = ['_id', 'tenantCount', 'createdAt', 'updatedAt', '__v'];
const unknownPlanFields = (body) => Object.keys(body).filter((k) => !PLAN_FIELDS.includes(k) && !PLAN_ECHO_FIELDS.includes(k));

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slugFromName = (name) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const plainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const modulesObject = (modules) => (modules instanceof Map ? Object.fromEntries(modules) : (modules || {}));

// Whole rupees / whole counts; undefined when absent, NaN when invalid.
function planWhole(value, min, max) {
    if (value === undefined) return undefined;
    const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
    return Number.isInteger(n) && n >= min && n <= max ? n : NaN;
}

/** Live companies per plan id, in one query. */
async function planTenantCounts(planIds) {
    const rows = await Subscription.aggregate([
        { $match: { planId: { $in: planIds }, status: { $in: PLAN_LIVE_STATUSES } } },
        { $group: { _id: '$planId', n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
}

/**
 * Check a plan body. Returns { data, modules, error, status }. `data` holds the
 * scalar fields to write; `modules` the per-key values to merge.
 */
async function readPlanInput(body, existing) {
    const isCreate = !existing;
    const data = {};
    const fail = (error, status = 400) => ({ error, status });

    if (body.name !== undefined || isCreate) {
        if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 60) {
            return fail('Please enter a plan name (2 to 60 characters).');
        }
        data.name = body.name.trim().replace(/\s+/g, ' ');
    }

    if (isCreate) {
        const raw = body.slug === undefined || body.slug === null || body.slug === '' ? slugFromName(data.name) : body.slug;
        if (typeof raw !== 'string' || !PLAN_SLUG_RE.test(raw.trim()) || raw.trim().length > 40) {
            return fail('The short code may use only small letters, numbers and dashes (for example "growth-plus").');
        }
        data.slug = raw.trim();
    } else if (body.slug !== undefined && body.slug !== existing.slug) {
        return fail("A plan's short code can't be changed after it is created.");
    }

    const price = planWhole(body.price, 0, PLAN_PRICE_MAX);
    if (Number.isNaN(price) || (isCreate && price === undefined)) {
        return fail('Monthly price must be a whole number of rupees from ₹0 to ₹10,00,000.');
    }
    if (price !== undefined) data.price = price;

    if (body.annualPrice === null || body.annualPrice === '') {
        data.annualPrice = null; // billed as 12 × monthly
    } else {
        const annual = planWhole(body.annualPrice, 0, PLAN_ANNUAL_MAX);
        if (Number.isNaN(annual)) return fail('Annual price must be a whole number of rupees from ₹0 to ₹1,20,00,000, or left blank.');
        if (annual !== undefined) data.annualPrice = annual;
    }

    if (body.maxEmployees === null || body.maxEmployees === '') {
        data.maxEmployees = null; // unlimited
    } else {
        const seats = planWhole(body.maxEmployees, 1, PLAN_SEATS_MAX);
        if (Number.isNaN(seats)) return fail('Employee limit must be a whole number from 1 to 1,00,000, or left blank for unlimited.');
        if (seats !== undefined) data.maxEmployees = seats;
    }

    // At least one day: createTenant reads `plan.trialDays || 14`, so 0 would
    // quietly become a 14-day trial.
    const trial = planWhole(body.trialDays, 1, 365);
    if (Number.isNaN(trial)) return fail('Trial length must be a whole number of days from 1 to 365.');
    if (trial !== undefined) data.trialDays = trial;

    if (body.color !== undefined) {
        if (typeof body.color !== 'string' || !PLAN_COLOR_RE.test(body.color.trim())) return fail('Colour must be a hex code such as #1D9E75.');
        data.color = body.color.trim();
    }
    if (body.isFeatured !== undefined) {
        if (typeof body.isFeatured !== 'boolean') return fail('"Popular" must be on or off.');
        data.isFeatured = body.isFeatured;
    }
    if (!isCreate && body.isActive !== undefined) {
        if (typeof body.isActive !== 'boolean') return fail('Plan status must be on or off.');
        data.isActive = body.isActive;
    }

    // Duplicate names make the Customers page's plan picker ambiguous.
    if (data.name) {
        const clash = await Plan.findOne({
            name: new RegExp(`^${escapeRegex(data.name)}$`, 'i'),
            ...(existing ? { _id: { $ne: existing._id } } : {}),
        }).select('name isActive').lean();
        if (clash) return fail(`A plan called "${clash.name}" already exists${clash.isActive === false ? ' (switched off)' : ''}. Use a different name.`, 409);
    }
    if (data.slug && await Plan.exists({ slug: data.slug })) {
        return fail(`The short code "${data.slug}" is already used by another plan. Use a different one.`, 409);
    }

    const modules = {};
    if (body.modules !== undefined) {
        if (!plainObject(body.modules)) return fail('Module settings are not in the right format.');
        const features = await PlanFeature.find({ isActive: true }).lean();
        const byKey = new Map(features.map((f) => [f.key, f]));
        for (const [key, value] of Object.entries(body.modules)) {
            const f = byKey.get(key);
            if (!f) return fail(`"${key}" is not a feature in the plan catalog.`);
            if (f.type === 'select') {
                if (typeof value !== 'string' || !(f.options || []).includes(value)) {
                    return fail(`${f.label} must be one of: ${(f.options || []).join(', ')}.`);
                }
            } else if (typeof value !== 'boolean') {
                return fail(`${f.label} must be on or off.`);
            }
            modules[key] = value;
        }
    }
    return { data, modules };
}

/**
 * Companies on this plan that already have more employees than `limit`. They
 * keep everyone, but can add nobody until they are back under the cap, so a
 * seat cut is confirmed rather than applied silently.
 */
async function tenantsOverSeats(planId, limit) {
    if (limit === null || limit === undefined) return [];
    const subs = await Subscription.find({ planId, status: { $in: PLAN_LIVE_STATUSES } }).select('adminId').lean();
    if (!subs.length) return [];
    // Every employee takes a seat, active or not (the rule createUser applies).
    const rows = await User.aggregate([
        { $match: { role: 'employee', adminId: { $in: subs.map((s) => s.adminId) } } },
        { $group: { _id: '$adminId', n: { $sum: 1 } } },
    ]);
    const counts = new Map(rows.map((r) => [String(r._id), r.n]));
    const over = [];
    for (const s of subs) {
        const used = counts.get(String(s.adminId)) || 0;
        if (used > limit) over.push({ adminId: s.adminId, used });
    }
    if (!over.length) return [];
    const names = await User.find({ _id: { $in: over.map((o) => o.adminId) } }).select('name companyName').lean();
    const nameOf = new Map(names.map((u) => [String(u._id), u.companyName || u.name]));
    return over.map((o) => ({ name: nameOf.get(String(o.adminId)) || 'Unnamed company', used: o.used }));
}

async function planResponse(planId) {
    const plan = await Plan.findById(planId).lean();
    const counts = await planTenantCounts([plan._id]);
    return { ...plan, tenantCount: counts.get(String(plan._id)) || 0 };
}

exports.getPlans = async (req, res) => {
    try {
        const plans = await Plan.find({}).sort({ price: 1, name: 1 }).lean();
        const counts = await planTenantCounts(plans.map((p) => p._id));
        res.json(plans.map((plan) => ({ ...plan, tenantCount: counts.get(String(plan._id)) || 0 })));
    } catch (error) {
        console.error('Get plans error:', error);
        res.status(500).json({ message: 'Could not load plans. Please try again.' });
    }
};

exports.createPlan = async (req, res) => {
    try {
        const body = plainObject(req.body) ? req.body : {};
        const unknown = unknownPlanFields(body);
        if (unknown.length) return res.status(400).json({ message: `These fields can't be set on a plan: ${unknown.join(', ')}.` });
        const { data, modules, error, status } = await readPlanInput(body, null);
        if (error) return res.status(status).json({ message: error });
        const plan = await Plan.create({ ...data, modules, isActive: true });
        res.status(201).json(await planResponse(plan._id));
    } catch (error) {
        console.error('Create plan error:', error);
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

exports.updatePlan = async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Plan not found.' });
        const plan = await Plan.findById(req.params.id);
        if (!plan) return res.status(404).json({ message: 'Plan not found.' });

        const body = plainObject(req.body) ? req.body : {};
        const unknown = unknownPlanFields(body);
        if (unknown.length) return res.status(400).json({ message: `These fields can't be set on a plan: ${unknown.join(', ')}.` });

        const { data, modules, error, status } = await readPlanInput(body, plan);
        if (error) return res.status(status).json({ message: error });

        if (data.isActive === false && plan.isActive !== false) {
            const live = (await planTenantCounts([plan._id])).get(String(plan._id)) || 0;
            if (live) return res.status(409).json({ message: planInUseMessage(live), tenantCount: live });
        }

        // A lower (or first) seat cap is confirmed when it puts companies over.
        const oldMax = plan.maxEmployees ?? null;
        if (data.maxEmployees !== undefined && data.maxEmployees !== null && (oldMax === null || data.maxEmployees < oldMax) && body.acceptOverSeats !== true) {
            const over = await tenantsOverSeats(plan._id, data.maxEmployees);
            if (over.length) {
                const list = over.slice(0, 3).map((o) => `${o.name} (${o.used})`).join(', ');
                return res.status(409).json({
                    message: `${over.length === 1 ? '1 company on this plan has' : `${over.length} companies on this plan have`} more than ${data.maxEmployees} employees: ${list}${over.length > 3 ? ', …' : ''}. Nobody is removed, but they can't add employees until they are within the limit.`,
                    overSeats: over,
                    needsConfirm: true,
                });
            }
        }

        for (const [k, v] of Object.entries(data)) plan.set(k, v);
        for (const [k, v] of Object.entries(modules)) plan.modules.set(k, v);
        await plan.save();
        res.json(await planResponse(plan._id));
    } catch (error) {
        console.error('Update plan error:', error);
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

function planInUseMessage(n) {
    return `${n === 1 ? '1 company is' : `${n} companies are`} on this plan. Move ${n === 1 ? 'it' : 'them'} to another plan on the Companies page first, then switch this plan off.`;
}

// Soft delete: the plan is switched off (hidden from the pickers) but kept, so
// history rows and expired companies that still point at it stay readable.
exports.deletePlan = async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Plan not found.' });
        const plan = await Plan.findById(req.params.id);
        if (!plan) return res.status(404).json({ message: 'Plan not found.' });
        const live = (await planTenantCounts([plan._id])).get(String(plan._id)) || 0;
        if (live) return res.status(409).json({ message: planInUseMessage(live), tenantCount: live });
        if (plan.isActive !== false) {
            plan.isActive = false;
            await plan.save();
        }
        res.json({ message: 'Plan switched off', plan: await planResponse(plan._id) });
    } catch (error) {
        console.error('Delete plan error:', error);
        res.status(500).json({ message: 'Could not switch this plan off. Please try again.' });
    }
};

// ─── INVOICES ────────────────────────────────────────────────────────────────
//
// Invoices are money records a customer sees on their own Plan & Billing page,
// so bodies are read field by field against a whitelist (an unknown field or a
// `$` operator is refused, never passed to Mongo), the company must be a real
// tenant admin, and a paid invoice's amount cannot be edited in place.

const INVOICE_STATUSES = ['paid', 'pending', 'failed', 'refunded'];
const INVOICE_LIST_STATUSES = ['all', 'overdue', ...INVOICE_STATUSES];
const INVOICE_CREATE_FIELDS = ['adminId', 'amount', 'period', 'dueDate', 'status', 'notes'];
const INVOICE_UPDATE_FIELDS = ['amount', 'period', 'dueDate', 'status', 'notes'];
// Echoed back by a client that re-sends a whole row; ignored, never written.
const INVOICE_ECHO_FIELDS = ['_id', 'invoiceNumber', 'currency', 'createdAt', 'updatedAt', '__v', 'planId', 'subscriptionId', 'paidAt', 'overdue', 'companyDeleted'];
// The largest amount any plan can bill in one go (PLAN_ANNUAL_MAX, ₹1.2 crore).
const INVOICE_AMOUNT_MAX = 12000000;
const INVOICE_PERIOD_MAX = 40;
const INVOICE_NOTES_MAX = 500;
const INVOICE_ADMIN_FIELDS = 'name phone companyName';
const INVOICE_PLAN_FIELDS = 'name slug color';
// en-US spells September "Sep" (en-IN gives "Sept"), matching the billing form's default.
const IST_MONTH_LABEL = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', month: 'short', year: 'numeric' });

// Which status an invoice may move to from which. A refund is final; a paid
// invoice goes back to pending only through "Mark unpaid".
const INVOICE_TRANSITIONS = {
    pending: ['paid', 'failed'],
    failed: ['pending', 'paid'],
    paid: ['pending', 'refunded'],
    refunded: [],
};

// Rupees, at most two decimals, ₹1 to ₹1.2 crore. Returns undefined when
// absent and NaN when invalid.
function invoiceAmount(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : NaN);
    if (!Number.isFinite(n) || n < 1 || n > INVOICE_AMOUNT_MAX) return NaN;
    if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return NaN;
    return Math.round(n * 100) / 100;
}

// Reads a create/update body. Returns { error } or { values }.
function readInvoiceBody(body, allowed) {
    if (!plainObject(body)) return { error: 'Please send the invoice details.' };
    const unknown = Object.keys(body).filter((k) => !allowed.includes(k) && !INVOICE_ECHO_FIELDS.includes(k));
    if (unknown.length) return { error: `These fields can't be set on an invoice: ${unknown.slice(0, 5).join(', ')}.` };
    const values = {};

    if (body.amount !== undefined) {
        const amount = invoiceAmount(body.amount);
        if (Number.isNaN(amount) || amount === undefined) return { error: 'Enter an amount from ₹1 to ₹1,20,00,000, with at most two decimals.' };
        values.amount = amount;
    }
    if (body.period !== undefined) {
        if (typeof body.period !== 'string' || !body.period.trim()) return { error: 'Enter the period this invoice covers, for example "Sep 2026".' };
        if (body.period.trim().length > INVOICE_PERIOD_MAX) return { error: `Keep the period under ${INVOICE_PERIOD_MAX} characters.` };
        values.period = body.period.trim();
    }
    if (body.dueDate !== undefined) {
        if (body.dueDate === null || body.dueDate === '') values.dueDate = null;
        else {
            const due = parseTenantDay(body.dueDate);
            if (!due) return { error: 'Enter a real due date.' };
            const years = Math.abs(due.getTime() - Date.now()) / (365 * MS_DAY);
            if (years > 5) return { error: 'The due date must be within five years of today.' };
            values.dueDate = due;
        }
    }
    if (body.status !== undefined) {
        if (!INVOICE_STATUSES.includes(body.status)) return { error: 'Unknown invoice status.' };
        values.status = body.status;
    }
    if (body.notes !== undefined) {
        if (body.notes !== null && typeof body.notes !== 'string') return { error: 'Notes must be text.' };
        const notes = (body.notes || '').trim();
        if (notes.length > INVOICE_NOTES_MAX) return { error: `Keep the notes under ${INVOICE_NOTES_MAX} characters.` };
        values.notes = notes;
    }
    return { values };
}

function invoiceRow(inv, now = new Date()) {
    return {
        ...inv,
        overdue: inv.status === 'pending' && !!inv.dueDate && new Date(inv.dueDate) < now,
        companyDeleted: !inv.adminId,
    };
}

async function populatedInvoice(id) {
    const inv = await Invoice.findById(id)
        .populate('adminId', INVOICE_ADMIN_FIELDS)
        .populate('planId', INVOICE_PLAN_FIELDS)
        .lean();
    return inv ? invoiceRow(inv) : null;
}

// 'YYYY-MM-DD' as the start or end of that IST day; null when not a real day.
function istDayBound(value, end) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const noon = new Date(`${value}T12:00:00+05:30`);
    if (Number.isNaN(noon.getTime()) || istDateKey(noon) !== value) return null;
    return end ? istEndOfDay(noon) : istStartOfDay(noon);
}

exports.getInvoices = async (req, res) => {
    try {
        const q = req.query || {};
        const now = new Date();
        const status = typeof q.status === 'string' && q.status ? q.status : 'all';
        if (!INVOICE_LIST_STATUSES.includes(status)) return res.status(400).json({ message: 'Unknown status filter.' });
        const page = Math.max(1, parseInt(q.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));

        const filter = {};
        if (status === 'overdue') Object.assign(filter, { status: 'pending', dueDate: { $lt: now } });
        else if (status !== 'all') filter.status = status;

        if (q.adminId !== undefined && q.adminId !== '') {
            if (!isObjectId(q.adminId)) return res.status(400).json({ message: 'Invalid company id.' });
            filter.adminId = new mongoose.Types.ObjectId(q.adminId);
        }

        // Issued between two IST days (inclusive).
        if (q.from || q.to) {
            const from = q.from ? istDayBound(q.from, false) : null;
            const to = q.to ? istDayBound(q.to, true) : null;
            if ((q.from && !from) || (q.to && !to)) return res.status(400).json({ message: 'Enter real dates for the date range.' });
            if (from && to && from > to) return res.status(400).json({ message: 'The start date must be before the end date.' });
            filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
        }

        // Search: invoice number, or the company's name / phone. User input is
        // escaped before it becomes a RegExp.
        const search = typeof q.search === 'string' ? q.search.trim().slice(0, 100) : '';
        if (search) {
            const regex = new RegExp(escapeRegex(search), 'i');
            const matches = await User.find({ role: 'admin', $or: [{ name: regex }, { companyName: regex }, { phone: regex }] }).select('_id').lean();
            const or = [{ invoiceNumber: regex }, { adminId: { $in: matches.map((m) => m._id) } }];
            if (filter.adminId) filter.$and = [{ $or: or }];
            else filter.$or = or;
        }

        const monthStart = istMonthStartOf(now);
        const [invoices, total, filteredAgg, collected, pending, overdue, failed] = await Promise.all([
            Invoice.find(filter)
                .populate('adminId', INVOICE_ADMIN_FIELDS)
                .populate('planId', INVOICE_PLAN_FIELDS)
                .sort({ createdAt: -1, _id: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            Invoice.countDocuments(filter),
            Invoice.aggregate([{ $match: filter }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
            // Money received this IST month: by the day it was paid, not the
            // day the invoice was raised.
            Invoice.aggregate([
                { $match: { status: 'paid', paidAt: { $gte: monthStart, $lte: now } } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
            ]),
            Invoice.aggregate([{ $match: { status: 'pending' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
            Invoice.aggregate([{ $match: { status: 'pending', dueDate: { $lt: now } } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
            Invoice.aggregate([{ $match: { status: 'failed' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
        ]);

        res.json({
            invoices: invoices.map((i) => invoiceRow(i, now)),
            total,
            totalPages: Math.max(1, Math.ceil(total / limit)),
            currentPage: page,
            limit,
            filteredAmount: filteredAgg[0]?.total || 0,
            stats: {
                collected: collected[0]?.total || 0,
                collectedCount: collected[0]?.count || 0,
                pending: pending[0]?.total || 0,
                pendingCount: pending[0]?.count || 0,
                overdue: overdue[0]?.total || 0,
                overdueCount: overdue[0]?.count || 0,
                failed: failed[0]?.count || 0,
                failedAmount: failed[0]?.total || 0,
            },
            monthStart,
        });
    } catch (error) {
        console.error('Get invoices error:', error);
        res.status(500).json({ message: 'Could not load invoices. Please try again.' });
    }
};

exports.createInvoice = async (req, res) => {
    try {
        const { error, values } = readInvoiceBody(req.body, INVOICE_CREATE_FIELDS);
        if (error) return res.status(400).json({ message: error });

        const admin = await findTenantAdmin(req.body.adminId, '_id name');
        if (!admin) return res.status(404).json({ message: 'Customer not found. Choose a company from the list.' });
        if (values.amount === undefined) return res.status(400).json({ message: 'Enter the amount for this invoice.' });
        const status = values.status || 'pending';
        if (status !== 'pending' && status !== 'paid') {
            return res.status(400).json({ message: 'A new invoice can only be pending or paid.' });
        }

        const sub = await Subscription.findOne({ adminId: admin._id }).select('_id planId').lean();
        const doc = {
            adminId: admin._id,
            subscriptionId: sub?._id,
            planId: sub?.planId,
            amount: values.amount,
            currency: 'INR',
            period: values.period || IST_MONTH_LABEL.format(new Date()),
            status,
            dueDate: values.dueDate || undefined,
            notes: values.notes || undefined,
            paidAt: status === 'paid' ? new Date() : undefined,
        };

        // The number comes from an atomic counter (see models/Invoice.js). The
        // unique index still guards it; on a collision (a number entered by
        // hand elsewhere) the counter is moved past it and the create retried.
        let invoice;
        for (let attempt = 0; attempt < 3 && !invoice; attempt++) {
            try {
                invoice = await Invoice.create(doc);
            } catch (e) {
                if (e?.code === 11000 && e.keyPattern?.invoiceNumber && attempt < 2) {
                    await Invoice.resyncInvoiceCounter();
                    continue;
                }
                throw e;
            }
        }
        res.status(201).json(await populatedInvoice(invoice._id));
    } catch (error) {
        console.error('Create invoice error:', error);
        if (error?.name === 'ValidationError') return res.status(400).json({ message: friendlyMongooseError(error).message });
        res.status(500).json({ message: 'Could not create the invoice. Please try again.' });
    }
};

exports.updateInvoice = async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Invoice not found.' });
        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

        const { error, values } = readInvoiceBody(req.body, INVOICE_UPDATE_FIELDS);
        if (error) return res.status(400).json({ message: error });
        if (!Object.keys(values).length) return res.status(400).json({ message: 'Nothing to change.' });

        const admin = await findTenantAdmin(String(invoice.adminId), '_id');
        if (!admin) return res.status(409).json({ message: 'This company has been deleted, so its invoices can no longer be changed.' });

        const from = invoice.status;
        const to = values.status || from;
        if (to !== from && !INVOICE_TRANSITIONS[from].includes(to)) {
            const why = from === 'refunded' ? 'A refunded invoice is final.' : `A ${from} invoice can't be marked ${to}.`;
            return res.status(409).json({ message: why });
        }

        // The amount, period and due date of money already received stay as
        // they were paid. Mark it unpaid first to correct them.
        const moneyEdit = ['amount', 'period', 'dueDate'].some((k) => values[k] !== undefined &&
            String(values[k] ?? '') !== String(invoice[k] ?? ''));
        if (moneyEdit && (from === 'paid' || from === 'refunded') && to !== 'pending') {
            return res.status(409).json({ message: 'This invoice is already paid. Mark it unpaid first to change the amount, period or due date.' });
        }

        for (const k of ['amount', 'period', 'notes']) if (values[k] !== undefined) invoice[k] = values[k];
        if (values.dueDate !== undefined) invoice.dueDate = values.dueDate || undefined;
        if (to !== from) {
            invoice.status = to;
            if (to === 'paid') invoice.paidAt = new Date();
            if (to === 'pending' || to === 'failed') invoice.paidAt = undefined;
        }
        await invoice.save();
        res.json(await populatedInvoice(invoice._id));
    } catch (error) {
        console.error('Update invoice error:', error);
        if (error?.name === 'ValidationError') return res.status(400).json({ message: friendlyMongooseError(error).message });
        res.status(500).json({ message: 'Could not save the invoice. Please try again.' });
    }
};

// ─── ALERT RULES ─────────────────────────────────────────────────────────────

// What each rule's switch actually controls, read from the code rather than
// from the rule's stored description (the seeded descriptions promise things
// nothing implements). `wired` is true only when some job reads isEnabled.
// Keep this in step with the code: grep for the slug before calling one wired.
const ALERT_WIRING = {
    device_offline: {
        wired: true,
        effect: 'Every hour, a company whose attendance machine has not been heard from for 2 hours gets a warning, at most once a day per machine. Off: nobody is warned.',
    },
    trial_expiry: {
        wired: false,
        effect: 'Not connected. Trial reminders go out 7, 3 and 1 days before the trial ends whether this is on or off.',
    },
    renewal_reminder: {
        wired: false,
        effect: 'Not connected. Renewal reminders go out 7, 3 and 1 days before the paid period ends whether this is on or off.',
    },
    grace_expiry: {
        wired: false,
        effect: 'Not connected. A company is locked out when its grace period ends (3 days by default, not 5) whether this is on or off.',
    },
    seat_limit: {
        wired: false,
        effect: 'Not connected. Nothing warns a company as it nears its employee limit; adding an employee over the limit is simply refused.',
    },
    payment_failed: {
        wired: false,
        effect: 'Not connected. There is no online payment, so no payment can fail and nothing is retried.',
    },
    health_check: {
        wired: true,
        effect: 'Every hour at :45 the system looks through real data for wrong auto punch-outs, silent trackers, duplicate days, stuck days and similar problems, and lists them on Super admin → Health. Off: nothing is checked.',
    },
    push_on_upgrade: {
        wired: false,
        effect: 'Not connected. There are no push notifications in the app, so nothing is sent on a plan change.',
    },
};
const ALERT_UNKNOWN = { wired: false, effect: 'Not connected. No part of the system reads this rule.' };
const alertRow = (a) => {
    const w = ALERT_WIRING[a.slug] || ALERT_UNKNOWN;
    return { _id: a._id, slug: a.slug, name: a.name, description: a.description, isEnabled: a.isEnabled !== false, wired: w.wired, effect: w.effect, updatedAt: a.updatedAt };
};

exports.getAlerts = async (req, res) => {
    try {
        const alerts = await AlertRule.find({}).sort({ createdAt: 1 }).lean();
        res.json(alerts.map(alertRow));
    } catch (error) {
        console.error('Get alerts error:', error);
        res.status(500).json({ message: 'Could not load the alert rules. Please try again.' });
    }
};

// PUT /api/superadmin/alerts/:slug  { isEnabled: boolean }
// An explicit value, so a double click or two open tabs cannot flip a rule
// back. A body without isEnabled keeps the old toggle behaviour.
exports.toggleAlert = async (req, res) => {
    try {
        const slug = String(req.params.slug || '');
        if (!/^[a-z0-9_-]{1,40}$/.test(slug)) return res.status(404).json({ message: 'Alert rule not found.' });
        const want = req.body?.isEnabled;
        if (want !== undefined && typeof want !== 'boolean') {
            return res.status(400).json({ message: 'isEnabled must be true or false.' });
        }
        const alert = await AlertRule.findOne({ slug });
        if (!alert) return res.status(404).json({ message: 'Alert rule not found.' });

        alert.isEnabled = want === undefined ? !alert.isEnabled : want;
        await alert.save();

        res.json(alertRow(alert.toObject()));
    } catch (error) {
        console.error('Toggle alert error:', error);
        res.status(500).json({ message: 'Could not change the alert rule. Please try again.' });
    }
};

// ─── PLAN FEATURES ───────────────────────────────────────────────────────────
//
// The catalog is what the plan builder offers. A row does nothing by itself:
// only keys the product checks (checkModuleAccess on a router, a plan cap, the
// dashboard) change what a company can do. Those rows can't be deleted, and an
// option a plan still uses can't be removed, or plans would hold values the
// builder can no longer show or change.

// Keys some route or cap reads. advanceSalary is the catalog name for the
// 'advance-salary' route key (see LEGACY_MODULE_KEYS in subscription.middleware).
const ENFORCED_FEATURE_KEYS = [
    'attendance', 'salary', 'branchesDepts', 'shifts', 'holidays', 'tickets', 'gpsTracking',
    'assets', 'expenses', 'noticeBoard', 'leads', 'advanceSalary',
    'performance', 'policies', 'projects', 'recruitment', 'training',
];
const FEATURE_KEY_RE = /^[a-z][a-zA-Z0-9]{1,39}$/;
const FEATURE_FIELDS = ['key', 'label', 'type', 'options', 'order'];
const FEATURE_ECHO_FIELDS = ['_id', 'isActive', 'enforced', 'createdAt', 'updatedAt', '__v'];

function readFeatureOptions(raw) {
    if (!Array.isArray(raw)) return { error: 'List the choices for this feature, separated by commas.' };
    const options = raw.map((o) => (typeof o === 'string' ? o.trim().replace(/\s+/g, ' ') : o));
    if (options.some((o) => typeof o !== 'string' || !o || o.length > 30)) return { error: 'Each choice must be 1 to 30 characters.' };
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { error: 'Each choice must be different.' };
    if (options.length < 2 || options.length > 10) return { error: 'A choice feature needs 2 to 10 choices.' };
    return { options };
}

/** Plans (any status) that store a value for `key`, with that value. */
async function plansUsingFeature(key) {
    const plans = await Plan.find({ [`modules.${key}`]: { $exists: true } }).select('name modules isActive').lean();
    return plans.map((p) => ({ name: p.name, isActive: p.isActive !== false, value: modulesObject(p.modules)[key] }));
}

const featureRow = (f) => ({ ...f, enforced: ENFORCED_FEATURE_KEYS.includes(f.key) });

exports.getPlanFeatures = async (req, res) => {
    try {
        const features = await PlanFeature.find({ isActive: true }).sort({ order: 1, createdAt: 1 }).lean();
        res.json(features.map(featureRow));
    } catch (error) {
        console.error('Get plan features error:', error);
        res.status(500).json({ message: 'Could not load the feature list. Please try again.' });
    }
};

exports.createPlanFeature = async (req, res) => {
    try {
        const body = plainObject(req.body) ? req.body : {};
        const unknown = Object.keys(body).filter((k) => !FEATURE_FIELDS.includes(k));
        if (unknown.length) return res.status(400).json({ message: `These fields can't be set on a feature: ${unknown.join(', ')}.` });

        const key = typeof body.key === 'string' ? body.key.trim() : '';
        if (!FEATURE_KEY_RE.test(key)) {
            return res.status(400).json({ message: 'The key must start with a small letter and use only letters and numbers, 2 to 40 characters (for example "advancedReports").' });
        }
        const label = typeof body.label === 'string' ? body.label.trim().replace(/\s+/g, ' ') : '';
        if (label.length < 2 || label.length > 60) return res.status(400).json({ message: 'Please enter a name for the feature (2 to 60 characters).' });
        const type = body.type === undefined ? 'boolean' : body.type;
        if (!['boolean', 'select'].includes(type)) return res.status(400).json({ message: 'Type must be on/off or a choice list.' });
        let options = [];
        if (type === 'select') {
            const r = readFeatureOptions(body.options);
            if (r.error) return res.status(400).json({ message: r.error });
            options = r.options;
        }
        let order = planWhole(body.order, 0, 999);
        if (Number.isNaN(order)) return res.status(400).json({ message: 'Order must be a whole number from 0 to 999.' });

        const existing = await PlanFeature.findOne({ key }).select('isActive').lean();
        if (existing) {
            return res.status(409).json({
                message: existing.isActive === false
                    ? `The key "${key}" belonged to a feature that was removed earlier. Use a different key.`
                    : `A feature with the key "${key}" already exists.`,
            });
        }
        if (order === undefined) {
            const last = await PlanFeature.findOne({ isActive: true }).sort({ order: -1 }).select('order').lean();
            order = Math.min(999, (last?.order || 0) + 1);
        }
        const feature = await PlanFeature.create({ key, label, type, options, order, isActive: true });
        res.status(201).json(featureRow(feature.toObject()));
    } catch (error) {
        console.error('Create plan feature error:', error);
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

exports.updatePlanFeature = async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Feature not found.' });
        const feature = await PlanFeature.findOne({ _id: req.params.id, isActive: true });
        if (!feature) return res.status(404).json({ message: 'Feature not found.' });

        const body = plainObject(req.body) ? req.body : {};
        const unknown = Object.keys(body).filter((k) => !FEATURE_FIELDS.includes(k) && !FEATURE_ECHO_FIELDS.includes(k));
        if (unknown.length) return res.status(400).json({ message: `These fields can't be set on a feature: ${unknown.join(', ')}.` });

        // Plans store their values under the key, so renaming it would orphan them.
        if (body.key !== undefined && body.key !== feature.key) {
            return res.status(400).json({ message: "A feature's key can't be changed. Add a new feature instead." });
        }
        if (body.label !== undefined) {
            const label = typeof body.label === 'string' ? body.label.trim().replace(/\s+/g, ' ') : '';
            if (label.length < 2 || label.length > 60) return res.status(400).json({ message: 'Please enter a name for the feature (2 to 60 characters).' });
            feature.label = label;
        }
        if (body.order !== undefined) {
            const order = planWhole(body.order, 0, 999);
            if (Number.isNaN(order)) return res.status(400).json({ message: 'Order must be a whole number from 0 to 999.' });
            feature.order = order;
        }

        const type = body.type === undefined ? feature.type : body.type;
        if (!['boolean', 'select'].includes(type)) return res.status(400).json({ message: 'Type must be on/off or a choice list.' });
        const typeChanged = type !== feature.type;
        if (typeChanged || (type === 'select' && body.options !== undefined)) {
            const users = await plansUsingFeature(feature.key);
            if (typeChanged && users.length) {
                return res.status(409).json({ message: `${users.length === 1 ? '1 plan uses' : `${users.length} plans use`} this feature (${users.map((u) => u.name).join(', ')}), so its type can't be changed.` });
            }
            if (type === 'select') {
                const r = readFeatureOptions(body.options === undefined ? feature.options : body.options);
                if (r.error) return res.status(400).json({ message: r.error });
                const stuck = users.filter((u) => !r.options.includes(u.value));
                if (stuck.length) {
                    return res.status(409).json({
                        message: `Can't remove a choice a plan still uses: ${stuck.map((u) => `${u.name} is on "${u.value}"`).join(', ')}. Change those plans first.`,
                    });
                }
                feature.options = r.options;
            } else {
                feature.options = [];
            }
            feature.type = type;
        } else if (type === 'boolean' && body.options !== undefined && !(Array.isArray(body.options) && body.options.length === 0)) {
            return res.status(400).json({ message: 'An on/off feature has no choices.' });
        }

        await feature.save();
        res.json(featureRow(feature.toObject()));
    } catch (error) {
        console.error('Update plan feature error:', error);
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

exports.deletePlanFeature = async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Feature not found.' });
        const feature = await PlanFeature.findOne({ _id: req.params.id, isActive: true });
        if (!feature) return res.status(404).json({ message: 'Feature not found.' });
        if (ENFORCED_FEATURE_KEYS.includes(feature.key)) {
            return res.status(409).json({ message: `The app checks "${feature.label}" to decide what companies can use, so it can't be deleted. Switch it on or off on each plan instead.` });
        }
        // A plan that still holds a value would get it back, unseen, if the key
        // were ever added again; say so rather than hide it.
        const users = await plansUsingFeature(feature.key);
        await PlanFeature.deleteOne({ _id: feature._id });
        res.json({
            message: users.length
                ? `Feature deleted. ${users.length === 1 ? '1 plan still stores' : `${users.length} plans still store`} a value for it; it has no effect.`
                : 'Feature deleted',
            plansWithValue: users.length,
        });
    } catch (error) {
        console.error('Delete plan feature error:', error);
        res.status(500).json({ message: 'Could not delete this feature. Please try again.' });
    }
};

// ─── FEATURE TOGGLES ─────────────────────────────────────────────────────────

exports.updateFeatureToggles = async (req, res) => {
    try {
        const { featureToggles } = req.body || {};
        if (!featureToggles || typeof featureToggles !== 'object' || Array.isArray(featureToggles)) {
            return res.status(400).json({ message: 'featureToggles object is required' });
        }

        // Reject unknown keys rather than storing them: a typo would otherwise
        // persist silently and gate nothing.
        const unknown = Object.keys(featureToggles).filter((k) => !FEATURE_KEYS.includes(k));
        if (unknown.length) {
            return res.status(400).json({ message: `Unknown feature toggle(s): ${unknown.join(', ')}` });
        }
        // Booleans only. Boolean("false") is true, so a string used to switch
        // a feature ON while the caller meant off.
        const notBoolean = Object.entries(featureToggles).filter(([, v]) => typeof v !== 'boolean').map(([k]) => k);
        if (notBoolean.length) {
            return res.status(400).json({ message: `Each feature must be true (on) or false (off): ${notBoolean.join(', ')}` });
        }

        const admin = await findTenantAdmin(req.params.id);
        if (!admin) return res.status(404).json({ message: 'Customer not found.' });
        const sub = await Subscription.findOne({ adminId: admin._id });
        if (!sub) {
            return res.status(404).json({ message: 'This customer has no subscription record.' });
        }

        // Merge — only update keys that are explicitly sent, leave others as-is.
        // The field has no schema default, so it is absent until first written.
        if (!sub.featureToggles) sub.featureToggles = new Map();
        for (const [key, value] of Object.entries(featureToggles)) {
            sub.featureToggles.set(key, value);
        }

        await sub.save();

        res.json({ message: 'Feature toggles updated', featureToggles: resolveFeatureToggles(sub.featureToggles) });
    } catch (error) {
        console.error('Update feature toggles error:', error);
        res.status(500).json({ message: 'Could not save the feature toggles. Please try again.' });
    }
};

// ─── SYSTEM ANALYTICS ────────────────────────────────────────────────────────

// Plan keys whose route also has a per-company feature toggle (the super
// admin's switch on the Customers page). A company with the toggle off can't
// use the module whatever its plan says.
const MODULE_TOGGLE_KEYS = {
    gpsTracking: 'tracking',
    noticeBoard: 'announcements',
    leads: 'leads',
    expenses: 'expenses',
    assets: 'assets',
    advanceSalary: 'advanceSalary',
};
// The legacy combined keys seeded plans still store (subscription.middleware).
const MODULE_LEGACY_KEYS = { expenses: 'expensesAssets', assets: 'expensesAssets', leads: 'crmLeads' };

// Whether a plan gives a company this module, read the way the product reads
// it. Enforced keys follow checkModuleAccess: only false / 'none' switch a
// module off, so '10', 'unlimited', 'full + custom' and a missing key are all
// "included", and the legacy combined keys are consulted. For a key nothing
// enforces, a missing value means the plan simply doesn't offer it.
function planIncludesModule(modules, key) {
    const m = modulesObject(modules);
    let v = m[key];
    if (v === undefined && MODULE_LEGACY_KEYS[key]) v = m[MODULE_LEGACY_KEYS[key]];
    if (v === false || v === 'none' || v === 0 || v === '0') return false;
    if (v === undefined || v === null || v === '') return ENFORCED_FEATURE_KEYS.includes(key);
    return true;
}

exports.getSystemAnalytics = async (req, res) => {
    try {
        const now = new Date();
        const { companies, adminIds } = await loadCompanyBook(now);

        // ── Top companies by live employee count ─────────────────────────
        const topTenants = [...companies]
            .filter((c) => c.employees > 0)
            .sort((a, b) => b.employees - a.employees)
            .slice(0, 10)
            .map((c) => ({
                adminId: c.admin._id,
                name: c.admin.name,
                companyName: c.admin.companyName,
                employeeCount: c.employees,
                activeEmployees: c.activeEmployees,
                plan: c.plan?.name || null,
                planColor: c.plan?.color || null,
                status: c.bucket,
                mrr: c.mrr,
            }));

        // ── Module availability across live companies ───────────────────
        // Live = can use the product today: active, grace, or a trial that
        // has not run out. Legacy companies without a subscription are left
        // out; they have no plan to read.
        const live = companies.filter((c) => c.plan && ['active', 'grace', 'trial'].includes(c.bucket));
        const features = await PlanFeature.find({ isActive: true }).sort({ order: 1 }).lean();
        const featureAdoption = features.map((f) => {
            let adoptedCount = 0;
            for (const c of live) {
                if (!planIncludesModule(c.plan.modules, f.key)) continue;
                const toggle = MODULE_TOGGLE_KEYS[f.key];
                if (toggle && resolveFeatureToggles(c.sub.featureToggles)[toggle] === false) continue;
                adoptedCount++;
            }
            return {
                key: f.key,
                label: f.label,
                type: f.type,
                enforced: ENFORCED_FEATURE_KEYS.includes(f.key),
                adoptedCount,
                liveCompanies: live.length,
                adoptionPercent: live.length ? Math.round((adoptedCount / live.length) * 100) : 0,
            };
        });

        // ── Cross-company usage, this IST day / month ────────────────────
        const monthStart = istMonthStartOf(now);
        const inCompanies = { adminId: { $in: adminIds } };
        const [totalBranches, totalDepartments, attendanceToday, leavesThisMonth, expensesThisMonth, ticketsOpen] = await Promise.all([
            Branch.countDocuments(inCompanies),
            Department.countDocuments(inCompanies),
            Attendance.countDocuments({ ...inCompanies, date: { $gte: istStartOfDay(now), $lte: istEndOfDay(now) } }),
            Leave.countDocuments({ ...inCompanies, createdAt: { $gte: monthStart } }),
            Expense.aggregate([
                { $match: { ...inCompanies, createdAt: { $gte: monthStart } } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
            ]),
            Ticket.countDocuments({ ...inCompanies, status: 'pending' }),
        ]);

        // ── New companies per IST month, last six months, zeros included ─
        const [y, m] = istDateKey(now).split('-').map(Number);
        const months = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(Date.UTC(y, m - 1 - i, 1));
            months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
        }
        const tenantGrowth = months.map(({ year, month }) => {
            const { start, end } = istMonthRange(year, month);
            const joined = companies.filter((c) => c.admin.createdAt && new Date(c.admin.createdAt) >= start && new Date(c.admin.createdAt) <= end);
            const churned = companies.filter((c) => {
                if (c.bucket !== 'expired') return false;
                const at = endedAt(c.sub);
                return at && at >= start && at <= end && at <= now;
            });
            return { month: `${year}-${String(month).padStart(2, '0')}`, count: joined.length, churned: churned.length };
        });

        res.json({
            topTenants,
            featureAdoption,
            liveCompanies: live.length,
            usage: {
                totalEmployees: companies.reduce((s, c) => s + c.employees, 0),
                totalBranches,
                totalDepartments,
                attendanceToday,
                leavesThisMonth,
                expensesThisMonth: expensesThisMonth[0]?.total || 0,
                expensesCount: expensesThisMonth[0]?.count || 0,
                ticketsOpen,
            },
            tenantGrowth,
        });
    } catch (error) {
        console.error('System analytics error:', error);
        res.status(500).json({ message: 'Could not load the analytics. Please try again.' });
    }
};
