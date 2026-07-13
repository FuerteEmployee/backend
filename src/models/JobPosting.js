const mongoose = require('mongoose');

const JobPostingSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: { type: String, required: true },
    department: { type: String, required: true },
    description: { type: String },
    openings: { type: Number, default: 1 },
    location: { type: String },
    salary: { type: String },
    status: { type: String, default: "open", enum: ["open","closed","on-hold"] },
    applications: { type: Number, default: 0 },
  },
  { timestamps: true }
);

JobPostingSchema.index({ adminId: 1, createdAt: -1 });

module.exports = mongoose.model('JobPosting', JobPostingSchema);
