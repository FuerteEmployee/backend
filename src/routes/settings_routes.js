const express = require('express');
const router = express.Router();
const { getSettings, updateSettings, getFeatureToggles } = require('../controllers/settings_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkSubscription } = require('../middleware/subscription.middleware');
const { upload } = require('../config/cloudinary');

// Panel roles only (admin, superadmin, subadmin) — employees stay blocked.
const panelOnly = (req, res, next) => {
    const role = req.currentUser?.role || req.user?.role;
    if (role === 'admin' || role === 'superadmin' || role === 'subadmin') return next();
    return res.status(403).json({ message: 'Access denied: Admin only' });
};

// Feature toggles — what modules the super admin has enabled for this tenant.
// Readable by any panel role so the sidebar can gate menu items.
router.get('/feature-toggles', protect, panelOnly, getFeatureToggles);

// --- System Settings ---
// GET stays readable by all panel roles: several admin pages (employee form,
// shifts, attendance config) fetch settings even without the Settings page right.
router.get('/', protect, panelOnly, checkSubscription, getSettings);
// Writes require the settings edit right for sub-admins.
router.put('/', protect, panelOnly, checkSubscription, checkPermission('settings', 'edit'), upload.single('logo'), updateSettings);

module.exports = router;
