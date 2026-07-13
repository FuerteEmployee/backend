const express = require('express');
const router  = express.Router();
const { getAll, create, getById, update, remove } = require('../controllers/project_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess }        = require('../middleware/subscription.middleware');

// All routes require a valid session + module plan access
router.use(protect);
router.use(checkModuleAccess('projects'));

router.get('/', getAll);
router.post('/', checkPermission('projects', 'create'), create);
router.get('/:id', getById);
router.put('/:id', checkPermission('projects', 'edit'), update);
router.delete('/:id', checkPermission('projects', 'delete'), remove);

module.exports = router;
