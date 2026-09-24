const Settings = require('../models/Settings');
const User = require('../models/User');

// Flattens plain nested objects into Mongo dot-path keys (e.g.
// { attendance: { officeRadius: 500 } } -> { 'attendance.officeRadius': 500 })
// so a $set only touches the fields actually present in the request instead of
// replacing the whole nested sub-document and wiping out sibling fields that a
// different settings tab owns (e.g. Settings' Attendance tab vs
// attendance-config.tsx both writing to `settings.attendance`).
// Arrays are left as atomic leaf values — merging them by index would be more
// surprising than useful (e.g. `attendance.workDays`, `attendance.punchSequence.steps`).
function flattenForSet(obj, prefix = '') {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            Object.assign(out, flattenForSet(value, path));
        } else {
            out[path] = value;
        }
    }
    return out;
}

exports.getSettings = async (req, res) => {
    try {
        let settings = await Settings.findOne({ adminId: req.adminId });
        
        // If no settings exist yet, create default settings from User profile
        if (!settings) {
            const user = await User.findById(req.adminId);
            settings = await Settings.create({
                adminId: req.adminId,
                companyName: user?.companyName || '',
                companyLogo: user?.companyLogo || '',
                address: user?.address || '',
                email: user?.email || '',
                phone: user?.phone || ''
            });
        }
        
        res.json(settings);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateSettings = async (req, res) => {
    try {
        const updateData = { ...req.body };
        
        // Handle file upload for company logo
        if (req.file) {
            updateData.companyLogo = req.file.path;
        }

        // Handle nested fields if they are sent as strings (common with multipart/form-data)
        if (typeof updateData.notifications === 'string') {
            updateData.notifications = JSON.parse(updateData.notifications);
        }
        if (typeof updateData.appearance === 'string') {
            updateData.appearance = JSON.parse(updateData.appearance);
        }
        if (typeof updateData.attendance === 'string') {
            updateData.attendance = JSON.parse(updateData.attendance);
        }

        // Reject an unworkable punch sequence here rather than letting it fail
        // silently at 9am on the floor. The downstream handlers have hard
        // preconditions (lunch-out needs an existing lunch-in; nothing records
        // after punch-out), so only certain orderings can actually execute.
        const seq = updateData.attendance?.punchSequence;
        if (seq && seq.enabled) {
            const { validateSteps } = require('../utils/punch_sequence');
            const check = validateSteps(seq.steps);
            if (!check.ok) {
                return res.status(400).json({ message: check.message });
            }
        }

        const settings = await Settings.findOneAndUpdate(
            { adminId: req.adminId },
            { $set: flattenForSet(updateData) },
            { new: true, upsert: true, runValidators: true }
        );
        
        res.json(settings);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.getFeatureToggles = async (req, res) => {
    try {
        const Subscription = require('../models/Subscription');
        const sub = await Subscription.findOne({ adminId: req.adminId }).lean();

        // Default toggles for tenants without a subscription or without toggles set
        const defaults = {
            tracking: true,
            geofenceAutoPunchOut: true,
            leads: true,
            expenses: true,
            recruitment: false,
            training: false,
            performance: false,
            projects: false,
            assets: false,
            advanceSalary: true,
            announcements: true,
            policies: false,
            biometricDevices: true,
        };

        if (!sub || !sub.featureToggles) {
            return res.json(defaults);
        }

        // Mongoose .lean() turns Maps into plain objects
        const toggles = sub.featureToggles instanceof Map
            ? Object.fromEntries(sub.featureToggles)
            : (sub.featureToggles || {});

        // Merge with defaults so new keys added later are visible
        res.json({ ...defaults, ...toggles });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
