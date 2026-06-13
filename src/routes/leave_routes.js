const express = require('express');
const router = express.Router();
const { getLeaves, addLeave, updateLeaveStatus, deleteLeave } = require('../controllers/leave_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('attendance'));

router.get('/', getLeaves);
router.post('/', checkPermission('leaves', 'create'), addLeave); // Employees pass through; sub-admins need create
router.put('/:id', checkPermission('leaves', 'edit'), updateLeaveStatus);
router.delete('/:id', checkPermission('leaves', 'delete'), deleteLeave);

module.exports = router;
