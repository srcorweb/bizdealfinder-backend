const mongoose = require('mongoose');
const { OpenAI } = require('openai');
require('dotenv').config();
const Business = require('../models/business');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generateEmbeddings() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.DB_DATABASE, { serverSelectionTimeoutMS: 5000 });
    console.log('Connected to MongoDB');

    const businesses = await Business.find({ descriptionEmbedding: null }).lean();
    console.log(`Found ${businesses.length} businesses to process`);

    for (const business of businesses) {
      try {
        const description = business.description || 'No description available';
        const response = await openai.embeddings.create({
          model: 'text-embedding-ada-002',
          input: description.slice(0, 8000) // Limit to avoid token limits
        });
        const embedding = response.data[0].embedding;

        await Business.updateOne(
          { _id: business._id },
          { $set: { descriptionEmbedding: embedding } }
        );
        console.log(`Updated embedding for ${business.businessId}`);
      } catch (err) {
        console.error(`Error processing ${business.businessId}:`, err.message);
      }
    }
    console.log('Embedding generation complete');
  } catch (err) {
    console.error('Script error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

generateEmbeddings();