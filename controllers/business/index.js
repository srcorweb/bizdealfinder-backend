const express = require('express');
const router = express.Router();
const Business = require('../../models/business');
const { OpenAI } = require('openai');
require('dotenv').config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Basic search (keyword-based, existing functionality)
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    const query = q ? {
      $or: [
        { name: { $regex: q, $options: 'i' } },
        { 'location.city': { $regex: q, $options: 'i' } },
        { 'location.state': { $regex: q, $options: 'i' } },
        { sector: { $regex: q, $options: 'i' } }
      ]
    } : {};
    const businesses = await Business.find(query).limit(20);
    res.json(businesses);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// AI-powered search
router.get('/ai-search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ message: 'Query required' });

    // Parse query with Open AI
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an expert at converting natural language queries into MongoDB queries for a business listings database with fields:
          - businessId: string
          - name: string
          - price: number
          - revenue: number
          - location: { city: string, state: string }
          - sbaPreApproved: boolean
          - sellerFinancing: boolean
          - zeroDown: boolean
          - distressed: boolean
          - ownerAbsentee: boolean
          - brickAndMortar: boolean
          - sector: string (Agriculture, Energy, Engineering, Food, Franchise Resales, Leisure, Manufacturing, Online, Real Estate, Retail, Services, Tech & Media, Wholesale & Distribution)
          - scrapedData: { source: string, priceText: string, revenueText: string, detailUrl: string }

          Return a JSON object with a MongoDB query to match listings. Use:
          - $lte, $gte for price/revenue
          - $regex with 'i' for text (name, city, state, sector)
          - Exact matches for booleans
          - $and/$or for combinations

          Examples:
          Query: "sba approved under 500k car shops in manhattan"
          Output: { "sbaPreApproved": true, "price": { "$lte": 500000 }, "location.city": { "$regex": "Manhattan", "$options": "i" }, "$or": [{ "name": { "$regex": "car shop", "$options": "i" } }, { "sector": "Retail" }] }

          Query: "franchises in florida"
          Output: { "sector": "Franchise Resales", "location.state": { "$regex": "Florida", "$options": "i" } }

          Return JSON only, no markdown.`
        },
        {
          role: 'user',
          content: q
        }
      ],
      response_format: { type: 'json_object' }
    });

    const mongoQuery = JSON.parse(response.choices[0].message.content);
    console.log('MongoDB query:', mongoQuery);

    // Run MongoDB query
    const businesses = await Business.find(mongoQuery).limit(20);
    if (businesses.length === 0) {
      // Fallback to keyword search
      const fallbackQuery = {
        $or: [
          { name: { $regex: q, $options: 'i' } },
          { 'location.city': { $regex: q, $options: 'i' } },
          { 'location.state': { $regex: q, $options: 'i' } },
          { sector: { $regex: q, $options: 'i' } }
        ]
      };
      const fallbackBusinesses = await Business.find(fallbackQuery).limit(20);
      return res.json(fallbackBusinesses);
    }

    res.json(businesses);
  } catch (error) {
    console.error('AI search error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;