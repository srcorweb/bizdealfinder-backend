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
      serverSelectionTimeoutMS: 30000, // Increase timeout to 30s
      maxPoolSize: 10, // Allow up to 10 concurrent connections
      minPoolSize: 2, // Maintain at least 2 connections
      heartbeatFrequencyMS: 10000, // Check server status every 10s
    });
    console.log('MongoDB connected successfully to:', DB_STRING);
    mongoose.connection.on('disconnected', () => {
      console.log('MongoDB disconnected, attempting to reconnect...');
      connectDB();
    });
    mongoose.connection.on('error', (err) => {
      console.error('MongoDB connection error:', err);
    });
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  }
};

connectDB();

module.exports = mongoose;