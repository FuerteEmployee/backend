const mongoose = require('mongoose');
const AdvanceSalaryRequest = require('../models/AdvanceSalaryRequest');
const User = require('../models/User');

// Every 500 below used to send `error.message` to the client, and the employee
// app shows that string word-for-word in a toast — so people saw Mongoose
// internals like "Cast to Number failed for value ..." or "reason.trim is not
// a function". Log the real error; send a sentence a person can act on.
const SERVER_ERROR_MESSAGE = 'Something went wrong. Please try again in a few minutes.';

// Mirrors the maxlength on the model. Checked here first so an over-long reason
// gets a plain 400 rather than a raw Mongoose validation 500.
const MAX_TEXT_LENGTH = 500;

// A phone on a weak network can lose the response to a request the server did
// save. The app then shows an error with the form still filled in, and the
// next tap files the same request again. Employees cannot cancel a request, so
// the copy sits in the admin's queue until somebody rejects it. An identical
// pending request from this window is treated as the same submission.
const DUPLICATE_WINDOW_MS = 60 * 1000;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Hard cap on one request: ₹1,00,00,000 (1 crore), set by the product owner on
// 2026-09-25. Nothing stopped a request before, and the database already holds
// requests for ₹1e20 and more — which render as 30-digit numbers, and which
// payroll would deduct as-is if one were approved. The app enforces the same
// cap (NewRequestModal.tsx); change both together.
const MAX_REQUEST_AMOUNT = 10000000;

// The cap applies to what gets APPROVED as well as to what gets asked for.
// Every request above it was saved before the cap existed (₹1e14 up to ₹5e55
// in the test database); approving one records that amount, and payroll then
// deducts it from the employee's salary in full.
const OVER_CAP_APPROVE_MESSAGE = 'This request is over ₹1,00,00,000 and cannot be approved. Reject it instead.';
const OVER_CAP_REPAID_MESSAGE = 'This request is over ₹1,00,00,000 and cannot be marked as repaid.';

// The admin's optional reason for a rejection, shown to the employee.
const MAX_REMARK_LENGTH = 300;

/**
 * Validate the amount an admin approves. Returns { value } or { error }.
 *
 * Absent means "the full requested amount". It used to be `Number(raw)` with
 * only a `< 1` check, so `true` approved ₹1, 1500.5 approved paise, and a
 * request's own amount was approved whatever it was.
 */
function parseApprovedAmount(raw, requested) {
    const supplied = raw !== undefined && raw !== null && raw !== '';
    let value = supplied ? raw : requested;
    if (typeof value === 'string' && value.trim() !== '') value = Number(value);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { error: 'Please enter the approved amount in numbers, for example 5000.' };
    }
    if (value < 1) {
        return { error: 'Approved amount must be at least ₹1.' };
    }
    if (!Number.isInteger(value)) {
        return { error: 'Please enter the approved amount in whole rupees, without paise.' };
    }
    if (value > MAX_REQUEST_AMOUNT) {
        return { error: OVER_CAP_APPROVE_MESSAGE };
    }
    if (value > requested) {
        return { error: 'Approved amount cannot be more than the requested amount.' };
    }
    return { value };
}

/**
 * Validate a requested amount. Returns { value } or { error }.
 *
 * The old check was `!amount || amount < 1`, which let `true` through (stored
 * as ₹1), let "abc" and [5] through to die in the Mongoose cast as a 500, and
 * accepted 1.5 and 1e26 as-is. Numeric strings are still accepted because an
 * older client may send them.
 */
function parseAmount(raw) {
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { error: 'Please enter the amount in numbers, for example 5000.' };
    }
    if (value < 1) {
        return { error: 'Amount must be at least ₹1.' };
    }
    if (!Number.isInteger(value)) {
        return { error: 'Please enter the amount in whole rupees, without paise.' };
    }
    if (value > MAX_REQUEST_AMOUNT) {
        return { error: 'Maximum amount is ₹1,00,00,000.' };
    }
    return { value };
}

/**
 * Load one request inside the caller's tenant. The tenant is part of the query
 * rather than compared after the fetch, and a malformed id reads as "not found"
 * instead of reaching findById and coming back as a CastError 500.
 */
async function findTenantRequest(id, companyId) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    return AdvanceSalaryRequest.findOne({ _id: id, companyId });
}

// What an admin is told when the request was decided in the meantime -- by
// another admin, in another tab, or by a double tap on a slow network.
const ALREADY_DECIDED = {
    approved: 'This request was already approved. Refresh the page to see the latest.',
    rejected: 'This request was already rejected. Refresh the page to see the latest.',
    repaid: 'This request is already marked as repaid. Refresh the page to see the latest.',
};
const alreadyDecidedMessage = (status) => ALREADY_DECIDED[status] || 'This request was already decided. Refresh the page to see the latest.';

const DECISION_POPULATE = [
    { path: 'employeeId', select: 'name phone email profileImage' },
    { path: 'branchId', select: 'name' },
    { path: 'reviewedBy', select: 'name' }
];

/**
 * Move one request out of `fromStatus` in a single conditional write.
 *
 * The status is part of the filter, so two decisions racing each other (two
 * admins, or a double tap) cannot both land: the loser matches nothing and is
 * told what happened with a 409. It used to be read, check, then save(), and
 * the second save simply overwrote the first -- an approve could turn into a
 * reject after the employee had already been told yes.
 */
async function transitionRequest(id, companyId, fromStatus, set, unset) {
    const update = unset ? { $set: set, $unset: unset } : { $set: set };
    return AdvanceSalaryRequest.findOneAndUpdate(
        { _id: id, companyId, status: fromStatus },
        update,
        { new: true, runValidators: true }
    ).populate(DECISION_POPULATE);
}

/** The 404/409 answer after a conditional write matched nothing. */
async function lostRace(res, id, companyId) {
    const now = await findTenantRequest(id, companyId);
    if (!now) return res.status(404).json({ success: false, message: 'Request not found' });
    return res.status(409).json({ success: false, message: alreadyDecidedMessage(now.status) });
}

/** Validate an optional/required free-text field. Returns { value } or { error }. */
function parseText(raw, { required, missingMessage, tooLongMessage, label, maxLength = MAX_TEXT_LENGTH }) {
    if (raw === undefined || raw === null) raw = '';
    if (typeof raw !== 'string') {
        return { error: `${label} must be written as text.` };
    }
    const value = raw.trim();
    if (required && !value) {
        return { error: missingMessage };
    }
    if (value.length > maxLength) {
        return { error: tooLongMessage };
    }
    return { value: value || undefined };
}

/**
 * GET /api/advance-salary
 * List advance salary & loan requests with filters
 * Query: branchId, type, status, search (employee name)
 * Auth: verify companyId
 * Access: employee sees own only, branch_admin sees branch, super_admin sees all
 */
const getAdvanceSalaryRequests = async (req, res) => {
    try {
        const { branchId, type, status, search, employeeId } = req.query;
        const userId = req.user.userId;
        const userRole = req.user.role;
        const companyId = req.adminId;

        // A malformed id used to reach .find() and come back as a CastError 500.
        if ((branchId && !mongoose.Types.ObjectId.isValid(branchId)) ||
            (employeeId && !mongoose.Types.ObjectId.isValid(employeeId))) {
            return res.status(400).json({ success: false, message: 'Invalid branch or employee' });
        }

        // Build query
        const query = { companyId };

        // Role-based filters
        if (userRole === 'employee') {
            query.employeeId = userId;
        } else if (userRole === 'subadmin' || (userRole === 'admin' && branchId)) {
            // Subadmin or admin with branch filter
            if (branchId) query.branchId = branchId;
        } else if (userRole === 'superadmin') {
            // Super admin sees all; can optionally filter by branch
            if (branchId) query.branchId = branchId;
        } else if (userRole === 'admin') {
            // Regular admin sees all branches
        }

        // Explicit single-employee filter (e.g. the payroll advance-deduction
        // picker) — admins/subadmins only, employees are already self-scoped above.
        if (employeeId && userRole !== 'employee') {
            query.employeeId = employeeId;
        }

        // Type filter
        if (type && (type === 'advance-salary' || type === 'loan')) {
            query.type = type;
        }

        // Status filter
        if (status && ['pending', 'approved', 'rejected', 'repaid'].includes(status)) {
            query.status = status;
        }

        // Search by employee name — a panel tool, so never for an employee.
        // For an employee it used to REPLACE the self-scope above with an $in of
        // whoever matched; that only stayed harmless because the lookup filtered
        // on `companyId`, which User does not have, so every search matched
        // nobody (for admins too). The term is escaped because it went into
        // $regex raw: "(" was a 500, and a crafted pattern could pin the CPU.
        if (search && userRole !== 'employee') {
            const employees = await User.find({
                adminId: companyId,
                name: { $regex: escapeRegex(search), $options: 'i' }
            }).select('_id');
            const employeeIds = employees.map(emp => emp._id);
            query.employeeId = { $in: employeeIds };
        }

        const requests = await AdvanceSalaryRequest.find(query)
            .populate('employeeId', 'name phone email profileImage')
            .populate('branchId', 'name')
            .populate('reviewedBy', 'name')
            .sort({ createdAt: -1 })
            .lean();

        res.status(200).json({
            success: true,
            data: requests,
            count: requests.length
        });
    } catch (error) {
        console.error('Error fetching advance salary requests:', error);
        res.status(500).json({ success: false, message: SERVER_ERROR_MESSAGE });
    }
};

/**
 * POST /api/advance-salary
 * Create a new advance salary or loan request
 * Body: type, amount, reason, notes
 * Auth: employee creates for self
 */
const createAdvanceSalaryRequest = async (req, res) => {
    try {
        const body = req.body || {};
        const { type } = body;
        const employeeId = req.user.userId;
        const companyId = req.adminId;

        // The request is always for the person sending it, so only an
        // employee can send one. A sub-admin's token used to be accepted and
        // filed a request in their own name, which no admin screen expects.
        if (req.user.role !== 'employee') {
            return res.status(403).json({ success: false, message: 'Only employees can send advance salary or loan requests.' });
        }

        // Validate inputs. The messages are shown to the employee as-is, so
        // they say what to do rather than what failed.
        if (!type || !['advance-salary', 'loan'].includes(type)) {
            return res.status(400).json({ success: false, message: 'Please choose Advance Salary or Loan.' });
        }
        const amount = parseAmount(body.amount);
        if (amount.error) {
            return res.status(400).json({ success: false, message: amount.error });
        }
        const reason = parseText(body.reason, {
            required: true,
            label: 'Reason',
            missingMessage: 'Please write why you need this money.',
            tooLongMessage: `Your reason is too long. Please use ${MAX_TEXT_LENGTH} letters or fewer.`
        });
        if (reason.error) {
            return res.status(400).json({ success: false, message: reason.error });
        }
        const notes = parseText(body.notes, {
            required: false,
            label: 'Notes',
            tooLongMessage: `Your notes are too long. Please use ${MAX_TEXT_LENGTH} letters or fewer.`
        });
        if (notes.error) {
            return res.status(400).json({ success: false, message: notes.error });
        }

        // Get employee to verify they belong to this company
        const employee = await User.findById(employeeId);
        if (!employee || employee.adminId?.toString() !== companyId.toString()) {
            return res.status(403).json({ success: false, message: 'Only employees can send advance salary or loan requests.' });
        }

        // Get branch
        const branchId = employee.branchId;
        if (!branchId) {
            return res.status(400).json({
                success: false,
                message: 'Your branch is not set yet. Please ask your admin to set your branch, then try again.'
            });
        }

        const populateFields = [
            { path: 'employeeId', select: 'name phone email profileImage' },
            { path: 'branchId', select: 'name' }
        ];

        const duplicate = await AdvanceSalaryRequest.findOne({
            companyId,
            employeeId,
            type,
            amount: amount.value,
            reason: reason.value,
            status: 'pending',
            createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) }
        }).sort({ createdAt: -1 });
        if (duplicate) {
            return res.status(200).json({
                success: true,
                duplicate: true,
                message: 'Your request was already sent.',
                data: await duplicate.populate(populateFields)
            });
        }

        const request = await AdvanceSalaryRequest.create({
            employeeId,
            companyId,
            branchId,
            type,
            amount: amount.value,
            // Stored trimmed: the admin list shows it in quotes, and a reason
            // padded with spaces looked like an empty one.
            reason: reason.value,
            notes: notes.value,
            status: 'pending'
        });

        const populated = await request.populate(populateFields);

        res.status(201).json({
            success: true,
            message: 'Request created successfully',
            data: populated
        });
    } catch (error) {
        console.error('Error creating advance salary request:', error);
        res.status(500).json({ success: false, message: SERVER_ERROR_MESSAGE });
    }
};

/**
 * GET /api/advance-salary/summary
 * Get 4 stat totals: pending/approved/rejected/repaid (₹ sums)
 * Query: branchId (optional, defaults to user's branch/company)
 * Uses Promise.all + 4 aggregations
 */
const getAdvanceSalarySummary = async (req, res) => {
    try {
        const { branchId } = req.query;
        const userRole = req.user.role;
        const companyId = req.adminId;

        // NOTE: aggregation $match does NOT auto-cast strings to ObjectId the way
        // Mongoose .find() does. companyId / employeeId / branchId are stored as
        // ObjectId, so we must cast the (string) request values or every $match
        // silently returns nothing — which showed up as all-zero summary cards.
        const matchStage = { companyId: new mongoose.Types.ObjectId(companyId) };

        // Role-based filter
        if (userRole === 'employee') {
            matchStage.employeeId = new mongoose.Types.ObjectId(req.user.userId);
        } else if (
            (userRole === 'admin' || userRole === 'subadmin' || userRole === 'superadmin') &&
            branchId &&
            mongoose.Types.ObjectId.isValid(branchId)
        ) {
            matchStage.branchId = new mongoose.Types.ObjectId(branchId);
        }

        // Approved and repaid money is what the admin actually granted, which a
        // partial approval makes smaller than what was asked. Summing `amount`
        // overstated both — and payroll recovers approvedAmount, so "repaid"
        // claimed more had been paid back than was ever taken.
        const grantedAmount = { $ifNull: ['$approvedAmount', '$amount'] };

        // Promise.all with 4 separate aggregations
        const [pendingResult, approvedResult, rejectedResult, repaidResult] = await Promise.all([
            AdvanceSalaryRequest.aggregate([
                { $match: { ...matchStage, status: 'pending' } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]),
            AdvanceSalaryRequest.aggregate([
                { $match: { ...matchStage, status: 'approved' } },
                { $group: { _id: null, total: { $sum: grantedAmount } } }
            ]),
            AdvanceSalaryRequest.aggregate([
                { $match: { ...matchStage, status: 'rejected' } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]),
            AdvanceSalaryRequest.aggregate([
                { $match: { ...matchStage, status: 'repaid' } },
                { $group: { _id: null, total: { $sum: grantedAmount } } }
            ])
        ]);

        res.status(200).json({
            success: true,
            data: {
                pending: pendingResult[0]?.total || 0,
                approved: approvedResult[0]?.total || 0,
                rejected: rejectedResult[0]?.total || 0,
                repaid: repaidResult[0]?.total || 0
            }
        });
    } catch (error) {
        console.error('Error fetching summary:', error);
        res.status(500).json({ success: false, message: SERVER_ERROR_MESSAGE });
    }
};

/**
 * PATCH /api/advance-salary/:id/approve
 * Approve a pending request
 * Auth: branch_admin or super_admin only
 */
const approveAdvanceSalary = async (req, res) => {
    try {
        const { id } = req.params;
        const userRole = req.user.role;
        const userId = req.user.userId;
        const companyId = req.adminId;

        // Only branch_admin and super_admin can approve
        if (!['admin', 'superadmin'].includes(userRole)) {
            return res.status(403).json({ success: false, message: 'Only admins can approve requests' });
        }

        const request = await findTenantRequest(id, companyId);
        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found' });
        }

        // Only pending requests can be approved. Checked here for a clear
        // message; the conditional write below is what makes it race-safe.
        if (request.status !== 'pending') {
            return res.status(409).json({ success: false, message: alreadyDecidedMessage(request.status) });
        }

        // A request above the cap is refused at ANY amount, including a
        // partial one: none of them is a real request, and the employee can
        // send a new one within the cap. `!(x <= cap)` also catches a
        // non-numeric stored amount.
        if (!(request.amount <= MAX_REQUEST_AMOUNT)) {
            return res.status(400).json({ success: false, message: OVER_CAP_APPROVE_MESSAGE });
        }

        // Optional partial approval — admin may approve less than requested.
        // Defaults to the full requested amount when not supplied.
        const approved = parseApprovedAmount(req.body?.approvedAmount, request.amount);
        if (approved.error) {
            return res.status(400).json({ success: false, message: approved.error });
        }

        const updated = await transitionRequest(id, companyId, 'pending', {
            status: 'approved',
            approvedAmount: approved.value,
            reviewedBy: userId,
            reviewedAt: new Date()
        }, { adminRemark: 1 });
        if (!updated) return lostRace(res, id, companyId);

        res.status(200).json({
            success: true,
            message: 'Request approved successfully',
            data: updated
        });
    } catch (error) {
        console.error('Error approving request:', error);
        res.status(500).json({ success: false, message: SERVER_ERROR_MESSAGE });
    }
};

/**
 * PATCH /api/advance-salary/:id/reject
 * Reject a pending request
 * Auth: branch_admin or super_admin only
 */
const rejectAdvanceSalary = async (req, res) => {
    try {
        const { id } = req.params;
        const userRole = req.user.role;
        const userId = req.user.userId;
        const companyId = req.adminId;

        // Only branch_admin and super_admin can reject
        if (!['admin', 'superadmin'].includes(userRole)) {
            return res.status(403).json({ success: false, message: 'Only admins can reject requests' });
        }

        const request = await findTenantRequest(id, companyId);
        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found' });
        }

        // Only pending requests can be rejected.
        if (request.status !== 'pending') {
            return res.status(409).json({ success: false, message: alreadyDecidedMessage(request.status) });
        }

        // Optional: why. Shown to the employee, who otherwise only learned
        // "Not approved" and had to go and ask.
        const remark = parseText(req.body?.adminRemark, {
            required: false,
            label: 'Reason',
            maxLength: MAX_REMARK_LENGTH,
            tooLongMessage: `Please keep the reason under ${MAX_REMARK_LENGTH} letters.`
        });
        if (remark.error) {
            return res.status(400).json({ success: false, message: remark.error });
        }

        const set = { status: 'rejected', reviewedBy: userId, reviewedAt: new Date() };
        if (remark.value) set.adminRemark = remark.value;
        const updated = await transitionRequest(id, companyId, 'pending', set, remark.value ? undefined : { adminRemark: 1 });
        if (!updated) return lostRace(res, id, companyId);

        res.status(200).json({
            success: true,
            message: 'Request rejected successfully',
            data: updated
        });
    } catch (error) {
        console.error('Error rejecting request:', error);
        res.status(500).json({ success: false, message: SERVER_ERROR_MESSAGE });
    }
};

/**
 * PATCH /api/advance-salary/:id/repaid
 * Mark as repaid
 * Auth: branch_admin or super_admin only
 */
const markAdvanceSalaryRepaid = async (req, res) => {
    try {
        const { id } = req.params;
        const userRole = req.user.role;
        const companyId = req.adminId;

        // Only branch_admin and super_admin can mark repaid
        if (!['admin', 'superadmin'].includes(userRole)) {
            return res.status(403).json({ success: false, message: 'Only admins can mark as repaid' });
        }

        const request = await findTenantRequest(id, companyId);
        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found' });
        }

        // Only approved requests can be marked repaid.
        if (request.status !== 'approved') {
            const message = request.status === 'repaid'
                ? alreadyDecidedMessage('repaid')
                : 'Only an approved request can be marked as repaid.';
            return res.status(409).json({ success: false, message });
        }

        // An over-cap amount approved before the approve guard existed must
        // not be recorded as money paid back either: it would add ₹1e20 to
        // the "Repaid" totals. Approval now refuses these, so this only
        // matters for a row that slipped through earlier.
        if (!((request.approvedAmount ?? request.amount) <= MAX_REQUEST_AMOUNT)) {
            return res.status(400).json({ success: false, message: OVER_CAP_REPAID_MESSAGE });
        }

        // Conditional on 'approved', so a payroll run recovering this advance
        // at the same moment cannot be overwritten or double-marked.
        const updated = await transitionRequest(id, companyId, 'approved', { status: 'repaid', repaidAt: new Date() });
        if (!updated) return lostRace(res, id, companyId);

        res.status(200).json({
            success: true,
            message: 'Request marked as repaid successfully',
            data: updated
        });
    } catch (error) {
        console.error('Error marking as repaid:', error);
        res.status(500).json({ success: false, message: SERVER_ERROR_MESSAGE });
    }
};

// The duplicate check inside reads then writes; two requests together both passed it.
const { serialisePerUser } = require('../utils/employee_lock');

module.exports = {
    getAdvanceSalaryRequests,
    createAdvanceSalaryRequest: serialisePerUser(createAdvanceSalaryRequest, 'create'),
    getAdvanceSalarySummary,
    approveAdvanceSalary,
    rejectAdvanceSalary,
    markAdvanceSalaryRepaid
};
