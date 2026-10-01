const express = require('express');
const router = express.Router();
const { getBranches, getBranchUsage, createBranch, updateBranch, deleteBranch } = require('../controllers/branch_controller');
const { protect, panelOnly, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('branchesDepts'));

// Plan cap usage ("N of M used") for the page's Add button.
router.get('/usage', panelOnly, getBranchUsage);

// --- Branch Management ---
router.get('/', getBranches); // Fetch all registered branches for the admin
// panelOnly: checkPermission restricts sub-admins only and lets employees
// straight through, so without it an employee's token could do all of this.
router.post('/', panelOnly, checkPermission('branches', 'create'), createBranch); // Register a new office/branch location with coordinates
router.put('/:id', panelOnly, checkPermission('branches', 'edit'), updateBranch); // Update existing branch details
router.delete('/:id', panelOnly, checkPermission('branches', 'delete'), deleteBranch); // Permanently remove a branch record

module.exports = router;
