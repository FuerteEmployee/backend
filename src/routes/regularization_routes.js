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

router.get('/', getRegularizations);
router.post('/', checkPermission('attendance', 'create'), submitRegularization);
router.patch('/:id/approve', checkPermission('attendance', 'edit'), approveRegularization);
router.patch('/:id/reject', checkPermission('attendance', 'edit'), rejectRegularization);

module.exports = router;
