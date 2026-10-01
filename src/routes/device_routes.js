const express = require('express');
const router = express.Router();
const { protect, panelOnly, checkPermission } = require('../middleware/auth.middleware');
const { checkSubscription, checkModuleAccess } = require('../middleware/subscription.middleware');
const { checkFeatureToggle } = require('../utils/feature_toggles');
const {
    getMyDevices,
    claimDevice,
    updateMyDevice,
    releaseMyDevice,
    clearMyUnresolved,
    setEmployeePin,
} = require('../controllers/device_controller');

// Company admins manage their own biometric machines here: register a serial,
// rename it, pause it, or detach it.
//
// The one thing they CANNOT do is take over a serial already registered to a
// different company — that would silently divert another company's attendance.
// Moving a claimed machine between companies, and deleting a device record
// outright, stay under /api/superadmin/devices.
router.use(protect);
// panelOnly: checkPermission restricts sub-admins only and lets employees
// straight through, so without it an employee's token could do all of this.
router.use(panelOnly);
router.use(checkSubscription);
router.use(checkModuleAccess('attendance'));
// Super-admin per-tenant switch. Gates the admin panel only; see feature_toggles.js.
router.use(checkFeatureToggle('biometricDevices'));

router.get('/', checkPermission('biometric-devices', 'view'), getMyDevices);
router.post('/', checkPermission('biometric-devices', 'create'), claimDevice);
router.put('/pins/:employeeId', checkPermission('biometric-devices', 'edit'), setEmployeePin);
router.put('/:id', checkPermission('biometric-devices', 'edit'), updateMyDevice);
router.delete('/:id', checkPermission('biometric-devices', 'delete'), releaseMyDevice);
router.post('/:id/clear-unresolved', checkPermission('biometric-devices', 'edit'), clearMyUnresolved);

module.exports = router;
