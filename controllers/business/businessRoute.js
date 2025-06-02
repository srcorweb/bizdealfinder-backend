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
const relevanceCache = new NodeCache({ stdTTL: 3600 }); // Cache relevance scores for 1 hour

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Retry logic for Open AI rate limit errors
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

// Helper function to extract metrics from description text (for Flippa and Sunbelt)
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

  // AI fallback for complex cases
  if (metrics.length < 2) {
    try {
      const aiPrompt = `
        Extract financial and operational metrics from the following business description. Return a JSON array of objects with "key" and "value" fields for metrics like Year Established, Years in Operation, Employees, Revenue, Cash Flow, Monthly Rent, etc. Use numeric values where possible, and format monetary values with "$" and commas (e.g., "$1,000,000").

        Description: ${description.substring(0, 1000)}

        Return JSON only:
        []
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

  // Deduplicate metrics
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

// Generate suggestions using OpenAI and filter against businesses collection
router.get('/suggest', authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    const query = q ? q.toLowerCase().trim() : '';

    // Predefined suggestions
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

    // Return predefined suggestions if no query
    if (!query) {
      return res.status(200).json(predefinedSuggestions.slice(0, 5));
    }

    // Check cache
    const cacheKey = `suggest:${query}`;
    const cachedSuggestions = suggestionCache.get(cacheKey);
    if (cachedSuggestions) {
      console.log('Serving suggestions from cache:', query);
      return res.status(200).json(cachedSuggestions);
    }

    // Generate suggestions with OpenAI
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

    // Parse and extract suggestions array
    const responseData = JSON.parse(response.choices[0].message.content);
    let suggestions = Array.isArray(responseData.suggestions) ? responseData.suggestions : [];

    if (!Array.isArray(suggestions)) {
      console.error('OpenAI response is not an array:', responseData);
      suggestions = [];
    }

    // Fetch popular terms from businesses collection
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

    // Filter and rank suggestions
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

    // Cache suggestions
    suggestionCache.set(cacheKey, suggestions);
    console.log('Generated suggestions:', suggestions);

    res.status(200).json(suggestions);
  } catch (error) {
    console.error('Suggest error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Keyword-based search
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
    /* ────────── 1. basic input ────────── */
    const { q } = req.query;
    if (!q) return res.status(400).json({ message: 'Query required' });

    const query = q.toLowerCase().trim();
    const terms = query.split(' ').filter(t => t.length > 2);

    /* ────────── 2. light NLP filters ────────── */
    let location = '';
    const locationMatch = query.match(/in\s+([a-z\s]+)$/i);
    if (locationMatch) {
      location = locationMatch[1].trim();
    } else if (['texas', 'california', 'new york', 'florida'].includes(query)) {
      location = query;
    }

    let priceFilter = {};
    const priceMatch = query.match(/under\s+(\d+\.?\d*)\s*(k|m)/i);
    if (priceMatch) {
      const num  = parseFloat(priceMatch[1]);
      const mult = priceMatch[2].toLowerCase() === 'm' ? 1_000_000 : 1_000;
      priceFilter = { price: { $lte: num * mult } };
    }

    const booleanFilters = [];
    if (query.includes('distressed'))       booleanFilters.push({ distressed: true });
    if (query.includes('owner absentee') ||
        query.includes('absentee'))         booleanFilters.push({ ownerAbsentee: true });
    if (query.includes('sba') ||
        query.includes('approved'))         booleanFilters.push({ sbaPreApproved: true });
    if (query.includes('brick and mortar')) booleanFilters.push({ brickAndMortar: true });
    if (query.includes('seller financing')) booleanFilters.push({ sellerFinancing: true });
    if (query.includes('zero down'))        booleanFilters.push({ zeroDown: true });

    /* ────────── 3. embed the query ────────── */
    const { data } = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: query
    });
    const queryVector = data[0].embedding;

    /* ────────── 4. vector search pipeline ────────── */
    const pipeline = [
      {
        $vectorSearch: {
          index: 'vector_index',                 // Atlas Vector Search index
          path:  'descriptionEmbedding',
          queryVector,
          limit: 100,                            // how many to return
          numCandidates: 400,                    // 4×limit is a good default
          filter: {
            ...priceFilter,
            ...(location && { 'location.state': { $regex: location, $options: 'i' } }),
            ...(booleanFilters.length && { $and: booleanFilters })
          }
        }
      },
      { $addFields: { score: { $meta: 'vectorSearchScore' } } },
      { $sort: { score: -1, _id: 1 } },
      { $limit: 100 },
      {
        $project: {
          businessId: 1,
          name: 1,
          sector: 1,
          price: 1,
          revenue: 1,
          cashFlow: 1,
          location: 1,
          description: { $substr: ['$description', 0, 1000] },
          scrapedData: { detailUrl: 1 },
          sourceContent: {
            financials: 1,
            detailedInfo: 1,
            content: { $substr: ['$sourceContent.content', 0, 1000] }
          },
          distressed: 1,
          ownerAbsentee: 1,
          sbaPreApproved: 1,
          sellerFinancing: 1,
          zeroDown: 1,
          brickAndMortar: 1,
          score: 1
        }
      }
    ];

    const businesses = await Business.aggregate(pipeline).exec();
    res.status(200).json(businesses);
  } catch (err) {
    console.error('AI-search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Save a deal
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

// Get saved deals
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

// Unsave a deal
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

// Save or update user preferences
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

// Get user preferences
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

// Get "For You" matched deals
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

// Check matches for new listings
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

// Generate SWOT analysis and benchmarks
router.post('/swot-analysis', authMiddleware, async (req, res) => {
  try {
    const { businessId } = req.body;
    if (!businessId) return res.status(400).json({ message: 'Business ID required' });

    const business = await Business.findOne({ businessId }).lean();
    if (!business) return res.status(404).json({ message: 'Business not found' });

    // Check if cached analysis exists
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

    // Fetch competitors
    const competitors = await Business.find({
      sector: business.sector,
      price: { $gte: business.price * 0.5, $lte: business.price * 1.5 },
      businessId: { $ne: businessId }
    }).limit(3).lean();

    let sourceContent = business.sourceContent?.content || '';
    let financials = business.sourceContent?.financials || [];
    let detailedInfo = business.sourceContent?.detailedInfo || [];
    let useFallback = false;

    // Scrape source page if no cached content or cache is older than 7 days
    if (!sourceContent || !business.sourceContent?.scrapedAt || (new Date() - new Date(business.sourceContent.scrapedAt)) > 7 * 24 * 60 * 60 * 1000) {
      let attempt = 0;
      const maxRetries = 3;
      while (attempt < maxRetries) {
        try {
          if (business.scrapedData?.source === 'BizBuySell') {
            // Use Axios + Cheerio for BizBuySell
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

            // Extract financial data
            financials = [];
            $('.financials p').each((_, el) => {
              const key = $(el).find('.title').text().trim();
              let value = $(el).find('.normal').text().trim().replace(/[^0-9.$]/g, '');
              if (key && value && !['N/A', 'Not Disclosed'].includes(value)) {
                if (key === 'Rent') value = value.replace(' per Month', '');
                financials.push({ key, value });
              }
            });

            // Extract detailed information
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
            // Use Axios + Cheerio for Sunbelt Network
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

            // Extract financials
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

            // Extract detailed information
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

            // Extract from description
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
            // Use Axios + Cheerio for Flippa
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

            // Extract financials from #properties-summary
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

            // Extract detailed information from #properties-summary
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

            // Extract from description
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
            // Puppeteer for other sources
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

          // Cache the scraped content
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

    // Use existing data if scrape failed
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

    // Generate AI content
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
          "threats": "...  }
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

    // Generate AI description
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

    // Cache the analysis and description
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

// Contact form submission
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