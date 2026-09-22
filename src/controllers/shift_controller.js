const Shift = require('../models/Shift');
const Subscription = require('../models/Subscription');
const mongoose = require('mongoose');

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Reject a lunch policy that cannot be applied, at save time.
 *
 * A half-configured mode (fixed_window with no times, fixed_duration with no
 * length) resolves back to `inherit` at read time so attendance never halts --
 * but an admin who picked "1pm to 2pm" and left the times blank has not got
 * what they chose, and silently giving them the tenant default is how a payroll
 * surprise arrives a month later. Same reasoning as validateSteps() on the
 * punch sequence: refuse it here, where somebody is looking at the screen.
 *
 * Returns an error string, or null when the block is usable.
 */
function validateLunch(lunch) {
    if (!lunch || typeof lunch !== 'object') return null;
    const mode = lunch.mode || 'inherit';
    const allowed = ['inherit', 'none', 'fixed_window', 'fixed_duration', 'from_punches'];
    if (!allowed.includes(mode)) return `Unknown lunch mode '${mode}'`;

    if (mode === 'fixed_window') {
        if (!HHMM.test(String(lunch.startTime || ''))) return 'Lunch start time must be HH:mm';
        if (!HHMM.test(String(lunch.endTime || ''))) return 'Lunch end time must be HH:mm';
        if (String(lunch.startTime) === String(lunch.endTime)) {
            return 'Lunch start and end cannot be the same time';
        }
    }

    if (mode === 'fixed_duration') {
        const d = Number(lunch.durationMins);
        if (!Number.isFinite(d) || d <= 0) return 'Lunch duration must be a positive number of minutes';
        if (d > 12 * 60) return 'Lunch duration cannot exceed 12 hours';
    }

    if (mode === 'from_punches') {
        const mn = lunch.minMins == null || lunch.minMins === '' ? null : Number(lunch.minMins);
        const mx = lunch.maxMins == null || lunch.maxMins === '' ? null : Number(lunch.maxMins);
        if (mn !== null && (!Number.isFinite(mn) || mn < 0)) return 'Minimum lunch must be 0 or more minutes';
        if (mx !== null && (!Number.isFinite(mx) || mx <= 0)) return 'Maximum lunch must be a positive number of minutes';
        if (mn !== null && mx !== null && mx < mn) return 'Maximum lunch cannot be less than the minimum';
    }

    return null;
}

exports.getShifts = async (req, res) => {
    try {
        const shifts = await Shift.find({ adminId: new mongoose.Types.ObjectId(req.adminId) });
        res.json(shifts);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.createShift = async (req, res) => {
    try {
        // Check shift count limit
        if (req.adminId) {
            const subscription = await Subscription.findOne({ adminId: req.adminId }).populate('planId');
            if (subscription && subscription.planId) {
                const limitVal = subscription.planId.modules?.get('shifts') || subscription.planId.modules?.['shifts'];
                if (limitVal && limitVal.includes('2')) {
                    const currentCount = await Shift.countDocuments({ adminId: req.adminId });
                    if (currentCount >= 2) {
                        return res.status(400).json({
                            message: `Shift limit reached (maximum 2 shift profiles allowed on your plan). Please upgrade your plan to add more.`
                        });
                    }
                }
            }
        }

        const lunchError = validateLunch(req.body.lunch);
        if (lunchError) return res.status(400).json({ message: lunchError });

        const shift = await Shift.create({ ...req.body, adminId: new mongoose.Types.ObjectId(req.adminId) });
        res.status(201).json(shift);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.updateShift = async (req, res) => {
    try {
        const lunchError = validateLunch(req.body.lunch);
        if (lunchError) return res.status(400).json({ message: lunchError });

        const shift = await Shift.findOneAndUpdate(
            { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) },
            req.body,
            { new: true }
        );
        if (!shift) return res.status(404).json({ message: 'Shift not found' });
        res.json(shift);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.deleteShift = async (req, res) => {
    try {
        const shift = await Shift.findOneAndDelete({ _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) });
        if (!shift) return res.status(404).json({ message: 'Shift not found' });
        res.json({ message: 'Shift removed' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
