const express = require('express');
const router = express.Router();
const {
    punchIn, punchOut, lunchIn, lunchOut, getReports, updateAttendance, getEmployeeHistory,
    markAbsent, getAbsentToday, getStats,
} = require('../controllers/attendance_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('attendance'));

// --- Daily Punch Actions ---
router.post('/punch-in', punchIn); // Record daily arrival with geofencing check
router.post('/punch-out', punchOut); // Record daily departure and calculate work hours
router.post('/lunch-in', lunchIn); // Record start of lunch break
router.post('/lunch-out', lunchOut); // Record end of lunch break

// --- Reports & Management ---
router.get('/my-history', getEmployeeHistory); // Employee views their own monthly attendance logs
router.get('/reports', getReports); // Fetch attendance history/reports for employees (Admin)
router.get('/stats', getStats); // Bundled KPI counts + shift-wise breakdown for the Attendance page
router.get('/absent-today', getAbsentToday); // Active employees with no punch record today

// NOTE: literal paths above must stay registered before the "/:id" wildcard below.
router.put('/mark-absent', checkPermission('attendance', 'edit'), markAbsent); // Admin marks an employee absent
router.put('/:id', checkPermission('attendance', 'edit'), updateAttendance); // Admin update for specific attendance record

module.exports = router;
