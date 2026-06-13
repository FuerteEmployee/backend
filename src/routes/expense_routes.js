const express = require('express');
const router = express.Router();
const { getExpenses, addExpense, updateExpense, deleteExpense } = require('../controllers/expense_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('expenses'));

// --- Expense Management ---
router.get('/', getExpenses); // Fetch expense claims for the user/admin
router.post('/', checkPermission('expenses', 'create'), addExpense); // Submit a new expense claim (employees pass through)
router.put('/:id', checkPermission('expenses', 'edit'), updateExpense); // Update existing expense claim details
router.delete('/:id', checkPermission('expenses', 'delete'), deleteExpense); // Remove an expense record

module.exports = router;
