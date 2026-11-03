const express = require('express');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const router = express.Router();
const { getSettings, updateSettings, getFeatureToggles } = require('../controllers/settings_controller');
const { protect, panelOnly, checkPermission } = require('../middleware/auth.middleware');
const { checkSubscription } = require('../middleware/subscription.middleware');
const { cloudinary } = require('../config/cloudinary');

// Company logo upload. The shared `upload` had no size limit and let any file
// through to Cloudinary, whose refusal of a GIF or a PDF surfaced as a raw
// error. Checked here instead, before anything is uploaded.
const LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const logoUpload = multer({
    storage: new CloudinaryStorage({
        cloudinary,
        params: { folder: 'bot-uploads', allowed_formats: ['jpg', 'png', 'jpeg', 'webp'] },
    }),
    limits: { fileSize: LOGO_MAX_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
        if (LOGO_TYPES.includes(file.mimetype)) return cb(null, true);
        const err = new Error('The logo must be a JPG, PNG or WebP image.');
        err.code = 'LOGO_TYPE';
        return cb(err);
    },
}).single('logo');

function uploadLogo(req, res, next) {
    logoUpload(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: 'The logo is too large. Use an image under 2 MB.' });
        if (err.code === 'LOGO_TYPE') return res.status(400).json({ message: err.message });
        if (err instanceof multer.MulterError) return res.status(400).json({ message: 'Upload one logo image at a time.' });
        console.error('[settings] logo upload failed:', err.message);
        return res.status(502).json({ message: 'The logo could not be uploaded. Please try again.' });
    });
}

// Feature toggles — what modules the super admin has enabled for this tenant.
// Readable by any panel role so the sidebar can gate menu items.
router.get('/feature-toggles', protect, panelOnly, getFeatureToggles);

// --- System Settings ---
// GET stays readable by all panel roles: several admin pages (employee form,
// shifts, attendance config) fetch settings even without the Settings page right.
router.get('/', protect, panelOnly, checkSubscription, getSettings);
// Writes require the settings edit right for sub-admins.
router.put('/', protect, panelOnly, checkSubscription, checkPermission('settings', 'edit'), uploadLogo, updateSettings);

module.exports = router;
