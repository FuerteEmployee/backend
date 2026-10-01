const express = require('express');
const router = express.Router();
const { updateLocation, updateLocationBatch, getLatestLocations, getHistory, getHeldFixes, getStats, requestPing, checkPing } = require('../controllers/tracking_controller');
const { protect, panelOnly, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');
const { checkFeatureToggle } = require('../utils/feature_toggles');

router.use(protect);
router.use(checkModuleAccess('gpsTracking'));
// Super-admin per-tenant switch. Gates the admin panel only; see feature_toggles.js.
router.use(checkFeatureToggle('tracking'));

// --- Real-time Tracking ---
router.post('/update', updateLocation); // Update current GPS location of an employee
router.post('/update/batch', updateLocationBatch); // Bulk flush from the native background tracker's offline queue
// panelOnly: checkPermission restricts sub-admins only and lets employees
// straight through, so without it an employee's token could do all of this.
// checkPermission('tracking', ...) is what limits a sub-admin to what the
// Sub-admins page granted them; it passes admins straight through.
router.get('/latest', panelOnly, checkPermission('tracking', 'view'), getLatestLocations); // Admin view of latest locations for all active employees
router.get('/history', panelOnly, checkPermission('tracking', 'view'), getHistory); // One employee's full route for a day (for the map polyline)
router.get('/held-fixes', panelOnly, checkPermission('tracking', 'view'), getHeldFixes); // Fixes delivered late -- the offline backlog, proving what was recovered rather than lost
router.get('/stats', panelOnly, checkPermission('tracking', 'view'), getStats); // Bundled counts for the Tracking page's stat cards
router.post('/ping/:employeeId', panelOnly, checkPermission('tracking', 'edit'), requestPing); // Admin asks a device for a fresh fix right now
router.get('/ping-check', checkPing); // The employee's own device polls for a pending ping

module.exports = router;
