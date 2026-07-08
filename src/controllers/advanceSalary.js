const mongoose = require('mongoose');
const AdvanceSalaryRequest = require('../models/AdvanceSalaryRequest');
const User = require('../models/User');

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

        // Search by employee name
        if (search) {
            const employees = await User.find({
                name: { $regex: search, $options: 'i' },
                companyId
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
        res.status(500).json({ success: false, message: error.message });
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
        const { type, amount, reason, notes } = req.body;
        const employeeId = req.user.userId;
        const companyId = req.adminId;

        // Validate inputs
        if (!type || !['advance-salary', 'loan'].includes(type)) {
            return res.status(400).json({ success: false, message: 'Invalid type' });
        }
        if (!amount || amount < 1) {
            return res.status(400).json({ success: false, message: 'Amount must be positive' });
        }
        if (!reason || reason.trim().length === 0) {
            return res.status(400).json({ success: false, message: 'Reason is required' });
        }

        // Get employee to verify they belong to this company
        const employee = await User.findById(employeeId);
        if (!employee || employee.adminId?.toString() !== companyId.toString()) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        // Get branch
        const branchId = employee.branchId;
        if (!branchId) {
            return res.status(400).json({ success: false, message: 'Employee has no branch assigned' });
        }

        const request = await AdvanceSalaryRequest.create({
            employeeId,
            companyId,
            branchId,
            type,
            amount,
            reason,
            notes: notes || undefined,
            status: 'pending'
        });

        const populated = await request.populate([
            { path: 'employeeId', select: 'name phone email profileImage' },
            { path: 'branchId', select: 'name' }
        ]);

        res.status(201).json({
            success: true,
            message: 'Request created successfully',
            data: populated
        });
    } catch (error) {
        console.error('Error creating advance salary request:', error);
        res.status(500).json({ success: false, message: error.message });
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

        // Promise.all with 4 separate aggregations
        const [pendingResult, approvedResult, rejectedResult, repaidResult] = await Promise.all([
            AdvanceSalaryRequest.aggregate([
                { $match: { ...matchStage, status: 'pending' } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]),
            AdvanceSalaryRequest.aggregate([
                { $match: { ...matchStage, status: 'approved' } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]),
            AdvanceSalaryRequest.aggregate([
                { $match: { ...matchStage, status: 'rejected' } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]),
            AdvanceSalaryRequest.aggregate([
                { $match: { ...matchStage, status: 'repaid' } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
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
        res.status(500).json({ success: false, message: error.message });
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

        const request = await AdvanceSalaryRequest.findById(id);
        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found' });
        }

        // Verify company ownership
        if (request.companyId.toString() !== companyId.toString()) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        // Only pending requests can be approved
        if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot approve request with status: ${request.status}`
            });
        }

        // Optional partial approval — admin may approve less than requested.
        // Defaults to the full requested amount when not supplied.
        let approvedAmount = request.amount;
        const rawApproved = req.body?.approvedAmount;
        if (rawApproved !== undefined && rawApproved !== null && rawApproved !== '') {
            approvedAmount = Number(rawApproved);
            if (!Number.isFinite(approvedAmount) || approvedAmount < 1) {
                return res.status(400).json({ success: false, message: 'Approved amount must be a positive number' });
            }
            if (approvedAmount > request.amount) {
                return res.status(400).json({ success: false, message: 'Approved amount cannot exceed the requested amount' });
            }
        }

        request.status = 'approved';
        request.approvedAmount = approvedAmount;
        request.reviewedBy = userId;
        request.reviewedAt = new Date();
        await request.save();

        const updated = await request.populate([
            { path: 'employeeId', select: 'name phone email profileImage' },
            { path: 'branchId', select: 'name' },
            { path: 'reviewedBy', select: 'name' }
        ]);

        res.status(200).json({
            success: true,
            message: 'Request approved successfully',
            data: updated
        });
    } catch (error) {
        console.error('Error approving request:', error);
        res.status(500).json({ success: false, message: error.message });
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

        const request = await AdvanceSalaryRequest.findById(id);
        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found' });
        }

        // Verify company ownership
        if (request.companyId.toString() !== companyId.toString()) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        // Only pending requests can be rejected
        if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot reject request with status: ${request.status}`
            });
        }

        request.status = 'rejected';
        request.reviewedBy = userId;
        request.reviewedAt = new Date();
        await request.save();

        const updated = await request.populate([
            { path: 'employeeId', select: 'name phone email profileImage' },
            { path: 'branchId', select: 'name' },
            { path: 'reviewedBy', select: 'name' }
        ]);

        res.status(200).json({
            success: true,
            message: 'Request rejected successfully',
            data: updated
        });
    } catch (error) {
        console.error('Error rejecting request:', error);
        res.status(500).json({ success: false, message: error.message });
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

        const request = await AdvanceSalaryRequest.findById(id);
        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found' });
        }

        // Verify company ownership
        if (request.companyId.toString() !== companyId.toString()) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        // Only approved requests can be marked repaid
        if (request.status !== 'approved') {
            return res.status(400).json({
                success: false,
                message: `Cannot mark as repaid: current status is ${request.status}`
            });
        }

        request.status = 'repaid';
        request.repaidAt = new Date();
        await request.save();

        const updated = await request.populate([
            { path: 'employeeId', select: 'name phone email profileImage' },
            { path: 'branchId', select: 'name' },
            { path: 'reviewedBy', select: 'name' }
        ]);

        res.status(200).json({
            success: true,
            message: 'Request marked as repaid successfully',
            data: updated
        });
    } catch (error) {
        console.error('Error marking as repaid:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    getAdvanceSalaryRequests,
    createAdvanceSalaryRequest,
    getAdvanceSalarySummary,
    approveAdvanceSalary,
    rejectAdvanceSalary,
    markAdvanceSalaryRepaid
};
