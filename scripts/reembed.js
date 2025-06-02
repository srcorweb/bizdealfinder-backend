// scripts/reembed.js  (compact / no enum clash)
require('dotenv').config();
const mongoose = require('mongoose');
const { OpenAI } = require('openai');
const Business = require('../models/business');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

(async () => {
  await mongoose.connect(process.env.DB_DATABASE, { serverSelectionTimeoutMS: 5000 });

  const cursor = Business.find().select('name description').lean().cursor();
  for await (const biz of cursor) {
    const text = `${biz.name}. ${biz.description || ''}`.slice(0, 8000);
    const { data } = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: text
    });

    await Business.updateOne(
      { _id: biz._id },
      { $set: { descriptionEmbedding: data[0].embedding } },
      { strict: false }           // skip enum validation
    );
    console.log('updated', biz.name);
  }

  await mongoose.disconnect();
})();
