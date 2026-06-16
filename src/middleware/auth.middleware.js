const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
    let token;

    const authHeader = req.headers.authorization;

    if (authHeader) {
        try {
            // Support both "Bearer <token>" and raw "<token>"
            if (authHeader.startsWith('Bearer ')) {
                token = authHeader.split(' ')[1];
            } else {
                token = authHeader;
            }

            if (!token) {
                return res.status(401).json({ message: 'Not authorized, no token provided' });
            }
            
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            req.adminId = decoded.adminId;
            req.userId = decoded.userId;
            req.user = decoded;

            const user = await User.findById(req.userId);
            if (!user || user.status === 'inactive') {
                return res.status(401).json({ message: 'Not authorized, user inactive or not found' });
            }

            // Make the full user record (incl. permissions) available downstream
            req.currentUser = user;

            // Multiple-device login is allowed: do not reject tokens superseded
            // by a login on another device. (Single-device enforcement disabled.)

            // Super admins bypass tenant checks entirely
            if (user.role === 'superadmin') {
                return next();
            }

            // If it's an employee, verify the tenant (admin) is active
            if (user.role === 'employee') {
                const admin = await User.findById(req.adminId);
                if (!admin || !admin.isActive) {
                    return res.status(401).json({ message: 'Not authorized, tenant inactive' });
                }
            } else if (!user.isActive) {
                return res.status(401).json({ message: 'Not authorized, account inactive' });
            }

            return next();
        } catch (error) {
            console.error('JWT Error:', error.message);
            return res.status(401).json({ message: 'Not authorized, token failed' });
        }
    }

    if (!token) {
        return res.status(401).json({ message: 'Not authorized, no token' });
    }
};

const adminOnly = (req, res, next) => {
    if (req.user && (req.user.role === 'admin' || req.user.role === 'superadmin')) {
        next();
    } else {
        res.status(403).json({ message: 'Access denied: Admin only' });
    }
};

// Gate an action (view/create/edit/delete) on a page for SUB-ADMINS ONLY.
// Every other role passes through untouched — admins/superadmins have full
// rights, and employee access on shared routes (punch, leave apply, etc.)
// stays governed by the existing controller/middleware logic.
const checkPermission = (page, action) => (req, res, next) => {
    const role = req.currentUser?.role || req.user?.role;
    if (role !== 'subadmin') return next();
    const perm = req.currentUser?.permissions?.[page];
    if (perm && perm[action]) return next();
    return res.status(403).json({ message: `Access denied: no ${action} permission for ${page}` });
};

const superAdminOnly = (req, res, next) => {
    if (req.user && req.user.role === 'superadmin') {
        next();
    } else {
        res.status(403).json({ message: 'Access denied: Super admin only' });
    }
};

module.exports = { protect, adminOnly, superAdminOnly, checkPermission };

