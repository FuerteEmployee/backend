const Subscription = require('../models/Subscription');

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
            return res.status(403).json({ message: 'Subscription expired. Please renew.' });
        }

        if (sub.status === 'paused') {
            return res.status(403).json({ message: 'Account paused. Please contact support.' });
        }

        // Check trial expiry
        if (sub.status === 'trial' && sub.trialEndDate && sub.trialEndDate < new Date()) {
            return res.status(403).json({ message: 'Trial period ended. Please subscribe to continue.' });
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
            return res.status(403).json({ message: 'Subscription expired. Please renew.' });
        }

        const moduleValue = sub.planId.modules?.[moduleName];

        // Boolean modules
        if (moduleValue === false) {
            return res.status(403).json({
                message: `${moduleName} is not available on your current plan. Please upgrade to access this feature.`,
                requiredUpgrade: true
            });
        }

        // String modules (e.g. salary: 'none' | 'basic' | 'full')
        if (moduleValue === 'none') {
            return res.status(403).json({
                message: `${moduleName} is not available on your current plan. Please upgrade to access this feature.`,
                requiredUpgrade: true
            });
        }

        req.moduleAccess = moduleValue;
        next();
    } catch (error) {
        console.error('Module access check error:', error);
        res.status(500).json({ message: 'Server error checking module access' });
    }
};

module.exports = { checkSubscription, checkModuleAccess };

