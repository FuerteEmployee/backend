const Subscription = require('../models/Subscription');

// Same outcomes, worded for who is reading: an employee cannot renew or
// subscribe, so the only useful instruction for them is to tell the admin.
const BLOCKED_MESSAGES = {
    expired: ['Subscription expired. Please renew.', "Your company's plan has ended. Please tell your admin."],
    paused: ['Account paused. Please contact support.', "Your company's account is paused. Please tell your admin."],
    trial: ['Trial period ended. Please subscribe to continue.', "Your company's free trial has ended. Please tell your admin."],
};
const blockedMessage = (req, kind) => {
    const isEmployee = (req.currentUser?.role || req.user?.role) === 'employee';
    return BLOCKED_MESSAGES[kind][isEmployee ? 1 : 0];
};

const checkSubscription = async (req, res, next) => {
    try {
        // Super admins bypass subscription checks
        if (req.user && req.user.role === 'superadmin') {
            return next();
        }

        const sub = await Subscription.findOne({ adminId: req.adminId }).populate('planId');

        if (!sub) {
            // Fallback: if no subscription record exists, allow access (legacy tenants)
            req.subscriptionPlan = 'free';
            return next();
        }

        if (sub.status === 'expired' || sub.status === 'cancelled') {
            return res.status(403).json({ message: blockedMessage(req, 'expired'), subscriptionStatus: sub.status });
        }

        if (sub.status === 'paused') {
            return res.status(403).json({ message: blockedMessage(req, 'paused'), subscriptionStatus: 'paused' });
        }

        // Check trial expiry
        if (sub.status === 'trial' && sub.trialEndDate && sub.trialEndDate < new Date()) {
            return res.status(403).json({ message: blockedMessage(req, 'trial'), subscriptionStatus: 'expired' });
        }

        // Attach subscription data for downstream use
        req.subscription = sub;
        req.subscriptionPlan = sub.planId?.slug || 'free';

        next();
    } catch (error) {
        console.error('Subscription check error:', error);
        res.status(500).json({ message: 'Server error checking subscription' });
    }
};

// Names people read, for the plan keys routes gate on. The raw key used to go
// straight into the message ("noticeBoard is not available on your current
// plan"), and employees saw it too.
const MODULE_LABELS = {
    attendance: 'Attendance',
    salary: 'Salary & payroll',
    branchesDepts: 'Branches & departments',
    shifts: 'Shift management',
    holidays: 'Festivals & holidays',
    tickets: 'Helpdesk tickets',
    gpsTracking: 'GPS tracking',
    assets: 'Assets management',
    expenses: 'Expense management',
    noticeBoard: 'Notice board',
    leads: 'Lead management',
    performance: 'Performance',
    policies: 'HR policies',
    projects: 'Projects',
    recruitment: 'Recruitment',
    training: 'Training',
    'advance-salary': 'Advance salary & loans',
};

// Plans created by seedSuperAdmin.js before the plan-builder catalog existed
// store combined keys. Without this fallback a seeded plan could never switch
// Expenses, Assets or Leads off: the route asked for `expenses`, the plan only
// had `expensesAssets`, and an undefined module is allowed. The route's own key
// always wins when the plan has it.
const LEGACY_MODULE_KEYS = {
    expenses: 'expensesAssets',
    assets: 'expensesAssets',
    leads: 'crmLeads',
    // Not legacy: the advance router gates on 'advance-salary', but a catalog
    // key must be camelCase, so a plan-builder row would be 'advanceSalary'.
    // Without this alias such a row could never switch advances off.
    'advance-salary': 'advanceSalary',
};

const readModule = (modules, key) => modules?.get?.(key) ?? modules?.[key];

// Employees cannot change the plan, so telling them to upgrade is noise; the
// admin is who can act on it.
const moduleUnavailable = (req, moduleName) => {
    const label = MODULE_LABELS[moduleName] || moduleName;
    const isEmployee = (req.currentUser?.role || req.user?.role) === 'employee';
    return {
        message: isEmployee
            ? `${label} is not available for your company.`
            : `${label} is not included in your current plan. Upgrade to use it.`,
        requiredUpgrade: true,
    };
};

/**
 * Middleware factory for plan-based module gating.
 * Usage: router.use('/tracking', checkModuleAccess('gpsTracking'), trackingRoutes)
 */
const checkModuleAccess = (moduleName) => async (req, res, next) => {
    try {
        // Super admins bypass module checks
        if (req.user && req.user.role === 'superadmin') {
            return next();
        }

        const sub = await Subscription.findOne({ adminId: req.adminId }).populate('planId');

        if (!sub || !sub.planId) {
            return next(); // Fallback: allow access for legacy tenants
        }

        if (sub.status === 'expired' || sub.status === 'cancelled') {
            return res.status(403).json({ message: blockedMessage(req, 'expired'), subscriptionStatus: sub.status });
        }

        if (sub.status === 'paused') {
            return res.status(403).json({ message: blockedMessage(req, 'paused'), subscriptionStatus: 'paused' });
        }

        // A trial whose window has elapsed but hasn't been flipped yet by the cron.
        if (sub.status === 'trial' && sub.trialEndDate && sub.trialEndDate < new Date()) {
            return res.status(403).json({ message: blockedMessage(req, 'trial'), subscriptionStatus: 'expired' });
        }

        // planId.modules is a Mongoose Map — bracket access never reads a Map's
        // entries (only .get() does), so this must try .get() first or a
        // disabled/limited module silently falls through as `undefined` and is
        // never blocked. Falls back to bracket access for a plain object (e.g.
        // if the plan was ever populated/lean()'d into a POJO upstream).
        const modules = sub.planId.modules;
        let moduleValue = readModule(modules, moduleName);
        if (moduleValue === undefined && LEGACY_MODULE_KEYS[moduleName]) {
            moduleValue = readModule(modules, LEGACY_MODULE_KEYS[moduleName]);
        }

        // Boolean modules, and string modules (e.g. salary: 'none' | 'basic' | 'full')
        if (moduleValue === false || moduleValue === 'none') {
            return res.status(403).json(moduleUnavailable(req, moduleName));
        }

        req.moduleAccess = moduleValue;
        next();
    } catch (error) {
        console.error('Module access check error:', error);
        res.status(500).json({ message: 'Server error checking module access' });
    }
};

module.exports = { checkSubscription, checkModuleAccess };

