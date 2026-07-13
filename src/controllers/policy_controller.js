const HrPolicy = require('../models/HrPolicy');
const mongoose   = require('mongoose');

/** GET /  — list all records for current admin */
exports.getAll = async (req, res) => {
  try {
    const items = await HrPolicy.find({ adminId: req.adminId }).sort({ createdAt: -1 });
    res.json(items);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

/** GET /:id  — fetch single record */
exports.getById = async (req, res) => {
  try {
    const item = await HrPolicy.findOne({ _id: req.params.id, adminId: req.adminId });
    if (!item) return res.status(404).json({ message: 'HrPolicy not found' });
    res.json(item);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

/** POST /  — create new record */
exports.create = async (req, res) => {
  try {
    const item = await HrPolicy.create({
      ...req.body,
      adminId: new mongoose.Types.ObjectId(req.adminId),
    });
    res.status(201).json(item);
  } catch (err) { res.status(400).json({ message: err.message }); }
};

/** PUT /:id  — update existing record */
exports.update = async (req, res) => {
  try {
    const item = await HrPolicy.findOneAndUpdate(
      { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) },
      req.body,
      { new: true, runValidators: true }
    );
    if (!item) return res.status(404).json({ message: 'HrPolicy not found' });
    res.json(item);
  } catch (err) { res.status(400).json({ message: err.message }); }
};

/** DELETE /:id  — remove record */
exports.remove = async (req, res) => {
  try {
    const item = await HrPolicy.findOneAndDelete({
      _id: req.params.id,
      adminId: new mongoose.Types.ObjectId(req.adminId),
    });
    if (!item) return res.status(404).json({ message: 'HrPolicy not found' });
    res.json({ message: 'HrPolicy removed' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
