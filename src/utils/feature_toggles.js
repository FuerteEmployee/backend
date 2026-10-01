// Per-tenant feature toggles, set by the super admin on the Customers page.
//
// This file is the one place the defaults live. The Subscription schema, the
// tenant read endpoint, the super-admin write endpoint and the route gate all
// read FEATURE_TOGGLE_DEFAULTS from here, so they cannot drift apart. The
// frontend keeps a mirror in src/hooks/use-feature-toggles.ts -- change both.
//
// Every feature that already shipped to tenants defaults to ON. Defaulting one
// to false removes it from every existing tenant the moment this deploys,
// because none of them has a toggle row yet (this is what happened to Assets).
// The five dormant modules have no page behind them, so OFF costs nothing.
//
// No model is required at the top level: Subscription.js requires this file
// for its schema default, so a top-level require back would be a load cycle.

const FEATURE_TOGGLE_DEFAULTS = Object.freeze({
    tracking: true,
    geofenceAutoPunchOut: true,
    leads: true,
    expenses: true,
    advanceSalary: true,
    announcements: true,
    biometricDevices: true,
    assets: true,
    recruitment: false,
    training: false,
    performance: false,
    projects: false,
    policies: false,
});

const FEATURE_KEYS = Object.freeze(Object.keys(FEATURE_TOGGLE_DEFAULTS));

// Merge a stored toggle set (a Mongoose Map on a hydrated doc, a plain object
// after .lean(), or nothing at all) over the defaults.
function resolveFeatureToggles(stored) {
    const saved = stored instanceof Map ? Object.fromEntries(stored) : (stored || {});
    const out = { ...FEATURE_TOGGLE_DEFAULTS };
    for (const key of FEATURE_KEYS) {
        if (typeof saved[key] === 'boolean') out[key] = saved[key];
    }
    return out;
}

async function getTenantFeatureToggles(adminId) {
    const Subscription = require('../models/Subscription');
    const sub = await Subscription.findOne({ adminId }).select('featureToggles').lean();
    return resolveFeatureToggles(sub?.featureToggles);
}

async function isTenantFeatureEnabled(adminId, key) {
    const toggles = await getTenantFeatureToggles(adminId);
    return toggles[key] !== false;
}

/**
 * Route gate: refuse the admin panel's use of a feature the super admin has
 * switched off for this tenant.
 *
 * Only panel roles (admin, subadmin) are gated -- the same people the sidebar
 * hides the page from. Employees are deliberately let through: their phones
 * post GPS fixes and read the notice board in the background, and builds
 * already installed in the field would start throwing on every sync if those
 * calls began to 403. Superadmin bypasses, as with every other gate.
 *
 * Mount after `protect`, which sets req.user and req.adminId.
 */
const checkFeatureToggle = (key) => async (req, res, next) => {
    try {
        // The role re-read from the database by `protect`, not the one frozen
        // into a 30-day JWT (the same order panelOnly and checkPermission use).
        const role = req.currentUser?.role || req.user?.role;
        if (role !== 'admin' && role !== 'subadmin') return next();

        if (await isTenantFeatureEnabled(req.adminId, key)) return next();

        return res.status(403).json({
            message: 'This feature is not enabled for your organisation. Contact support to turn it on.',
            featureDisabled: true,
            feature: key,
        });
    } catch (error) {
        console.error('Feature toggle check error:', error);
        res.status(500).json({ message: 'Server error checking feature access' });
    }
};

module.exports = {
    FEATURE_TOGGLE_DEFAULTS,
    FEATURE_KEYS,
    resolveFeatureToggles,
    getTenantFeatureToggles,
    isTenantFeatureEnabled,
    checkFeatureToggle,
};
