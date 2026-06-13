const express = require('express');
const router = express.Router();
const {
    loginRequest,
    verifyOtp,
    getProfile,
    getUsers,
    getEmployees,
    createUser,
    updateUser,
    updateProfile,
    deleteUser,
    getAdminUsers,
    createAdminUser,
    updateAdminUser,
    deleteAdminUser,
} = require('../controllers/user_controller');
const { protect, adminOnly, checkPermission } = require('../middleware/auth.middleware');
const { upload } = require('../config/cloudinary');

// --- Auth Routes ---
router.post('/login-request', loginRequest); // Request OTP for login via phone
router.post('/verify-otp', verifyOtp); // Verify OTP and receive JWT token
router.get('/profile', protect, getProfile); // Get currently logged-in user details
router.put('/profile', protect, upload.single('logo'), updateProfile); // Update logged-in user profile with image

// --- User Management (Protected) ---
router.use(protect);
router.get('/', getUsers); // List all users under the admin
router.get('/employees', getEmployees); // Fetch only employee role users
router.post('/employees', checkPermission('employees', 'create'), createUser); // Create a new employee record
router.put('/employees/:id', checkPermission('employees', 'edit'), updateUser); // Update specific employee details by ID
router.delete('/employees/:id', checkPermission('employees', 'delete'), deleteUser); // Delete a specific employee record

// Subadmin management (admin only — sub-admins cannot manage other sub-admins)
router.get('/admin-users', adminOnly, getAdminUsers);
router.post('/admin-users', adminOnly, createAdminUser);
router.put('/admin-users/:id', adminOnly, updateAdminUser);
router.delete('/admin-users/:id', adminOnly, deleteAdminUser);

// Base CRUD aliases
router.post('/', createUser); // Generic create user
router.put('/:id', updateUser); // Generic update user
router.delete('/:id', deleteUser); // Generic delete user

module.exports = router;
