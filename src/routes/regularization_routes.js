const express = require('express');
const router = express.Router();
const {
    getRegularizations,
    submitRegularization,
    approveRegularization,
    rejectRegularization,
} = require('../controllers/regularization_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('attendance'));

// Approving is an ADMIN act, and checkPermission does not say so.
//
// checkPermission gates sub-admins and waves every other role straight through
// -- by design, because employees legitimately share routes like punch and
// leave-apply. On approve/reject that default is backwards: an employee holding
// a valid token could approve their OWN correction, writing arbitrary punch
// times onto their attendance and kicking off a salary recompute. Nothing but
// the absence of a button was stopping them, and this feature adds the button.
const reviewersOnly = (req, res, next) => {
    const role = req.currentUser?.role || req.user?.role;
    if (role === 'admin' || role === 'subadmin' || role === 'superadmin') return next();
    return res.status(403).json({ message: 'Access denied: only an admin can review correction requests.' });
};

router.get('/', getRegularizations);
// No reviewersOnly here: employees submitting their own request is the point.
// submitRegularization takes employeeId from the token, never the body.
router.post('/', checkPermission('attendance', 'create'), submitRegularization);
router.patch('/:id/approve', reviewersOnly, checkPermission('attendance', 'edit'), approveRegularization);
router.patch('/:id/reject', reviewersOnly, checkPermission('attendance', 'edit'), rejectRegularization);

module.exports = router;
