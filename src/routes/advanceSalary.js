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
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

// Apply auth to all routes
router.use(protect);
router.use(checkModuleAccess('advance-salary'));

// GET /api/advance-salary
// List requests with filters
router.get('/', getAdvanceSalaryRequests);

// GET /api/advance-salary/summary
// 4 stat totals: pending/approved/rejected/repaid
router.get('/summary', getAdvanceSalarySummary);

// POST /api/advance-salary
// Create a new request
router.post('/', createAdvanceSalaryRequest);

// PATCH /api/advance-salary/:id/approve
// Approve a pending request (admin/superadmin only)
router.patch('/:id/approve', checkPermission('advance-salary', 'edit'), approveAdvanceSalary);

// PATCH /api/advance-salary/:id/reject
// Reject a pending request (admin/superadmin only)
router.patch('/:id/reject', checkPermission('advance-salary', 'edit'), rejectAdvanceSalary);

// PATCH /api/advance-salary/:id/repaid
// Mark as repaid (admin/superadmin only)
router.patch('/:id/repaid', checkPermission('advance-salary', 'edit'), markAdvanceSalaryRepaid);

module.exports = router;
