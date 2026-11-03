const express = require('express');
const router = express.Router();
const {
    punchIn, punchOut, lunchIn, lunchOut, getReports, updateAttendance, getEmployeeHistory,
    markAbsent, getAbsentToday, getStats, getPunchLog, getToday, getMissedPunchOuts,
} = require('../controllers/attendance_controller');
const { protect, panelOnly, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('attendance'));

// --- Daily Punch Actions ---
router.post('/punch-in', punchIn); // Record daily arrival with geofencing check
router.post('/punch-out', punchOut); // Record daily departure and calculate work hours
router.post('/lunch-in', lunchIn); // Record start of lunch break
router.post('/lunch-out', lunchOut); // Record end of lunch break

// --- Reports & Management ---
router.get('/today', getToday); // The caller's OWN day -- polled by the native background tracker to decide whether to keep running
router.get('/my-history', getEmployeeHistory); // Employee views their own monthly attendance logs
router.get('/missed-punch-outs', getMissedPunchOuts); // The caller's OWN recent days auto-closed at shift end, awaiting their confirmation
// panelOnly: checkPermission restricts sub-admins only and lets employees
// straight through, so without it an employee's token could do all of this.
// checkPermission('attendance', 'view'): the sidebar hides Attendance from a
// sub-admin without that permission, and the API has to agree -- these used to
// answer any sub-admin, so the page was hidden but its data was not.
const canView = checkPermission('attendance', 'view');
router.get('/reports', panelOnly, canView, getReports); // Fetch attendance history/reports for employees (Admin)
router.get('/stats', panelOnly, canView, getStats); // Bundled KPI counts + shift-wise breakdown for the Attendance page
router.get('/absent-today', panelOnly, canView, getAbsentToday); // Active employees expected today with no graded record
router.get('/punch-log', panelOnly, canView, getPunchLog); // Every raw device tap for one employee on one day (drives the expandable tap list)

// NOTE: literal paths above must stay registered before the "/:id" wildcard below.
router.put('/mark-absent', panelOnly, checkPermission('attendance', 'edit'), markAbsent); // Admin marks an employee absent
router.put('/:id', panelOnly, checkPermission('attendance', 'edit'), updateAttendance); // Admin update for specific attendance record

module.exports = router;
