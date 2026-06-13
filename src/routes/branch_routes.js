const express = require('express');
const router = express.Router();
const { getBranches, createBranch, updateBranch, deleteBranch } = require('../controllers/branch_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('branchesDepts'));

// --- Branch Management ---
router.get('/', getBranches); // Fetch all registered branches for the admin
router.post('/', checkPermission('branches', 'create'), createBranch); // Register a new office/branch location with coordinates
router.put('/:id', checkPermission('branches', 'edit'), updateBranch); // Update existing branch details
router.delete('/:id', checkPermission('branches', 'delete'), deleteBranch); // Permanently remove a branch record

module.exports = router;
