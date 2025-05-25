module.exports = {
    loginRules: {
        "password": "required|string",
        "email": "required|email|string",
    },
    signupRules: {
        "email": "required|email|exist:User,email",
        "password": "required|string",
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
        postType: "required|in:Social,Product",     // Type of the post (case-sensitive)
        isEarningPost: "boolean",                    // Boolean indicating if it's an earning post
        postName: "required|string",                 // Name of the post
        keysRequired: "required|integer",            // Number of keys required
        diamondsEarned: "required|integer",          // Diamonds earned from the post
        mediaType: "required|in:audio,video",       // Type of media associated with the post
        mediaUrl: "array",                    // Array of media URLs (string format)
        imagePath: "array",                   // Array of image URLs (string format)
        coinsEarned: "required|integer",             // Coins earned from the post
        postLocation: "string",                       // Location of the post (optional)
        itemsInPortal: "required|integer",           // Number of items in the portal
        description: "string",                        // Description of the post (optional)
    },

};
