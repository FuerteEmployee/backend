const express = require('express');
const router = express.Router();
const { getAnnouncements, addAnnouncement, updateAnnouncement, deleteAnnouncement, togglePin } = require('../controllers/announcement_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('noticeBoard'));

// --- Announcements & News ---
router.get('/', getAnnouncements); // Fetch all company announcements
router.post('/', checkPermission('announcements', 'create'), addAnnouncement); // Post a new announcement for employees
router.put('/:id', checkPermission('announcements', 'edit'), updateAnnouncement); // Edit an existing announcement
router.delete('/:id', checkPermission('announcements', 'delete'), deleteAnnouncement); // Remove an announcement
router.patch('/:id/pin', checkPermission('announcements', 'edit'), togglePin); // Pin/Unpin announcement to the top of the feed

module.exports = router;
