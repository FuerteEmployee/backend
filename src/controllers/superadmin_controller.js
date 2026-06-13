const User = require('../models/User');
const Plan = require('../models/Plan');
const Subscription = require('../models/Subscription');
const Invoice = require('../models/Invoice');
const AlertRule = require('../models/AlertRule');
const PlanFeature = require('../models/PlanFeature');
const Attendance = require('../models/Attendance');
const Leave = require('../models/Leave');
const Ticket = require('../models/Ticket');
const Branch = require('../models/Branch');
const Department = require('../models/Department');
const Expense = require('../models/Expense');
const mongoose = require('mongoose');

// ─── OVERVIEW / DASHBOARD ────────────────────────────────────────────────────

exports.getOverview = async (req, res) => {
    try {
        const [
            totalTenants,
            activeSubs,
            trialSubs,
            expiredSubs,
            graceSubs,
            failedInvoices,
            plans,
            recentActivity,
            mrrAgg
        ] = await Promise.all([
            User.countDocuments({ role: 'admin' }),
            Subscription.countDocuments({ status: 'active' }),
            Subscription.countDocuments({ status: 'trial' }),
            Subscription.countDocuments({ status: 'expired' }),
            Subscription.countDocuments({ status: 'grace' }),
            Invoice.countDocuments({ status: 'failed' }),
            Plan.find({ isActive: true }).lean(),
            // Recent activity: last 10 subscription history events
            Subscription.find({})
                .populate('adminId', 'name phone')
                .populate('planId', 'name slug color')
                .sort({ updatedAt: -1 })
                .limit(10)
                .lean(),
            // Total MRR calculated dynamically as the sum of plan prices of active subscriptions
            Subscription.aggregate([
                { $match: { status: 'active' } },
                {
                    $lookup: {
                        from: 'plans',
                        localField: 'planId',
                        foreignField: '_id',
                        as: 'plan'
                    }
                },
                { $unwind: '$plan' },
                { $group: { _id: null, totalMrr: { $sum: '$plan.price' } } }
            ])
        ]);

        // Plan distribution: count tenants per plan. Trials are surfaced in their
        // own card, so exclude them here to avoid double-counting in the totals.
        const planDistribution = await Promise.all(
            plans.map(async (plan) => {
                const count = await Subscription.countDocuments({ planId: plan._id, status: { $in: ['active', 'grace'] } });
                const planMrr = await Subscription.aggregate([
                    { $match: { planId: plan._id, status: 'active' } },
                    {
                        $lookup: {
                            from: 'plans',
                            localField: 'planId',
                            foreignField: '_id',
                            as: 'plan'
                        }
                    },
                    { $unwind: '$plan' },
                    { $group: { _id: null, total: { $sum: '$plan.price' } } }
                ]);
                return {
                    plan: { _id: plan._id, name: plan.name, slug: plan.slug, color: plan.color },
                    count,
                    mrr: planMrr[0]?.total || 0
                };
            })
        );

        // Trials expiring soon (within 7 days)
        const expiringTrials = await Subscription.countDocuments({
            status: 'trial',
            trialEndDate: { $lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }
        });

        // New tenants created in the current calendar month (for the "+N this month" note)
        const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        const newThisMonth = await Subscription.countDocuments({ createdAt: { $gte: startOfMonth } });

        // Format recent activity from subscription history
        const formattedActivity = [];
        for (const sub of recentActivity) {
            if (sub.history && sub.history.length > 0) {
                const lastEvent = sub.history[sub.history.length - 1];
                formattedActivity.push({
                    company: sub.adminId?.name || 'Unknown',
                    phone: sub.adminId?.phone || '',
                    event: lastEvent.action,
                    plan: sub.planId?.name || 'N/A',
                    planColor: sub.planId?.color || '#888',
                    amount: sub.mrr || 0,
                    employeesUsed: sub.employeesUsed || 0,
                    date: lastEvent.date
                });
            }
        }

        // ─── Product-level KPIs (cross-tenant) ────────────────────────────
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

        const [
            totalEmployees,
            attendanceToday,
            pendingLeaves,
            openTickets
        ] = await Promise.all([
            User.countDocuments({ role: 'employee' }),
            Attendance.countDocuments({ date: { $gte: todayStart, $lte: todayEnd } }),
            Leave.countDocuments({ status: 'pending' }),
            Ticket.countDocuments({ status: 'pending' })
        ]);

        res.json({
            stats: {
                totalTenants,
                activeTenants: activeSubs,
                trials: trialSubs,
                expiringTrials,
                expired: expiredSubs,
                grace: graceSubs,
                failedPayments: failedInvoices,
                mrr: mrrAgg[0]?.totalMrr || 0,
                newThisMonth,
                // Product KPIs
                totalEmployees,
                attendanceToday,
                pendingLeaves,
                openTickets
            },
            planDistribution,
            recentActivity: formattedActivity.slice(0, 6)
        });
    } catch (error) {
        console.error('Overview error:', error);
        res.status(500).json({ message: error.message });
    }
};

// ─── TENANTS ─────────────────────────────────────────────────────────────────

exports.getTenants = async (req, res) => {
    try {
        const { search, status, plan, page = 1, limit = 20 } = req.query;

        // Build base filter (plan only — status is applied after so we can also
        // report the unfiltered "All" count for the current search).
        const baseFilter = {};
        if (plan) {
            if (!mongoose.Types.ObjectId.isValid(plan)) {
                return res.status(400).json({ message: 'Invalid plan id' });
            }
            baseFilter.planId = new mongoose.Types.ObjectId(plan);
        }

        // Get subscriptions with populated data
        const subs = await Subscription.find(baseFilter)
            .populate('adminId', 'name phone email companyName isActive createdAt')
            .populate('planId', 'name slug color price maxEmployees')
            .sort({ updatedAt: -1 })
            .lean();

        // Apply search filter on populated fields (escape user input — it is fed
        // into a RegExp and special chars like ( [ \ would otherwise throw).
        let searchMatched = subs;
        if (search) {
            const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(safe, 'i');
            searchMatched = subs.filter(s =>
                regex.test(s.adminId?.name) ||
                regex.test(s.adminId?.phone) ||
                regex.test(s.adminId?.email) ||
                regex.test(s.adminId?.companyName)
            );
        }

        // "All" count across every status (respecting search), used for tab labels
        const totalAll = searchMatched.length;

        // Apply status filter
        let filtered = searchMatched;
        if (status && status !== 'all') {
            filtered = searchMatched.filter(s => s.status === status);
        }

        // Pagination
        const total = filtered.length;
        const start = (page - 1) * limit;
        const paginated = filtered.slice(start, start + parseInt(limit));

        res.json({
            tenants: paginated,
            totalPages: Math.ceil(total / limit),
            currentPage: parseInt(page),
            total,
            totalAll
        });
    } catch (error) {
        console.error('Get tenants error:', error);
        res.status(500).json({ message: error.message });
    }
};

exports.getTenant = async (req, res) => {
    try {
        const adminId = req.params.id;

        const sub = await Subscription.findOne({ adminId })
            .populate('adminId', 'name phone email companyName isActive createdAt')
            .populate('planId')
            .populate('history.fromPlan', 'name slug')
            .populate('history.toPlan', 'name slug')
            .lean();

        if (!sub) {
            return res.status(404).json({ message: 'Tenant subscription not found' });
        }

        // Today's date range for attendance
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

        const [
            employeeCount,
            activeEmployees,
            branchCount,
            departmentCount,
            pendingLeaves,
            openTickets,
            totalExpenses,
            attendanceToday
        ] = await Promise.all([
            User.countDocuments({ adminId, role: 'employee' }),
            User.countDocuments({ adminId, role: 'employee', isActive: true }),
            Branch.countDocuments({ adminId }),
            Department.countDocuments({ adminId }),
            Leave.countDocuments({ adminId, status: 'pending' }),
            Ticket.countDocuments({ adminId, status: 'pending' }),
            Expense.aggregate([
                { $match: { adminId: new mongoose.Types.ObjectId(adminId) } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]),
            Attendance.countDocuments({ adminId, date: { $gte: todayStart, $lte: todayEnd } })
        ]);

        // Get plan features for module status display
        const features = await PlanFeature.find({ isActive: true }).sort({ order: 1 }).lean();

        res.json({
            ...sub,
            employeesUsed: employeeCount,
            activeEmployees,
            branchCount,
            departmentCount,
            pendingLeaves,
            openTickets,
            totalExpenses: totalExpenses[0]?.total || 0,
            attendanceToday,
            features
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateTenant = async (req, res) => {
    try {
        const { planId, status, billingCycle, trialEndDate, note } = req.body;

        const sub = await Subscription.findOne({ adminId: req.params.id }).populate('planId');
        if (!sub) {
            return res.status(404).json({ message: 'Tenant subscription not found' });
        }

        const oldPlanId = sub.planId?._id;

        // Update fields
        if (planId && planId !== oldPlanId?.toString()) {
            const newPlan = await Plan.findById(planId);
            if (!newPlan) return res.status(404).json({ message: 'Plan not found' });

            const action = newPlan.price > (sub.planId?.price || 0) ? 'upgraded' : 'downgraded';
            sub.planId = planId;
            sub.history.push({
                action,
                fromPlan: oldPlanId,
                toPlan: planId,
                date: new Date(),
                note: note || `${action} by super admin`
            });
        }

        if (status) {
            if (sub.status !== status) {
                sub.history.push({
                    action: status === 'active' ? 'reactivated' : status,
                    toPlan: sub.planId,
                    date: new Date(),
                    note: note || `Status changed to ${status} by super admin`
                });
            }
            sub.status = status;
        }
        if (billingCycle) sub.billingCycle = billingCycle;
        if (trialEndDate) sub.trialEndDate = new Date(trialEndDate);

        // Recompute MRR centrally: only an *active* subscription contributes
        // recurring revenue. Trials/paused/expired/cancelled are ₹0. This keeps
        // the per-tenant MRR consistent with the dashboard's live aggregate.
        const effectivePlan = await Plan.findById(sub.planId);
        if (sub.status === 'active' && effectivePlan) {
            sub.mrr = sub.billingCycle === 'annual'
                ? Math.round((effectivePlan.annualPrice || effectivePlan.price * 12) / 12)
                : effectivePlan.price;
        } else {
            sub.mrr = 0;
        }

        await sub.save();

        const updated = await Subscription.findById(sub._id)
            .populate('adminId', 'name phone email companyName')
            .populate('planId');

        res.json(updated);
    } catch (error) {
        console.error('Update tenant error:', error);
        res.status(400).json({ message: error.message });
    }
};

exports.createTenant = async (req, res) => {
    try {
        const { name, phone, email, planId, billingCycle = 'monthly' } = req.body;

        // Create the admin user
        const admin = await User.create({
            name,
            phone,
            email,
            role: 'admin',
            isActive: true,
            status: 'active'
        });

        const plan = await Plan.findById(planId);
        if (!plan) {
            await User.findByIdAndDelete(admin._id);
            return res.status(404).json({ message: 'Plan not found' });
        }

        const now = new Date();
        const trialEnd = new Date(now.getTime() + (plan.trialDays || 14) * 24 * 60 * 60 * 1000);

        // Create subscription
        const sub = await Subscription.create({
            adminId: admin._id,
            planId: plan._id,
            status: 'trial',
            billingCycle,
            trialStartDate: now,
            trialEndDate: trialEnd,
            currentPeriodStart: now,
            currentPeriodEnd: trialEnd,
            employeesUsed: 0,
            mrr: 0,
            history: [{
                action: 'trial_started',
                toPlan: plan._id,
                date: now,
                note: 'Tenant created by super admin'
            }]
        });

        const result = await Subscription.findById(sub._id)
            .populate('adminId', 'name phone email')
            .populate('planId', 'name slug color price');

        res.status(201).json(result);
    } catch (error) {
        console.error('Create tenant error:', error);
        res.status(400).json({ message: error.message });
    }
};

exports.deactivateTenant = async (req, res) => {
    try {
        const admin = await User.findByIdAndUpdate(req.params.id, { isActive: false, status: 'inactive' }, { new: true });
        if (!admin) return res.status(404).json({ message: 'Tenant not found' });

        await Subscription.findOneAndUpdate(
            { adminId: req.params.id },
            {
                status: 'cancelled',
                $push: { history: { action: 'cancelled', date: new Date(), note: 'Deactivated by super admin' } }
            }
        );

        res.json({ message: 'Tenant deactivated', admin });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.deleteTenant = async (req, res) => {
    try {
        const adminId = req.params.id;

        // Delete the subscription first
        await Subscription.findOneAndDelete({ adminId });

        // Delete all employees belonging to this admin
        await User.deleteMany({ adminId, role: 'employee' });

        // Delete the admin user
        const admin = await User.findByIdAndDelete(adminId);
        if (!admin) return res.status(404).json({ message: 'Tenant not found' });

        // Delete related invoices
        await Invoice.deleteMany({ adminId });

        res.json({ message: 'Tenant permanently deleted' });
    } catch (error) {
        console.error('Delete tenant error:', error);
        res.status(500).json({ message: error.message });
    }
};


exports.getPlans = async (req, res) => {
    try {
        const plans = await Plan.find({}).sort({ price: 1 }).lean();

        // Count tenants per plan
        const plansWithCounts = await Promise.all(
            plans.map(async (plan) => {
                const tenantCount = await Subscription.countDocuments({ planId: plan._id, status: { $in: ['active', 'trial', 'grace'] } });
                return { ...plan, tenantCount };
            })
        );

        res.json(plansWithCounts);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.createPlan = async (req, res) => {
    try {
        const plan = await Plan.create(req.body);
        res.status(201).json(plan);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.updatePlan = async (req, res) => {
    try {
        const plan = await Plan.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!plan) return res.status(404).json({ message: 'Plan not found' });
        res.json(plan);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.deletePlan = async (req, res) => {
    try {
        // Soft delete
        const plan = await Plan.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
        if (!plan) return res.status(404).json({ message: 'Plan not found' });
        res.json({ message: 'Plan deactivated', plan });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ─── INVOICES ────────────────────────────────────────────────────────────────

exports.getInvoices = async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const filter = {};
        if (status && status !== 'all') filter.status = status;

        const invoices = await Invoice.find(filter)
            .populate('adminId', 'name phone companyName')
            .populate('planId', 'name slug color')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit))
            .lean();

        const total = await Invoice.countDocuments(filter);

        // Invoice stats
        const [collected, pending, failed] = await Promise.all([
            Invoice.aggregate([
                { $match: { status: 'paid', createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]),
            Invoice.aggregate([
                { $match: { status: 'pending' } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]),
            Invoice.countDocuments({ status: 'failed' })
        ]);

        res.json({
            invoices,
            total,
            totalPages: Math.ceil(total / limit),
            currentPage: parseInt(page),
            stats: {
                collected: collected[0]?.total || 0,
                pending: pending[0]?.total || 0,
                pendingCount: pending[0]?.count || 0,
                failed
            }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.createInvoice = async (req, res) => {
    try {
        const invoice = await Invoice.create(req.body);
        const populated = await Invoice.findById(invoice._id)
            .populate('adminId', 'name phone companyName')
            .populate('planId', 'name slug color');
        res.status(201).json(populated);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.updateInvoice = async (req, res) => {
    try {
        const updates = { ...req.body };
        if (updates.status === 'paid' && !updates.paidAt) {
            updates.paidAt = new Date();
        }
        const invoice = await Invoice.findByIdAndUpdate(req.params.id, updates, { new: true })
            .populate('adminId', 'name phone companyName')
            .populate('planId', 'name slug color');
        if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
        res.json(invoice);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// ─── ALERT RULES ─────────────────────────────────────────────────────────────

exports.getAlerts = async (req, res) => {
    try {
        const alerts = await AlertRule.find({}).sort({ createdAt: 1 }).lean();
        res.json(alerts);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.toggleAlert = async (req, res) => {
    try {
        const alert = await AlertRule.findOne({ slug: req.params.slug });
        if (!alert) return res.status(404).json({ message: 'Alert rule not found' });

        alert.isEnabled = !alert.isEnabled;
        await alert.save();

        res.json(alert);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// ─── PLAN FEATURES ───────────────────────────────────────────────────────────

exports.getPlanFeatures = async (req, res) => {
    try {
        const features = await PlanFeature.find({ isActive: true }).sort({ order: 1, createdAt: 1 }).lean();
        res.json(features);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.createPlanFeature = async (req, res) => {
    try {
        const feature = await PlanFeature.create(req.body);
        res.status(201).json(feature);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.updatePlanFeature = async (req, res) => {
    try {
        const feature = await PlanFeature.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!feature) return res.status(404).json({ message: 'Plan feature not found' });
        res.json(feature);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.deletePlanFeature = async (req, res) => {
    try {
        // Soft delete or hard delete. Let's hard delete for simplicity or soft delete.
        const feature = await PlanFeature.findByIdAndDelete(req.params.id);
        if (!feature) return res.status(404).json({ message: 'Plan feature not found' });
        res.json({ message: 'Plan feature deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ─── SYSTEM ANALYTICS ────────────────────────────────────────────────────────

exports.getSystemAnalytics = async (req, res) => {
    try {
        // ── Top tenants by employee count ────────────────────────────────
        const topTenants = await User.aggregate([
            { $match: { role: 'employee' } },
            { $group: { _id: '$adminId', employeeCount: { $sum: 1 } } },
            { $sort: { employeeCount: -1 } },
            { $limit: 10 },
            {
                $lookup: {
                    from: 'users',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'admin'
                }
            },
            { $unwind: { path: '$admin', preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: 'subscriptions',
                    localField: '_id',
                    foreignField: 'adminId',
                    as: 'subscription'
                }
            },
            { $unwind: { path: '$subscription', preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: 'plans',
                    localField: 'subscription.planId',
                    foreignField: '_id',
                    as: 'plan'
                }
            },
            { $unwind: { path: '$plan', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    adminId: '$_id',
                    name: '$admin.name',
                    companyName: '$admin.companyName',
                    employeeCount: 1,
                    plan: '$plan.name',
                    planColor: '$plan.color',
                    status: '$subscription.status',
                    mrr: '$subscription.mrr'
                }
            }
        ]);

        // ── Feature adoption (% of active tenants using each feature) ────
        const features = await PlanFeature.find({ isActive: true }).sort({ order: 1 }).lean();
        const activePlans = await Plan.find({ isActive: true }).lean();
        const activeSubs = await Subscription.find({ status: { $in: ['active', 'trial'] } })
            .populate('planId')
            .lean();

        const totalActive = activeSubs.length || 1; // avoid divide by zero

        const featureAdoption = features.map(f => {
            let adoptedCount = 0;
            for (const sub of activeSubs) {
                const plan = sub.planId;
                if (!plan) continue;
                // Get the modules map — .lean() returns a plain object for Maps
                const modules = plan.modules instanceof Map ? Object.fromEntries(plan.modules) : (plan.modules || {});
                const val = modules[f.key];
                if (val === true || val === 'full' || val === 'basic') {
                    adoptedCount++;
                }
            }
            return {
                key: f.key,
                label: f.label,
                type: f.type,
                adoptedCount,
                adoptionPercent: Math.round((adoptedCount / totalActive) * 100)
            };
        });

        // ── Cross-tenant usage counters ──────────────────────────────────
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
        const thisMonthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

        const [
            totalEmployees,
            totalBranches,
            totalDepartments,
            attendanceToday,
            leavesThisMonth,
            expensesThisMonth,
            ticketsOpen
        ] = await Promise.all([
            User.countDocuments({ role: 'employee' }),
            Branch.countDocuments({}),
            Department.countDocuments({}),
            Attendance.countDocuments({ date: { $gte: todayStart, $lte: todayEnd } }),
            Leave.countDocuments({ createdAt: { $gte: thisMonthStart } }),
            Expense.aggregate([
                { $match: { createdAt: { $gte: thisMonthStart } } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]),
            Ticket.countDocuments({ status: 'pending' })
        ]);

        // ── Tenant growth (last 6 months) ────────────────────────────────
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        sixMonthsAgo.setDate(1);
        sixMonthsAgo.setHours(0, 0, 0, 0);

        const tenantGrowth = await Subscription.aggregate([
            { $match: { createdAt: { $gte: sixMonthsAgo } } },
            {
                $group: {
                    _id: {
                        year: { $year: '$createdAt' },
                        month: { $month: '$createdAt' }
                    },
                    count: { $sum: 1 }
                }
            },
            { $sort: { '_id.year': 1, '_id.month': 1 } }
        ]);

        res.json({
            topTenants,
            featureAdoption,
            usage: {
                totalEmployees,
                totalBranches,
                totalDepartments,
                attendanceToday,
                leavesThisMonth,
                expensesThisMonth: expensesThisMonth[0]?.total || 0,
                expensesCount: expensesThisMonth[0]?.count || 0,
                ticketsOpen
            },
            tenantGrowth: tenantGrowth.map(g => ({
                month: `${g._id.year}-${String(g._id.month).padStart(2, '0')}`,
                count: g.count
            }))
        });
    } catch (error) {
        console.error('System analytics error:', error);
        res.status(500).json({ message: error.message });
    }
};
