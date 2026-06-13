const Expense = require('../models/Expense');
const mongoose = require('mongoose');

exports.getExpenses = async (req, res) => {
    try {
        const { startDate, endDate, employeeId, category, status } = req.query;
        const query = { adminId: new mongoose.Types.ObjectId(req.adminId) };

        if (employeeId) query.employeeId = new mongoose.Types.ObjectId(employeeId);
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
        const expense = await Expense.create({
            ...req.body,
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: req.body.employeeId ? new mongoose.Types.ObjectId(req.body.employeeId) : undefined
        });
        res.status(201).json(expense);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateExpense = async (req, res) => {
    try {
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
