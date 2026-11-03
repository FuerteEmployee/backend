const LeaveType = require('../models/LeaveType');
const Leave = require('../models/Leave');
const mongoose = require('mongoose');
const { serialisePerTenant } = require('../utils/employee_lock');

// Leave types are company policy that payroll reads directly (isPaid,
// payWeight) and that every employee's balance is measured against
// (totalDays). Each message below is read by an admin, often on a phone, so it
// says what to change rather than naming a schema path.

const isObjectId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

const MAX_NAME_LENGTH = 60;
const MAX_CODE_LENGTH = 10;
const MAX_DESCRIPTION_LENGTH = 500;
// A year of working days is already more than any real quota; the cap stops a
// mistyped 1200 (for 12) from handing every employee a balance nobody meant.
const MAX_DAYS = 365;

/**
 * The fields a request may write, validated and normalised.
 *
 * Copied field by field on purpose. This used to spread req.body straight
 * into create/findOneAndUpdate, so a body of {"$inc": {"totalDays": 5}} or
 * {"$set": {"isPaid": false}} was applied as a Mongo OPERATOR (and skipped
 * every validator), and an `_id` in a create body collided with an existing
 * type and came back as a raw E11000 error.
 *
 * `partial` (an edit) validates only the fields that were sent.
 */
function readLeaveTypeBody(body, { partial }) {
    const src = body && typeof body === 'object' ? body : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined;
    const data = {};

    if (!partial || has('leaveName')) {
        const name = typeof src.leaveName === 'string' ? src.leaveName.trim().replace(/\s+/g, ' ') : '';
        if (!name) return { error: 'Please enter a name for this leave type.' };
        if (name.length > MAX_NAME_LENGTH) return { error: `Please keep the name under ${MAX_NAME_LENGTH} letters.` };
        data.leaveName = name;
    }

    if (!partial || has('code')) {
        const code = typeof src.code === 'string' ? src.code.trim().toUpperCase() : '';
        if (!code) return { error: 'Please enter a short code for this leave type, for example CL or SL.' };
        if (code.length > MAX_CODE_LENGTH) return { error: `Please keep the code to ${MAX_CODE_LENGTH} letters or fewer.` };
        data.code = code;
    }

    if (!partial || has('totalDays')) {
        const raw = src.totalDays;
        const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
        if (!Number.isFinite(n)) return { error: 'Please enter how many days are allowed (0 or more).' };
        if (n < 0) return { error: 'Days allowed cannot be less than 0.' };
        if (n > MAX_DAYS) return { error: `Days allowed cannot be more than ${MAX_DAYS}.` };
        // Leave is booked in whole and half days, so a quota of 1.3 could
        // never be used up exactly and would show a left-over 0.3 for ever.
        if (Math.round(n * 2) !== n * 2) return { error: 'Days allowed must be a whole or half number, like 12 or 7.5.' };
        data.totalDays = n;
    }

    if (has('isPaid')) {
        if (typeof src.isPaid !== 'boolean') return { error: 'Please choose whether this leave is paid or unpaid.' };
        data.isPaid = src.isPaid;
    }

    if (has('payWeight')) {
        if (src.payWeight === null || src.payWeight === '') {
            data.payWeight = null;
        } else {
            const w = typeof src.payWeight === 'number' ? src.payWeight : Number(src.payWeight);
            if (!Number.isFinite(w) || w < 0 || w > 1) {
                return { error: 'The share of a day paid must be between 0 and 1, for example 0.5 for half pay.' };
            }
            data.payWeight = w;
        }
    }

    if (!partial || has('iconStyle')) {
        const icon = typeof src.iconStyle === 'string' ? src.iconStyle.trim() : '';
        if (icon.length > 40) return { error: 'Please choose an icon from the list.' };
        data.iconStyle = icon || 'Calendar';
    }

    if (has('colorCode')) {
        const color = typeof src.colorCode === 'string' ? src.colorCode.trim() : '';
        if (!/^#[0-9a-f]{6}$/i.test(color)) return { error: 'Please pick a colour for this leave type.' };
        data.colorCode = color;
    }

    if (has('description')) {
        if (src.description !== null && typeof src.description !== 'string') {
            return { error: 'The description must be text.' };
        }
        const text = (src.description || '').trim();
        if (text.length > MAX_DESCRIPTION_LENGTH) {
            return { error: `Please keep the description under ${MAX_DESCRIPTION_LENGTH} letters.` };
        }
        data.description = text;
    }

    return { data };
}

/**
 * Another type in this company with the same name or code, ignoring case.
 * Two "Casual Leave" rows let an employee apply against one and the admin
 * change the quota of the other, and the list gives no way to tell them apart.
 */
async function findClash(adminId, { leaveName, code }, excludeId) {
    const or = [];
    if (leaveName) or.push({ leaveName: { $regex: `^\\s*${escapeRegex(leaveName)}\\s*$`, $options: 'i' } });
    if (code) or.push({ code: { $regex: `^\\s*${escapeRegex(code)}\\s*$`, $options: 'i' } });
    if (!or.length) return null;
    const query = { adminId, $or: or };
    if (excludeId) query._id = { $ne: excludeId };
    const clash = await LeaveType.findOne(query).select('leaveName code');
    if (!clash) return null;
    if (leaveName && sameText(clash.leaveName, leaveName)) {
        return `A leave type named "${clash.leaveName}" already exists. Please use a different name.`;
    }
    return `The code "${clash.code}" is already used by "${clash.leaveName}". Please use a different code.`;
}

exports.getLeaveTypes = async (req, res) => {
    try {
        const leaveTypes = await LeaveType.find({ adminId: new mongoose.Types.ObjectId(req.adminId) }).sort({ createdAt: 1 });
        res.json(leaveTypes);
    } catch (error) {
        console.error('getLeaveTypes error:', error);
        res.status(500).json({ message: 'Could not load leave types. Please try again.' });
    }
};

exports.createLeaveType = async (req, res) => {
    try {
        const { data, error } = readLeaveTypeBody(req.body, { partial: false });
        if (error) return res.status(400).json({ message: error });

        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const clash = await findClash(adminId, data);
        if (clash) return res.status(409).json({ message: clash });

        const leaveType = await LeaveType.create({ ...data, adminId });
        res.status(201).json(leaveType);
    } catch (error) {
        console.error('createLeaveType error:', error);
        res.status(500).json({ message: 'Could not save the leave type. Please try again.' });
    }
};

exports.updateLeaveType = async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Leave type not found' });
        const { data, error } = readLeaveTypeBody(req.body, { partial: true });
        if (error) return res.status(400).json({ message: error });

        // The tenant is fixed by the token, never the body, so a type cannot be
        // moved into another company's list (and payroll).
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const current = await LeaveType.findOne({ _id: req.params.id, adminId }).select('leaveName code');
        if (!current) return res.status(404).json({ message: 'Leave type not found' });

        // Only a name or code that is actually CHANGING is checked. Tenants
        // may already hold duplicates from before this check existed, and
        // those rows must stay editable (to fix a quota, say) without first
        // being renamed.
        const changing = {
            leaveName: data.leaveName && !sameText(data.leaveName, current.leaveName) ? data.leaveName : null,
            code: data.code && !sameText(data.code, current.code) ? data.code : null,
        };
        const clash = await findClash(adminId, changing, current._id);
        if (clash) return res.status(409).json({ message: clash });

        const leaveType = await LeaveType.findOneAndUpdate(
            { _id: current._id, adminId },
            { $set: data },
            { new: true, runValidators: true }
        );
        if (!leaveType) return res.status(404).json({ message: 'Leave type not found' });
        res.json(leaveType);
    } catch (error) {
        console.error('updateLeaveType error:', error);
        res.status(500).json({ message: 'Could not save the leave type. Please try again.' });
    }
};

exports.deleteLeaveType = async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Leave type not found' });
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const leaveType = await LeaveType.findOne({ _id: req.params.id, adminId }).select('leaveName');
        if (!leaveType) return res.status(404).json({ message: 'Leave type not found' });

        // Refused while any approved or waiting request uses it. Payroll reads
        // a leave whose type it cannot find as PAID, so deleting an unpaid
        // type turned every approved day of it into paid leave at the next
        // salary run, and the requests themselves lost their name. Rejected
        // requests never reach payroll or a balance, so they do not block.
        const inUse = await Leave.countDocuments({
            adminId,
            leaveTypeId: leaveType._id,
            status: { $in: ['pending', 'approved'] },
        });
        if (inUse > 0) {
            return res.status(409).json({
                message: `"${leaveType.leaveName}" is used by ${inUse} approved or waiting leave request${inUse === 1 ? '' : 's'}, so it cannot be deleted. You can edit it instead.`,
                inUse,
            });
        }

        await LeaveType.deleteOne({ _id: leaveType._id, adminId });
        res.json({ message: 'Leave type deleted' });
    } catch (error) {
        console.error('deleteLeaveType error:', error);
        res.status(500).json({ message: 'Could not delete the leave type. Please try again.' });
    }
};

// Same-instant creates queue per company (utils/employee_lock.js serialisePerTenant):
// the duplicate check above reads then writes, so two requests arriving together
// both passed it and both created.
exports.createLeaveType = serialisePerTenant(exports.createLeaveType, 'create');
