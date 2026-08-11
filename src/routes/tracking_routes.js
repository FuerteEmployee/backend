const express = require('express');
const router = express.Router();
const { updateLocation, getLatestLocations, getHistory, getStats, requestPing, checkPing } = require('../controllers/tracking_controller');
const { protect } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('gpsTracking'));

// --- Real-time Tracking ---
router.post('/update', updateLocation); // Update current GPS location of an employee
router.get('/latest', getLatestLocations); // Admin view of latest locations for all active employees
router.get('/history', getHistory); // One employee's full route for a day (for the map polyline)
router.get('/stats', getStats); // Bundled counts for the Tracking page's stat cards
router.post('/ping/:employeeId', requestPing); // Admin asks a device for a fresh fix right now
router.get('/ping-check', checkPing); // The employee's own device polls for a pending ping

module.exports = router;
