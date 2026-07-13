const express = require('express');
const router  = express.Router();
const { getAll, create, getById, update, remove } = require('../controllers/training_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess }        = require('../middleware/subscription.middleware');

// All routes require a valid session + module plan access
router.use(protect);
router.use(checkModuleAccess('training'));

router.get('/', getAll);
router.post('/', checkPermission('training', 'create'), create);
router.get('/:id', getById);
router.put('/:id', checkPermission('training', 'edit'), update);
router.delete('/:id', checkPermission('training', 'delete'), remove);

module.exports = router;
