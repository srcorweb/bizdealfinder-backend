const mongoose = require('mongoose');

const userPreferencesSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  sector: { type: String, enum: ['Agriculture', 'Energy', 'Engineering', 'Food', 'Franchise Resales', 'Leisure', 'Manufacturing', 'Online', 'Real Estate', 'Retail', 'Services', 'Tech & Media', 'Wholesale & Distribution'], default: null },
  priceRange: { min: { type: Number, default: 0 }, max: { type: Number, default: Infinity } },
  location: { city: { type: String, default: null }, state: { type: String, default: null } },
  distressed: { type: Boolean, default: false },
  ownerAbsentee: { type: Boolean, default: false },
  sbaPreApproved: { type: Boolean, default: false },
  sellerFinancing: { type: Boolean, default: false },
  zeroDown: { type: Boolean, default: false },
  brickAndMortar: { type: Boolean, default: null },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('UserPreferences', userPreferencesSchema);