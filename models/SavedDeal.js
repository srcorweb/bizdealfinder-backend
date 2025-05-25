const mongoose = require('mongoose');
const { Schema } = mongoose;

// Define schema
const savedDealsSchema = new Schema(
  {
    deal_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "business", // Reference Business model
      required: [true, "Deal ID is required"],
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User ID is required"],
    },
  },
  { 
    timestamps: true, 
    versionKey: false,
  }
);

savedDealsSchema.index({ deal_id: 1, user_id: 1 }, { unique: true });

savedDealsSchema.pre("save", async function (next) {
  try {
    next();
  } catch (error) {
    next(error);
  }
});

// Export model, preventing overwrite
module.exports = mongoose.models.SavedDeal || mongoose.model('SavedDeal', savedDealsSchema);