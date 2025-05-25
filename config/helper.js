const db = require("../models");
module.exports = {
  success: function (res, message = "", body = {}, code = 200) {
    res.status(code).json({
      success: true,
      code: code,
      message: message,
      data: body
    })
  },

  permission: function (res, err, body = {}) {
    const { code, message } = getErrorDetails(err, 403);
    res.status(code).json({
      success: false,
      code: code,
      message: message,
      body: body
    });
  },

  error: function (res, err, body = {}) {
    const { code, message } = getErrorDetails(err, 500);
    res.status(code).json({
      success: false,
      code: code,
      message: message,
      data: body
    });
  },

  invalidRequest: function (res, body = {}) {
    res.status(400).json({
      success: false,
      code: 400,
      message: "Invalid Request",
      body: body
    });
  },

  notFound: function (res, message = "Resource Not Found", body = {}) {
    res.status(404).json({
      success: false,
      code: 404,
      message: message,
      body: body
    });
  },

  created: function (res, message = "Resource Created", body = {}) {
    res.status(201).json({
      success: true,
      code: 201,
      message: message,
      data: body
    });
  },

};
const getErrorDetails = (err, defaultCode) => {
  if (typeof err === 'object') {
    return {
      code: err.code || defaultCode,
      message: err.message || 'An error occurred'
    };
  }
  return {
    code: defaultCode,
    message: err || 'An error occurred'
  };
}
