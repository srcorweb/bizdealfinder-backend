const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Business = require('../../models/business');
const SavedDeal = require('../../models/SavedDeal');
const UserPreferences = require('../../models/userPreferences');
const { OpenAI } = require('openai');
const { processSearchQuery } = require('../../service/searchServices');
const { authMiddleware } = require('../../requests/middleware/AuthMiddleware');
const nodemailer = require('nodemailer');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const NodeCache = require('node-cache');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
require('dotenv').config();

puppeteer.use(StealthPlugin());
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const suggestionCache = new NodeCache({ stdTTL: 86400 });
const relevanceCache = new NodeCache({ stdTTL: 3600 });

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const retryWithBackoff = async (fn, retries = 3, delay = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error.status === 429 && i < retries - 1) {
        const waitTime = delay * Math.pow(2, i);
        console.log(`Rate limit hit, retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        throw error;
      }
    }
  }
};

const extractMetricsFromDescription = async (description) => {
  const metrics = [];
  const regexPatterns = [
    { key: 'Year Established', pattern: /(\d{4})\s*(?:founded|established|started|since)/i },
    { key: 'Years in Operation', pattern: /(\d+)\s*(?:years?|yrs?)\s*(?:in\s*operation|operating|established)/i },
    { key: 'Employees', pattern: /(\d+)\s*(?:employees|staff|team\s*members)/i },
    { key: 'Revenue', pattern: /\$([\d,.]+)\s*(?:revenue|sales|income)/i },
    { key: 'Cash Flow', pattern: /\$([\d,.]+)\s*(?:cash\s*flow|profit|earnings)/i },
    { key: 'Monthly Rent', pattern: /\$([\d,.]+)\s*(?:rent|monthly\s*rent)/i }
  ];

  for (const { key, pattern } of regexPatterns) {
    const match = description.match(pattern);
    if (match) {
      let value = match[1].replace(/,/g, '');
      if (key === 'Revenue' || key === 'Cash Flow' || key === 'Monthly Rent') {
        value = `$${parseInt(value).toLocaleString()}`;
      }
      metrics.push({ key, value });
    }
  }

  if (metrics.length < 2) {
    try {
      const aiPrompt = `
        Extract financial and operational metrics from the following business description. Return a JSON array of objects with "key" and "value" fields for metrics like Year Established, Years in Operation, Employees, Revenue, Cash Flow, Monthly Rent, etc. Use numeric values where possible, and format monetary values with "$" and commas (e.g., "$1,000,000").
        Description: ${description.substring(0, 1000)}
        Return JSON only: []
      `;
      const aiResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are an expert in extracting business metrics from text.' },
          { role: 'user', content: aiPrompt }
        ],
        response_format: { type: 'json_object' }
      });
      const aiMetrics = JSON.parse(aiResponse.choices[0].message.content);
      if (Array.isArray(aiMetrics)) {
        metrics.push(...aiMetrics);
      }
    } catch (error) {
      console.error('AI description parsing error:', error);
    }
  }

  const uniqueMetrics = [];
  const seenKeys = new Set();
  for (const metric of metrics) {
    if (!seenKeys.has(metric.key)) {
      seenKeys.add(metric.key);
      uniqueMetrics.push(metric);
    }
  }

  return uniqueMetrics;
};

router.get('/suggest', authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    const query = q ? q.toLowerCase().trim() : '';

    const predefinedSuggestions = [
      'sba preapproved',
      'distressed restaurants',
      'low price gas station',
      'ecom store',
      'owner absentee retail',
      'brick and mortar under 500k',
      'seller financing in texas',
      'zero down businesses'
    ];

    if (!query) {
      return res.status(200).json(predefinedSuggestions.slice(0, 5));
    }

    const cacheKey = `suggest:${query}`;
    const cachedSuggestions = suggestionCache.get(cacheKey);
    if (cachedSuggestions) {
      console.log('Serving suggestions from cache:', query);
      return res.status(200).json(cachedSuggestions);
    }

    const prompt = `
      Generate up to 10 search query completions for the partial query "${query}" relevant to a business listing database. Focus on business-related terms like sectors (e.g., Food, Retail, Services), locations (e.g., Texas, New York), and attributes (e.g., sba preapproved, distressed, under 500k). Avoid unrelated suggestions (e.g., tourism, weather). Return a JSON object with a "suggestions" key containing an array of strings.
      Example: For "rest", return { "suggestions": ["restaurants in texas", "restaurants under 500k", "restaurants sba preapproved", "restaurants distressed"] }
    `;
    const response = await retryWithBackoff(() =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are an expert in generating business-related search query completions.' },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      })
    );

    let suggestions = JSON.parse(response.choices[0].message.content).suggestions || [];

    const popularTerms = await Business.aggregate([
      {
        $facet: {
          sectors: [{ $group: { _id: '$sector', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          states: [{ $group: { _id: '$location.state', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          names: [{ $unwind: '$name' }, { $group: { _id: '$name', count: { $sum: 1 } } }, { $sort: { count: -1 } }]
        }
      }
    ]);

    const sectorCounts = popularTerms[0].sectors.reduce((acc, { _id, count }) => ({ ...acc, [_id.toLowerCase()]: count }), {});
    const stateCounts = popularTerms[0].states.reduce((acc, { _id, count }) => ({ ...acc, [_id.toLowerCase()]: count }), {});
    const nameCounts = popularTerms[0].names.reduce((acc, { _id, count }) => ({ ...acc, [_id.toLowerCase()]: count }), {});
    const booleanTerms = ['distressed', 'owner absentee', 'absentee', 'sba', 'approved', 'brick and mortar', 'seller financing', 'zero down'];

    suggestions = suggestions
      .filter(suggestion => {
        const words = suggestion.toLowerCase().split(' ');
        return words.some(word =>
          sectorCounts[word] ||
          stateCounts[word] ||
          nameCounts[word] ||
          booleanTerms.includes(word) ||
          word.match(/\d+k/)
        );
      })
      .map(suggestion => ({
        text: suggestion,
        score: suggestion.toLowerCase().split(' ').reduce((acc, word) => {
          return acc + (sectorCounts[word] || stateCounts[word] || nameCounts[word] || (booleanTerms.includes(word) ? 10 : 0) || 0);
        }, 0)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ text }) => text);

    suggestionCache.set(cacheKey, suggestions);
    console.log('Generated suggestions:', suggestions);

    res.status(200).json(suggestions);
  } catch (error) {
    console.error('Suggest error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/search', authMiddleware, async (req, res) => {
  try {
    const query = req.query.q || "coffee shop in New York under 500k";
    const results = await processSearchQuery(query);
    res.status(200).json(results);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/ai-search', authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ message: 'Query required' });

    const query = q.trim();
    console.log('Processing natural language query:', query);

    // Generate MongoDB query using OpenAI
    const prompt = `
      Translate the following natural language query into a MongoDB query for a business listings database. The database has fields: name (string), sector (string, e.g., "Food", "Retail"), price (number), revenue (number), cashFlow (number), location (object with city and state strings), description (string), distressed (boolean), ownerAbsentee (boolean), sbaPreApproved (boolean), sellerFinancing (boolean), zeroDown (boolean), brickAndMortar (boolean). Return a JSON object with a single key "query" containing the MongoDB query object. Use $regex for partial string matches (case-insensitive), $gt/$lte for numeric comparisons, and ensure logical operators ($and, $or) are used correctly. Handle terms like "under/over" for price/revenue, locations (e.g., "Texas"), and attributes (e.g., "sba preapproved"). If the query is ambiguous, prioritize name, sector, or location matches.

      Query: "${query}"

      Examples:
      Query: "businesses in Texas with revenue over $1 million"
      Output: { "query": { "$and": [{ "location.state": { "$regex": "^Texas$", "$options": "i" } }, { "revenue": { "$gt": 1000000 } }] } }
      Query: "coffee shops under 500k"
      Output: { "query": { "$and": [{ "sector": "Food" }, { "price": { "$lte": 500000 } }, { "name": { "$regex": "coffee", "$options": "i" } }] } }
      Query: "sba preapproved restaurants"
      Output: { "query": { "$and": [{ "sbaPreApproved": true }, { "sector": "Food" }] } }

      Return JSON only: { "query": {} }
    `;
    const queryResponse = await retryWithBackoff(() =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are an expert in translating natural language to MongoDB queries.' },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      })
    );

    const mongoQuery = JSON.parse(queryResponse.choices[0].message.content).query;
    console.log('Generated MongoDB query:', JSON.stringify(mongoQuery));

    // Execute the query
    const businesses = await Business.find(mongoQuery).limit(100).lean();
    console.log('Fetched listings:', businesses.length);

    // Apply relevance scoring
    const results = [];
    const batchSize = 5;
    for (let i = 0; i < businesses.length; i += batchSize) {
      const batch = businesses.slice(i, i + batchSize);
      const batchPromises = batch.map(async (business) => {
        try {
          const cacheKey = `relevance:${query}:${business.businessId}`;
          const cachedResult = relevanceCache.get(cacheKey);
          if (cachedResult) {
            console.log(`Serving relevance from cache for ${business.businessId}`);
            return cachedResult;
          }

          const truncatedBusiness = {
            businessId: business.businessId,
            name: business.name,
            sector: business.sector,
            price: business.price,
            revenue: business.revenue,
            cashFlow: business.cashFlow,
            location: business.location,
            description: business.description?.substring(0, 1000),
            scrapedData: { detailUrl: business.scrapedData?.detailUrl },
            sourceContent: {
              financials: business.sourceContent?.financials,
              detailedInfo: business.sourceContent?.detailedInfo,
              content: business.sourceContent?.content?.substring(0, 1000)
            },
            distressed: business.distressed,
            ownerAbsentee: business.ownerAbsentee,
            sbaPreApproved: business.sbaPreApproved,
            sellerFinancing: business.sellerFinancing,
            zeroDown: business.zeroDown,
            brickAndMortar: business.brickAndMortar
          };

          const messageContent = `Query: ${query}\nListing: ${JSON.stringify(truncatedBusiness)}`;
          const approxTokens = messageContent.length / 4;
          if (approxTokens > 120000) {
            console.warn(`Skipping ${business.businessId}: estimated ${approxTokens} tokens exceeds limit`);
            return { businessId: business.businessId, relevance: 50, reason: 'Listing data too large for processing' };
          }

          const response = await retryWithBackoff(() =>
            openai.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [
                {
                  role: 'system',
                  content: `Evaluate business listings for relevance to a user query. Return:
                  - businessId: string
                  - relevance: number (0-100)
                  - reason: string
                  Map terms: "restaurants" → sector: "Food", "shops" → sector: "Retail" or "Services", "distressed" → distressed: true, etc. Prioritize exact matches for boolean fields and location. Penalize non-matching locations (-40). Score >50 for clear matches, <30 for poor matches. Return JSON only.`
                },
                { role: 'user', content: messageContent }
              ],
              response_format: { type: 'json_object' }
            })
          );
          const result = JSON.parse(response.choices[0].message.content);
          relevanceCache.set(cacheKey, result);
          return result;
        } catch (error) {
          console.error('Open AI error for', business.businessId, error.message);
          return { businessId: business.businessId, relevance: 0, reason: 'Failed to process' };
        }
      });
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const relevantResults = results
      .filter(result => result.relevance > 50)
      .map(result => {
        const business = businesses.find(b => b.businessId === result.businessId);
        return business ? { ...business, relevance: result.relevance } : null;
      })
      .filter(b => b);

    console.log('Relevant listings:', relevantResults.length);
    res.status(200).json(relevantResults);
  } catch (error) {
    console.error('AI search error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/saved', authMiddleware, async (req, res) => {
  try {
    const { businessId } = req.body;
    if (!businessId) return res.status(400).json({ message: 'Business ID required' });

    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const business = await Business.findOne({ businessId });
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const existingSavedDeal = await SavedDeal.findOne({ deal_id: business._id, user_id: userId });
    if (existingSavedDeal) return res.status(400).json({ message: 'Deal already saved' });

    const savedDeal = new SavedDeal({ deal_id: business._id, user_id: userId });
    await savedDeal.save();

    res.status(200).json(business);
  } catch (error) {
    console.error('Save deal error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/saved', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const savedDeals = await SavedDeal.find({ user_id: userId }).lean();
    const dealIds = savedDeals.map(deal => deal.deal_id);
    const businesses = await Business.find({ _id: { $in: dealIds } }).lean();
    console.log('Fetched saved deals:', businesses.length);
    res.status(200).json(businesses);
  } catch (error) {
    console.error('Get saved deals error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/saved/:businessId', authMiddleware, async (req, res) => {
  try {
    const { businessId } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const business = await Business.findOne({ businessId });
    if (!business) return res.status(404).json({ message: 'Business not found' });

    await SavedDeal.deleteOne({ deal_id: business._id, user_id: userId });
    res.status(200).json({ message: 'Deal unsaved' });
  } catch (error) {
    console.error('Unsave deal error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/preferences', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const preferences = req.body;
    if (!preferences || Object.keys(preferences).length === 0) {
      return res.status(400).json({ message: 'Preferences required' });
    }

    const validFields = ['sector', 'priceRange', 'location', 'distressed', 'ownerAbsentee', 'sbaPreApproved', 'sellerFinancing', 'zeroDown', 'brickAndMortar'];
    const invalidFields = Object.keys(preferences).filter(key => !validFields.includes(key));
    if (invalidFields.length > 0) {
      return res.status(400).json({ message: `Invalid preference fields: ${invalidFields.join(', ')}` });
    }

    await UserPreferences.updateOne(
      { userId },
      { $set: { ...preferences, userId } },
      { upsert: true }
    );

    res.status(200).json({ message: 'Preferences saved' });
  } catch (error) {
    console.error('Save preferences error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/preferences', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const preferences = await UserPreferences.findOne({ userId }).lean();
    if (!preferences) return res.status(404).json({ message: 'No preferences found' });

    res.status(200).json(preferences);
  } catch (error) {
    console.error('Get preferences error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/for-you', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const matches = await Business.find({ matchedUsers: userId }).limit(50).lean();
    console.log('Fetched For You deals:', matches.length);

    res.status(200).json(matches);
  } catch (error) {
    console.error('Get For You deals error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/check-matches', async (req, res) => {
  try {
    const newListings = req.body.listings || [];
    if (!Array.isArray(newListings) || newListings.length === 0) {
      return res.status(400).json({ message: 'New listings required' });
    }

    const users = await UserPreferences.find({}).lean();
    const matches = [];

    for (const user of users) {
      const userMatches = [];
      for (const listing of newListings) {
        const isMatch = (
          (!user.sector || listing.sector === user.sector) &&
          (!user.priceRange?.min || listing.price >= user.priceRange.min) &&
          (!user.priceRange?.max || listing.price <= user.priceRange.max) &&
          (!user.location?.city || listing.location.city === user.location.city) &&
          (!user.location?.state || listing.location.state === user.location.state) &&
          (user.distressed === true ? listing.distressed === true : true) &&
          (user.ownerAbsentee === true ? listing.ownerAbsentee === true : true) &&
          (user.sbaPreApproved === true ? listing.sbaPreApproved === true : true) &&
          (user.sellerFinancing === true ? listing.sellerFinancing === true : true) &&
          (user.zeroDown === true ? listing.zeroDown === true : true) &&
          (user.brickAndMortar === true ? listing.brickAndMortar === true : true)
        );

        if (isMatch) {
          userMatches.push({
            userId: user.userId,
            businessId: listing.businessId,
            listing
          });
        }
      }
      if (userMatches.length > 0) {
        matches.push(...userMatches);
      }
    }

    console.log('Found matches:', matches.length);
    res.status(200).json({ matches });
  } catch (error) {
    console.error('Check matches error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/swot-analysis', authMiddleware, async (req, res) => {
  try {
    const { businessId } = req.body;
    if (!businessId) return res.status(400).json({ message: 'Business ID required' });

    const business = await Business.findOne({ businessId }).lean();
    if (!business) return res.status(404).json({ message: 'Business not found' });

    if (business.swotAnalysis?.strengths && business.benchmarks?.dealSummary && business.riskAnalysis?.score && business.marketTrendsData?.length >= 10) {
      let aiGeneratedDescription = business.aiGeneratedDescription;
      if (!aiGeneratedDescription) {
        const descPrompt = `
          Generate a concise 1-2 sentence description of the following business listing based on all available data, including name, sector, price, revenue, cash flow, location, description, and scraped data. Ensure the description is professional, engaging, and highlights key aspects of the business.
          Listing Data:
          - Title: ${business.name}
          - Sector: ${business.sector}
          - Price: $${business.price.toLocaleString()}
          - Revenue: ${business.revenue ? `$${business.revenue.toLocaleString()}` : 'Unavailable'}
          - Cash Flow (Monthly): ${business.cashFlow ? `$${business.cashFlow.toLocaleString()}` : 'Unavailable'}
          - Location: ${business.location.city}, ${business.location.state}
          - Description: ${business.description}
          - Keywords: ${business.distressed ? 'distressed, ' : ''}${business.sellerFinancing ? 'seller financing, ' : ''}${business.sbaPreApproved ? 'SBA approved, ' : ''}${business.ownerAbsentee ? 'owner absentee, ' : ''}${business.zeroDown ? 'zero down, ' : ''}${business.brickAndMortar ? 'brick and mortar' : 'online'}
          - Source URL: ${business.scrapedData.detailUrl}
          - Source Data: ${JSON.stringify(business.sourceContent || {})}
          Return a JSON object with a single key "description" containing the 1-2 sentence description.
        `;
        const descResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are an expert in summarizing business listings.' },
            { role: 'user', content: descPrompt }
          ],
          response_format: { type: 'json_object' }
        });
        aiGeneratedDescription = JSON.parse(descResponse.choices[0].message.content).description;
        await Business.updateOne(
          { businessId },
          { $set: { aiGeneratedDescription } }
        );
      }

      return res.status(200).json({
        businessName: business.name,
        aiGeneratedDescription,
        swotAnalysis: business.swotAnalysis,
        benchmarks: business.benchmarks,
        riskAnalysis: business.riskAnalysis,
        competitors: business.competitors,
        insights: business.insights,
        marketTrends: business.marketTrends,
        marketTrendsData: business.marketTrendsData,
        valuation: business.valuation,
        detailUrl: business.scrapedData?.detailUrl || '',
        sourceData: {
          financials: business.sourceContent?.financials || [
            { key: 'Asking Price', value: `$${business.price.toLocaleString()}` },
            { key: 'Revenue', value: business.revenue ? `$${business.revenue.toLocaleString()}` : 'Unavailable' },
            ...(business.cashFlow ? [{ key: 'Cash Flow (Monthly)', value: `$${business.cashFlow.toLocaleString()}` }] : [])
          ],
          detailedInfo: business.sourceContent?.detailedInfo || []
        }
      });
    }

    const competitors = await Business.find({
      sector: business.sector,
      price: { $gte: business.price * 0.5, $lte: business.price * 1.5 },
      businessId: { $ne: businessId }
    }).limit(3).lean();

    let sourceContent = business.sourceContent?.content || '';
    let financials = business.sourceContent?.financials || [];
    let detailedInfo = business.sourceContent?.detailedInfo || [];
    let useFallback = false;

    if (!sourceContent || !business.sourceContent?.scrapedAt || (new Date() - new Date(business.sourceContent.scrapedAt)) > 7 * 24 * 60 * 60 * 1000) {
      let attempt = 0;
      const maxRetries = 3;
      while (attempt < maxRetries) {
        try {
          if (business.scrapedData?.source === 'BizBuySell') {
            const httpsAgent = new https.Agent({ ALPNProtocols: ['http/1.1'] });
            const response = await axios.get(business.scrapedData.detailUrl, {
              timeout: 30000,
              headers: {
                'User-Agent': 'Safari/17612.3.14.1.6 CFNetwork/1327.0.4 Darwin/21.2.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
              },
              httpsAgent
            });
            sourceContent = response.data;
            const $ = cheerio.load(sourceContent);

            financials = [];
            $('.financials p').each((_, el) => {
              const key = $(el).find('.title').text().trim();
              let value = $(el).find('.normal').text().trim().replace(/[^0-9.$]/g, '');
              if (key && value && !['N/A', 'Not Disclosed'].includes(value)) {
                if (key === 'Rent') value = value.replace(' per Month', '');
                financials.push({ key, value });
              }
            });

            detailedInfo = [];
            $('#ctl00_ctl00_Content_ContentPlaceHolder1_wideProfile_listingDetails_dlDetailedInformation dt').each((i, dt) => {
              const key = $(dt).find('.normal').text().trim();
              let value = $(dt).next('dd').text().trim();
              if (key === 'Established' && value.match(/^\d{4}$/)) {
                value = (2025 - parseInt(value)).toString();
              }
              if (key && value && !['N/A', 'Not Disclosed'].includes(value)) {
                detailedInfo.push({ key, value });
              }
            });
          } else if (business.scrapedData?.source === 'Sunbelt Network') {
            const httpsAgent = new https.Agent({ rejectUnauthorized: false, maxVersion: 'TLSv1.2' });
            const response = await axios.get(business.scrapedData.detailUrl, {
              timeout: 30000,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Connection': 'keep-alive',
                'Accept-Encoding': 'gzip, deflate, br'
              },
              httpsAgent
            });
            sourceContent = response.data;
            const $ = cheerio.load(sourceContent);

            financials = [];
            $('.resultsBusiness__detailsFinancial--item ul.valuesItems li').each((_, el) => {
              const key = $(el).find('.resultsBusiness__detailsFinancial--itemSpan').text().trim();
              let value = $(el).find('.resultsBusiness__detailsFinancial--itemStrong').text().trim();
              if (key && value && !['N/A', 'Not Disclosed', 'On request'].includes(value)) {
                value = value.replace(/[^0-9.$]/g, '');
                if (value.startsWith('$')) {
                  value = `$${parseInt(value.replace(/[^0-9]/g, '')).toLocaleString()}`;
                }
                financials.push({ key, value });
              }
            });

            detailedInfo = [];
            $('.resultsBusiness__detailsInformation ul li').each((_, el) => {
              const key = $(el).find('strong').text().trim().replace(':', '');
              let value = $(el).find('span').text().trim();
              if (key === 'Year Established' && value.match(/^\d{4}$/)) {
                value = (2025 - parseInt(value)).toString();
              }
              if (key && value && !['N/A', 'Not Disclosed'].includes(value)) {
                detailedInfo.push({ key, value });
              }
            });

            const description = $('div.w-full.lg\\:pr-2.lg\\:w-7\\/12 > p').text().trim();
            const descMetrics = await extractMetricsFromDescription(description);
            for (const metric of descMetrics) {
              if (['Revenue', 'Cash Flow', 'Monthly Rent'].includes(metric.key) && !financials.some(f => f.key === metric.key)) {
                financials.push(metric);
              } else if (!detailedInfo.some(d => d.key === metric.key)) {
                detailedInfo.push(metric);
              }
            }
          } else if (business.scrapedData?.source === 'Flippa') {
            const httpsAgent = new https.Agent({ rejectUnauthorized: false, maxVersion: 'TLSv1.2' });
            const response = await axios.get(business.scrapedData.detailUrl, {
              timeout: 30000,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Connection': 'keep-alive',
                'Accept-Encoding': 'gzip, deflate, br'
              },
              httpsAgent
            });
            sourceContent = response.data;
            const $ = cheerio.load(sourceContent);

            financials = [];
            $('#properties-summary .tw-mr-8.tw-mb-5').each((_, el) => {
              const key = $(el).find('.tw-text-sm.tw-text-gray-500').text().trim();
              let value = $(el).find('.tw-text-lg.tw-font-semibold div').text().trim();
              if (key && value && !['N/A', 'Not Disclosed', 'Confidential'].includes(value)) {
                if (value.includes('AUD') || value.includes('USD')) {
                  value = value.replace(/[^0-9$]/g, '');
                  value = `$${parseInt(value).toLocaleString()}`;
                }
                financials.push({ key, value });
              }
            });

            detailedInfo = [];
            $('#properties-summary .tw-mr-8.tw-mb-5').each((_, el) => {
              const key = $(el).find('.tw-text-sm.tw-text-gray-500').text().trim();
              let value = $(el).find('.tw-text-lg.tw-font-semibold div').text().trim();
              if (key && value && !['N/A', 'Not Disclosed', 'Confidential'].includes(value) && !['Monthly Profit', 'Revenue'].includes(key)) {
                if (key === 'Site Age') {
                  value = value.replace(/years?/, '').trim();
                }
                detailedInfo.push({ key, value });
              }
            });

            const description = $('div[data-toggle-class-target="element"]').text().trim();
            const descMetrics = await extractMetricsFromDescription(description);
            for (const metric of descMetrics) {
              if (['Revenue', 'Cash Flow', 'Monthly Rent'].includes(metric.key) && !financials.some(f => f.key === metric.key)) {
                financials.push(metric);
              } else if (!detailedInfo.some(d => d.key === metric.key)) {
                detailedInfo.push(metric);
              }
            }
          } else {
            const browser = await puppeteer.launch({
              headless: true,
              args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
              protocolTimeout: 120000
            });
            const page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.setViewport({ width: 1280, height: 800 });

            console.log(`Scraping source page (attempt ${attempt + 1}): ${business.scrapedData.detailUrl}`);
            await page.goto(business.scrapedData.detailUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            sourceContent = await page.content();
            await browser.close();

            const $ = cheerio.load(sourceContent);
            const description = $('body').text().trim();
            const descMetrics = await extractMetricsFromDescription(description);
            financials = descMetrics.filter(m => ['Revenue', 'Cash Flow', 'Monthly Rent'].includes(m.key));
            detailedInfo = descMetrics.filter(m => !['Revenue', 'Cash Flow', 'Monthly Rent'].includes(m.key));
          }

          await Business.updateOne(
            { businessId },
            {
              $set: {
                sourceContent: {
                  content: sourceContent,
                  scrapedAt: new Date(),
                  financials,
                  detailedInfo
                }
              }
            }
          );
          console.log(`Cached source content for ${businessId}`);
          break;
        } catch (err) {
          console.error(`Failed to scrape source page for ${businessId} (attempt ${attempt + 1}):`, err.message);
          attempt++;
          if (attempt === maxRetries) {
            console.error(`Max retries reached for ${businessId}. Using fallback.`);
            useFallback = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 5000 * Math.pow(2, attempt)));
        }
      }
    }

    if (useFallback) {
      console.log(`Using existing data for analysis of ${businessId}`);
      financials = business.sourceContent?.financials || [
        { key: 'Asking Price', value: `$${business.price.toLocaleString()}` },
        { key: 'Revenue', value: business.revenue ? `$${business.revenue.toLocaleString()}` : 'Unavailable' },
        ...(business.cashFlow ? [{ key: 'Cash Flow (Monthly)', value: `$${business.cashFlow.toLocaleString()}` }] : [])
      ];
      detailedInfo = business.sourceContent?.detailedInfo || [];
      sourceContent = business.sourceContent?.content || business.description || '';
    }

    const prompt = `
      Analyze the following business listing and its source page content to provide a comprehensive SWOT Analysis, industry benchmarks, and additional insights. Use the provided listing data and source page data if available. If source page data is limited, rely on the listing data and estimate missing metrics based on industry standards for the sector.
      Listing Data:
      - Title: ${business.name}
      - Description: ${business.description}
      - Sector: ${business.sector}
      - Price: $${business.price.toLocaleString()}
      - Revenue: ${business.revenue ? `$${business.revenue.toLocaleString()}` : 'Unavailable'}
      - Cash Flow (Monthly): ${business.cashFlow ? `$${business.cashFlow.toLocaleString()}` : 'Unavailable'}
      - Location: ${business.location.city}, ${business.location.state}
      - Keywords: ${business.distressed ? 'distressed, ' : ''}${business.sellerFinancing ? 'seller financing, ' : ''}${business.sbaPreApproved ? 'SBA approved, ' : ''}${business.ownerAbsentee ? 'owner absentee, ' : ''}${business.zeroDown ? 'zero down, ' : ''}${business.brickAndMortar ? 'brick and mortar' : 'online'}
      - Source URL: ${business.scrapedData.detailUrl}
      Source Page Content:
      ${sourceContent.substring(0, 10000)}...
      Additional Source Data:
      Financials: ${JSON.stringify(financials)}
      Detailed Info: ${JSON.stringify(detailedInfo)}
      Provide:
      1. SWOT Analysis (1–2 sentences each, incorporating source page details or listing data):
        - Strengths: Key advantages or positive attributes.
        - Weaknesses: Potential drawbacks or limitations.
        - Opportunities: Growth or market potential.
        - Threats: External risks or challenges.
      2. Industry Benchmarks (based on sector: ${business.sector}):
        - EBITDA Margin: Average for the sector (e.g., percentage range).
        - Revenue Growth YoY: Typical yearly growth range.
        - Cash Multiple: Typical revenue or profit multiple.
        - Deal Summary: 3 paragraphs (100–150 words total) focusing on market potential, risk vs reward, and growth levers.
      3. Risk Analysis:
        - Score: Numeric score (0–100) based on SWOT, financials, and market conditions.
        - Summary: 1-sentence explanation of the score.
      4. Actionable Insights: 3–5 actionable recommendations (1 sentence each) based on SWOT and available data.
      5. Market Trends:
        - Summary: 1–2 sentences on sector-specific trends (e.g., growth rate, consumer demand) based on web-sourced data.
        - Data: Array of 10 numbers representing annual percentage revenue growth rates for the sector in the U.S. from 2015 to 2024, in order (e.g., [3.2, 4.1, 2.8, ...]). Average multiple sources and use 0 for missing years.
      6. Valuation Estimate:
        - Range: Estimated valuation range (e.g., "$300k–$400k").
        - Confidence: Confidence score (0–100).
      Return JSON only:
      {
        "swotAnalysis": {
          "strengths": "...",
          "weaknesses": "...",
          "opportunities": "...",
          "threats": "..."
        },
        "benchmarks": {
          "ebitdaMargin": "...",
          "revenueGrowthYoY": "...",
          "cashMultiple": "...",
          "dealSummary": "..."
        },
        "riskAnalysis": {
          "score": 0,
          "summary": "..."
        },
        "insights": ["...", "...", "..."],
        "marketTrends": "...",
        "marketTrendsData": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        "valuation": {
          "range": "...",
          "confidence": 0
        }
      }
    `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are an expert business analyst with access to web search capabilities.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    });

    const analysis = JSON.parse(response.choices[0].message.content);

    const descPrompt = `
      Generate a concise 1-2 sentence description of the following business listing based on all available data, including name, sector, price, revenue, cash flow, location, description, and scraped data. Ensure the description is professional, engaging, and highlights key aspects of the business.
      Listing Data:
      - Title: ${business.name}
      - Sector: ${business.sector}
      - Price: $${business.price.toLocaleString()}
      - Revenue: ${business.revenue ? `$${business.revenue.toLocaleString()}` : 'Unavailable'}
      - Cash Flow (Monthly): ${business.cashFlow ? `$${business.cashFlow.toLocaleString()}` : 'Unavailable'}
      - Location: ${business.location.city}, ${business.location.state}
      - Description: ${business.description}
      - Keywords: ${business.distressed ? 'distressed, ' : ''}${business.sellerFinancing ? 'seller financing, ' : ''}${business.sbaPreApproved ? 'SBA approved, ' : ''}${business.ownerAbsentee ? 'owner absentee, ' : ''}${business.zeroDown ? 'zero down, ' : ''}${business.brickAndMortar ? 'brick and mortar' : 'online'}
      - Source URL: ${business.scrapedData.detailUrl}
      - Source Data: ${JSON.stringify(business.sourceContent || {})}
      Return a JSON object with a single key "description" containing the 1-2 sentence description.
    `;
    const descResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are an expert in summarizing business listings.' },
        { role: 'user', content: descPrompt }
      ],
      response_format: { type: 'json_object' }
    });
    const aiGeneratedDescription = JSON.parse(descResponse.choices[0].message.content).description;

    await Business.updateOne(
      { businessId },
      {
        $set: {
          swotAnalysis: analysis.swotAnalysis,
          benchmarks: analysis.benchmarks,
          riskAnalysis: analysis.riskAnalysis,
          competitors: competitors.map(c => ({
            name: c.name,
            price: c.price,
            revenue: c.revenue,
            cashFlow: c.cashFlow,
            yearsEstablished: c.sourceContent?.detailedInfo?.find(d => d.key === 'Years Established')?.value || 'N/A',
            detailUrl: c.scrapedData?.detailUrl || ''
          })),
          insights: analysis.insights,
          marketTrends: analysis.marketTrends,
          marketTrendsData: analysis.marketTrendsData,
          valuation: analysis.valuation,
          aiGeneratedDescription
        }
      }
    );

    res.status(200).json({
      businessName: business.name,
      aiGeneratedDescription,
      swotAnalysis: analysis.swotAnalysis,
      benchmarks: analysis.benchmarks,
      riskAnalysis: analysis.riskAnalysis,
      competitors: competitors.map(c => ({
        name: c.name,
        price: c.price,
        revenue: c.revenue,
        cashFlow: c.cashFlow,
        yearsEstablished: c.sourceContent?.detailedInfo?.find(d => d.key === 'Years Established')?.value || 'N/A',
        detailUrl: c.scrapedData?.detailUrl || ''
      })),
      insights: analysis.insights,
      marketTrends: analysis.marketTrends,
      marketTrendsData: analysis.marketTrendsData,
      valuation: analysis.valuation,
      detailUrl: business.scrapedData?.detailUrl || '',
      sourceData: {
        financials: financials.length > 0 ? financials : [
          { key: 'Asking Price', value: `$${business.price.toLocaleString()}` },
          { key: 'Revenue', value: business.revenue ? `$${business.revenue.toLocaleString()}` : 'Unavailable' },
          ...(business.cashFlow ? [{ key: 'Cash Flow (Monthly)', value: `$${business.cashFlow.toLocaleString()}` }] : [])
        ],
        detailedInfo
      }
    });
  } catch (error) {
    console.error('SWOT analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/contact', authMiddleware, async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ message: 'Name, email, and message are required' });
    }

    const mailOptions = {
      from: email,
      to: process.env.CONTACT_EMAIL,
      subject: `Contact Form Submission from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\nMessage: ${message}`
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Message sent successfully' });
  } catch (error) {
    console.error('Contact form error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;