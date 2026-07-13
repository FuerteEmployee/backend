const mongoose = require('mongoose');

const PerformanceReviewSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    employeeId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
    period: { type: String, required: true },
    rating: { type: Number, required: true },
    comments: { type: String },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, default: "pending", enum: ["pending","completed","approved"] },
  },
  { timestamps: true }
);

PerformanceReviewSchema.index({ adminId: 1, createdAt: -1 });

module.exports = mongoose.model('PerformanceReview', PerformanceReviewSchema);
