// testQuery.js
require('dotenv').config();
const { MongoClient } = require('mongodb');
const { OpenAI } = require('openai');

(async () => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // 1. get embedding for the user’s question
  const { data } = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: 'cash-flow-positive furniture store in Texas under $500k'
  });
  const queryVec = data[0].embedding;

  // 2. connect to MongoDB
  const client = new MongoClient(process.env.DB_DATABASE);
  await client.connect();
  const col = client.db().collection('businesses');

  // 3. run the vector search
  const results = await col.aggregate([
    {
      $vectorSearch: {
        index: 'vector_index',
        path: 'descriptionEmbedding',
        queryVector: queryVec,
        limit: 50,            // grab a wider pool
        numCandidates: 200,
        // example: keep ≤$500 k, drop Texas
        filter: { price: { $lte: 500000 } }

      }
    },
    {
      $match: {               // plain Mongo regex works here
        $or: [
          { name:        /furniture/i },
          { description: /furniture/i }
        ]
      }
    },
    { $limit: 10 },
    { $project: { name: 1, price: 1, score: { $meta: 'vectorSearchScore' } } }
  ]).toArray();
  
  

  console.log(results);
  await client.close();
})();
