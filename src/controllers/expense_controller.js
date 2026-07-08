const Expense = require('../models/Expense');
const User = require('../models/User');
const mongoose = require('mongoose');

exports.getExpenses = async (req, res) => {
    try {
        const { startDate, endDate, employeeId, category, status } = req.query;
        const query = { adminId: new mongoose.Types.ObjectId(req.adminId) };

        // Employees may only ever see their own expense claims, never the whole tenant's
        if (req.user.role === 'employee') {
            query.employeeId = new mongoose.Types.ObjectId(req.userId);
        } else if (employeeId) {
            query.employeeId = new mongoose.Types.ObjectId(employeeId);
        }
        if (category) query.category = category;
        if (status) query.status = status;
        if (startDate && endDate) {
            query.date = { $gte: new Date(startDate), $lte: new Date(endDate) };
        }

        const expenses = await Expense.find(query).sort({ date: -1 });
        res.json(expenses);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.addExpense = async (req, res) => {
    try {
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const attachmentUrl = req.file ? req.file.path : undefined;

        if (req.user.role === 'employee') {
            const { category, amount, date, description, splitWith } = req.body;
            const totalAmount = Number(amount);

            let splitIds = [];
            if (splitWith) {
                try {
                    splitIds = JSON.parse(splitWith);
                } catch {
                    splitIds = [];
                }
            }

            if (Array.isArray(splitIds) && splitIds.length > 0) {
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

        const expense = await Expense.create({
            ...req.body,
            adminId,
            employeeId: req.body.employeeId ? new mongoose.Types.ObjectId(req.body.employeeId) : undefined,
            attachmentUrl
        });
        res.status(201).json(expense);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.approveExpense = async (req, res) => {
    try {
        if (req.user.role === 'employee') {
            return res.status(403).json({ message: 'Employees cannot approve expenses' });
        }

        const expense = await Expense.findOne({ _id: req.params.id, adminId: req.adminId });
        if (!expense) return res.status(404).json({ message: 'Expense not found' });
        if (expense.status !== 'pending') {
            return res.status(400).json({ message: `Cannot approve expense with status: ${expense.status}` });
        }

        expense.status = 'approved';
        expense.reviewedBy = req.userId;
        expense.reviewedAt = new Date();
        await expense.save();

        res.json(expense);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.rejectExpense = async (req, res) => {
    try {
        if (req.user.role === 'employee') {
            return res.status(403).json({ message: 'Employees cannot reject expenses' });
        }

        const expense = await Expense.findOne({ _id: req.params.id, adminId: req.adminId });
        if (!expense) return res.status(404).json({ message: 'Expense not found' });
        if (expense.status !== 'pending') {
            return res.status(400).json({ message: `Cannot reject expense with status: ${expense.status}` });
        }

        expense.status = 'rejected';
        expense.reviewedBy = req.userId;
        expense.reviewedAt = new Date();
        await expense.save();

        res.json(expense);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateExpense = async (req, res) => {
    try {
        if (req.user.role === 'employee') {
            return res.status(403).json({ message: 'Employees cannot edit expense records' });
        }

        const data = { ...req.body };
        if (data.employeeId) data.employeeId = new mongoose.Types.ObjectId(data.employeeId);

        const expense = await Expense.findOneAndUpdate(
            { _id: new mongoose.Types.ObjectId(req.params.id), adminId: new mongoose.Types.ObjectId(req.adminId) },
            data,
            { new: true }
        );
        if (!expense) return res.status(404).json({ message: 'Expense not found' });
        res.json(expense);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.deleteExpense = async (req, res) => {
    try {
        if (req.user.role === 'employee') {
            return res.status(403).json({ message: 'Employees cannot delete expense records' });
        }

        const expense = await Expense.findOneAndDelete({
            _id: new mongoose.Types.ObjectId(req.params.id),
            adminId: new mongoose.Types.ObjectId(req.adminId)
        });
        if (!expense) return res.status(404).json({ message: 'Expense not found' });
        res.json({ message: 'Expense deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
