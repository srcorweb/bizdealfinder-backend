module.exports = [
  '/auth/sign-up',
  '/auth/login',
  '/auth/forgot/password',
  '/auth/verifyOtp',
  '/auth/resetPassword',
  /^\/auth\/send-verification-link\/.*/,
  /^\/auth\/verifyEmail\/.*/,
  /^\/auth\/verification-status\/.*/,
  /^\/auth\/email-authentication\/.*/,
  '/admin/file-upload',
  '/business/add-businesses',
  '/auth/file-upload',
  '/business/add-sector',
  '/business/business',
  '/business/search' // Add this
];