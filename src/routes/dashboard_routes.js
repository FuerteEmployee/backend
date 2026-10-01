const express = require('express');
const router = express.Router();
const { getSummary, getEmployeeDashboard } = require('../controllers/dashboard_controller');
const { protect, panelOnly, checkPermission } = require('../middleware/auth.middleware');
const { checkSubscription } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkSubscription); // block expired/paused/expired-trial tenants

// --- Dashboard APIs ---
// panelOnly refuses employees; checkPermission refuses a sub-admin whose
// Dashboard permission is off (it lets every other role through, which is why
// it cannot stand alone). The sidebar already hid the page from that
// sub-admin, but the summary -- payroll total included -- was one request away.
router.get('/summary', panelOnly, checkPermission('dashboard', 'view'), getSummary); // Admin Summary (Total employees, present today, stats)
router.get('/employee', getEmployeeDashboard); // Employee Dashboard (Personal stats, today's punch, monthly summary)

module.exports = router;
