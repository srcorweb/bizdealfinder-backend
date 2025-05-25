const mongoose = require('mongoose');
const { Schema } = mongoose;

const sectorSchema = new Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    parentId: {
        type: Schema.Types.ObjectId,
        default: null,
        ref: 'sector'
    },
    is_active: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

const Sector = mongoose.model('sector', sectorSchema);

module.exports = Sector;