const express = require('express');
const router = express.Router();
const {
    loginRequest,
    verifyOtp,
    verifyBotlensCredentials,
    getProfile,
    getMySubscription,
    getMyInvoices,
    logout,
    getUsers,
    getEmployees,
    getEmployeeUsage,
    getCoworkers,
    createUser,
    updateUser,
    updateEmployeeDocuments,
    updateProfile,
    deleteUser,
    getAdminUsers,
    createAdminUser,
    updateAdminUser,
    deleteAdminUser,
} = require('../controllers/user_controller');
const { protect, adminOnly, panelOnly, checkPermission } = require('../middleware/auth.middleware');
const { checkSubscription } = require('../middleware/subscription.middleware');
const { upload, uploadIdDocument } = require('../config/cloudinary');

// PAN/Aadhaar scans (front and back). Upload errors come back in plain words
// rather than as a 500 carrying Cloudinary's text.
const ID_DOCUMENT_FIELDS = [{ name: 'panCard', maxCount: 2 }, { name: 'aadhaarCard', maxCount: 2 }];
const uploadIdScans = (req, res, next) => uploadIdDocument.fields(ID_DOCUMENT_FIELDS)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ message: 'Attach at most 2 photos each for PAN and Aadhaar (front and back).' });
    }
    if (/format|file type/i.test(err.message || '')) {
        return res.status(400).json({ message: 'This file type cannot be attached. Please attach a photo (JPG, PNG, WebP) or a PDF.' });
    }
    if (/invalid image/i.test(err.message || '')) {
        return res.status(400).json({ message: 'This photo could not be read. Please take the photo again.' });
    }
    return next(err);
});

// --- Auth Routes ---
router.post('/login-request', loginRequest); // Request OTP for login via phone
router.post('/verify-otp', verifyOtp); // Verify OTP and receive JWT token
router.post('/logout', protect, logout); // Record a logout in the access log + clear activeToken (not subscription-gated)
router.get('/profile', protect, getProfile); // Get currently logged-in user details
router.get('/subscription', protect, getMySubscription); // Get current tenant subscription/trial status (not subscription-gated; employees refused, sub-admins get the banner fields only)
router.get('/subscription/invoices', protect, adminOnly, getMyInvoices); // The tenant's own invoices for Plan & Billing (not subscription-gated, so a lapsed tenant can still see them)
router.post('/verify-add-employee', protect, verifyBotlensCredentials); // Re-confirm admin identity before BOTLens adds an employee (not subscription-gated)
router.put('/profile', protect, uploadIdDocument.fields([
    { name: 'logo', maxCount: 1 },
    ...ID_DOCUMENT_FIELDS,
]), updateProfile); // Update logged-in user profile, incl. PAN/Aadhaar scans

// --- User Management (Protected) ---
// Auth + profile + subscription routes above stay open even when expired so the
// client can still log in and read its subscription state. Everything below is
// tenant data management and is gated on an active subscription.
router.use(protect);
router.use(checkSubscription);
// panelOnly on everything but /coworkers. checkPermission alone let any
// EMPLOYEE token through: it could list every colleague's full record
// (salary, PAN/Aadhaar scans), delete co-workers, and -- because create and
// update copied the request body wholesale -- set `role: 'superadmin'` on a
// new account or on its own. The employee app only ever calls /coworkers.
router.get('/', panelOnly, getUsers); // List all users under the admin
router.get('/employees', panelOnly, getEmployees); // Fetch only employee role users
router.get('/employees/usage', panelOnly, getEmployeeUsage); // Seats used vs the plan's cap ("N of M used")
router.get('/coworkers', getCoworkers); // Minimal id+name colleague list (e.g. for bill-split pickers)
router.post('/employees', panelOnly, checkPermission('employees', 'create'), createUser); // Create a new employee record
router.put('/employees/:id', panelOnly, checkPermission('employees', 'edit'), updateUser); // Update specific employee details by ID
router.put('/employees/:id/documents', panelOnly, checkPermission('employees', 'edit'), uploadIdScans, updateEmployeeDocuments); // Admin uploads PAN/Aadhaar scans for an employee
router.delete('/employees/:id', panelOnly, checkPermission('employees', 'delete'), deleteUser); // Delete a specific employee record

// Subadmin management (admin only — sub-admins cannot manage other sub-admins)
router.get('/admin-users', adminOnly, getAdminUsers);
router.post('/admin-users', adminOnly, createAdminUser);
router.put('/admin-users/:id', adminOnly, updateAdminUser);
router.delete('/admin-users/:id', adminOnly, deleteAdminUser);

module.exports = router;
