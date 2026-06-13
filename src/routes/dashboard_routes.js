const express = require('express');
const router = express.Router();
const { getSummary, getEmployeeDashboard } = require('../controllers/dashboard_controller');
const { protect } = require('../middleware/auth.middleware');

router.use(protect);

// --- Dashboard APIs ---
router.get('/summary', getSummary); // Admin Summary (Total employees, present today, stats)
router.get('/employee', getEmployeeDashboard); // Employee Dashboard (Personal stats, today's punch, monthly summary)

module.exports = router;
