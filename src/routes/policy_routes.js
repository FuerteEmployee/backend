const express = require('express');
const router  = express.Router();
const { getAll, create, getById, update, remove } = require('../controllers/policy_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess }        = require('../middleware/subscription.middleware');

// All routes require a valid session + module plan access
router.use(protect);
router.use(checkModuleAccess('policies'));

router.get('/', getAll);
router.post('/', checkPermission('policies', 'create'), create);
router.get('/:id', getById);
router.put('/:id', checkPermission('policies', 'edit'), update);
router.delete('/:id', checkPermission('policies', 'delete'), remove);

module.exports = router;
