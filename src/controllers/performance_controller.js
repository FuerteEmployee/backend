const PerformanceReview = require('../models/PerformanceReview');
const mongoose   = require('mongoose');

/** GET /  — list all records for current admin */
exports.getAll = async (req, res) => {
  try {
    const items = await PerformanceReview.find({ adminId: req.adminId }).sort({ createdAt: -1 });
    res.json(items);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

/** GET /:id  — fetch single record */
exports.getById = async (req, res) => {
  try {
    const item = await PerformanceReview.findOne({ _id: req.params.id, adminId: req.adminId });
    if (!item) return res.status(404).json({ message: 'PerformanceReview not found' });
    res.json(item);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

/** POST /  — create new record */
exports.create = async (req, res) => {
  try {
    const item = await PerformanceReview.create({
      ...req.body,
      adminId: new mongoose.Types.ObjectId(req.adminId),
    });
    res.status(201).json(item);
  } catch (err) { res.status(400).json({ message: err.message }); }
};

/** PUT /:id  — update existing record */
exports.update = async (req, res) => {
  try {
    const item = await PerformanceReview.findOneAndUpdate(
      { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) },
      req.body,
      { new: true, runValidators: true }
    );
    if (!item) return res.status(404).json({ message: 'PerformanceReview not found' });
    res.json(item);
  } catch (err) { res.status(400).json({ message: err.message }); }
};

/** DELETE /:id  — remove record */
exports.remove = async (req, res) => {
  try {
    const item = await PerformanceReview.findOneAndDelete({
      _id: req.params.id,
      adminId: new mongoose.Types.ObjectId(req.adminId),
    });
    if (!item) return res.status(404).json({ message: 'PerformanceReview not found' });
    res.json({ message: 'PerformanceReview removed' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
