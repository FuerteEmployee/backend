const express = require('express');
const router = express.Router();
const { getLeads, addLead, updateLead, deleteLead } = require('../controllers/lead_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');
const { checkFeatureToggle } = require('../utils/feature_toggles');
const { upload } = require('../config/cloudinary');

router.use(protect);
router.use(checkModuleAccess('leads'));
// Super-admin per-tenant switch. Gates the admin panel only; see feature_toggles.js.
router.use(checkFeatureToggle('leads'));

// --- Sales Lead Management ---
// checkPermission restricts sub-admins only; an employee passes and the
// controller scopes the list to the leads they brought in.
router.get('/', checkPermission('leads', 'view'), getLeads); // List all sales leads/prospects
router.post('/', checkPermission('leads', 'create'), upload.array('images', 5), addLead); // Create a new lead record
router.put('/:id', checkPermission('leads', 'edit'), updateLead); // Update lead status or contact info
router.delete('/:id', checkPermission('leads', 'delete'), deleteLead); // Remove a lead from the system

module.exports = router;
