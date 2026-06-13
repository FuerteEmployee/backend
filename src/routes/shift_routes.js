const express = require('express');
const router = express.Router();
const { getShifts, createShift, updateShift, deleteShift } = require('../controllers/shift_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('shifts'));

// --- Shift Management ---
router.get('/', getShifts); // List all configured shifts (start/end times)
router.post('/', checkPermission('shifts', 'create'), createShift); // Create a new shift schedule
router.put('/:id', checkPermission('shifts', 'edit'), updateShift); // Update shift timings or name
router.delete('/:id', checkPermission('shifts', 'delete'), deleteShift); // Remove a shift configuration

module.exports = router;
