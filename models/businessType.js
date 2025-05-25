const mongoose = require('mongoose');
const { Schema } = mongoose;

const businessType = new Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        default: null
    },
    is_active: {
        type: Boolean,
        default: true
    },
}, { timestamps: true });

const BusinessType = mongoose.model('BusinessType', businessType);

module.exports = BusinessType;