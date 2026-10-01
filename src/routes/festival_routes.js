const express = require('express');
const multer = require('multer');
const router = express.Router();
const { getFestivals, createFestival, updateFestival, deleteFestival } = require('../controllers/festival_controller');
const { protect, checkPermission, panelOnly } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');
const { upload } = require('../config/cloudinary');

// The shared `upload` has no size limit, while the page promises "max 5 MB".
// Same Cloudinary storage (and its jpg/png/webp list), with the limit added.
const POSTER_MAX_BYTES = 5 * 1024 * 1024;
const posterUpload = multer({ storage: upload.storage, limits: { fileSize: POSTER_MAX_BYTES } });

// Upload failures answered in words, as expense receipts are. Left to the
// global error handler they came back as a 500 carrying Cloudinary's own text.
const uploadPoster = (req, res, next) => posterUpload.single('poster')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: 'This picture is too big. Please choose one smaller than 5 MB.' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ message: 'Please attach only one picture.' });
    }
    if (/format|file type|invalid image/i.test(err.message || '')) {
        return res.status(400).json({ message: 'This picture type cannot be used. Please choose a JPG, PNG or WebP image.' });
    }
    return next(err);
});

router.use(protect);
router.use(checkModuleAccess('holidays'));

// --- Festival & Holiday Management ---
// Employees read the list (Holidays page, Home card) but never write it.
// panelOnly sits in front of the upload so an employee's request is refused
// before a poster reaches Cloudinary; the controller refuses them as well.
// checkPermission runs before upload so denied requests never hit Cloudinary.
router.get('/', checkPermission('festivals', 'view'), getFestivals); // Fetch all registered festivals/holidays (sub-admins need view; employees pass)
router.post('/', panelOnly, checkPermission('festivals', 'create'), uploadPoster, createFestival); // Add new festival with optional poster image
router.put('/:id', panelOnly, checkPermission('festivals', 'edit'), uploadPoster, updateFestival); // Update festival details or poster
router.delete('/:id', panelOnly, checkPermission('festivals', 'delete'), deleteFestival); // Remove a festival from the list

module.exports = router;
