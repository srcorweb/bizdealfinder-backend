const mongoose = require('mongoose');
const { Schema } = mongoose;

const sellBusinessSchema = new Schema({
    businessTypeId: {
        type: Schema.Types.ObjectId,
        ref: 'BusinessType',
        required: true
    },
    name: {
        type: String,
        required: [true, 'Business name is required'],
        trim: true,
    },
    general_summary: {
        type: String,
        default: null,
        trim: true,
    },
    status_of_business: {
        type: String,
        enum: ['For Sale', 'Under Offer', 'Sold (Subject to Contract)', 'Active', 'New', 'Operating', 'Startup'],
        default: 'New',
    },
    property_status: {
        type: String,
        enum: ['Real Property', 'Lease', 'Both', 'N/A', 'Online'],
        default: 'Real Property',
    },
    is_real_property_included: {
        type: Boolean,
        default: null,
    },
    is_active: {
        type: Boolean,
        default: true
    },
    quick_sale: {
        type: Boolean,
        default: false,
    },
    photographs: {
        type: [String],
        default: [],
    },
    documents: {
        type: [String],
        default: [],
    },
    website_address: {
        type: String,
        default: null,
        match: [/^https?:\/\/[^\s$.?#].[^\s]*$/, 'Please enter a valid URL'], // URL validation
    },
    years_established: {
        type: String,
        default: null,
        match: [/^\d{4}$/, 'Please enter a valid year'],
    },
    reason_for_selling: {
        type: String,
        default: null,
    },
    description: {
        type: String,
        default: null,
    },
    sellerEmail: {
        type: String,
        default: null,
    },
    region: {
        type: String,
        trim: true,
        default: null
    },
    city_town: {
        type: String,
        trim: true,
        default: null
    },
    location: {
        type: String,
        trim: true,
        default: null
    },
    sectorId: {
        type: Schema.Types.ObjectId,
        default: null,
        ref: 'sector'
    },
    asking_price: {
        type: Schema.Types.Number,
        trim: true,
        default: null,
        validate: {
            validator: function (value) {
                return value === null || /^[\d,]+(\.\d{1,2})?$/.test(value.toString());
            },
            message: 'Asking price must be a valid number or null.'
        }
    },
    sales_revenue: {
        type: Schema.Types.Number,
        trim: true,
        default: null,
        validate: {
            validator: function (value) {
                return value === null || /^[\d,]+(\.\d{1,2})?$/.test(value.toString());
            },
            message: 'Sales revenue must be a valid number or null.'
        }
    },
    cash_flow: {
        type: Schema.Types.Number,
        trim: true,
        default: null,
        validate: {
            validator: function (value) {
                return value === null || /^[\d,]+(\.\d{1,2})?$/.test(value.toString());
            },
            message: 'Cash flow must be a valid number or null.'
        }
    }
}, { timestamps: true });

sellBusinessSchema.index({
    name: 'text',
    general_summary: 'text',
    description: 'text',
    region: 'text',
    city_town: 'text',
    location: 'text',
});

sellBusinessSchema.index({ businessTypeId: 1 });
sellBusinessSchema.index({ sectorId: 1 });
sellBusinessSchema.index({ is_active: 1, status_of_business: 1 });
sellBusinessSchema.index({ asking_price: 1 });
sellBusinessSchema.index({ createdAt: -1 });

const SellBusiness = mongoose.model('SellBusiness', sellBusinessSchema);
module.exports = SellBusiness;