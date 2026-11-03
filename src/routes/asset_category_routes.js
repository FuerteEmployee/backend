const express = require('express');
const router = express.Router();
const { getCategories, createCategory, updateCategory, deleteCategory } = require('../controllers/asset_category_controller');
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

// --- Asset Category Configuration ---
router.get('/', checkPermission('assets', 'view'), getCategories); // Fetch all asset categories
router.post('/', checkPermission('assets', 'create'), createCategory); // Create a new asset category (Electronics, Furniture, etc.)
router.put('/:id', checkPermission('assets', 'edit'), updateCategory); // Update category name or details
router.delete('/:id', checkPermission('assets', 'delete'), deleteCategory); // Remove an asset category

module.exports = router;
