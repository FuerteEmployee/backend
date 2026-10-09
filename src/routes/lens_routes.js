const express = require('express');
const router = express.Router();
const { protect, adminOnly, panelOnly, checkPermission, protectLens } = require('../middleware/auth.middleware');
const { checkSubscription, checkModuleAccess } = require('../middleware/subscription.middleware');
const lens = require('../controllers/lens_controller');

// Face kiosk (BOTLens). Three callers, three guards -- see lens_controller.js.

// 1. The admin, signed in on the kiosk, creating it. Their own token.
router.post('/kiosks', protect, adminOnly, checkSubscription, checkModuleAccess('attendance'), lens.createKiosk);

// 2. The admin panel. Same page and permission as the fingerprint machines.
const panel = [protect, panelOnly, checkSubscription];
router.get('/admin/kiosks', ...panel, checkPermission('biometric-devices', 'view'), lens.adminListKiosks);
router.delete('/admin/kiosks/:id', ...panel, checkPermission('biometric-devices', 'edit'), lens.adminRevokeKiosk);
router.get('/admin/faces', ...panel, checkPermission('biometric-devices', 'view'), lens.adminListFaces);
router.delete('/admin/faces/:employeeId', ...panel, checkPermission('biometric-devices', 'edit'), lens.adminDeleteFace);

// 3. The kiosk itself, with its own key. Registered last so the paths above
//    never fall through to the kiosk guard.
const kiosk = [protectLens, checkSubscription, checkModuleAccess('attendance')];
router.get('/me', ...kiosk, lens.me);
router.get('/employees', ...kiosk, lens.listEmployees);
router.get('/faces', ...kiosk, lens.listFaces);
router.post('/enroll-grant', ...kiosk, lens.enrollGrant);
router.put('/faces/:employeeId', ...kiosk, lens.requireEnrollGrant, lens.saveFace);
router.delete('/faces/:employeeId', ...kiosk, lens.requireEnrollGrant, lens.deleteFace);
router.post('/taps', ...kiosk, lens.recordSighting);
router.get('/activity', ...kiosk, lens.activity);

module.exports = router;
