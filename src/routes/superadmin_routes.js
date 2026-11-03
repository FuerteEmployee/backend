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
    getSystemAnalytics,
    updateFeatureToggles
} = require('../controllers/superadmin_controller');
const {
    getDevices,
    createDevice,
    updateDevice,
    deleteDevice,
    clearUnresolved,
    getDevicePinMap,
    getDeviceCompanies,
} = require('../controllers/device_controller');

const { getFindings, updateFinding, runNow } = require('../controllers/health_controller');

// All routes require superadmin authentication
router.use(protect, superAdminOnly);

// A company kept on the previous release (FROZEN_TENANT_IDS) must not be
// changed from this console: its account, its plan, its invoices and its
// machines all belong to that release. Reads still work.
const Subscription = require('../models/Subscription');
const Device = require('../models/Device');
const Invoice = require('../models/Invoice');
const { frozenIds, isFrozenTenant } = require('../utils/frozen_tenants');
const FROZEN_EDIT = { code: 'frozen_tenant', message: 'This customer is kept on the classic release and cannot be changed here.' };
const refuseIf = (test) => async (req, res, next) => {
    try {
        if (frozenIds().size === 0) return next();
        if (await test(req)) return res.status(409).json(FROZEN_EDIT);
        return next();
    } catch (err) {
        return next(err);
    }
};
const tenantParam = refuseIf((req) => isFrozenTenant(req.params.id));
const bodyTenant = refuseIf((req) => isFrozenTenant(req.body?.adminId));
const planOfFrozen = refuseIf(async (req) => {
    const subs = await Subscription.find({ adminId: { $in: [...frozenIds()] } }).select('planId').lean();
    return subs.some((s) => String(s.planId) === String(req.params.id));
});
const deviceOfFrozen = refuseIf(async (req) => {
    if (isFrozenTenant(req.body?.adminId)) return true;
    const d = await Device.findById(req.params.id).select('adminId').lean().catch(() => null);
    return !!d && isFrozenTenant(d.adminId);
});
const invoiceOfFrozen = refuseIf(async (req) => {
    const inv = await Invoice.findById(req.params.id).select('adminId').lean().catch(() => null);
    return !!inv && isFrozenTenant(inv.adminId);
});

// Overview / Dashboard
router.get('/overview', getOverview);

// System Analytics
router.get('/analytics', getSystemAnalytics);

// Tenant management
router.get('/tenants', getTenants);
router.get('/tenants/:id', getTenant);
router.post('/tenants', createTenant);
router.put('/tenants/:id', tenantParam, updateTenant);
router.delete('/tenants/:id', tenantParam, deactivateTenant);
router.delete('/tenants/:id/permanent', tenantParam, deleteTenant);
router.put('/tenants/:id/feature-toggles', tenantParam, updateFeatureToggles);

// Plan management
router.get('/plans', getPlans);
router.post('/plans', createPlan);
router.put('/plans/:id', planOfFrozen, updatePlan);
router.delete('/plans/:id', planOfFrozen, deletePlan);

// Plan Features management
router.get('/plan-features', getPlanFeatures);
router.post('/plan-features', createPlanFeature);
router.put('/plan-features/:id', updatePlanFeature);
router.delete('/plan-features/:id', deletePlanFeature);

// Invoice management
router.get('/invoices', getInvoices);
router.post('/invoices', bodyTenant, createInvoice);
router.put('/invoices/:id', invoiceOfFrozen, updateInvoice);

// Alert rules
router.get('/alerts', getAlerts);
router.put('/alerts/:slug', toggleAlert);

// Health check findings (jobs/health_check.js). Read-only towards business data.
router.get('/health', getFindings);
router.post('/health/run', runNow);
router.patch('/health/:id', updateFinding);

// Biometric machines (eSSL/ZKTeco terminals). Claiming a serial number decides
// which company's attendance its punches land in, so this stays super-admin only.
router.get('/devices', getDevices);
router.get('/devices/companies', getDeviceCompanies); // every company, for the Assign picker
router.post('/devices', bodyTenant, createDevice);
router.get('/devices/:id/pin-map', getDevicePinMap);
router.post('/devices/:id/clear-unresolved', deviceOfFrozen, clearUnresolved);
router.put('/devices/:id', deviceOfFrozen, updateDevice);
router.delete('/devices/:id', deviceOfFrozen, deleteDevice);

module.exports = router;
