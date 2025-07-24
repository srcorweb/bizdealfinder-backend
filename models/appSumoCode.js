const mongoose = require('mongoose');
const { Schema } = mongoose;

const appSumoCodeSchema = new Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true
  },
  tier: {
    type: Number,
    required: true,
    enum: [1, 2, 3]
  },
  isRedeemed: {
    type: Boolean,
    default: false
  },
  redeemedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  redeemedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('AppSumoCode', appSumoCodeSchema);