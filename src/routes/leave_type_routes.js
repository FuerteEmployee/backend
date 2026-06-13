const express = require('express');
const router = express.Router();
const { getLeaveTypes, createLeaveType, updateLeaveType, deleteLeaveType } = require('../controllers/leave_type_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('attendance'));

// --- Leave Type Configuration ---
router.get('/', getLeaveTypes); // Fetch all leave types (Sick, Casual, Annual)
router.post('/', checkPermission('leave-types', 'create'), createLeaveType); // Define a new leave type with quota and icon
router.put('/:id', checkPermission('leave-types', 'edit'), updateLeaveType); // Update leave type details
router.delete('/:id', checkPermission('leave-types', 'delete'), deleteLeaveType); // Remove a leave type configuration

module.exports = router;
