const mongoose = require('mongoose');
const GpsPenalty = require('../models/GpsPenalty');
const Salary = require('../models/Salary');
const User = require('../models/User');
const Settings = require('../models/Settings');
const { istMonthRange } = require('../utils/attendance_helpers');
const { syncGpsPenalties } = require('../utils/gps_penalty');
const { calculateAndSaveSalary } = require('./salary_controller');

// GET /tracking/gps-penalties?month=&year=[&employeeId=]
// Brings the month up to date from the phones' reports, then lists it.
exports.listGpsPenalties = async (req, res) => {
    try {
        const month = Number(req.query.month);
        const year = Number(req.query.year);
        if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2020 || year > 2100) {
            return res.status(400).json({ message: 'Choose a month and year.' });
        }
        const employeeId = req.query.employeeId && mongoose.Types.ObjectId.isValid(req.query.employeeId) ? req.query.employeeId : null;
        const adminId = new mongoose.Types.ObjectId(req.adminId);

        const settings = await Settings.findOne({ adminId }).select('attendance.gpsOffPenalty').lean();
        const cfg = settings?.attendance?.gpsOffPenalty || {};
        const { start, end } = istMonthRange(year, month);
        const now = new Date();
        if (cfg.enabled === true && start <= now) {
            await syncGpsPenalties(adminId, { from: start, to: end < now ? end : now, employeeId, settings });
        }

        const prefix = `${year}-${String(month).padStart(2, '0')}-`;
        const rows = await GpsPenalty.find({ adminId, ...(employeeId ? { employeeId } : {}), dayKey: { $regex: `^${prefix}` } })
            .sort({ dayKey: -1, offAt: -1 })
            .populate('employeeId', 'name phone')
            .populate('decidedBy', 'name')
            .lean();
        res.json({
            settings: {
                enabled: cfg.enabled === true,
                graceMinutes: cfg.graceMinutes ?? 10,
                amount: cfg.amount ?? 0,
                autoApprove: cfg.autoApprove === true,
            },
            penalties: rows,
        });
    } catch (error) {
        res.status(500).json({ message: 'Could not load GPS-off penalties. Please try again.' });
    }
};

// PATCH /tracking/gps-penalties/:id  { status: 'approved' | 'waived' | 'pending', note? }
// The month's salary is recalculated when one already exists, so the payslip
// follows the decision.
exports.decideGpsPenalty = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ message: 'Penalty not found.' });
        const status = req.body?.status;
        if (!['approved', 'waived', 'pending'].includes(status)) {
            return res.status(400).json({ message: 'Choose approve or waive.' });
        }
        const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : undefined;
        const adminId = new mongoose.Types.ObjectId(req.adminId);

        const set = status === 'pending'
            ? { status, decidedBy: null, decidedAt: null }
            : { status, decidedBy: req.userId, decidedAt: new Date() };
        if (note !== undefined) set.note = note;
        const row = await GpsPenalty.findOneAndUpdate({ _id: id, adminId }, { $set: set }, { new: true });
        if (!row) return res.status(404).json({ message: 'Penalty not found.' });

        const [y, m] = row.dayKey.split('-').map(Number);
        const hasSalary = await Salary.exists({ adminId, employeeId: row.employeeId, month: m, year: y });
        if (hasSalary) {
            const emp = await User.findOne({ _id: row.employeeId, adminId, role: 'employee' }).populate('shiftId');
            if (emp) {
                calculateAndSaveSalary(adminId, emp, m, y).catch((err) => {
                    console.error('[gps-penalty] salary recalc failed:', err.message);
                });
            }
        }
        res.json(row);
    } catch (error) {
        res.status(500).json({ message: 'Could not save that decision. Please try again.' });
    }
};
