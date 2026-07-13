const express = require('express');
const router  = express.Router();
const { getAll, create, getById, update, remove } = require('../controllers/recruitment_controller');
const { protect, checkPermission } = require('../middleware/auth.middleware');
const { checkModuleAccess }        = require('../middleware/subscription.middleware');

// All routes require a valid session + module plan access
router.use(protect);
router.use(checkModuleAccess('recruitment'));

router.get('/', getAll);
router.post('/', checkPermission('recruitment', 'create'), create);
router.get('/:id', getById);
router.put('/:id', checkPermission('recruitment', 'edit'), update);
router.delete('/:id', checkPermission('recruitment', 'delete'), remove);

module.exports = router;
