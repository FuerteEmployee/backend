const express = require('express');
const router = express.Router();
const { getExpenses, addExpense, updateExpense, deleteExpense, approveExpense, rejectExpense, approveExpenseGroup, rejectExpenseGroup } = require('../controllers/expense_controller');
const { protect, checkPermission, panelOnly } = require('../middleware/auth.middleware');
const { checkSubscription, checkModuleAccess } = require('../middleware/subscription.middleware');
const { checkFeatureToggle } = require('../utils/feature_toggles');
const { uploadDocument, EXPENSE_MAX_BYTES } = require('../config/cloudinary');

// Upload failures answered in words. Left to the global error handler, a file
// over the size limit came back as a 500 "File too large" and a refused type
// as Cloudinary's own error text -- neither of which an employee can act on.
const uploadReceipt = (req, res, next) => uploadDocument.single('document')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: `This file is too big. Please attach a file smaller than ${EXPENSE_MAX_BYTES / (1024 * 1024)} MB.` });
    }
    if (/format|file type/i.test(err.message || '')) {
        return res.status(400).json({ message: 'This file type cannot be attached. Please attach a photo (JPG, PNG) or a PDF or Word file.' });
    }
    if (/invalid image/i.test(err.message || '')) {
        return res.status(400).json({ message: 'This photo could not be read. Please take the photo again.' });
    }
    return next(err);
});

router.use(protect);
// Expired / paused / ended-trial tenants are refused, as on the user,
// dashboard, device and geofence routers. checkModuleAccess below only
// checks this when the subscription has a plan attached.
router.use(checkSubscription);
router.use(checkModuleAccess('expenses'));
// Super-admin per-tenant switch. Gates the admin panel only; see feature_toggles.js.
router.use(checkFeatureToggle('expenses'));

// --- Expense Management ---
// Edit, decide and delete are panel-only (panelOnly): checkPermission alone
// lets every employee token through. Employees only list and submit.
router.get('/', checkPermission('expenses', 'view'), getExpenses); // Employees get only their own; a sub-admin needs view permission
router.post('/', checkPermission('expenses', 'create'), uploadReceipt, addExpense); // Submit a new expense claim (employees pass through)
router.put('/:id', panelOnly, checkPermission('expenses', 'edit'), updateExpense); // Update existing expense claim details
router.patch('/:id/approve', panelOnly, checkPermission('expenses', 'edit'), approveExpense); // One-click approve a pending expense claim
router.patch('/:id/reject', panelOnly, checkPermission('expenses', 'edit'), rejectExpense); // One-click reject a pending expense claim
router.patch('/group/:splitGroupId/approve', panelOnly, checkPermission('expenses', 'edit'), approveExpenseGroup); // Approve every share of a split expense together
router.patch('/group/:splitGroupId/reject', panelOnly, checkPermission('expenses', 'edit'), rejectExpenseGroup); // Reject every share of a split expense together
router.delete('/:id', panelOnly, checkPermission('expenses', 'delete'), deleteExpense); // Remove an expense record

module.exports = router;
