const express = require('express');
const router = express.Router();
const { getCategories, createCategory, updateCategory, deleteCategory } = require('../controllers/asset_category_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('assets'));

// --- Asset Category Configuration ---
router.get('/', getCategories); // Fetch all asset categories
router.post('/', checkPermission('assets', 'create'), createCategory); // Create a new asset category (Electronics, Furniture, etc.)
router.put('/:id', checkPermission('assets', 'edit'), updateCategory); // Update category name or details
router.delete('/:id', checkPermission('assets', 'delete'), deleteCategory); // Remove an asset category

module.exports = router;
