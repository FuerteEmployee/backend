const express = require('express');
const router = express.Router();
const { updateLocation, getLatestLocations } = require('../controllers/tracking_controller');
const { protect } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('gpsTracking'));

// --- Real-time Tracking ---
router.post('/update', updateLocation); // Update current GPS location of an employee
router.get('/latest', getLatestLocations); // Admin view of latest locations for all active employees

module.exports = router;
