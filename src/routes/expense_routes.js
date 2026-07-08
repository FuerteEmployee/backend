const express = require('express');
const router = express.Router();
const { getExpenses, addExpense, updateExpense, deleteExpense, approveExpense, rejectExpense } = require('../controllers/expense_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');
const { uploadDocument } = require('../config/cloudinary');

router.use(protect);
router.use(checkModuleAccess('expenses'));

// --- Expense Management ---
router.get('/', getExpenses); // Fetch expense claims for the user/admin
router.post('/', checkPermission('expenses', 'create'), uploadDocument.single('document'), addExpense); // Submit a new expense claim (employees pass through)
router.put('/:id', checkPermission('expenses', 'edit'), updateExpense); // Update existing expense claim details
router.patch('/:id/approve', checkPermission('expenses', 'edit'), approveExpense); // One-click approve a pending expense claim
router.patch('/:id/reject', checkPermission('expenses', 'edit'), rejectExpense); // One-click reject a pending expense claim
router.delete('/:id', checkPermission('expenses', 'delete'), deleteExpense); // Remove an expense record

module.exports = router;
