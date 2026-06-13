const express = require('express');
const router = express.Router();
const { getFestivals, createFestival, updateFestival, deleteFestival } = require('../controllers/festival_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');
const { upload } = require('../config/cloudinary');

router.use(protect);
router.use(checkModuleAccess('holidays'));

// --- Festival & Holiday Management ---
// checkPermission runs before upload so denied requests never hit Cloudinary
router.get('/', getFestivals); // Fetch all registered festivals/holidays
router.post('/', checkPermission('festivals', 'create'), upload.single('poster'), createFestival); // Add new festival with optional poster image
router.put('/:id', checkPermission('festivals', 'edit'), upload.single('poster'), updateFestival); // Update festival details or poster
router.delete('/:id', checkPermission('festivals', 'delete'), deleteFestival); // Remove a festival from the list

module.exports = router;
