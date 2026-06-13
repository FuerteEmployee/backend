const express = require('express');
const router = express.Router();
const { getAssets, addAsset, updateAsset, deleteAsset } = require('../controllers/asset_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('assets'));

// --- Asset Inventory ---
router.get('/', getAssets); // List all company assets (Laptops, Mobiles, etc.)
router.post('/', checkPermission('assets', 'create'), addAsset); // Record a new asset in the inventory
router.put('/:id', checkPermission('assets', 'edit'), updateAsset); // Update asset assignment or details
router.delete('/:id', checkPermission('assets', 'delete'), deleteAsset); // Remove an asset from inventory

module.exports = router;
