module.exports = {
    loginRules: {
      "password": "required|string",
      "email": "required|email|string",
    },
    signupRules: {
      "email": "required|email|exist:User,email",
      "password": "required|string",
      "fullName": "required|string",
      "phoneNumber": "string|regex:^\\(?([0-9]{3})\\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})$", // Optional US phone number
    },
    updateProfileRule: {
      "email": "required|email",
      "firstName": "required|string",
      "lastName": "required|string",
    },
    forgotPasswordRules: {
      "email": "required|email",
    },
    resetPasswordRules: {
      "email": "required|email",
      "password": "required|min:6",
    },
    createProductRule: {
      "name": "required|string|min:3",
      "description": "string",
      "brand_name": "string",
      "type": "required|string",
      "isDigitalAsset": "required|boolean",
      "productLink": "url",
      "price": "required|numeric|min:0.01",
      "images": "array",
    },
    createPostRules: {
      postType: "required|in:Social,Product",
      isEarningPost: "boolean",
      postName: "required|string",
      keysRequired: "required|integer",
      diamondsEarned: "required|integer",
      mediaType: "required|in:audio,video",
      mediaUrl: "array",
      imagePath: "array",
      coinsEarned: "required|integer",
      postLocation: "string",
      itemsInPortal: "required|integer",
      description: "string",
    },
  };