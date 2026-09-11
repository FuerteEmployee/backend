const express = require('express');
const router = express.Router();
const { checkForUpdate, listReleases, updateRelease } = require('../controllers/app_release_controller');
const { protect } = require('../middleware/auth.middleware');

// The device's update check. No `protect`: the plugin calls this before login,
// and it is the channel that would deliver a fix for a build too broken to
// reach the login screen. It exposes only the current bundle version and URL,
// which is the same public JavaScript the web app already serves.
router.post('/update', checkForUpdate);

// Some firmware/proxy setups only issue GETs for health checks; answering both
// keeps a misconfigured client from silently never updating.
router.get('/update', checkForUpdate);

// Operator views. Super-admin only in practice; `protect` is the floor so a
// release list is not public.
router.get('/releases', protect, listReleases);
router.put('/releases/:id', protect, updateRelease);

module.exports = router;
