const express = require('express');
const router  = express.Router();
const { getAll, create, getById, update, remove } = require('../controllers/performance_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess }        = require('../middleware/subscription.middleware');

// All routes require a valid session + module plan access
router.use(protect);
router.use(checkModuleAccess('performance'));

router.get('/', getAll);
router.post('/', checkPermission('performance', 'create'), create);
router.get('/:id', getById);
router.put('/:id', checkPermission('performance', 'edit'), update);
router.delete('/:id', checkPermission('performance', 'delete'), remove);

module.exports = router;
