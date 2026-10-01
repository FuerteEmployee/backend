const express = require('express');
const router = express.Router();
const { getDepartments, getDepartmentUsage, createDepartment, updateDepartment, deleteDepartment } = require('../controllers/department_controller');
const { protect, panelOnly, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess } = require('../middleware/subscription.middleware');

router.use(protect);
router.use(checkModuleAccess('branchesDepts'));

// Plan cap usage ("N of M used") for the page's Add button.
router.get('/usage', panelOnly, getDepartmentUsage);

// --- Department Management ---
router.get('/', getDepartments); // List all departments (Engineering, HR, etc.)
// panelOnly: checkPermission restricts sub-admins only and lets employees
// straight through, so without it an employee's token could do all of this.
router.post('/', panelOnly, checkPermission('departments', 'create'), createDepartment); // Add a new department with custom color code
router.put('/:id', panelOnly, checkPermission('departments', 'edit'), updateDepartment); // Edit department name or color
router.delete('/:id', panelOnly, checkPermission('departments', 'delete'), deleteDepartment); // Remove a department record

module.exports = router;
