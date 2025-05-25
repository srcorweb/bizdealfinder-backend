require("dotenv").config();
const mongoose = require('mongoose');
const DB_STRING = process.env.DB_DATABASE;
if (!DB_STRING) {
  throw new Error('DB_DATABASE environment variable is not defined');
}
mongoose.connect(DB_STRING);
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', async () => {
  console.log('MongoDB connected successfully to:', DB_STRING);
  const collections = await db.db.listCollections().toArray();
});

module.exports = mongoose;