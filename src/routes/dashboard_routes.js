const express = require('express');
const router = express.Router();
const { getSummary, getEmployeeDashboard } = require('../controllers/dashboard_controller');
const { protect } = require('../middleware/auth.middleware');
const { checkSubscription } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkSubscription); // block expired/paused/expired-trial tenants

// --- Dashboard APIs ---
router.get('/summary', getSummary); // Admin Summary (Total employees, present today, stats)
router.get('/employee', getEmployeeDashboard); // Employee Dashboard (Personal stats, today's punch, monthly summary)

module.exports = router;
