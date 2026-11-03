const express = require('express');
const router  = express.Router();
const { getAll, create, getById, update, remove } = require('../controllers/policy_controller');
const { protect, panelOnly, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess }        = require('../middleware/subscription.middleware');

// All routes require a valid session + module plan access
router.use(protect);
// panelOnly: checkPermission restricts sub-admins only and lets employees
// straight through, so without it an employee's token could do all of this.
router.use(panelOnly);
router.use(checkModuleAccess('policies'));

router.get('/', getAll);
router.post('/', checkPermission('policies', 'create'), create);
router.get('/:id', getById);
router.put('/:id', checkPermission('policies', 'edit'), update);
router.delete('/:id', checkPermission('policies', 'delete'), remove);

module.exports = router;
