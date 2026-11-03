const express = require('express');
const router = express.Router();
const { getAssets, addAsset, updateAsset, deleteAsset } = require('../controllers/asset_controller');
const { protect, panelOnly, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');
const { checkFeatureToggle } = require('../utils/feature_toggles');

router.use(protect);
// panelOnly: checkPermission restricts sub-admins only and lets employees
// straight through, so without it an employee's token could do all of this.
router.use(panelOnly);
router.use(checkModuleAccess('assets'));
// Super-admin per-tenant switch. Gates the admin panel only; see feature_toggles.js.
router.use(checkFeatureToggle('assets'));

// --- Asset Inventory ---
router.get('/', checkPermission('assets', 'view'), getAssets); // List all company assets (Laptops, Mobiles, etc.)
router.post('/', checkPermission('assets', 'create'), addAsset); // Record a new asset in the inventory
router.put('/:id', checkPermission('assets', 'edit'), updateAsset); // Update asset assignment or details
router.delete('/:id', checkPermission('assets', 'delete'), deleteAsset); // Remove an asset from inventory

module.exports = router;
