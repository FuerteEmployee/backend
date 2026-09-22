const express = require('express');
const path = require('path');
const os = require('os');
const multer = require('multer');
const router = express.Router();
const {
    checkForUpdate, listReleases, updateRelease,
    getApkRelease, publishApk, listApks, updateApk,
} = require('../controllers/app_release_controller');
const { protect } = require('../middleware/auth.middleware');

// The device's update check. No `protect`: the plugin calls this before login,
// and it is the channel that would deliver a fix for a build too broken to
// reach the login screen. It exposes only the current bundle version and URL,
// which is the same public JavaScript the web app already serves.
router.post('/update', checkForUpdate);

// Some firmware/proxy setups only issue GETs for health checks; answering both
// keeps a misconfigured client from silently never updating.
router.get('/update', checkForUpdate);

// The APK equivalent, unauthenticated for exactly the same reason.
router.get('/apk-release', getApkRelease);
router.post('/apk-release', getApkRelease);

/**
 * Uploading an APK is a super-admin act, and it has to say so itself.
 *
 * `checkPermission` cannot be the gate here: it waves through every role that
 * is not a sub-admin, so an ordinary employee's token would pass it. That
 * default is fine on routes employees legitimately share, and completely wrong
 * on one that publishes executable code to every handset in the company.
 */
const superAdminOnly = (req, res, next) => {
    const role = req.currentUser?.role || req.user?.role;
    if (role === 'superadmin') return next();
    return res.status(403).json({ message: 'Access denied: super admin only.' });
};

// Land the upload in the OS temp dir, not the serving directory: a half-written
// or rejected file must never be reachable at /apks, and the controller only
// moves it across once the version fields validate.
// 25 MB to match nginx's `client_max_body_size 25M` on the api server blocks.
// These two MUST agree: a file over nginx's limit is cut off at the proxy and
// the uploader gets a bare 413 that never reaches this code, so a higher limit
// here would only ever produce a confusing error. Builds are ~8 MB.
const MAX_APK_BYTES = 25 * 1024 * 1024;

const upload = multer({
    dest: path.join(os.tmpdir(), 'bot-apk-uploads'),
    limits: { fileSize: MAX_APK_BYTES },
    fileFilter: (_req, file, cb) => {
        const ok = file.originalname.toLowerCase().endsWith('.apk');
        cb(ok ? null : new Error('Only .apk files can be uploaded'), ok);
    },
});

// Operator views. Super-admin only in practice; `protect` is the floor so a
// release list is not public.
router.get('/releases', protect, listReleases);
router.put('/releases/:id', protect, updateRelease);

router.get('/apks', protect, superAdminOnly, listApks);
router.put('/apks/:id', protect, superAdminOnly, updateApk);
router.post('/apk', protect, superAdminOnly, upload.single('apk'), publishApk);

// Multer rejects (too large, wrong extension) arrive here as errors rather than
// as a normal response. Without this they surface as an opaque 500 and the
// uploader is left guessing which of the two limits they hit.
router.use((err, _req, res, next) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: 'That APK is larger than the 25 MB limit.' });
    }
    if (/Only \.apk/.test(err.message || '')) {
        return res.status(400).json({ message: err.message });
    }
    return next(err);
});

module.exports = router;
