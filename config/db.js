require("dotenv").config();
const mongoose = require('mongoose');
const DB_STRING = process.env.DB_DATABASE;

if (!DB_STRING) {
  throw new Error('DB_DATABASE environment variable is not defined');
}

const connectDB = async () => {
  try {
    await mongoose.connect(DB_STRING, {
      ssl: true,
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB connected successfully to:', DB_STRING);
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  }
};

connectDB();

module.exports = mongoose;