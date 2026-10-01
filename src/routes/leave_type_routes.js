const express = require('express');
const router = express.Router();
const { getLeaveTypes, createLeaveType, updateLeaveType, deleteLeaveType } = require('../controllers/leave_type_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('attendance'));

// Leave types are company policy -- quota, paid or unpaid, pay weight -- and
// payroll reads them directly. checkPermission only gates sub-admins and lets
// every other role through, so without this an employee's token could raise
// their own quota or turn an unpaid type into a paid one. Reading stays open:
// the employee Leaves page needs the list to apply.
const adminsOnly = (req, res, next) => {
    const role = req.currentUser?.role || req.user?.role;
    if (role === 'admin' || role === 'subadmin' || role === 'superadmin') return next();
    return res.status(403).json({ message: 'Only an admin can change leave types.' });
};

// --- Leave Type Configuration ---
router.get('/', getLeaveTypes); // Fetch all leave types (Sick, Casual, Annual)
router.post('/', adminsOnly, checkPermission('leave-types', 'create'), createLeaveType); // Define a new leave type with quota and icon
router.put('/:id', adminsOnly, checkPermission('leave-types', 'edit'), updateLeaveType); // Update leave type details
router.delete('/:id', adminsOnly, checkPermission('leave-types', 'delete'), deleteLeaveType); // Remove a leave type configuration

module.exports = router;
