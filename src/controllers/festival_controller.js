const Festival = require('../models/Festival');
const mongoose = require('mongoose');
const { serialisePerTenant } = require('../utils/employee_lock');

// Employees read the holiday calendar; only HR/admin change it.
//
// This one carries money. A festival is a PAID holiday to the payroll engine
// and a non-working day to leave counting, for every employee in the company.
// The routes' checkPermission() restricts sub-admins only -- employees pass
// straight through it -- so without this an employee could add a month-long
// "holiday" with one API call and be paid for it. The database role is read
// before the JWT's, so a promotion takes effect at once.
function refuseEmployee(req, res) {
    const role = req.currentUser?.role || req.user?.role;
    if (role !== 'employee') return false;
    res.status(403).json({ message: 'Only HR or an admin can change the holiday list.' });
    return true;
}

const TYPES = ['mandatory', 'optional', 'event'];
const NAME_MAX = 100;
const DESCRIPTION_MAX = 500;
// Longest single holiday entry. Every day of it is a paid day off for every
// employee (payroll_engine buildFestivalSet), so a slip of the year field
// ("2026-10-02 to 2027-10-02") would otherwise pay a whole year of holidays.
// A longer shutdown can still be entered as more than one holiday.
const MAX_SPAN_DAYS = 31;

// Festival dates are stored as 'YYYY-MM-DD' strings and every reader compares
// them as strings (day_classification, the Home card's endDate >= today), so
// only the exact zero-padded form is accepted, and only real calendar days
// ("2026-02-30" is refused, not rolled over to March).
function isDateKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    if (y < 2000 || y > 2100) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function daySpan(startKey, endKey) {
    const toUtc = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((toUtc(endKey) - toUtc(startKey)) / 86400000) + 1;
}

// "02 Oct 2026" for messages, with no timezone involved.
function showDay(key) {
    const [y, m, d] = key.split('-').map(Number);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d} ${months[m - 1]} ${y}`;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Copy only the fields a holiday has, from a body that may be JSON or
// multipart. The body was spread straight into create/findOneAndUpdate, so a
// body of {"$set": {"adminId": ...}} moved a holiday into another company, and
// any stray field (createdAt, posterUrl) was written as sent.
//
// `existing` is the stored holiday on an edit: the result is validated as the
// merged whole, so an edit that only moves the end date is still checked
// against the start date it keeps.
function readFestivalInput(body, existing) {
    const src = body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined;
    const out = {};

    if (has('name') || !existing) {
        if (typeof src.name !== 'string' || !src.name.trim()) return { error: 'Please enter the holiday name.' };
        const name = src.name.trim().replace(/\s+/g, ' ');
        if (name.length < 2) return { error: 'The holiday name is too short. Please enter at least 2 letters.' };
        if (name.length > NAME_MAX) return { error: `The holiday name is too long. Please keep it under ${NAME_MAX} letters.` };
        out.name = name;
    }

    if (has('startDate') || !existing) {
        if (!isDateKey(src.startDate)) return { error: 'Please choose a valid start date.' };
        out.startDate = src.startDate;
    }
    if (has('endDate') && src.endDate !== '') {
        if (!isDateKey(src.endDate)) return { error: 'Please choose a valid end date.' };
        out.endDate = src.endDate;
    } else if (!existing) {
        out.endDate = out.startDate; // a one-day holiday
    }

    if (has('type') || !existing) {
        const type = src.type === undefined || src.type === '' ? 'mandatory' : src.type;
        if (!TYPES.includes(type)) return { error: 'Please choose a holiday type: mandatory, optional or company event.' };
        out.type = type;
    }

    if (has('description')) {
        if (typeof src.description !== 'string') return { error: 'The description must be plain text.' };
        const description = src.description.trim();
        if (description.length > DESCRIPTION_MAX) {
            return { error: `The description is too long. Please keep it under ${DESCRIPTION_MAX} letters.` };
        }
        out.description = description;
    }

    const start = out.startDate || existing?.startDate;
    const end = out.endDate || existing?.endDate || start;
    if (end < start) return { error: 'The end date cannot be before the start date.' };
    const span = daySpan(start, end);
    if (span > MAX_SPAN_DAYS) {
        return { error: `A holiday can be at most ${MAX_SPAN_DAYS} days long (this one is ${span}). Add a longer break as separate holidays.` };
    }

    return { data: out, start, end };
}

// The same holiday twice on overlapping dates would show twice on every
// calendar. Two DIFFERENT holidays on one day (e.g. two festivals that fall
// together) are allowed.
async function findDuplicate(adminId, name, start, end, exceptId) {
    const query = {
        adminId,
        name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' },
        startDate: { $lte: end },
        endDate: { $gte: start },
    };
    if (exceptId) query._id = { $ne: exceptId };
    return Festival.findOne(query).select('name startDate endDate').lean();
}

function duplicateMessage(dup) {
    const when = dup.startDate === dup.endDate ? showDay(dup.startDate) : `${showDay(dup.startDate)} to ${showDay(dup.endDate)}`;
    return `"${dup.name}" is already on the holiday list for ${when}.`;
}

exports.getFestivals = async (req, res) => {
    try {
        if (!req.adminId) {
            return res.status(401).json({ message: "Admin ID missing" });
        }
        const festivals = await Festival.find({
            adminId: new mongoose.Types.ObjectId(req.adminId)
        }).sort({ startDate: 1 });
        res.json(festivals);
    } catch (error) {
        console.error("GET Festivals Error:", error);
        res.status(500).json({ message: 'Could not load the holiday list. Please try again.' });
    }
};

exports.createFestival = async (req, res) => {
    if (refuseEmployee(req, res)) return;
    try {
        const { data, error, start, end } = readFestivalInput(req.body, null);
        if (error) return res.status(400).json({ message: error });

        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const dup = await findDuplicate(adminId, data.name, start, end, null);
        if (dup) return res.status(409).json({ message: duplicateMessage(dup) });

        data.adminId = adminId;
        if (req.file) data.posterUrl = req.file.path;

        const festival = await Festival.create(data);
        res.status(201).json(festival);
    } catch (error) {
        console.error("Festival Creation Error:", error);
        if (error?.name === 'ValidationError') return res.status(400).json({ message: 'Please check the holiday details and try again.' });
        res.status(500).json({ message: 'Could not add the holiday. Please try again.' });
    }
};

exports.updateFestival = async (req, res) => {
    if (refuseEmployee(req, res)) return;
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Holiday not found' });
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const existing = await Festival.findOne({ _id: req.params.id, adminId }).lean();
        if (!existing) return res.status(404).json({ message: 'Holiday not found' });

        const { data, error, start, end } = readFestivalInput(req.body, existing);
        if (error) return res.status(400).json({ message: error });

        const dup = await findDuplicate(adminId, data.name || existing.name, start, end, existing._id);
        if (dup) return res.status(409).json({ message: duplicateMessage(dup) });

        if (req.file) {
            data.posterUrl = req.file.path;
        } else if (req.body?.removePoster === 'true' || req.body?.removePoster === true) {
            data.posterUrl = "";
        }

        const festival = await Festival.findOneAndUpdate(
            { _id: existing._id, adminId },
            { $set: data },
            { new: true, runValidators: true }
        );
        if (!festival) return res.status(404).json({ message: 'Holiday not found' });
        res.json(festival);
    } catch (error) {
        console.error("Festival Update Error:", error);
        if (error?.name === 'ValidationError') return res.status(400).json({ message: 'Please check the holiday details and try again.' });
        res.status(500).json({ message: 'Could not save the holiday. Please try again.' });
    }
};

exports.deleteFestival = async (req, res) => {
    if (refuseEmployee(req, res)) return;
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Holiday not found' });
        const festival = await Festival.findOneAndDelete({
            _id: req.params.id,
            adminId: new mongoose.Types.ObjectId(req.adminId)
        });
        if (!festival) return res.status(404).json({ message: 'Holiday not found' });
        res.json({ message: 'Holiday removed' });
    } catch (error) {
        console.error("Delete Festival Error:", error);
        res.status(500).json({ message: 'Could not delete the holiday. Please try again.' });
    }
};

// Exposed for the QA unit check (qa/admin-festivals-notice/unit.cjs).
exports._test = { readFestivalInput, isDateKey, daySpan, MAX_SPAN_DAYS };

// Same-instant creates queue per company (utils/employee_lock.js serialisePerTenant):
// the duplicate check above reads then writes, so two requests arriving together
// both passed it and both created.
exports.createFestival = serialisePerTenant(exports.createFestival, 'create');
