const express = require('express');
const router = express.Router();
const {
    getAdvanceSalaryRequests,
    createAdvanceSalaryRequest,
    getAdvanceSalarySummary,
    approveAdvanceSalary,
    rejectAdvanceSalary,
    markAdvanceSalaryRepaid
} = require('../controllers/advanceSalary');
const { protect, checkPermission, panelOnly } = require('../middleware/auth.middleware');
const { checkSubscription, checkModuleAccess } = require('../middleware/subscription.middleware');
const { checkFeatureToggle } = require('../utils/feature_toggles');

// Apply auth to all routes
router.use(protect);
// Expired / paused / ended-trial tenants are refused, as on the user,
// dashboard, device and geofence routers. checkModuleAccess below only
// checks this when the subscription has a plan attached.
router.use(checkSubscription);
router.use(checkModuleAccess('advance-salary'));
// Super-admin per-tenant switch. Gates the admin panel only; see feature_toggles.js.
router.use(checkFeatureToggle('advanceSalary'));

// GET /api/advance-salary
// List requests with filters. Employees get only their own (controller);
// a sub-admin needs the page's view permission, as the sidebar already
// assumes -- without it the list was readable straight from the API.
router.get('/', checkPermission('advance-salary', 'view'), getAdvanceSalaryRequests);

// GET /api/advance-salary/summary
// 4 stat totals: pending/approved/rejected/repaid
router.get('/summary', checkPermission('advance-salary', 'view'), getAdvanceSalarySummary);

// POST /api/advance-salary
// Create a new request (the controller accepts employees only)
router.post('/', createAdvanceSalaryRequest);

// Decisions below are panel-only at the route: checkPermission waves every
// non-subadmin through, employees included. The controller additionally
// limits them to admin/superadmin.

// PATCH /api/advance-salary/:id/approve
// Approve a pending request (admin/superadmin only)
router.patch('/:id/approve', panelOnly, checkPermission('advance-salary', 'edit'), approveAdvanceSalary);

// PATCH /api/advance-salary/:id/reject
// Reject a pending request (admin/superadmin only)
router.patch('/:id/reject', panelOnly, checkPermission('advance-salary', 'edit'), rejectAdvanceSalary);

// PATCH /api/advance-salary/:id/repaid
// Mark as repaid (admin/superadmin only)
router.patch('/:id/repaid', panelOnly, checkPermission('advance-salary', 'edit'), markAdvanceSalaryRepaid);

module.exports = router;
