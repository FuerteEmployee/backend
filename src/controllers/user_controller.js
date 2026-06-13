const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Festival = require('../models/Festival');
const Subscription = require('../models/Subscription');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

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
            return res.status(404).json({ message: 'Account not found. Please contact support.' });
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
        const user = await User.findById(req.userId).populate('shiftId branchId departmentId');
        if (!user) return res.status(404).json({ message: 'User not found' });

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [todayAttendance, recentAttendance, upcomingHolidays, settings] = await Promise.all([
            Attendance.findOne({
                employeeId: user._id,
                date: { $gte: today }
            }),
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

exports.updateProfile = async (req, res) => {
    try {
        const updateData = { ...req.body };
        if (req.file) {
            updateData.companyLogo = req.file.path;
        }

        const user = await User.findByIdAndUpdate(
            req.userId,
            updateData,
            { new: true, runValidators: true }
        );
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(user);
    } catch (error) {
        res.status(400).json({ message: error.message });
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
            .populate('departmentId branchId shiftId')
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
            .populate('departmentId branchId shiftId')
            .sort({ createdAt: -1 });
        res.json(employees);
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
        res.status(400).json({ message: error.message });
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

        const user = await User.findOneAndUpdate(
            { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) },
            updateData,
            { new: true, runValidators: true }
        );
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(user);
    } catch (error) {
        res.status(400).json({ message: error.message });
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
