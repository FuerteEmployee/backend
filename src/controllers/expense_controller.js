const Expense = require('../models/Expense');
const User = require('../models/User');
const mongoose = require('mongoose');
const { istDateKey } = require('../utils/attendance_helpers');

// Limits on an employee's claim. The app enforces the same numbers before
// submit; these are what hold when the request comes from anywhere else.
const MIN_AMOUNT = 1;
const MAX_AMOUNT = 10000000; // ₹1,00,00,000
const MAX_CLAIM_AGE_DAYS = 365;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 60;
const MAX_REMARK_LENGTH = 300; // mirrors Expense.adminRemark maxlength

/**
 * The admin's optional reason for rejecting, from the request body.
 * Returns { value } (undefined when blank) or { error }. Checked here so an
 * over-long or non-text reason is a plain 400, not a Mongoose 500 -- and
 * because updateMany (the split-group path) never runs the schema maxlength.
 */
function parseRemark(raw) {
    if (raw === undefined || raw === null) return { value: undefined };
    if (typeof raw !== 'string') return { error: 'The reason must be written as text.' };
    const value = raw.trim();
    if (value.length > MAX_REMARK_LENGTH) {
        return { error: `Please keep the reason under ${MAX_REMARK_LENGTH} letters.` };
    }
    return { value: value || undefined };
}

// Every 500 used to send `error.message`, so the panel showed Mongoose text
// such as "Cast to ObjectId failed for value ...". Log it; say something usable.
const SERVER_ERROR_MESSAGE = 'Something went wrong. Please try again in a few minutes.';
const serverError = (res, where, error) => {
    console.error(`expense ${where} error:`, error);
    return res.status(500).json({ message: SERVER_ERROR_MESSAGE });
};

const isId = (v) => typeof v === 'string' ? mongoose.Types.ObjectId.isValid(v) && /^[0-9a-fA-F]{24}$/.test(v) : mongoose.Types.ObjectId.isValid(v);

// Only payroll marks a claim reimbursed (salary_controller), because that is
// the moment the money is actually added to a payslip. Allowing it from the
// panel recorded a claim as paid that no salary ever paid.
const PANEL_STATUSES = ['pending', 'approved', 'rejected'];

const ALREADY_DECIDED = {
    approved: 'This expense was already approved. Refresh the page to see the latest.',
    rejected: 'This expense was already rejected. Refresh the page to see the latest.',
    reimbursed: 'This expense was already paid in a salary. Refresh the page to see the latest.',
};
const alreadyDecidedMessage = (status) => ALREADY_DECIDED[status] || 'This expense was already decided. Refresh the page to see the latest.';

const OVER_CAP_APPROVE_MESSAGE = 'This expense is over ₹1,00,00,000 and cannot be approved. Reject it instead.';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const paidInMessage = (expense, action) => {
    const d = expense.reimbursedInMonth ? new Date(expense.reimbursedInMonth) : null;
    const when = d && !Number.isNaN(d.getTime()) ? ` in the salary for ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : ' in a salary';
    return `This expense was already paid${when}, so it cannot be ${action}. Delete that salary first if it was a mistake.`;
};

/**
 * Amount entered from the admin panel. Returns { value } or { error }.
 * Numbers or numeric strings, at least ₹1, at most 2 decimals. The edit path
 * used to accept anything -- a negative amount became a negative
 * reimbursement, i.e. a deduction from the employee's salary, and "abc"
 * was a 500. (The ₹1 crore ceiling on the admin's own entries is a pending
 * product decision; the employee's claim already has it.)
 */
function parsePanelAmount(raw) {
    const text = typeof raw === 'number' ? String(raw) : (typeof raw === 'string' ? raw.trim() : '');
    const value = Number(text);
    if (!text || !Number.isFinite(value) || !/^\d+(\.\d{1,2})?$/.test(text)) {
        return { error: 'Please enter the amount in numbers only, like 250 or 250.50.' };
    }
    if (value < MIN_AMOUNT) return { error: 'The amount must be at least ₹1.' };
    return { value };
}

/** A calendar date (YYYY-MM-DD or an ISO date) from the panel. */
function parsePanelDate(raw) {
    if (typeof raw !== 'string' && !(raw instanceof Date)) return { error: 'Please choose the date of the expense.' };
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return { error: 'Please choose the date of the expense.' };
    return { value: d };
}

/**
 * Build the fields an admin may set on an expense, from the request body.
 * A whitelist, never a spread: the body used to go into create() and
 * findOneAndUpdate() as-is, so `{"$set":{"adminId":...}}` moved a claim into
 * another company, and `status: "reimbursed"` / `reimbursedInMonth` could be
 * written by hand. Returns { fields } or { status, error }.
 */
async function panelFields(req, { partial }) {
    const body = req.body || {};
    const fields = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;

    if (!partial || has('employeeId')) {
        const raw = body.employeeId;
        if (raw === null || raw === '' || raw === 'admin' || raw === undefined) {
            fields.employeeId = null;
            fields.employeeName = 'General Office';
        } else {
            if (typeof raw !== 'string' || !isId(raw)) return { status: 400, error: 'Please choose an employee from the list.' };
            const emp = await User.findOne({ _id: raw, adminId: req.adminId, role: 'employee' }).select('_id name');
            if (!emp) return { status: 400, error: 'Please choose an employee from the list.' };
            fields.employeeId = emp._id;
            fields.employeeName = emp.name;
        }
    }
    if (!partial || has('amount')) {
        const amount = parsePanelAmount(body.amount);
        if (amount.error) return { status: 400, error: amount.error };
        fields.amount = amount.value;
    }
    if (!partial || has('date')) {
        const date = parsePanelDate(body.date);
        if (date.error) return { status: 400, error: date.error };
        fields.date = date.value;
    }
    if (!partial || has('category')) {
        if (typeof body.category !== 'string' || !body.category.trim() || body.category.length > MAX_CATEGORY_LENGTH) {
            return { status: 400, error: 'Please choose the expense type.' };
        }
        fields.category = body.category.trim();
    }
    if (has('description')) {
        if (typeof body.description !== 'string') return { status: 400, error: 'Please write the details as text.' };
        if (body.description.length > MAX_DESCRIPTION_LENGTH) {
            return { status: 400, error: `Please keep the details under ${MAX_DESCRIPTION_LENGTH} letters.` };
        }
        fields.description = body.description.trim();
    }
    if (has('status')) {
        if (body.status === 'reimbursed') {
            return { status: 400, error: 'An expense is marked paid only when a salary pays it. Choose Pending, Approved or Rejected.' };
        }
        if (!PANEL_STATUSES.includes(body.status)) return { status: 400, error: 'Choose Pending, Approved or Rejected.' };
        fields.status = body.status;
    } else if (!partial) {
        fields.status = 'pending';
    }
    return { fields };
}

exports.getExpenses = async (req, res) => {
    try {
        const { startDate, endDate, employeeId, category, status } = req.query;
        const query = { adminId: new mongoose.Types.ObjectId(req.adminId) };

        // Employees may only ever see their own expense claims, never the whole tenant's
        if (req.user.role === 'employee') {
            query.employeeId = new mongoose.Types.ObjectId(req.userId);
        } else if (employeeId) {
            // A malformed id used to reach the ObjectId constructor and 500.
            if (typeof employeeId !== 'string' || !isId(employeeId)) {
                return res.status(400).json({ message: 'Please choose an employee from the list.' });
            }
            query.employeeId = new mongoose.Types.ObjectId(employeeId);
        }
        if (typeof category === 'string' && category) query.category = category;
        if (typeof status === 'string' && status) query.status = status;
        if (startDate && endDate) {
            const from = new Date(startDate);
            const to = new Date(endDate);
            if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
                return res.status(400).json({ message: 'Please choose a valid date range.' });
            }
            query.date = { $gte: from, $lte: to };
        }

        const expenses = await Expense.find(query).sort({ date: -1 });
        res.json(expenses);
    } catch (error) {
        return serverError(res, 'list', error);
    }
};

exports.addExpense = async (req, res) => {
    try {
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const attachmentUrl = req.file ? req.file.path : undefined;

        if (req.user.role === 'employee') {
            const { category, amount, date, description, splitWith } = req.body;
            const amountText = String(amount ?? '').trim();
            const totalAmount = Number(amountText);

            // Checked here, in words, because the alternatives were worse: a
            // negative or zero amount was stored as a real claim that an admin
            // could approve into a payout, and a blank one failed inside
            // Mongoose with "Cast to Number failed for value NaN", which is
            // what the employee was shown. Digits only (paise allowed), so
            // "1e7", "-5" or "₹500" never reach Number().
            if (!/^\d+(\.\d{1,2})?$/.test(amountText) || !Number.isFinite(totalAmount)) {
                return res.status(400).json({ message: 'Please enter the amount in numbers only, like 250 or 250.50.' });
            }
            if (totalAmount < MIN_AMOUNT) {
                return res.status(400).json({ message: 'The amount must be at least ₹1.' });
            }
            if (totalAmount > MAX_AMOUNT) {
                return res.status(400).json({ message: 'The amount cannot be more than ₹1,00,00,000.' });
            }
            const dateKey = typeof date === 'string' ? date.slice(0, 10) : '';
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || Number.isNaN(new Date(dateKey).getTime())) {
                return res.status(400).json({ message: 'Please choose the date you spent the money.' });
            }
            // Compared as IST calendar days, so "today" is today in India
            // whatever timezone this server runs in.
            if (dateKey > istDateKey()) {
                return res.status(400).json({ message: 'The expense date cannot be in the future.' });
            }
            if (dateKey < istDateKey(new Date(Date.now() - MAX_CLAIM_AGE_DAYS * 24 * 60 * 60 * 1000))) {
                return res.status(400).json({ message: 'This date is more than 1 year ago. Please check the date.' });
            }
            if (typeof category !== 'string' || !category.trim() || category.length > MAX_CATEGORY_LENGTH) {
                return res.status(400).json({ message: 'Please choose the expense type.' });
            }
            if (typeof description === 'string' && description.length > MAX_DESCRIPTION_LENGTH) {
                return res.status(400).json({ message: `Please keep the details under ${MAX_DESCRIPTION_LENGTH} letters.` });
            }

            let splitIds = [];
            if (splitWith) {
                try {
                    splitIds = JSON.parse(splitWith);
                } catch {
                    splitIds = [];
                }
            }
            if (!Array.isArray(splitIds)) splitIds = [];
            // De-duplicated and without the submitter: a repeated id made the
            // colleague count disagree with the id count and was refused as
            // "could not be found", and the submitter's own id would have
            // created two shares for them.
            splitIds = [...new Set(splitIds.map(String))].filter(id => id !== String(req.userId));
            if (splitIds.some(id => !mongoose.Types.ObjectId.isValid(id))) {
                return res.status(400).json({ message: 'One or more selected colleagues could not be found' });
            }

            // The same claim again within a minute is the same tap, not a second expense:
            // a double tap made two identical claims (measured 2026-09-30). Answered with the
            // existing claim so the person sees success, not an error after a success.
            const repeated = await Expense.findOne({
                adminId,
                employeeId: req.userId,
                category,
                date,
                description: typeof description === 'string' ? description : null,
                createdAt: { $gte: new Date(Date.now() - 60 * 1000) },
                $or: [
                    { amount: totalAmount, splitGroupId: { $exists: false } },
                    { splitTotalAmount: totalAmount },
                ],
            }).sort({ createdAt: -1 });
            if (repeated) return res.status(200).json(repeated);

            if (splitIds.length > 0) {
                const colleagues = await User.find({
                    _id: { $in: splitIds },
                    adminId: req.adminId,
                    role: 'employee'
                }).select('_id name');

                if (colleagues.length !== splitIds.length) {
                    return res.status(400).json({ message: 'One or more selected colleagues could not be found' });
                }

                const participantCount = colleagues.length + 1;
                const share = totalAmount / participantCount;
                const splitGroupId = new mongoose.Types.ObjectId();

                const self = await User.findById(req.userId).select('name');
                const participants = [
                    { employeeId: req.userId, employeeName: self.name },
                    ...colleagues.map(c => ({ employeeId: c._id, employeeName: c.name }))
                ];

                const docs = participants.map(p => ({
                    adminId,
                    employeeId: p.employeeId,
                    employeeName: p.employeeName,
                    category,
                    amount: share,
                    date,
                    description,
                    status: 'pending',
                    attachmentUrl,
                    splitGroupId,
                    splitTotalAmount: totalAmount,
                    splitParticipantCount: participantCount
                }));

                const created = await Expense.insertMany(docs);
                const ownRecord = created.find(e => String(e.employeeId) === String(req.userId));
                return res.status(201).json(ownRecord || created[0]);
            }

            const expense = await Expense.create({
                adminId,
                employeeId: req.userId,
                employeeName: req.currentUser.name,
                category,
                amount: totalAmount,
                date,
                description,
                status: 'pending',
                attachmentUrl
            });
            return res.status(201).json(expense);
        }

        // Panel entry (admin / sub-admin). Whitelisted and checked: the body
        // used to be spread into create(), so it could carry any status
        // (including "reimbursed"), reimbursedInMonth, reviewer fields, or
        // an employee of another company.
        const built = await panelFields(req, { partial: false });
        if (built.error) return res.status(built.status).json({ message: built.error });
        const fields = built.fields;
        if (fields.status !== 'pending') {
            fields.reviewedBy = req.userId;
            fields.reviewedAt = new Date();
        }
        const expense = await Expense.create({ ...fields, adminId, attachmentUrl });
        res.status(201).json(expense);
    } catch (error) {
        return serverError(res, 'create', error);
    }
};

/**
 * Decide one claim in a single conditional write on status 'pending', so a
 * double tap or two admins at once cannot both land (the loser gets 409).
 * It used to be read-check-save, where the second save won.
 */
async function decideOne(req, res, newStatus) {
    if (req.user.role === 'employee') {
        return res.status(403).json({ message: `Employees cannot ${newStatus === 'approved' ? 'approve' : 'reject'} expenses` });
    }

    let remark = { value: undefined };
    if (newStatus === 'rejected') {
        remark = parseRemark(req.body?.adminRemark);
        if (remark.error) return res.status(400).json({ message: remark.error });
    }

    // A malformed id is "not found", not a CastError 500.
    if (!isId(req.params.id)) {
        return res.status(404).json({ message: 'Expense not found' });
    }
    const expense = await Expense.findOne({ _id: req.params.id, adminId: req.adminId });
    if (!expense) return res.status(404).json({ message: 'Expense not found' });
    if (expense.status !== 'pending') {
        return res.status(409).json({ message: alreadyDecidedMessage(expense.status) });
    }
    // One share of a split bill is one part of one real expense. Deciding it
    // alone left the others pending (or decided the other way), which the
    // group endpoints exist to prevent -- only the UI used to enforce that.
    if (expense.splitGroupId) {
        return res.status(409).json({ message: 'This expense was split between several people. Approve or reject all the shares together.' });
    }
    // Same ₹1 crore limit the claim form has. Claims saved before it existed
    // hold amounts like ₹1e50; approving one would put that on a payslip.
    if (newStatus === 'approved' && !(expense.amount <= MAX_AMOUNT)) {
        return res.status(400).json({ message: OVER_CAP_APPROVE_MESSAGE });
    }

    const set = { status: newStatus, reviewedBy: req.userId, reviewedAt: new Date() };
    if (remark.value) set.adminRemark = remark.value;
    const update = remark.value ? { $set: set } : { $set: set, $unset: { adminRemark: 1 } };
    // Approving clears any old reason (a claim moved back to pending through
    // Edit and then approved must not keep the old rejection text).
    const updated = await Expense.findOneAndUpdate(
        { _id: expense._id, adminId: req.adminId, status: 'pending' },
        update,
        { new: true }
    );
    if (!updated) {
        const now = await Expense.findOne({ _id: expense._id, adminId: req.adminId }).select('status');
        if (!now) return res.status(404).json({ message: 'Expense not found' });
        return res.status(409).json({ message: alreadyDecidedMessage(now.status) });
    }
    res.json(updated);
}

exports.approveExpense = (req, res) => decideOne(req, res, 'approved').catch((err) => serverError(res, 'approve', err));
exports.rejectExpense = (req, res) => decideOne(req, res, 'rejected').catch((err) => serverError(res, 'reject', err));

// Approve/reject every share of a split expense together, so the same
// real-world expense can't end up half-approved, half-rejected across
// participants with no way to reconcile it from the UI.
async function reviewExpenseGroup(req, res, newStatus) {
    if (req.user.role === 'employee') {
        return res.status(403).json({ message: `Employees cannot ${newStatus} expenses` });
    }

    const { splitGroupId } = req.params;
    if (!isId(splitGroupId)) {
        return res.status(404).json({ message: 'Expense not found' });
    }

    // One reason for the whole group: every share is the same real expense.
    // Approving clears any old reason, as the single-claim approve does.
    let remarkValue;
    if (newStatus === 'rejected') {
        const remark = parseRemark(req.body?.adminRemark);
        if (remark.error) return res.status(400).json({ message: remark.error });
        remarkValue = remark.value;
    }
    const shares = await Expense.find({ splitGroupId, adminId: req.adminId }).select('status amount');
    if (!shares.length) {
        return res.status(404).json({ message: 'Expense not found' });
    }
    const pending = shares.filter((e) => e.status === 'pending');
    if (!pending.length) {
        return res.status(409).json({ message: alreadyDecidedMessage(shares[0].status) });
    }
    if (newStatus === 'approved' && pending.some((e) => !(e.amount <= MAX_AMOUNT))) {
        return res.status(400).json({ message: OVER_CAP_APPROVE_MESSAGE });
    }

    const set = { status: newStatus, reviewedBy: req.userId, reviewedAt: new Date() };
    const update = remarkValue
        ? { $set: { ...set, adminRemark: remarkValue } }
        : { $set: set, $unset: { adminRemark: 1 } };

    // Conditional on 'pending', so a second click matches nothing (409).
    const result = await Expense.updateMany(
        { splitGroupId, adminId: req.adminId, status: 'pending' },
        update
    );
    if (result.matchedCount === 0) {
        return res.status(409).json({ message: alreadyDecidedMessage(newStatus) });
    }

    const expenses = await Expense.find({ splitGroupId, adminId: req.adminId });
    res.json({ message: `Split expense group ${newStatus}`, expenses });
}

exports.approveExpenseGroup = (req, res) => reviewExpenseGroup(req, res, 'approved').catch((err) => serverError(res, 'group approve', err));
exports.rejectExpenseGroup = (req, res) => reviewExpenseGroup(req, res, 'rejected').catch((err) => serverError(res, 'group reject', err));

exports.updateExpense = async (req, res) => {
    try {
        if (req.user.role === 'employee') {
            return res.status(403).json({ message: 'Employees cannot edit expense records' });
        }
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Expense not found' });

        const existing = await Expense.findOne({ _id: req.params.id, adminId: req.adminId });
        if (!existing) return res.status(404).json({ message: 'Expense not found' });
        // Paid claims are frozen. Payroll re-reads a paid claim's amount on
        // every recompute of that month, so editing one silently changed a
        // salary that had already gone out.
        if (existing.status === 'reimbursed') {
            return res.status(409).json({ message: paidInMessage(existing, 'changed') });
        }

        const built = await panelFields(req, { partial: true });
        if (built.error) return res.status(built.status).json({ message: built.error });
        const fields = built.fields;

        // A share of a split bill belongs to its person; moving it to someone
        // else would leave the group with two shares for one person.
        if (existing.splitGroupId && 'employeeId' in fields && String(fields.employeeId || '') !== String(existing.employeeId || '')) {
            return res.status(400).json({ message: 'This expense was split between several people, so the person cannot be changed.' });
        }
        if (existing.splitGroupId && fields.status && fields.status !== existing.status) {
            return res.status(400).json({ message: 'This expense was split between several people. Use Approve or Reject so every share changes together.' });
        }

        // Edit must not become a back door around Approve's ₹1 crore check.
        const finalStatus = fields.status || existing.status;
        const finalAmount = 'amount' in fields ? fields.amount : existing.amount;
        if (finalStatus === 'approved' && !(finalAmount <= MAX_AMOUNT)) {
            return res.status(400).json({ message: OVER_CAP_APPROVE_MESSAGE });
        }

        const update = { $set: { ...fields } };
        if (fields.status && fields.status !== existing.status) {
            if (fields.status === 'pending') {
                update.$unset = { reviewedBy: 1, reviewedAt: 1 };
            } else {
                update.$set.reviewedBy = req.userId;
                update.$set.reviewedAt = new Date();
            }
            // A rejection reason belongs to the rejection only.
            if (fields.status !== 'rejected') update.$unset = { ...(update.$unset || {}), adminRemark: 1 };
        }

        // Conditional on the status just read, so a claim that payroll paid
        // (or another admin decided) in the meantime is not overwritten.
        const expense = await Expense.findOneAndUpdate(
            { _id: existing._id, adminId: req.adminId, status: existing.status },
            update,
            { new: true, runValidators: true }
        );
        if (!expense) {
            return res.status(409).json({ message: 'This expense was changed by someone else. Refresh the page and try again.' });
        }
        res.json(expense);
    } catch (error) {
        return serverError(res, 'update', error);
    }
};

exports.deleteExpense = async (req, res) => {
    try {
        if (req.user.role === 'employee') {
            return res.status(403).json({ message: 'Employees cannot delete expense records' });
        }
        if (!isId(req.params.id)) return res.status(404).json({ message: 'Expense not found' });

        const existing = await Expense.findOne({ _id: req.params.id, adminId: req.adminId }).select('status reimbursedInMonth');
        if (!existing) return res.status(404).json({ message: 'Expense not found' });
        // A paid claim is part of a payslip: deleting it made the next
        // recompute of that month quietly drop the reimbursement.
        if (existing.status === 'reimbursed') {
            return res.status(409).json({ message: paidInMessage(existing, 'deleted') });
        }

        const expense = await Expense.findOneAndDelete({
            _id: existing._id,
            adminId: req.adminId,
            status: { $ne: 'reimbursed' }
        });
        if (!expense) return res.status(409).json({ message: 'This expense was changed by someone else. Refresh the page and try again.' });
        res.json({ message: 'Expense deleted' });
    } catch (error) {
        return serverError(res, 'delete', error);
    }
};
const { serialisePerUser } = require('../utils/employee_lock');

// Creates for one person run one at a time, so the duplicate check above sees the first request.
exports.addExpense = serialisePerUser(exports.addExpense, 'create');
