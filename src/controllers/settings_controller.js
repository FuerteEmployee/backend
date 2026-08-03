const Settings = require('../models/Settings');
const User = require('../models/User');

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
            { $set: updateData },
            { new: true, upsert: true, runValidators: true }
        );
        
        res.json(settings);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};
