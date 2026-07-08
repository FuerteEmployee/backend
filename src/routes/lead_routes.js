const express = require('express');
const router = express.Router();
const { getLeads, addLead, updateLead, deleteLead } = require('../controllers/lead_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');
const { upload } = require('../config/cloudinary');

router.use(protect);
router.use(checkModuleAccess('leads'));

// --- Sales Lead Management ---
router.get('/', getLeads); // List all sales leads/prospects
router.post('/', checkPermission('leads', 'create'), upload.array('images', 5), addLead); // Create a new lead record
router.put('/:id', checkPermission('leads', 'edit'), updateLead); // Update lead status or contact info
router.delete('/:id', checkPermission('leads', 'delete'), deleteLead); // Remove a lead from the system

module.exports = router;
