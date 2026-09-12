const express = require('express');
const router = express.Router();
const {
    getAudit,
    getShadowReport,
    updateAutoPunchOutMode,
    revertAutoPunchOut,
} = require('../controllers/geofence_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkSubscription } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkSubscription);

// The audit trail, including every abstention. Gated on the same permission key
// as the attendance pages, so a sub-admin who can see attendance can see why a
// day was closed -- refusing them that is refusing them the explanation for a
// record they are already looking at.
router.get('/audit', checkPermission('attendance', 'view'), getAudit);
router.get('/shadow-report', checkPermission('attendance', 'view'), getShadowReport);

// Arming the engine and undoing its decisions are both edits.
router.put('/mode', checkPermission('attendance', 'edit'), updateAutoPunchOutMode);
router.post('/revert/:attendanceId', checkPermission('attendance', 'edit'), revertAutoPunchOut);

module.exports = router;
