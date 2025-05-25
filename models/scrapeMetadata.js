const mongoose = require('mongoose');

const scrapeMetadataSchema = new mongoose.Schema({
  lastScrape: { type: Date, default: Date.now },
});

module.exports = mongoose.model('ScrapeMetadata', scrapeMetadataSchema);