var express = require('express');
const { signup, login, updateProfile, forgotPassword, resetPassword } = require('../../requests/middleware/DataValidatior');
const UserController = require('./UserController');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const User = require('../../models/users');
const HashMethods = require('../../config/HashMethode');
const { authMiddleware } = require('../../requests/middleware/AuthMiddleware');
require('dotenv').config();

var router = express.Router();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Signup with email verification
router.post('/sign-up', signup, async (req, res) => {
  try {
    console.log('Signup attempt:', req.body);
    const { fullName, email, password, country, role } = req.body;
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      console.log('Email exists:', email);
      return res.status(400).json({ message: 'Email already exists' });
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');
    req.body.verificationToken = verificationToken;
    req.body.isVerified = false;

    console.log('Creating user with token:', verificationToken);
    await UserController.signup(req, res);

    console.log('Sending verification email to:', email);
    const verificationLink = `${process.env.FRONTEND_URL}/auth/verify-email?token=${verificationToken}`;
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Verify Your Email - BusinessesForSale.com',
      html: `<p>Please verify your email by clicking <a href="${verificationLink}">here</a>.</p>`
    };
    const emailResult = await transporter.sendMail(mailOptions);
    console.log('Email send result:', { email, response: emailResult.response, messageId: emailResult.messageId });

    res.status(201).json({ message: 'User created. Please verify your email.' });
  } catch (error) {
    console.error('Signup error:', error, { code: error.code, details: error.details });
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Verify Email
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    console.log('Verifying token:', token);
    if (!token) {
      return res.status(400).json({ message: 'Verification token required' });
    }

    const user = await User.findOne({ verificationToken: token });
    if (!user) {
      console.log('No user found for token:', token);
      return res.status(400).json({ message: 'Invalid or expired token' });
    }

    user.isVerified = true;
    user.verificationToken = null;
    await user.save();
    console.log('User verified:', user.email);

    return res.status(200).json({ message: 'Email verified successfully' });
  } catch (error) {
    console.error('Verify email error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update user email/password
router.put('/update', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, email, newPassword } = req.body;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!currentPassword || !email) return res.status(400).json({ message: 'Current password and email required' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Verify current password
    const isMatch = await HashMethods.comparePassword(currentPassword, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Incorrect current password' });

    // Update email and password
    user.email = email;
    if (newPassword) user.password = newPassword;
    await user.save();

    res.status(200).json({ message: 'Account updated successfully' });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ message: 'Failed to update account' });
  }
});

// Get user plan
router.get('/plan', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const user = await User.findById(userId).select('plan billingInfo');
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.status(200).json({
      name: user.plan.name,
      price: user.plan.price,
      billingInfo: user.billingInfo
    });
  } catch (error) {
    console.error('Get plan error:', error);
    res.status(500).json({ message: 'Failed to load plan' });
  }
});

// Update user plan
router.put('/plan', authMiddleware, async (req, res) => {
  try {
    const { plan, price } = req.body;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!plan || price === undefined) return res.status(400).json({ message: 'Plan and price required' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.plan = { name: plan, price };
    await user.save();

    res.status(200).json({ message: 'Plan updated successfully' });
  } catch (error) {
    console.error('Update plan error:', error);
    res.status(500).json({ message: 'Failed to update plan' });
  }
});

// Update billing info
router.put('/billing', authMiddleware, async (req, res) => {
  try {
    const { cardNumber, expiry, cvv } = req.body;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!cardNumber || !expiry || !cvv) return res.status(400).json({ message: 'Billing info required' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.billingInfo = { cardNumber, expiry, cvv };
    await user.save();

    res.status(200).json({ message: 'Billing info updated successfully' });
  } catch (error) {
    console.error('Update billing error:', error);
    res.status(500).json({ message: 'Failed to update billing info' });
  }
});

// Existing routes
router.post('/login', login, UserController.login);
router.get('/get-my-details', UserController.getMyDetails);
router.post('/file-upload', UserController.fileUpload);

module.exports = router;