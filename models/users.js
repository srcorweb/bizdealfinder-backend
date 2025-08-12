const mongoose = require('mongoose');
const { Schema } = mongoose;
const HashMethods = require("../config/HashMethode");

const userSchema = new Schema({
  fullName: {
    type: String,
    required: true,
    unique: true,
  },
  country: {
    type: String,
    required: true,
    default: 'IN',
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  phoneNumber: {
    type: String,
    required: false,
    match: [/^\(?([0-9]{3})\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})$/, 'Invalid phone number format'],
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
    required: true,
  },
  profile: {
    type: String,
    required: false,
  },
  password: {
    type: String,
    required: false
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  verificationToken: {
    type: String,
    default: null
  },
  plan: {
    name: { type: String, default: 'Free' },
    price: { type: Number, default: 0 },
    stripeCustomerId: { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null },
    isAppSumo: { type: Boolean, default: false },
    appSumoTier: { type: Number, default: null },
    appSumoCode: { type: String, default: null }
  },
  usage: {
    searches: { type: Number, default: 0 },
    aiAnalyses: { type: Number, default: 0 },
    bizgptQueries: { type: Number, default: 0 },
    lastResetDate: { type: Date, default: Date.now }
  },
  workspace: {
    savedForAnalysis: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Business' }],
    privateFinancials: [{
      businessId: String,
      data: {
        purchasePrice: Number,
        downPaymentPercent: Number,
        loanTerm: Number,
        interestRate: Number,
        monthlyOperatingExpenses: Number,
        annualRevenue: Number,
        discretionaryEarnings: Number,
        addBacks: Number
      },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now }
    }]
  },
  billingInfo: {
    cardNumber: { type: String, default: '' },
    expiry: { type: String, default: '' },
    cvv: { type: String, default: '' }
  }
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (this.password && this.isModified('password')) {
    try {
      this.password = await HashMethods.hashPassword(this.password);
    } catch (error) {
      return next(error);
    }
  }
  next();
});

const User = mongoose.model('User', userSchema);

module.exports = User;