const express = require('express');
const router = express.Router();
const { getShifts, getShiftUsage, createShift, updateShift, deleteShift } = require('../controllers/shift_controller');
const { protect, panelOnly, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('shifts'));

// panelOnly on every route. checkPermission restricts sub-admins only and
// lets employees straight through, so without it an employee's token could do
// all of this. The list is panel-only too: the employee app reads its own
// shift from /users/profile and never calls this, and the list now carries
// per-shift headcounts.
//
// The list itself is NOT gated on shifts.view: the employee form, the
// attendance filters and Settings > Default Shift all need the names.

// Plan cap usage ("N of M used") for the page's New Shift button.
router.get('/usage', panelOnly, getShiftUsage);

// --- Shift Management ---
router.get('/', panelOnly, getShifts); // List all configured shifts (start/end times) with headcounts
router.post('/', panelOnly, checkPermission('shifts', 'create'), createShift); // Create a new shift schedule
router.put('/:id', panelOnly, checkPermission('shifts', 'edit'), updateShift); // Update shift timings or name
router.delete('/:id', panelOnly, checkPermission('shifts', 'delete'), deleteShift); // Remove a shift configuration

module.exports = router;
