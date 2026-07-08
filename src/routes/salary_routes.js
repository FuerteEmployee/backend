const express = require('express');
const router = express.Router();
const { getSalaryByEmployee, getMonthlyReport, updateSalary, generateSalaries, generateSalaryForEmployee, deleteSalary } = require('../controllers/salary_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('salary'));

// --- Salary Generation & CRUD ---
router.post('/generate', checkPermission('salary', 'create'), generateSalaries);
router.post('/generate-one', checkPermission('salary', 'create'), generateSalaryForEmployee);
router.put('/:id', checkPermission('salary', 'edit'), updateSalary); // Update an existing salary record details
router.delete('/:id', checkPermission('salary', 'delete'), deleteSalary); // Delete a salary record

// --- Reports & Retrieval ---
router.get('/employee/:employeeId', getSalaryByEmployee); // Get salary history for a specific employee
router.get('/report', getMonthlyReport); // Get a combined salary report for a specific month

module.exports = router;
