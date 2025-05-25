const validator = require('../validations/Validation');
const { signupRules, loginRules, updateProfileRule, addFaqQuestions, forgotPasswordRules, resetPasswordRules, createProductRule, createPostRules } = require("../validations/Rules");

const signup = async (req, res, next) => {
  try {
    await validator(req.body, signupRules, {}, (err, status) => {
      if (!status) {
        return res.status(400).send({
          code: 400,
          success: false,
          message: 'Validation failed',
          data: err
        });
      }
      next();
    });
  } catch (err) {
    console.error('Error during validation:', err);
    res.status(500).send({
      code: 500,
      success: false,
      message: 'Internal Server Error',
      data: err
    });
  }
};

const addProduct = async (req, res, next) => {
  try {
    await validator(req.body, createProductRule, {}, (err, status) => {
      if (!status) {
        return res.status(400).send({
          code: 400,
          success: false,
          message: 'Validation failed',
          data: err
        });
      }
      next();
    });
  } catch (err) {
    console.error('Error during validation:', err);
    res.status(500).send({
      code: 500,
      success: false,
      message: 'Internal Server Error',
      data: err
    });
  }
};

const login = async (req, res, next) => {
  try {
    await validator(req.body, loginRules, {}, (err, status) => {
      if (!status) {
        return res.status(400).send({
          code: 400,
          success: false,
          message: 'Validation failed',
          data: err
        });
      }
      next();
    });
  } catch (err) {
    console.error('Error during validation:', err);
    res.status(500).send({
      code: 500,
      success: false,
      message: 'Internal Server Error',
      data: err
    });
  }
};

const updateProfile = async (req, res, next) => {
  try {
    await validator(req.body, updateProfileRule, {}, (err, status) => {
      if (!status) {
        return res.status(400).send({
          success: false,
          message: 'Validation failed',
          data: err
        });
      }
      next();
    });
  } catch (err) {
    console.error('Error during validation:', err);
    res.status(500).send({
      success: false,
      message: 'Internal Server Error',
      data: err
    });
  }
};

const storeFaq = async (req, res, next) => {
  try {
    await validator(req.body, addFaqQuestions, {}, (err, status) => {
      if (!status) {
        return res.status(400).send({
          success: false,
          message: 'Validation failed',
          data: err
        });
      }
      next();
    });
  } catch (err) {
    console.error('Error during validation:', err);
    res.status(500).send({
      success: false,
      message: 'Internal Server Error',
      data: err
    });
  }
};

const forgotPassword = async (req, res, next) => {
  try {
    await validator(req.body, forgotPasswordRules, {}, (err, status) => {
      if (!status) {
        return res.status(400).send({
          success: false,
          message: 'Validation failed',
          data: err
        });
      }
      next();
    });
  } catch (err) {
    console.error('Error during validation:', err);
    res.status(500).send({
      success: false,
      message: 'Internal Server Error',
      data: err
    });
  }
};

const resetPassword = async (req, res, next) => {
  try {
    await validator(req.body, resetPasswordRules, {}, (err, status) => {
      if (!status) {
        return res.status(400).send({
          success: false,
          message: 'Validation failed',
          data: err
        });
      }
      next();
    });
  } catch (err) {
    console.error('Error during validation:', err);
    res.status(500).send({
      success: false,
      message: 'Internal Server Error',
      data: err
    });
  }
};

module.exports = {
  signup,
  login,
  updateProfile,
  storeFaq,
  forgotPassword,
  resetPassword,
  addProduct
};