const express = require('express');
const router = express.Router();
const {
    getAnnouncements, addAnnouncement, updateAnnouncement, deleteAnnouncement, togglePin,
    markSeen, markRead, respond, getResults,
} = require('../controllers/announcement_controller');
const { protect, checkPermission, panelOnly } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');
const { checkFeatureToggle } = require('../utils/feature_toggles');

router.use(protect);
router.use(checkModuleAccess('noticeBoard'));
// Super-admin per-tenant switch. Gates the admin panel only; see feature_toggles.js.
router.use(checkFeatureToggle('announcements'));

// --- Announcements & News ---
// Employees read the board but never write it; panelOnly refuses them at the
// route (the controller refuses them too). Sub-admins need the matching
// announcements.* permission, including view to read the list.
router.get('/', checkPermission('announcements', 'view'), getAnnouncements); // Fetch all company announcements (employees pass)
router.post('/', panelOnly, checkPermission('announcements', 'create'), addAnnouncement); // Post a new announcement for employees
router.put('/:id', panelOnly, checkPermission('announcements', 'edit'), updateAnnouncement); // Edit an existing announcement
router.delete('/:id', panelOnly, checkPermission('announcements', 'delete'), deleteAnnouncement); // Remove an announcement
router.patch('/:id/pin', panelOnly, checkPermission('announcements', 'edit'), togglePin); // Pin/Unpin announcement to the top of the feed

// Employees mark notices seen/read and answer their questions. Only for
// themselves: the controller takes the employee from the token, never the body,
// and only for notices meant for them.
const employeesOnly = (req, res, next) => {
    const role = req.currentUser?.role || req.user?.role;
    if (role === 'employee') return next();
    return res.status(403).json({ message: 'Only employees answer notices.' });
};
router.post('/seen', employeesOnly, markSeen);
router.post('/:id/read', employeesOnly, markRead);
router.post('/:id/respond', employeesOnly, respond);
// Who read, who answered what, and who has not yet.
router.get('/:id/results', panelOnly, checkPermission('announcements', 'view'), getResults);

module.exports = router;
