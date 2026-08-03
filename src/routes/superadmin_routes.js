const express = require('express');
const router = express.Router();
const { protect, superAdminOnly } = require('../middleware/auth.middleware');
const {
    getOverview,
    getTenants,
    getTenant,
    updateTenant,
    createTenant,
    deactivateTenant,
    deleteTenant,
    getPlans,
    createPlan,
    updatePlan,
    deletePlan,
    getInvoices,
    createInvoice,
    updateInvoice,
    getAlerts,
    toggleAlert,
    getPlanFeatures,
    createPlanFeature,
    updatePlanFeature,
    deletePlanFeature,
    getSystemAnalytics
} = require('../controllers/superadmin_controller');
const {
    getDevices,
    createDevice,
    updateDevice,
    deleteDevice,
    clearUnresolved,
    getDevicePinMap,
} = require('../controllers/device_controller');

// All routes require superadmin authentication
router.use(protect, superAdminOnly);

// Overview / Dashboard
router.get('/overview', getOverview);

// System Analytics
router.get('/analytics', getSystemAnalytics);

// Tenant management
router.get('/tenants', getTenants);
router.get('/tenants/:id', getTenant);
router.post('/tenants', createTenant);
router.put('/tenants/:id', updateTenant);
router.delete('/tenants/:id', deactivateTenant);
router.delete('/tenants/:id/permanent', deleteTenant);

// Plan management
router.get('/plans', getPlans);
router.post('/plans', createPlan);
router.put('/plans/:id', updatePlan);
router.delete('/plans/:id', deletePlan);

// Plan Features management
router.get('/plan-features', getPlanFeatures);
router.post('/plan-features', createPlanFeature);
router.put('/plan-features/:id', updatePlanFeature);
router.delete('/plan-features/:id', deletePlanFeature);

// Invoice management
router.get('/invoices', getInvoices);
router.post('/invoices', createInvoice);
router.put('/invoices/:id', updateInvoice);

// Alert rules
router.get('/alerts', getAlerts);
router.put('/alerts/:slug', toggleAlert);

// Biometric machines (eSSL/ZKTeco terminals). Claiming a serial number decides
// which company's attendance its punches land in, so this stays super-admin only.
router.get('/devices', getDevices);
router.post('/devices', createDevice);
router.get('/devices/:id/pin-map', getDevicePinMap);
router.post('/devices/:id/clear-unresolved', clearUnresolved);
router.put('/devices/:id', updateDevice);
router.delete('/devices/:id', deleteDevice);

module.exports = router;
