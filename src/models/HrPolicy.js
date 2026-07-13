const mongoose = require('mongoose');

const HrPolicySchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: { type: String, required: true },
    category: { type: String, required: true },
    content: { type: String },
    effectiveDate: { type: Date },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

HrPolicySchema.index({ adminId: 1, createdAt: -1 });

module.exports = mongoose.model('HrPolicy', HrPolicySchema);
