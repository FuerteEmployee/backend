const express = require('express');
const router = express.Router();
const { getDepartments, createDepartment, updateDepartment, deleteDepartment } = require('../controllers/department_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('branchesDepts'));

// --- Department Management ---
router.get('/', getDepartments); // List all departments (Engineering, HR, etc.)
router.post('/', checkPermission('departments', 'create'), createDepartment); // Add a new department with custom color code
router.put('/:id', checkPermission('departments', 'edit'), updateDepartment); // Edit department name or color
router.delete('/:id', checkPermission('departments', 'delete'), deleteDepartment); // Remove a department record

module.exports = router;
