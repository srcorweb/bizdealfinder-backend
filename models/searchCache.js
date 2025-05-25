const mongoose = require('mongoose');

const searchCacheSchema = new mongoose.Schema({
  query: { type: String, required: true, index: true },
  results: [{ type: mongoose.Schema.Types.Mixed }],
  createdAt: { type: Date, default: Date.now, expires: '2h' }, // Cache expires after 2 hours
});

module.exports = mongoose.model('SearchCache', searchCacheSchema);