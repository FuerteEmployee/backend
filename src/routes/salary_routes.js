const express = require('express');
const router = express.Router();
const { getSalaryByEmployee, getMonthlyReport, updateSalary, generateSalaries, generateSalaryForEmployee, deleteSalary } = require('../controllers/salary_controller');
const { protect, panelOnly, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('salary'));

// --- Salary Generation & CRUD ---
// panelOnly: checkPermission restricts sub-admins only and lets employees
// straight through, so without it an employee's token could do all of this.
router.post('/generate', panelOnly, checkPermission('salary', 'create'), generateSalaries);
router.post('/generate-one', panelOnly, checkPermission('salary', 'create'), generateSalaryForEmployee);
router.put('/:id', panelOnly, checkPermission('salary', 'edit'), updateSalary); // Update an existing salary record details
router.delete('/:id', panelOnly, checkPermission('salary', 'delete'), deleteSalary); // Delete a salary record

// --- Reports & Retrieval ---
router.get('/employee/:employeeId', checkPermission('salary', 'view'), getSalaryByEmployee); // Get salary history for a specific employee
router.get('/report', panelOnly, checkPermission('salary', 'view'), getMonthlyReport); // Get a combined salary report for a specific month

module.exports = router;
