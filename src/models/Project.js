const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: { type: String, required: true },
    client: { type: String },
    description: { type: String },
    startDate: { type: Date },
    deadline: { type: Date },
    budget: { type: Number },
    status: { type: String, default: "not-started", enum: ["not-started","in-progress","on-hold","completed"] },
  },
  { timestamps: true }
);

ProjectSchema.index({ adminId: 1, createdAt: -1 });

module.exports = mongoose.model('Project', ProjectSchema);
