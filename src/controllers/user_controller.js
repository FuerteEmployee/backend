const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Festival = require('../models/Festival');
const Subscription = require('../models/Subscription');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { friendlyMongooseError } = require('../utils/mongoose_errors');

// Generate JWT
const generateToken = (user) => {
    return jwt.sign(
        {
            userId: user._id,
            adminId: user.role === 'superadmin' ? user._id : (user.role === 'admin' ? user._id : user.adminId),
            role: user.role
        },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
    );
};

// --- AUTH LOGIC ---

exports.loginRequest = async (req, res) => {
    const { phone } = req.body;
    try {
        // Find any user with this phone number
        let user = await User.findOne({ phone });

        const otp = "123456";
        const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

        if (!user) {
            return res.status(404).json({ message: 'You are not registered. Please contact your admin to register you first.' });
        }

        if (user.status === 'inactive') {
            return res.status(403).json({
                code: 'account_inactive',
                message: user.inactiveReason?.trim() || 'Your account is inactive. Please contact your admin.',
                name: user.name
            });
        }

        // Update existing user with OTP
        user.otp = otp;
        user.otpExpiry = otpExpiry;
        await user.save();
        res.status(200).json({ message: 'OTP sent successfully (Mock: 123456)' });
    } catch (error) {
        console.error("Login Request Error:", error);
        res.status(500).json({ message: error.message });
    }
};

exports.verifyOtp = async (req, res) => {
    const { phone, otp } = req.body;
    try {
        const user = await User.findOne({ phone });
        if (!user || user.otp !== otp || user.otpExpiry < new Date()) {
            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }

        if (user.status === 'inactive') {
            return res.status(403).json({
                code: 'account_inactive',
                message: user.inactiveReason?.trim() || 'Your account is inactive. Please contact your admin.',
                name: user.name
            });
        }

        user.otp = undefined;
        user.otpExpiry = undefined;
        const token = generateToken(user);
        user.activeToken = token;
        await user.save();

        // For subadmin, pull company info from the parent admin
        let companyName = user.companyName;
        let companyLogo = user.companyLogo;
        let address = user.address;
        let email = user.email;
        if (user.role === 'subadmin' && user.adminId) {
            const admin = await User.findById(user.adminId).lean();
            if (admin) {
                companyName = admin.companyName;
                companyLogo = admin.companyLogo;
                address = admin.address;
                email = admin.email;
            }
        }

        res.status(200).json({
            _id: user._id,
            name: user.name,
            phone: user.phone,
            role: user.role,
            companyName,
            companyLogo,
            address,
            email,
            token,
            permissions: user.role === 'subadmin' ? (user.permissions || {}) : undefined,
        });
    } catch (error) {
        console.error("Verify OTP Error:", error);
        res.status(500).json({ message: error.message });
    }
};

exports.getProfile = async (req, res) => {
    try {
        const user = await User.findById(req.userId).populate('shiftId shiftIds branchId branchIds departmentId');
        if (!user) return res.status(404).json({ message: 'User not found' });

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const [todayAttendance, recentAttendance, upcomingHolidays, settings] = await Promise.all([
            Attendance.findOne({
                employeeId: user._id,
                date: { $gte: today, $lt: tomorrow }
            }).sort({ date: -1 }),
            Attendance.find({ employeeId: user._id })
                .sort({ date: -1 })
                .limit(5),
            // Fetch all holidays (festivals) for the user's company
            Festival.find({ 
                adminId: user.adminId || user._id
            }).sort({ startDate: 1 }).limit(50),
            require('../models/Settings').findOne({ adminId: user.adminId || user._id })
        ]);

        const userObj = user.toObject();
        userObj.todayAttendance = todayAttendance;
        userObj.recentAttendance = recentAttendance;
        userObj.upcomingHolidays = upcomingHolidays;
        userObj.allowMultiplePunches = settings?.attendance?.allowMultiplePunches || false;

        res.json(userObj);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Return the current tenant's subscription status for the logged-in admin/subadmin.
// Intentionally NOT gated by subscription middleware so the frontend can still
// read the status (and render the trial/expired notice) even after expiry.
exports.getMySubscription = async (req, res) => {
    try {
        // Superadmins have no tenant subscription of their own.
        if (req.user?.role === 'superadmin') {
            return res.json({ status: 'none' });
        }

        const sub = await Subscription.findOne({ adminId: req.adminId }).populate('planId');

        // Legacy tenants without a subscription record are treated as unrestricted.
        if (!sub) {
            return res.json({ status: 'none' });
        }

        const now = new Date();
        const MS_PER_DAY = 1000 * 60 * 60 * 24;

        // The relevant deadline depends on where the tenant is in its lifecycle.
        let deadline = null;
        if (sub.status === 'trial') deadline = sub.trialEndDate;
        else if (sub.status === 'grace') deadline = sub.graceEndDate || sub.currentPeriodEnd;
        else if (sub.status === 'active') deadline = sub.currentPeriodEnd;

        const daysRemaining = deadline
            ? Math.max(0, Math.ceil((new Date(deadline).getTime() - now.getTime()) / MS_PER_DAY))
            : null;

        // A trial whose end date has passed is effectively expired even if a cron
        // hasn't flipped the status yet — surface that to the client.
        const effectiveStatus =
            sub.status === 'trial' && sub.trialEndDate && new Date(sub.trialEndDate) < now
                ? 'expired'
                : sub.status;

        res.json({
            status: effectiveStatus,
            rawStatus: sub.status,
            planName: sub.planId?.name || null,
            planSlug: sub.planId?.slug || null,
            billingCycle: sub.billingCycle,
            trialEndDate: sub.trialEndDate,
            currentPeriodEnd: sub.currentPeriodEnd,
            graceEndDate: sub.graceEndDate,
            deadline,
            daysRemaining,
            bannerThresholdDays: sub.bannerThresholdDays ?? 7,
            employeesUsed: sub.employeesUsed,
            maxEmployees: sub.planId?.maxEmployees ?? null,
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateProfile = async (req, res) => {
    try {
        const allowedFields = ['name', 'phone', 'email', 'address', 'bloodGroup', 'contactPersonName', 'contactPersonMobile', 'aadhaarNo', 'panNo', 'bankDetails'];
        const updateData = {};
        for (const key of allowedFields) {
            if (req.body[key] !== undefined) updateData[key] = req.body[key];
        }
        // bankDetails arrives as a JSON string when the request is multipart (file uploads present)
        if (typeof updateData.bankDetails === 'string') {
            try { updateData.bankDetails = JSON.parse(updateData.bankDetails); } catch { delete updateData.bankDetails; }
        }

        if (req.files?.logo?.[0]) updateData.profileImage = req.files.logo[0].path;
        if (req.files?.panCard?.length) updateData.panCardUrls = req.files.panCard.map(f => f.path);
        if (req.files?.aadhaarCard?.length) updateData.aadhaarCardUrls = req.files.aadhaarCard.map(f => f.path);

        // Explicit duplicate-phone guard when the employee is changing their own login number
        if (updateData.phone) {
            const existing = await User.findOne({ phone: updateData.phone, _id: { $ne: req.userId } });
            if (existing) {
                return res.status(409).json({ message: `This phone number (${updateData.phone}) is already registered. Please use a different phone number.` });
            }
        }

        const user = await User.findByIdAndUpdate(
            req.userId,
            updateData,
            { new: true, runValidators: true }
        );
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(user);
    } catch (error) {
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

// --- EMPLOYEE MANAGEMENT LOGIC (Admin Only) ---

exports.getUsers = async (req, res) => {
    try {
        const { search, role, page = 1, limit = 10 } = req.query;
        const query = { adminId: new mongoose.Types.ObjectId(req.adminId) };

        if (role) query.role = role;
        if (search) query.name = { $regex: search, $options: 'i' };

        const users = await User.find(query)
            .populate('departmentId branchId branchIds shiftId shiftIds')
            .limit(limit * 1)
            .skip((page - 1) * limit)
            .sort({ createdAt: -1 });

        const count = await User.countDocuments(query);
        res.json({
            users,
            totalPages: Math.ceil(count / limit),
            currentPage: page,
            totalUsers: count
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.getEmployees = async (req, res) => {
    try {
        const employees = await User.find({ adminId: new mongoose.Types.ObjectId(req.adminId), role: 'employee' })
            .populate('departmentId branchId branchIds shiftId shiftIds')
            .sort({ createdAt: -1 });
        res.json(employees);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Minimal id+name listing of colleagues, safe to expose to any employee (e.g. for bill-split pickers)
exports.getCoworkers = async (req, res) => {
    try {
        const coworkers = await User.find({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            role: 'employee',
            _id: { $ne: req.userId }
        }).select('_id name');
        res.json(coworkers);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.createUser = async (req, res) => {
    try {
        const userData = { ...req.body, adminId: new mongoose.Types.ObjectId(req.adminId) };
        
        // Clean up empty strings for ObjectId fields
        ['shiftId', 'departmentId', 'branchId'].forEach(field => {
            if (userData[field] === "") {
                delete userData[field];
            }
        });

        // Multi-branch support: keep primary branchId in sync with branchIds
        if (Array.isArray(userData.branchIds)) {
            userData.branchIds = userData.branchIds.filter(Boolean);
            if (userData.branchIds.length > 0) {
                userData.branchId = userData.branchIds[0];
            }
        }

        // Multi-shift support: keep primary shiftId (used for attendance/lateness
        // calculations) in sync with shiftIds — mirrors branchId/branchIds above.
        if (Array.isArray(userData.shiftIds)) {
            userData.shiftIds = userData.shiftIds.filter(Boolean);
            if (userData.shiftIds.length > 0) {
                userData.shiftId = userData.shiftIds[0];
            }
        }

        // Explicit duplicate-phone guard — don't rely solely on the DB unique
        // index, since a phone can be shared across different adminId tenants
        // and stale/broken indexes on this collection have slipped through before.
        if (userData.phone) {
            const existing = await User.findOne({ phone: userData.phone });
            if (existing) {
                return res.status(409).json({ message: `This phone number (${userData.phone}) is already registered. Please use a different phone number.` });
            }
        }

        // Enforce employee seat limit check
        if (userData.role === 'employee' && req.adminId) {
            const subscription = await Subscription.findOne({ adminId: req.adminId }).populate('planId');
            if (subscription && subscription.planId) {
                const maxEmployees = subscription.planId.maxEmployees;
                if (maxEmployees !== null && maxEmployees !== undefined) {
                    const currentCount = await User.countDocuments({ adminId: req.adminId, role: 'employee' });
                    if (currentCount >= maxEmployees) {
                        return res.status(400).json({
                            message: `Employee seat limit reached (maximum ${maxEmployees} employees allowed on your plan). Please upgrade your plan to add more.`
                        });
                    }
                }
            }
        }

        const user = await User.create(userData);

        // Sync employeesUsed count on the tenant's subscription (if subscription exists)
        if (userData.role === 'employee' && req.adminId) {
            const count = await User.countDocuments({ adminId: req.adminId, role: 'employee' });
            const subscription = await Subscription.findOne({ adminId: req.adminId });
            if (subscription) {
                subscription.employeesUsed = count;
                await subscription.save();
            }
        }

        res.status(201).json(user);
    } catch (error) {
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

exports.updateUser = async (req, res) => {
    try {
        const updateData = { ...req.body };
        
        // Clean up empty strings for ObjectId fields
        ['shiftId', 'departmentId', 'branchId'].forEach(field => {
            if (updateData[field] === "") {
                updateData[field] = null;
            }
        });

        // Multi-branch support: keep primary branchId in sync with branchIds
        if (Array.isArray(updateData.branchIds)) {
            updateData.branchIds = updateData.branchIds.filter(Boolean);
            updateData.branchId = updateData.branchIds.length > 0 ? updateData.branchIds[0] : null;
        }

        // Multi-shift support: keep primary shiftId (used for attendance/lateness
        // calculations) in sync with shiftIds — mirrors branchId/branchIds above.
        if (Array.isArray(updateData.shiftIds)) {
            updateData.shiftIds = updateData.shiftIds.filter(Boolean);
            updateData.shiftId = updateData.shiftIds.length > 0 ? updateData.shiftIds[0] : null;
        }

        // Clear any stale deactivation reason once the account is reactivated
        if (updateData.status === 'active') {
            updateData.inactiveReason = '';
        }

        // Explicit duplicate-phone guard when the phone is being changed
        if (updateData.phone) {
            const existing = await User.findOne({ phone: updateData.phone, _id: { $ne: req.params.id } });
            if (existing) {
                return res.status(409).json({ message: `This phone number (${updateData.phone}) is already registered. Please use a different phone number.` });
            }
        }

        const user = await User.findOneAndUpdate(
            { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) },
            updateData,
            { new: true, runValidators: true }
        );
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(user);
    } catch (error) {
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

// --- SUBADMIN / ADMIN USER MANAGEMENT ---

const DEFAULT_SUBADMIN_PAGES = ['dashboard','employees','leaves','attendance','salary','expenses'];
const ALL_PAGES = ['dashboard','branches','departments','employees','leaves','attendance','tickets','salary','leads','festivals','announcements','tracking','leave-types','shifts','assets','expenses','settings'];

function buildDefaultPermissions() {
    return ALL_PAGES.reduce((acc, key) => {
        const on = DEFAULT_SUBADMIN_PAGES.includes(key);
        acc[key] = { view: on, create: false, edit: false, delete: false };
        return acc;
    }, {});
}

exports.getAdminUsers = async (req, res) => {
    try {
        const users = await User.find({ adminId: req.adminId, role: 'subadmin' }).sort({ createdAt: -1 });
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.createAdminUser = async (req, res) => {
    try {
        const { name, phone, permissions } = req.body;
        const existing = await User.findOne({ phone });
        if (existing) return res.status(400).json({ message: 'Phone number already registered' });
        const user = await User.create({
            name,
            phone,
            role: 'subadmin',
            adminId: req.adminId,
            permissions: permissions || buildDefaultPermissions(),
        });
        res.status(201).json(user);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.updateAdminUser = async (req, res) => {
    try {
        const { name, permissions, isActive } = req.body;
        const user = await User.findOneAndUpdate(
            { _id: req.params.id, adminId: req.adminId, role: 'subadmin' },
            { name, permissions, isActive },
            { new: true, runValidators: true }
        );
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(user);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.deleteAdminUser = async (req, res) => {
    try {
        const user = await User.findOneAndDelete({ _id: req.params.id, adminId: req.adminId, role: 'subadmin' });
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json({ message: 'User removed' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.deleteUser = async (req, res) => {
    try {
        const user = await User.findOneAndDelete({ _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) });
        if (!user) return res.status(404).json({ message: 'User not found' });

        // Sync employeesUsed count on the tenant's subscription (if subscription exists)
        if (user.role === 'employee' && req.adminId) {
            const count = await User.countDocuments({ adminId: req.adminId, role: 'employee' });
            const subscription = await Subscription.findOne({ adminId: req.adminId });
            if (subscription) {
                subscription.employeesUsed = count;
                await subscription.save();
            }
        }

        res.json({ message: 'User removed' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
