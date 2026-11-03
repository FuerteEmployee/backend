const express = require('express');
const router = express.Router();
const { getLeaves, getLeaveBalances, addLeave, updateLeaveStatus, deleteLeave } = require('../controllers/leave_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('attendance'));

// Approving is an ADMIN act, and checkPermission does not say so.
//
// checkPermission gates sub-admins and waves every other role straight through,
// so an employee holding a valid token could PUT { status: 'approved' } on their
// OWN leave -- which also kicks off a salary recompute that pays it -- or approve
// and reject a co-worker's. Same hole, and same fix, as the regularization routes.
const reviewersOnly = (req, res, next) => {
    const role = req.currentUser?.role || req.user?.role;
    if (role === 'admin' || role === 'subadmin' || role === 'superadmin') return next();
    return res.status(403).json({ message: 'Only an admin can approve or reject leave requests.' });
};

// Employees pass checkPermission and getLeaves limits them to their own rows.
// Sub-admins need leaves:view: without it this handed the whole company's
// leave list to any sub-admin, whatever their permissions said.
router.get('/', checkPermission('leaves', 'view'), getLeaves);
// Used / waiting / left per type for the tenant's balance period. An employee
// gets their own; a panel user passes ?employeeId= (sub-admins need leaves:view).
router.get('/balances', checkPermission('leaves', 'view'), getLeaveBalances);
router.post('/', checkPermission('leaves', 'create'), addLeave); // Employees pass through; sub-admins need create
router.put('/:id', reviewersOnly, checkPermission('leaves', 'edit'), updateLeaveStatus);
// No reviewersOnly: an employee may cancel their own request while it is still
// pending. deleteLeave enforces "own" and "pending" for employees itself.
router.delete('/:id', checkPermission('leaves', 'delete'), deleteLeave);

module.exports = router;
