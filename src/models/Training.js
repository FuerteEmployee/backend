const mongoose = require('mongoose');

const TrainingSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: { type: String, required: true },
    description: { type: String },
    trainer: { type: String, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date },
    status: { type: String, default: "scheduled", enum: ["scheduled","ongoing","completed","cancelled"] },
  },
  { timestamps: true }
);

TrainingSchema.index({ adminId: 1, createdAt: -1 });

module.exports = mongoose.model('Training', TrainingSchema);
