const jwt = require('jsonwebtoken');
const randomstring = require('randomstring');
const db = require("../../models");
const helper = require("../../config/helper");
const User = db.User;
const UserPreferences = db.UserPreferences;
var path = require('path');
const jwtSecrate = process.env.AUTH_JWT_SECRET;
const HashMethods = require("../../config/HashMethode");

module.exports = {
  signup: async (req, res) => {
    try {
      const { fullName, email, role, profile, password, isVerified, verificationToken, phoneNumber } = req.body;
      const newUser = new User({
        fullName,
        email,
        password,
        role: role || 'user',
        profile,
        isVerified: isVerified || false,
        verificationToken: verificationToken || null,
        phoneNumber
      });
      await newUser.save();
      return { message: 'User created successfully' };
    } catch (error) {
      console.error('Signup error:', error);
      throw error;
    }
  },
  login: async (req, res) => {
    try {
      const { password, email } = req.body;
      console.log('Login attempt:', { email });
      const user = await User.findOne({ email });
      if (!user) {
        console.log('User not found:', email);
        return res.status(200).json({
          status: 401,
          success: false,
          message: 'Invalid user'
        });
      }
      if (!user.isVerified) {
        console.log('User not verified:', email);
        return res.status(200).json({
          status: 403,
          success: false,
          message: 'Please verify your email'
        });
      }
      console.log('Verifying password for:', email);
      const isMatch = await HashMethods.verifyPassword(user.password, password);
      console.log('Password match:', isMatch);
      if (!isMatch) {
        console.log('Invalid password for:', email);
        return res.status(200).json({
          status: 401,
          success: false,
          message: 'Invalid password'
        });
      }
      const token = jwt.sign(
        { id: user.id, role: user.role },
        jwtSecrate,
        { expiresIn: '6000000s' }
      );
      let hasPreferences = false;
      try {
        const preferences = await UserPreferences.findOne({ userId: user._id });
        hasPreferences = !!preferences;
        console.log('Preferences check:', { userId: user._id, hasPreferences, preferences });
      } catch (err) {
        console.error('Error checking preferences:', err);
      }
      let userdata = {
        accessToken: token,
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        hasPreferences
      };
      console.log('Login response:', userdata);
      return helper.success(res, 'Login successful', userdata);
    } catch (error) {
      console.error('Login error:', error);
      return helper.error(res, error);
    }
  },
  verifyEmail: async (req, res) => {
    try {
      const { token } = req.params;
      const user = await User.findOne({ verificationToken: token });
      if (!user) {
        return res.status(400).json({ message: 'Invalid or expired token' });
      }
      user.isVerified = true;
      user.verificationToken = null;
      await user.save();
      return res.status(200).json({ message: 'Email successfully verified' });
    } catch (error) {
      console.error('Verify email error:', error);
      return res.status(500).json({ message: 'Server error' });
    }
  },
  sendVerificationLink: async (req, res) => {
    try {
      const { email } = req.params;
      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }
      const user = await User.findOne({ email });
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      if (user.isVerified) {
        return res.status(400).json({ message: 'Email already verified' });
      }
      const token = jwt.sign({ email }, jwtSecrate, { expiresIn: '10m' });
      return helper.success(res, 'Verification link sent to your email', { token });
    } catch (err) {
      console.error(err);
      return helper.error(res, err);
    }
  },
  checkVerificationStatus: async (req, res) => {
    try {
      const { email } = req.params;
      if (!email) {
        return helper.error(res, 'Email is required');
      }
      const user = await User.findOne({ email });
      if (!user) {
        return helper.success(res, 'Email not found.', { verificationStatus: 0 });
      }
      return helper.success(res, 'Verification status.', { verificationStatus: user.isVerified ? 1 : 0 });
    } catch (err) {
      return helper.error(res, 'An error occurred.', err.message);
    }
  },
  findByToken: async (token) => {
    return new Promise((resolve, reject) => {
      jwt.verify(
        token,
        process.env.AUTH_JWT_SECRET,
        (err, decoded) => {
          if (err) {
            reject(err);
            return;
          }
          const id = decoded.id;
          User.findById(id)
            .then((user) => {
              resolve(user);
            })
            .catch((error) => reject(error));
        }
      );
    });
  },
  emailAuthentication: async (req, res) => {
    try {
      const { email } = req.params;
      const user = await User.findOne({ email });
      if (!user) {
        return helper.error(res, 'This email is not registered');
      }
      const userdata = {
        id: user.id,
        fullName: user.fullName
      };
      return helper.success(res, 'User found successfully', userdata);
    } catch (err) {
      console.error(err);
      return helper.error(res, 'An error occurred during email authentication');
    }
  },
  getMyDetails: async (req, res) => {
    try {
      if (!req.user || !req.user.id) {
        return helper.error(res, 'Unauthorized - No user found');
      }
      const mydata = await User.findById(req.user.id).select('-password');
      if (!mydata) {
        return helper.error(res, 'User not found');
      }
      return helper.success(res, 'User details fetched successfully', mydata);
    } catch (err) {
      console.error(err);
      return helper.error(res, 'An error occurred while fetching user details');
    }
  },
  fileUpload: async (req, res) => {
    try {
      if (!req.files || !req.files.images) {
        return helper.error(res, "No files were uploaded");
      }
      let attachments = req.files.images;
      let fileUrls = [];

      if (!Array.isArray(attachments)) {
        attachments = [attachments];
      }

      for (const attachment of attachments) {
        const fileExtension = path.extname(attachment.name);
        const uniqueFileName = `${randomstring.generate(15)}${fileExtension}`;
        const uploadPath = path.join(process.cwd(), 'public', 'Uploads', uniqueFileName);

        await attachment.mv(uploadPath);
        const fileUrl = `${process.env.BASE_URL}/Uploads/${uniqueFileName}`;
        fileUrls.push(fileUrl);
      }

      return helper.success(res, "Files uploaded successfully", fileUrls);
    } catch (err) {
      console.error(err);
      return helper.error(res, "File upload failed", err);
    }
  },
};