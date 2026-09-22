const express = require('express');
const router = express.Router();
const {
    reportClient,
    reportClientError,
    reportTrackerEvents,
    getClientDevices,
    getClientErrors,
    getTrackerEvents,
    getLoginSessions,
} = require('../controllers/client_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkSubscription } = require('../middleware/subscription.middleware');

// --- Client self-reporting (employee's own token) ---
// Deliberately NOT subscription-gated. These are diagnostics: a tenant whose
// subscription lapsed is precisely when the app is throwing blocking errors at
// employees, and gating the report would blind us to that. They write only the
// caller's own device/error rows, so there's nothing here to withhold.
router.post('/report', protect, reportClient);
router.post('/error', protect, reportClientError);
// Device-state transitions (GPS off, network lost, battery saver on). Ungated
// for the same reason as the two above, and more so: the whole point is to
// still learn why an employee's tracking stopped on a tenant whose billing
// lapsed — exactly when they will be complaining that it did.
router.post('/events', protect, reportTrackerEvents);

// --- Admin-facing reads ---
router.use(protect);
router.use(checkSubscription);

// Surfaced on the employee detail page and the employees list, so they follow
// the same permission key those pages use.
router.get('/devices', checkPermission('employees', 'view'), getClientDevices);
router.get('/errors', checkPermission('employees', 'view'), getClientErrors);
router.get('/events', checkPermission('employees', 'view'), getTrackerEvents);

// Login history for the Settings access-log table. Left on plain tenant scoping
// rather than a checkPermission key, because `settings` has no permission entry
// in the sidebar-derived map and inventing one here would gate a page that
// currently has no gate.
router.get('/sessions', getLoginSessions);

module.exports = router;
