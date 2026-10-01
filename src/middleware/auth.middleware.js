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
            if (!user) {
                return res.status(401).json({ message: 'Not authorized, user not found' });
            }
            if (user.status === 'inactive') {
                return res.status(401).json({
                    code: 'account_inactive',
                    message: user.inactiveReason?.trim() || 'Your account is inactive. Please contact your admin.',
                    name: user.name
                });
            }

            // Make the full user record (incl. permissions) available downstream
            req.currentUser = user;

            // Multiple-device login is allowed: do not reject tokens superseded
            // by a login on another device. (Single-device enforcement disabled.)

            // Super admins bypass tenant checks entirely
            if (user.role === 'superadmin') {
                return next();
            }

            // A panel account switched off on its own (isActive is the flag
            // for admins and sub-admins).
            if (user.role !== 'employee' && user.isActive === false) {
                return res.status(401).json({
                    code: 'account_inactive',
                    message: user.inactiveReason?.trim() || 'Your account is switched off. Please contact your admin.',
                    name: user.name
                });
            }

            // Employees AND sub-admins belong to a company that can be switched
            // off. Sub-admins used to skip this (only their own flag was read),
            // so a switched-off company's sub-admins kept full panel access.
            // The tenant is read from the user's own record, not the token.
            if (user.role === 'employee' || user.role === 'subadmin') {
                const admin = user.adminId
                    ? await User.findOne({ _id: user.adminId, role: 'admin' }).select('isActive status').lean()
                    : null;
                if (!admin || admin.isActive === false || admin.status === 'inactive') {
                    return res.status(401).json({
                        code: 'company_inactive',
                        message: user.role === 'employee'
                            ? "Your company's B.O.T account is switched off. Please tell your admin."
                            : "Your company's B.O.T account is switched off. Please tell your company owner."
                    });
                }
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

// The role comes from the database record `protect` loaded, not the token: a
// JWT lives 30 days, so a demoted admin's token still said "admin".
const adminOnly = (req, res, next) => {
    const role = req.currentUser?.role;
    if (role === 'admin' || role === 'superadmin') {
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

// Panel roles only (admin, superadmin, subadmin) — employees are refused.
//
// checkPermission alone is NOT this: it restricts sub-admins and waves every
// other role through, employees included, so a route guarded only by it is
// open to any employee's token. Put this in front of any route the employee
// app has no business calling.
const panelOnly = (req, res, next) => {
    const role = req.currentUser?.role || req.user?.role;
    if (role === 'admin' || role === 'superadmin' || role === 'subadmin') return next();
    return res.status(403).json({ message: 'Access denied: Admin only' });
};

const superAdminOnly = (req, res, next) => {
    if (req.user && req.user.role === 'superadmin') {
        next();
    } else {
        res.status(403).json({ message: 'Access denied: Super admin only' });
    }
};

module.exports = { protect, adminOnly, panelOnly, superAdminOnly, checkPermission };

