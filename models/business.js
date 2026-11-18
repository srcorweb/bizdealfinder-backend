const mongoose = require('mongoose');

const businessSchema = new mongoose.Schema({
  businessId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  price: { type: Number, default: 0 },
  revenue: { type: Number, default: 0 },
  cashFlow: { type: Number, default: 0 },
  location: {
    city: { type: String, default: 'Unknown' },
    state: { type: String, default: 'Unknown' }
  },
  sbaPreApproved: { type: Boolean, default: false },
  sellerFinancing: { type: Boolean, default: false },
  zeroDown: { type: Boolean, default: false },
  distressed: { type: Boolean, default: false },
  ownerAbsentee: { type: Boolean, default: false },
  brickAndMortar: { type: Boolean, default: true },
  sector: {
    type: String,
    enum: [
      'Agriculture', 'Energy', 'Engineering', 'Food', 'Franchise Resales',
      'Leisure', 'Manufacturing', 'Online', 'Real Estate', 'Retail',
      'Services', 'Tech & Media', 'Wholesale & Distribution'
    ],
    default: 'Services'
  },
  description: { type: String, default: 'No description available' },
  scrapedData: {
    source: String,
    priceText: String,
    revenueText: String,
    detailUrl: String
  },
  matchedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  swotAnalysis: {
    strengths: String,
    weaknesses: String,
    opportunities: String,
    threats: String
  },
  benchmarks: {
    ebitdaMargin: String,
    revenueGrowthYoY: String,
    cashMultiple: String,
    dealSummary: String
  },
  sourceContent: {
    content: String,
    scrapedAt: Date,
    financials: [{ key: String, value: String }],
    detailedInfo: [{ key: String, value: String }]
  },
  riskAnalysis: {
    score: Number,
    summary: String
  },
  competitors: [{
    name: String,
    price: Number,
    revenue: Number,
    yearsEstablished: String
  }],
  insights: [String],
  marketTrends: String,
  marketTrendsData: [Number],
  valuation: {
    range: String,
    confidence: Number
  },
  aiGeneratedDescription: { type: String, default: '' },
  descriptionEmbedding: { type: [Number], default: null },
  isUserImported: {
    type: Boolean,
    default: false
  },
  importedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

businessSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Business', businessSchema);