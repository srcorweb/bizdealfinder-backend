const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AnonymizeUAPlugin = require('puppeteer-extra-plugin-anonymize-ua');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const { OpenAI } = require('openai');
const mongoose = require('mongoose');
const fs = require('fs').promises;
require('dotenv').config();

puppeteer.use(StealthPlugin());
puppeteer.use(AnonymizeUAPlugin());
const Business = require('../models/business');
const UserPreferences = require('../models/userPreferences');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch free proxies from proxyscrape.com
async function getFreeProxy() {
  try {
    const response = await axios.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=yes&anonymity=all', { timeout: 10000 });
    const proxies = response.data.split('\r\n').filter(p => p);
    return proxies.length > 0 ? `http://${proxies[Math.floor(Math.random() * proxies.length)]}` : null;
  } catch (err) {
    console.error('Error fetching free proxy from proxyscrape:', err.message);
    try {
      const response = await axios.get('https://free-proxy-list.net/', { timeout: 10000 });
      const $ = cheerio.load(response.data);
      const proxies = [];
      $('#proxylisttable tr').each((_, el) => {
        const ip = $(el).find('td:nth-child(1)').text();
        const port = $(el).find('td:nth-child(2)').text();
        const https = $(el).find('td:nth-child(7)').text();
        if (ip && port && https === 'yes') {
          proxies.push(`http://${ip}:${port}`);
        }
      });
      return proxies.length > 0 ? proxies[Math.floor(Math.random() * proxies.length)] : null;
    } catch (err) {
      console.error('Error fetching free proxy from free-proxy-list:', err.message);
      return null;
    }
  }
}

// Function to check if business already exists in database
const checkBusinessExists = async (businessId) => {
  try {
    const exists = await Business.findOne({ businessId }).select('businessId').lean();
    return !!exists;
  } catch (err) {
    console.error('Error checking business existence:', err.message);
    return false;
  }
};

// Function to batch check multiple businesses
const batchCheckBusinessExists = async (businessIds) => {
  try {
    const existingBusinesses = await Business.find({ 
      businessId: { $in: businessIds } 
    }).select('businessId').lean();
    
    const existingIds = new Set(existingBusinesses.map(b => b.businessId));
    return businessIds.map(id => existingIds.has(id));
  } catch (err) {
    console.error('Error batch checking business existence:', err.message);
    return businessIds.map(() => false);
  }
};

const scrapeBusinesses = async () => {
  let browser;
  try {
    console.log('Connecting to MongoDB...');
    const uri = process.env.DB_DATABASE || 'mongodb://localhost:27017/bizdeal';
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    console.log(`MongoDB connected to ${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.db.databaseName}`);

    const systemPrompt = `Extract structured data from HTML of a business listing detail page. This is a DETAIL PAGE scrape, so extract comprehensive information. Return a JSON object with:
    - businessId: string (full detail URL, e.g., "https://www.bizbuysell.com/...", prepend "https://www.bizbuysell.com" for BizBuySell, "https://dealstream.com" for DealStream, "https://www.sunbeltnetwork.com" for Sunbelt Network, "https://us.businessesforsale.com" for BusinessForSale, "https://flippa.com" for Flippa),
    - name: string (business title),
    - price: number (USD, 0 if "Not Disclosed"/"On request"/"N/A"/"Confidential", min of ranges, e.g., "$100k-$200k" -> 100000, convert "m" to millions, e.g., "$30m" -> 30000000),
    - revenue: number (USD, 0 if "Not Disclosed"/"Not applicable"/"N/A"/"On request"/"Confidential", min of ranges, convert monthly to annual if explicitly specified, e.g., "$3,275 p/mo" -> 39300, convert "m" to millions, e.g., "$36.829m" -> 36829000),
    - cashFlow: number (USD, 0 if "Not Disclosed"/"N/A"/"Confidential", treat as monthly, e.g., "$9m" -> 9000000, "$4,417" -> 4417, convert "m" to millions),
    - location: { city: string, state: string } (default "Unknown" if missing or "Confidential"; convert two-letter state codes to full names, e.g., "FL" -> "Florida", using: AL->Alabama, AK->Alaska, AZ->Arizona, AR->Arkansas, CA->California, CO->Colorado, CT->Connecticut, DE->Delaware, FL->Florida, GA->Georgia, HI->Hawaii, ID->Idaho, IL->Illinois, IN->Indiana, IA->Iowa, KS->Kansas, KY->Kentucky, LA->Louisiana, ME->Maine, MD->Maryland, MA->Massachusetts, MI->Michigan, MN->Minnesota, MS->Mississippi, MO->Missouri, MT->Montana, NE->Nebraska, NV->Nevada, NH->New Hampshire, NJ->New Jersey, NM->New Mexico, NY->New York, NC->North Carolina, ND->North Dakota, OH->Ohio, OK->Oklahoma, OR->Oregon, PA->Pennsylvania, RI->Rhode Island, SC->South Carolina, SD->South Dakota, TN->Tennessee, TX->Texas, UT->Utah, VT->Vermont, VA->Virginia, WA->Washington, WV->West Virginia, WI->Wisconsin, WY->Wyoming; for DealStream/Sunbelt Network/BusinessForSale/Flippa, set city to "Unknown" and use state name if location is a US state, else discard non-USA listings),
    - sbaPreApproved: boolean (true if text includes "SBA pre-approved", "SBA approved", "SBA loan eligible", "SBA financing available", "SBA Prequalified: Yes", case-insensitive),
    - sellerFinancing: boolean (true if text includes "Financing Available", "owner financed", "seller financing", "owner financing", "financing by owner", "seller offers payment plan", "owner will finance", case-insensitive),
    - zeroDown: boolean (true if text includes "zero down", "no down payment", "no upfront payment", "full financing available", "0% down", "no initial payment", case-insensitive),
    - distressed: boolean (true if text includes "distressed", "urgent sale", "must sell", "quick sale needed", "motivated seller", "liquidation", case-insensitive),
    - ownerAbsentee: boolean (true if text includes "absentee", "owner absentee", "runs itself", "passive income", "owner not involved", "managed remotely", case-insensitive),
    - brickAndMortar: boolean (true unless text explicitly mentions "online", "e-commerce", "digital business", case-insensitive),
    - sector: string (strictly choose from: Agriculture, Energy, Engineering, Food, Franchise Resales, Leisure, Manufacturing, Online, Real Estate, Retail, Services, Tech & Media, Wholesale & Distribution; intelligently infer from the title and description, prioritizing explicit terms in the title (e.g., "manufacturing" in "Imprinted Sportswear and Manufacturing Business" -> Manufacturing) and contextual clues in the description (e.g., production, printing, apparel fabrication); use the following keyword mappings and reason about the business type, ensuring strict adherence to the defined sectors (e.g., map "E-Commerce" or "ecommerce" to Online, not E-Commerce):
      - Agriculture: "agriculture", "farming", "livestock", "crop", "agribusiness"
      - Energy: "energy", "solar", "oil", "gas", "renewable", "utility"
      - Engineering: "engineering", "construction", "design", "architecture", "civil", "roofing", "storm restoration"
      - Food: "restaurant", "cafe", "diner", "bakery", "Italian restaurant", "food truck", "catering", "coffee shop"
      - Franchise Resales: "franchise", "franchised", "chain"
      - Leisure: "hotel", "tourism", "recreation", "gym", "spa", "entertainment", "powersports"
      - Manufacturing: "manufacturing", "production", "imprinted", "sportswear", "apparel", "textile", "printing", "fabrication", "assembly"
      - Online: "ecommerce", "E-Commerce", "online business", "digital", "website", "app", "software platform", "online auction", "auction platform"
      - Real Estate: "real estate", "property management", "realty", "housing"
      - Retail: "sporting goods", "apparel", "home decor", "shops", "stores", "retail", "boutique", "jewelry", "powersports dealer", "car rental", "auto repair", "towing", "dealership"
      - Services: "consulting", "cleaning", "landscaping", "legal", "accounting", "home health", "healthcare agency"
      - Tech & Media: "software", "tech", "consumer brand", "electronics", "media", "advertising", "circuit", "technology"
      - Wholesale & Distribution: "wholesale", "distribution", "supply chain", "logistics"
      Examples:
      - "Imprinted Sportswear and Manufacturing Business" -> Manufacturing
      - "Profitable, Well Established, Online Auction" -> Online
      - "Home Health Agency in Los Angeles County" -> Services
      - "CircuitScribe" (consumer brand) -> Tech & Media
      - "Island Outfitters" (sporting goods retail) -> Retail
      - "Italian restaurant" -> Food
      - "Premier Roofing and Storm Restoration Services Company" -> Engineering
      - "Premier Platform Powersports Dealer Group" -> Retail
      - "Car Rental Business for Sale, Auto Repair / Towing / Dealership" -> Retail
      Default to Services only as a last resort when no sector is reasonably inferred.
    - description: string (full business description from detail page, up to 2000 characters, default "No description available" if missing),
    - sourceContent: {
        content: string (full HTML content for caching, truncated to 50000 chars),
        scrapedAt: Date (current timestamp),
        financials: array of objects with key/value pairs for financial metrics like [{"key": "Asking Price", "value": "$175,000"}, {"key": "Revenue", "value": "$519,928"}, {"key": "Cash Flow", "value": "$99,812"}, {"key": "Down Payment", "value": "$50,000"}, {"key": "EBITDA", "value": "$120,000"}],
        detailedInfo: array of objects with key/value pairs for business details like [{"key": "Years Established", "value": "15"}, {"key": "Employees", "value": "8"}, {"key": "Hours of Operation", "value": "Mon-Fri 9-5"}]
      },
    - scrapedData: { source: string, priceText: string, revenueText: string, detailUrl: string }.

    IMPORTANT: Extract comprehensive financial and business details from the FULL DETAIL PAGE content. Look for:
    - Financial sections with asking price, revenue, cash flow, EBITDA, down payment, etc.
    - Business operation details like years established, employees, hours, lease terms
    - Complete business description and opportunity details
    - Equipment, inventory, and asset information

    For cash flow extraction:
    - Sunbelt Network: Extract from financial sections and ".latestBusinesses__values--box" 
    - BizBuySell: Extract from ".financials p" sections and detail financial tables
    - Flippa: Extract from "#properties-summary" and financial metrics sections
    - DealStream: Extract from financial information sections and deal details
    - BusinessForSale: Extract from financial details and business information sections
    Treat cash flow as monthly unless explicitly annual. Convert "m" to millions, "k" to thousands.

    For BizBuySell, prepend "https://www.bizbuysell.com" to relative URLs. For DealStream, prepend "https://dealstream.com". For Sunbelt Network, prepend "https://www.sunbeltnetwork.com". For BusinessForSale, prepend "https://us.businessesforsale.com". For Flippa, prepend "https://flippa.com". Discard non-USA listings for DealStream, Sunbelt Network, BusinessForSale, and Flippa by checking if location includes a US state or "United States". Use defaults: 0 for numbers, false for booleans, "Unknown" for strings, "Services" for sector only as a last resort. Return JSON only, no markdown. Log the extracted JSON for debugging.`;

    const allListings = [];
    const maxPages = 1;
    const maxRetries = 1;

    // Array of site scraping functions to process sequentially
    const siteScrapers = [
      {
        name: 'BusinessForSale',
        scrape: async () => {
          browser = await puppeteer.launch({
            headless: 'new',
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-blink-features=AutomationControlled',
              '--disable-web-security',
              '--disable-features=IsolateOrigins,site-per-process',
            ],
            protocolTimeout: 120000
          });

          try {
            for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
              const bfsUrl = pageNum === 1 ? 'https://us.businessesforsale.com/us/search/businesses-for-sale' : `https://us.businessesforsale.com/us/search/businesses-for-sale-${pageNum}`;
              console.log(`Scraping BusinessForSale page ${pageNum}: ${bfsUrl}`);
              let attempt = 0;
              let success = false;

              while (attempt < maxRetries && !success) {
                const page = await browser.newPage();
                const userAgents = [
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0'
                ];
                const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
                await page.setUserAgent(userAgent);
                await page.setViewport({ width: 1280, height: 800 });

                await page.evaluateOnNewDocument(() => {
                  Object.defineProperty(navigator, 'webdriver', { get: () => false });
                  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
                  window.chrome = { runtime: {} };
                });

                const proxy = await getFreeProxy();
                if (proxy) {
                  console.log(`Using proxy for attempt ${attempt + 1}: ${proxy}`);
                  await page.setExtraHTTPHeaders({ 'Proxy-Server': proxy });
                } else {
                  console.log(`No proxy available for attempt ${attempt + 1}`);
                }

                try {
                  await page.goto(bfsUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                  await page.evaluate(() => {
                    window.scrollTo(0, Math.random() * 1000);
                    const x = Math.random() * 500;
                    const y = Math.random() * 500;
                    document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
                  });
                  await sleep(2000 + Math.random() * 3000);

                  const isVerificationPresent = await page.evaluate(() => {
                    return document.querySelector('title')?.innerText.includes('Just a moment...') ||
                           document.querySelector('#cf-challenge, .cf-please-wait, [id*="captcha"], [class*="captcha"]');
                  });
                  if (isVerificationPresent) {
                    console.log(`Verification screen detected on BusinessForSale page ${pageNum}, attempt ${attempt + 1}`);
                    await page.screenshot({ path: `bfs-verification-page${pageNum}-attempt${attempt + 1}.png` });
                    throw new Error('Verification screen detected');
                  }

                  await page.waitForSelector('.result', { timeout: 60000 });
                  success = true;

                  const bfsSnippets = await page.evaluate(() => {
                    const snippets = [];
                    document.querySelectorAll('.result').forEach(el => {
                      const detailUrl = el.querySelector('a')?.href || '';
                      const fullUrl = detailUrl.startsWith('http') ? detailUrl : `https://us.businessesforsale.com${detailUrl}`;
                      snippets.push({ html: el.innerHTML, detailUrl: fullUrl });
                    });
                    return snippets;
                  });
                  console.log(`Found ${bfsSnippets.length} BusinessForSale listings on page ${pageNum}`);

                  const allDetailUrls = bfsSnippets.map(snippet => snippet.detailUrl);
                  const existsResults = await batchCheckBusinessExists(allDetailUrls);

                  let processedCount = 0;
                  let skippedCount = 0;


                  for (let i = 0; i < bfsSnippets.length; i++) {
                    const { html, detailUrl } = bfsSnippets[i];
                    const businessExists = existsResults[i];
                    
                    if (businessExists) {
                      console.log(`⏭️  Skipping existing business: ${detailUrl}`);
                      skippedCount++;
                      continue;
                    }

                    let detailPage;
                    try {
                      detailPage = await browser.newPage();
                      const userAgents = [
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0'
                      ];
                      const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
                      await detailPage.setUserAgent(userAgent);
                      await detailPage.setViewport({ width: 1280, height: 800 });

                      await detailPage.evaluateOnNewDocument(() => {
                        Object.defineProperty(navigator, 'webdriver', { get: () => false });
                        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
                        window.chrome = { runtime: {} };
                      });
                      
                      console.log(`Fetching BusinessForSale detail page: ${detailUrl}`);
                      await detailPage.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                      
                      await detailPage.evaluate(() => {
                        window.scrollTo(0, Math.random() * 1000);
                        const x = Math.random() * 500;
                        const y = Math.random() * 500;
                        document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
                      });
                      await sleep(2000 + Math.random() * 3000);
                      
                      const detailContent = await detailPage.content();
                      
                      let processedContent = detailContent;
                      if (processedContent.length > 50000) {
                        processedContent = processedContent.substring(0, 50000) + '...';
                      }

                      const aiResp = await openai.chat.completions.create({
                        model: 'gpt-4o-mini',
                        messages: [
                          { role: 'system', content: systemPrompt },
                          { role: 'user', content: processedContent }
                        ],
                        response_format: { type: 'json_object' }
                      });
                      const listing = JSON.parse(aiResp.choices[0].message.content);
                      listing.scrapedData.source = 'BusinessForSale';
                      listing.scrapedData.detailUrl = detailUrl || listing.scrapedData.detailUrl;
                      listing.businessId = detailUrl || listing.businessId;

                      if (!listing.sourceContent) {
                        listing.sourceContent = {
                          content: detailContent,
                          scrapedAt: new Date(),
                          financials: [],
                          detailedInfo: []
                        };
                      }

                      console.log(`Extracted BusinessForSale listing: ${listing.businessId}, sector: ${listing.sector}, cashFlow: ${listing.cashFlow}, financials: ${listing.sourceContent?.financials?.length || 0}`);
                      allListings.push(listing);

                      processedCount++;
                      await sleep(3000 + Math.random() * 2000);
                    } catch (err) {
                      console.error(`BusinessForSale parse error for ${detailUrl}:`, err.message);
                    } finally {
                      if (detailPage) await detailPage.close();
                    }
                  }
                } catch (err) {
                  console.error(`BusinessForSale load/error on page ${pageNum}, attempt ${attempt + 1}:`, err.message);
                  const content = await page.content();
                  console.log(`Page content snippet: ${content.substring(0, 500)}...`);
                  await page.screenshot({ path: `bfs-error-page${pageNum}-attempt${attempt + 1}.png` });
                  if (attempt < maxRetries - 1) {
                    console.log(`Retrying BusinessForSale page ${pageNum} with delay...`);
                    await sleep(5000 * Math.pow(2, attempt));
                  } else {
                    console.log(`Max retries reached for BusinessForSale page ${pageNum}. Skipping to next site...`);
                    throw new Error(`Failed to scrape BusinessForSale page ${pageNum} after ${maxRetries} attempts`);
                  }
                  attempt++;
                } finally {
                  await page.close();
                }
              }
              await sleep(10000);
            }
          } finally {
            if (browser) await browser.close();
            browser = null;
          }
        }
      },
      {
        name: 'DealStream',
        scrape: async () => {
          browser = await puppeteer.launch({
            headless: 'new',
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-blink-features=AutomationControlled',
              '--disable-web-security',
              '--disable-features=IsolateOrigins,site-per-process',
            ],
            protocolTimeout: 120000
          });

          try {
            for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
              const dsUrl = pageNum === 1 ? 'https://dealstream.com/search?location=United+States' : `https://dealstream.com/businesses-for-sale/${pageNum}`;
              console.log(`Scraping DealStream page ${pageNum}: ${dsUrl}`);
              let attempt = 0;
              let success = false;

              while (attempt < maxRetries && !success) {
                const page = await browser.newPage();
                const userAgents = [
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0'
                ];
                const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
                await page.setUserAgent(userAgent);
                await page.setViewport({ width: 1280, height: 800 });

                await page.evaluateOnNewDocument(() => {
                  Object.defineProperty(navigator, 'webdriver', { get: () => false });
                  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
                  window.chrome = { runtime: {} };
                });

                const proxy = await getFreeProxy();
                if (proxy) {
                  console.log(`Using proxy for attempt ${attempt + 1}: ${proxy}`);
                  await page.setExtraHTTPHeaders({ 'Proxy-Server': proxy });
                } else {
                  console.log(`No proxy available for attempt ${attempt + 1}`);
                }

                try {
                  await page.goto(dsUrl, { waitUntil: 'networkidle0', timeout: 60000 });
                  await page.evaluate(() => {
                    window.scrollTo(0, Math.random() * 1000);
                    const x = Math.random() * 500;
                    const y = Math.random() * 500;
                    document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
                  });
                  await sleep(2000 + Math.random() * 3000);

                  const isVerificationPresent = await page.evaluate(() => {
                    return document.querySelector('title')?.innerText.includes('Just a moment...') ||
                           document.querySelector('#cf-challenge, .cf-please-wait, [id*="captcha"], [class*="captcha"]');
                  });
                  if (isVerificationPresent) {
                    console.log(`Verification screen detected on DealStream page ${pageNum}, attempt ${attempt + 1}`);
                    await page.screenshot({ path: `dealstream-verification-page${pageNum}-attempt${attempt + 1}.png` });
                    throw new Error('Verification screen detected');
                  }

                  await page.waitForSelector('a.list-group-item.post', { timeout: 60000 });
                  success = true;

                  const dsSnippets = await page.evaluate(() => {
                    const snippets = [];
                    const usStates = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming", "United States"];
                    document.querySelectorAll('a.list-group-item.post').forEach(el => {
                      const location = el.querySelector('div.h4')?.innerText.trim() || '';
                      if (usStates.some(state => location.includes(state))) {
                        const detailUrl = el.getAttribute('href') || '';
                        const fullUrl = detailUrl.startsWith('http') ? detailUrl : `https://dealstream.com${detailUrl}`;
                        snippets.push({ html: el.innerHTML, detailUrl: fullUrl });
                      }
                    });
                    return snippets;
                  });
                  console.log(`Found ${dsSnippets.length} DealStream listings on page ${pageNum}`);

                  const allDetailUrls = dsSnippets.map(snippet => snippet.detailUrl);
                  const existsResults = await batchCheckBusinessExists(allDetailUrls);

                  let processedCount = 0;
                  let skippedCount = 0;

                  for (let i = 0; i < dsSnippets.length; i++) {
                    const { html, detailUrl } = dsSnippets[i];
                    const businessExists = existsResults[i];
                    
                    if (businessExists) {
                      console.log(`⏭️  Skipping existing business: ${detailUrl}`);
                      skippedCount++;
                      continue;
                    }

                    let detailPage;
                    try {
                      detailPage = await browser.newPage();
                      await detailPage.setUserAgent(userAgent);
                      await detailPage.setViewport({ width: 1280, height: 800 });
                      console.log(`Fetching detail page: ${detailUrl}`);
                      await detailPage.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                      const detailContent = await detailPage.content();
                      let processedContent = detailContent;
                      if (processedContent.length > 50000) {
                        processedContent = processedContent.substring(0, 50000) + '...';
                      }

                      const aiResp = await openai.chat.completions.create({
                        model: 'gpt-4o-mini',
                        messages: [
                          { role: 'system', content: systemPrompt },
                          { role: 'user', content: processedContent }
                        ],
                        response_format: { type: 'json_object' }
                      });
                      const listing = JSON.parse(aiResp.choices[0].message.content);
                      listing.scrapedData.source = 'DealStream';
                      listing.scrapedData.detailUrl = detailUrl || listing.scrapedData.detailUrl;
                      listing.businessId = detailUrl || listing.businessId;

                      if (!listing.sourceContent) {
                        listing.sourceContent = {
                          content: detailContent,
                          scrapedAt: new Date(),
                          financials: [],
                          detailedInfo: []
                        };
                      }

                      console.log(`Extracted listing: ${listing.businessId}, sector: ${listing.sector}, cashFlow: ${listing.cashFlow}, financials: ${listing.sourceContent?.financials?.length || 0}`);
                      allListings.push(listing);
                      processedCount++;
                      await sleep(3000);
                    } catch (err) {
                      console.error(`DealStream parse error for ${detailUrl}:`, err.message);
                    } finally {
                      if (detailPage) await detailPage.close();
                    }
                  }
                } catch (err) {
                  console.error(`DealStream load/error on page ${pageNum}, attempt ${attempt + 1}:`, err.message);
                  const content = await page.content();
                  console.log(`Page content snippet: ${content.substring(0, 500)}...`);
                  await page.screenshot({ path: `dealstream-error-page${pageNum}-attempt${attempt + 1}.png` });
                  if (attempt < maxRetries - 1) {
                    console.log(`Retrying DealStream page ${pageNum} with delay...`);
                    await sleep(5000 * Math.pow(2, attempt));
                  } else {
                    console.log(`Max retries reached for DealStream page ${pageNum}. Skipping to next site...`);
                    throw new Error(`Failed to scrape DealStream page ${pageNum} after ${maxRetries} attempts`);
                  }
                  attempt++;
                } finally {
                  await page.close();
                }
              }
              await sleep(10000);
            }
          } finally {
            if (browser) await browser.close();
            browser = null;
          }
        }
      },
      // {
      //   name: 'BizBuySell',
      //   scrape: async () => {
      //     for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      //       const url = pageNum === 1 ? 'https://www.bizbuysell.com/businesses-for-sale/' : `https://www.bizbuysell.com/businesses-for-sale/${pageNum}/`;
      //       console.log(`Fetching BizBuySell page ${pageNum}: ${url}`);
      //       try {
      //         const httpsAgent = new https.Agent({ ALPNProtocols: ['http/1.1'] });
      //         const safariAgents = [
      //           'Safari/17612.3.14.1.6 CFNetwork/1327.0.4 Darwin/21.2.0'
      //         ];
      //         const userAgent = safariAgents[Math.floor(Math.random() * safariAgents.length)];
      //         const start = Date.now();
      //         const response = await axios.get(url, {
      //           httpsAgent,
      //           timeout: 30000,
      //           headers: { 'User-Agent': userAgent }
      //         });
      //         const elapsed = ((Date.now() - start) / 1000).toFixed(4);
      //         console.log(`status=${response.status}, elapsed_time=${elapsed}s, url=${url}`);

      //         const $ = cheerio.load(response.data);
      //         const snippets = [];
      //         $('app-listing-diamond').each((_, el) => {
      //           const detailUrl = $(el).find('a').attr('href') || '';
      //           const fullUrl = detailUrl.startsWith('http') ? detailUrl : `https://www.bizbuysell.com${detailUrl}`;
      //           snippets.push({ html: $.html(el), detailUrl: fullUrl });
      //         });
      //         console.log(`Found ${snippets.length} BizBuySell listings on page ${pageNum}`);

      //         const allDetailUrls = snippets.map(snippet => snippet.detailUrl);
      //         const existsResults = await batchCheckBusinessExists(allDetailUrls);

      //         let processedCount = 0;
      //         let skippedCount = 0;

      //         for (let i = 0; i < snippets.length; i++) {
      //           const { html, detailUrl } = snippets[i];
      //           const businessExists = existsResults[i];
                
      //           if (businessExists) {
      //             console.log(`⏭️  Skipping existing business: ${detailUrl}`);
      //             skippedCount++;
      //             continue;
      //           }

      //           try {
      //             let detailContent = '';
      //             try {
      //               console.log(`Fetching detail page: ${detailUrl}`);
      //               processedCount++;
      //               const detailResponse = await axios.get(detailUrl, {
      //                 httpsAgent,
      //                 timeout: 30000,
      //                 headers: { 'User-Agent': userAgent }
      //               });
      //               detailContent = detailResponse.data;
      //               console.log(`Detail page fetched successfully for ${detailUrl}`);
      //             } catch (detailErr) {
      //               console.error(`Failed to fetch detail page ${detailUrl}:`, detailErr.message);
      //               detailContent = html;
      //             }

      //             if (detailContent.length > 50000) {
      //               detailContent = detailContent.substring(0, 50000) + '...';
      //             }

      //             const aiResp = await openai.chat.completions.create({
      //               model: 'gpt-4o-mini',
      //               messages: [
      //                 { role: 'system', content: systemPrompt },
      //                 { role: 'user', content: detailContent }
      //               ],
      //               response_format: { type: 'json_object' }
      //             });
      //             const listing = JSON.parse(aiResp.choices[0].message.content);
      //             listing.scrapedData.source = 'BizBuySell';
      //             listing.scrapedData.detailUrl = detailUrl || listing.scrapedData.detailUrl;
      //             listing.businessId = detailUrl || listing.businessId;

      //             if (!listing.sourceContent) {
      //               listing.sourceContent = {
      //                 content: detailContent,
      //                 scrapedAt: new Date(),
      //                 financials: [],
      //                 detailedInfo: []
      //               };
      //             }
      //             console.log(`Extracted listing: ${listing.businessId}, sector: ${listing.sector}, cashFlow: ${listing.cashFlow}, financials: ${listing.sourceContent?.financials?.length || 0}`);
      //             allListings.push(listing);
      //             await sleep(2000);
      //           } catch (err) {
      //             console.error(`BizBuySell parse error on page ${pageNum}:`, err.message);
      //           }
      //         }
      //       } catch (err) {
      //         console.error(`Error fetching BizBuySell page ${pageNum}:`, err.message);
      //         console.log(`Skipping to next site due to BizBuySell page ${pageNum} failure`);
      //         throw new Error(`Failed to scrape BizBuySell page ${pageNum}`);
      //       }
      //       await sleep(5000);
      //     }
      //   }
      // },
      {
        name: 'Flippa',
        scrape: async () => {
          browser = await puppeteer.launch({
            headless: 'new',
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-blink-features=AutomationControlled',
              '--disable-web-security',
              '--disable-features=IsolateOrigins,site-per-process',
            ],
            protocolTimeout: 120000
          });
      
          try {
            for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
              let attempt = 0;
              let success = false;
              const flippaUrl = pageNum === 1 ? 'https://flippa.com/online-businesses-united-states' : `https://flippa.com/online-businesses-united-states?page%5Bnumber%5D=${pageNum}`;
              console.log(`Scraping Flippa page ${pageNum}: ${flippaUrl}`);
      
              while (attempt < maxRetries && !success) {
                const page = await browser.newPage();
                try {
                  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                  await page.setViewport({ width: 1280, height: 800 });
      
                  await page.goto(flippaUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
                  await page.waitForSelector('div[id^="listing-"]', { timeout: 90000 });
                  success = true;
      
                  const flipSnippets = await page.evaluate(() => {
                    const snippets = [];
                    document.querySelectorAll('div[id^="listing-"]').forEach(el => {
                      const detailUrl = el.querySelector('a')?.href || '';
                      snippets.push({ html: el.outerHTML, detailUrl });
                    });
                    return snippets;
                  });
                  console.log(`Found ${flipSnippets.length} Flippa listings on page ${pageNum}`);
      
                  const allDetailUrls = flipSnippets.map(snippet => snippet.detailUrl);
                  const existsResults = await batchCheckBusinessExists(allDetailUrls);

                  let processedCount = 0;
                  let skippedCount = 0;

                  for (const { html, detailUrl } of flipSnippets) {
                    const { html, detailUrl } = flipSnippets[i];
                    const businessExists = existsResults[i];
                    
                    if (businessExists) {
                      console.log(`⏭️  Skipping existing business: ${detailUrl}`);
                      skippedCount++;
                      continue;
                    }

                    let detailPage;
                    try {
                      detailPage = await browser.newPage();
                      await detailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                      await detailPage.setViewport({ width: 1280, height: 800 });

                      console.log(`Fetching Flippa detail page: ${detailUrl}`);
                      await detailPage.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 60000 });

                      const detailContent = await detailPage.content();

                      let processedContent = detailContent;
                      if (processedContent.length > 50000) {
                        processedContent = processedContent.substring(0, 50000) + '...';
                      }

                      const aiResp = await openai.chat.completions.create({
                        model: 'gpt-4o-mini',
                        messages: [
                          { role: 'system', content: systemPrompt },
                          { role: 'user', content: processedContent }
                        ],
                        response_format: { type: 'json_object' }
                      });
                      const listing = JSON.parse(aiResp.choices[0].message.content);
                      listing.scrapedData.source = 'Flippa';
                      listing.scrapedData.detailUrl = detailUrl || listing.scrapedData.detailUrl;
                      listing.businessId = detailUrl || listing.businessId;

                      if (!listing.sourceContent) {
                        listing.sourceContent = {
                          content: detailContent,
                          scrapedAt: new Date(),
                          financials: [],
                          detailedInfo: []
                        };
                      }

                      console.log(`Extracted Flippa listing: ${listing.businessId}, sector: ${listing.sector}, cashFlow: ${listing.cashFlow}, financials: ${listing.sourceContent?.financials?.length || 0}`);
                      allListings.push(listing);
                      processedCount++;
                      await sleep(4000);
                    } catch (err) {
                      console.error(`Flippa parse error for ${detailUrl} on page ${pageNum}:`, err.message);
                    } finally {
                      if (detailPage) await detailPage.close();
                    }
                  }
                } catch (err) {
                  console.error(`Flippa load/error on page ${pageNum}, attempt ${attempt + 1}:`, err.message);
                  if (attempt < maxRetries - 1) {
                    console.log(`Retrying Flippa page ${pageNum} with delay...`);
                    await sleep(5000 * Math.pow(2, attempt));
                  } else {
                    console.log(`Max retries reached for Flippa page ${pageNum}. Skipping to next site...`);
                    throw new Error(`Failed to scrape Flippa page ${pageNum} after ${maxRetries} attempts`);
                  }
                  attempt++;
                } finally {
                  await page.close();
                }
                await sleep(10000);
              }
            }
          } finally {
            if (browser) await browser.close();
            browser = null;
          }
        }
      },
      // {
      //   name: 'BizBuySell-SBA',
      //   scrape: async () => {
      //     for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      //       const url = pageNum === 1 ? 'https://www.bizbuysell.com/businesses-for-sale/?q=az1zYmE%3D' : `https://www.bizbuysell.com/businesses-for-sale/${pageNum}/?q=az1zYmE%3D`;
      //       console.log(`Fetching BizBuySell SBA page ${pageNum}: ${url}`);
      //       try {
      //         const httpsAgent = new https.Agent({ ALPNProtocols: ['http/1.1'] });
      //         const safariAgents = [
      //           'Safari/17612.3.14.1.6 CFNetwork/1327.0.4 Darwin/21.2.0'
      //         ];
      //         const userAgent = safariAgents[Math.floor(Math.random() * safariAgents.length)];
      //         const start = Date.now();
      //         const response = await axios.get(url, {
      //           httpsAgent,
      //           timeout: 30000,
      //           headers: { 'User-Agent': userAgent }
      //         });
      //         const elapsed = ((Date.now() - start) / 1000).toFixed(4);
      //         console.log(`status=${response.status}, elapsed_time=${elapsed}s, url=${url}`);

      //         const $ = cheerio.load(response.data);
      //         const snippets = [];

      //         console.log('Checking for different listing selectors...');
      //         const appListingShowcaseCount = $('app-listing-showcase').length;
      //         const appListingCount = $('app-listing-diamond').length;
      //         const listingItemCount = $('.listing-item').length;
      //         const businessCardCount = $('.business-card').length;

      //         console.log(`app-listing-showcase: ${appListingShowcaseCount}`);
      //         console.log(`app-listing-diamond: ${appListingCount}`);
      //         console.log(`listing-item: ${listingItemCount}`);
      //         console.log(`business-card: ${businessCardCount}`);

      //         const selectors = [
      //           { name: 'app-listing-showcase', selector: 'app-listing-showcase' },
      //           { name: 'app-listing-diamond', selector: 'app-listing-diamond' },
      //           { name: 'listing-showcase', selector: '.listing-showcase' },
      //           { name: 'listing-item', selector: '.listing-item' },
      //           { name: 'business-card', selector: '.business-card' },
      //           { name: 'result-item', selector: '.result-item' }
      //         ];

      //         let bestSelector = null;
      //         let maxCount = 0;

      //         for (const { name, selector } of selectors) {
      //           const count = $(selector).length;
      //           console.log(`${name}: ${count}`);
      //           if (count > maxCount) {
      //             maxCount = count;
      //             bestSelector = { name, selector };
      //           }
      //         }

      //         console.log(`Best selector found: ${bestSelector?.name} with ${maxCount} elements`);

      //         const businessLinks = $('a[href*="/business-opportunity/"], a[href*="/business/"]');
      //         console.log(`Found ${businessLinks.length} direct business links`);

      //         if (businessLinks.length > 0) {
      //           console.log('Using direct business links approach');
      //           bestSelector = { name: 'business-links', selector: 'a[href*="/business-opportunity/"], a[href*="/business/"]' };
      //           maxCount = businessLinks.length;
      //         } else if (maxCount === 0) {
      //           console.log('No standard selectors found, searching for elements with business links...');
      //           const linkElements = $('a[href*="/business-opportunity/"], a[href*="/business/"]');
      //           console.log(`Found ${linkElements.length} business links`);
                
      //           if (linkElements.length > 0) {
      //             bestSelector = { name: 'business-links', selector: 'a[href*="/business-opportunity/"], a[href*="/business/"]' };
      //             maxCount = linkElements.length;
      //           }
      //         }

      //         if (bestSelector && maxCount > 0) {
      //           console.log(`Using selector: ${bestSelector.name} (${bestSelector.selector})`);
                
      //           $(bestSelector.selector).each((_, el) => {
      //             let detailUrl = '';

      //             if (bestSelector.name === 'business-links') {
      //               detailUrl = $(el).attr('href') || '';
      //             } else if (bestSelector.name === 'app-listing-showcase') {
      //               detailUrl = $(el).find('a.showcase').attr('href') || $(el).find('a').attr('href') || '';
      //             } else {
      //               detailUrl = $(el).find('a').attr('href') || '';
      //             }
                  
      //             if (detailUrl && (detailUrl.includes('/business-opportunity/') || detailUrl.includes('/business/'))) {
      //               const fullUrl = detailUrl.startsWith('http') ? detailUrl : `https://www.bizbuysell.com${detailUrl}`;
      //               console.log(`Found valid business link: ${fullUrl}`);
      //               snippets.push({ html: $.html(el), detailUrl: fullUrl });
      //             }
      //           });
      //         }

      //         console.log(`Found ${snippets.length} BizBuySell SBA listings on page ${pageNum}`);

      //         const allDetailUrls = snippets.map(snippet => snippet.detailUrl);
      //         const existsResults = await batchCheckBusinessExists(allDetailUrls);

      //         let processedCount = 0;
      //         let skippedCount = 0;

      //         for (let i = 0; i < snippets.length; i++) {
      //           const { html, detailUrl } = snippets[i];
      //           const businessExists = existsResults[i];
                
      //           if (businessExists) {
      //             console.log(`⏭️  Skipping existing SBA business: ${detailUrl}`);
      //             skippedCount++;
      //             continue;
      //           }

      //           try {
      //             let detailContent = '';
      //             try {
      //               console.log(`Fetching BizBuySell SBA detail page: ${detailUrl}`);
      //               processedCount++;
      //               const detailResponse = await axios.get(detailUrl, {
      //                 httpsAgent,
      //                 timeout: 30000,
      //                 headers: { 'User-Agent': userAgent }
      //               });

      //               detailContent = detailResponse.data;
      //               console.log(`BizBuySell SBA detail page fetched successfully for ${detailUrl}`);

      //               const $detail = cheerio.load(detailContent);
      //               let extractedFinancials = {};

      //               $detail('.financials .specs p').each((_, el) => {
      //                 const $el = $detail(el);
      //                 const title = $el.find('.title').text().trim().toLowerCase();
      //                 const value = $el.find('.normal, .price').first().text().trim();

      //                 if (title.includes('asking price')) {
      //                   extractedFinancials.askingPrice = value;
      //                 } else if (title.includes('gross revenue')) {
      //                   extractedFinancials.grossRevenue = value;
      //                 } else if (title.includes('cash flow')) {
      //                   extractedFinancials.cashFlow = value;
      //                 } else if (title.includes('ebitda')) {
      //                   extractedFinancials.ebitda = value;
      //                 } else if (title.includes('established')) {
      //                   extractedFinancials.established = value;
      //                 }
      //               });

      //               let financialSummary = 'EXTRACTED FINANCIAL DATA:\n';
      //               Object.entries(extractedFinancials).forEach(([key, value]) => {
      //                 financialSummary += `${key}: ${value}\n`;
      //               });
      //               console.log('Extracted financials:', extractedFinancials);
      //             } catch (detailErr) {
      //               console.error(`Failed to fetch BizBuySell SBA detail page ${detailUrl}:`, detailErr.message);
      //               detailContent = html;
      //             }

      //             let processedContent = financialSummary + '\n\n' + detailContent;
      //             if (processedContent.length > 50000) {
      //               processedContent = processedContent.substring(0, 50000) + '...';
      //             }

      //             const aiResp = await openai.chat.completions.create({
      //               model: 'gpt-4o',
      //               messages: [
      //                 { role: 'system', content: systemPrompt },
      //                 { role: 'user', content: `Extract business information from this HTML. Pay special attention to financial metrics like Asking Price, Gross Revenue, Cash Flow (SDE), EBITDA, and Rent:\n\n${processedContent}` }
      //               ],
      //               response_format: { type: 'json_object' },
      //               temperature: 0.1
      //             });
      //             const listing = JSON.parse(aiResp.choices[0].message.content);

      //             if ((listing.revenue === 0 || listing.cashFlow === 0) && Object.keys(extractedFinancials).length > 0) {
      //               console.log('AI extraction missed financial data, using pre-extracted values...');
                    
      //               if (listing.revenue === 0 && extractedFinancials.grossRevenue) {
      //                 const revenueValue = extractedFinancials.grossRevenue.replace(/[$,]/g, '');
      //                 if (revenueValue && !isNaN(revenueValue)) {
      //                   listing.revenue = parseInt(revenueValue);
      //                   console.log(`Using pre-extracted revenue: $${listing.revenue}`);
      //                 }
      //               }
                    
      //               if (listing.cashFlow === 0 && extractedFinancials.cashFlow) {
      //                 const cashFlowValue = extractedFinancials.cashFlow.replace(/[$,]/g, '');
      //                 if (cashFlowValue && !isNaN(cashFlowValue)) {
      //                   listing.cashFlow = parseInt(cashFlowValue);
      //                   console.log(`Using pre-extracted cash flow: $${listing.cashFlow}`);
      //                 }
      //               }
                    
      //               if (listing.price === 0 && extractedFinancials.askingPrice) {
      //                 const priceValue = extractedFinancials.askingPrice.replace(/[$,]/g, '');
      //                 if (priceValue && !isNaN(priceValue)) {
      //                   listing.price = parseInt(priceValue);
      //                   console.log(`Using pre-extracted price: $${listing.price}`);
      //                 }
      //               }
      //             }

      //             if (!listing.scrapedData) {
      //               listing.scrapedData = {};
      //             }

      //             listing.scrapedData = {
      //               source: 'BizBuySell',
      //               detailUrl: detailUrl,
      //               priceText: extractedFinancials.askingPrice || 'Not found',
      //               revenueText: extractedFinancials.grossRevenue || 'Not found',
      //               cashFlowText: extractedFinancials.cashFlow || 'Not found'
      //             };
      //             listing.businessId = detailUrl || listing.businessId;
      //             listing.sbaPreApproved = true;

      //             if (!listing.sourceContent) {
      //               listing.sourceContent = {
      //                 content: detailContent,
      //                 scrapedAt: new Date(),
      //                 financials: [],
      //                 detailedInfo: []
      //               };
      //             }

      //             console.log(`Extracted BizBuySell SBA listing:`);
      //             console.log(`   Business ID: ${listing.businessId}`);
      //             console.log(`   Name: ${listing.name}`);
      //             console.log(`   Price: $${listing.price.toLocaleString()}`);
      //             console.log(`   Revenue: $${listing.revenue.toLocaleString()}`);
      //             console.log(`   Cash Flow: $${listing.cashFlow.toLocaleString()}`);
      //             console.log(`   Raw price text: ${listing.scrapedData?.priceText || 'N/A'}`);
      //             console.log(`   Raw revenue text: ${listing.scrapedData?.revenueText || 'N/A'}`);
      //             console.log(`   Location: ${listing.location.city}, ${listing.location.state}`);
      //             console.log(`   Sector: ${listing.sector}`);
      //             console.log(`   SBA Pre-approved: ${listing.sbaPreApproved}`);
      //             console.log(`   Financials count: ${listing.sourceContent?.financials?.length || 0}`);
      //             console.log('---');
      //             allListings.push(listing);
      //             await sleep(2000);
      //           } catch (err) {
      //             console.error(`BizBuySell SBA parse error on page ${pageNum}:`, err.message);
      //           }
      //         }
      //       } catch (err) {
      //         console.error(`Error fetching BizBuySell SBA page ${pageNum}:`, err.message);
      //         console.log(`Skipping to next site due to BizBuySell SBA page ${pageNum} failure`);
      //         throw new Error(`Failed to scrape BizBuySell SBA page ${pageNum}`);
      //       }
      //       await sleep(5000);
      //     }
      //   }
      // },
      {
        name: 'SunbeltNetwork',
        scrape: async () => {
          for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
            const url = pageNum === 1 ? 'https://www.sunbeltnetwork.com/business-search/business-results/' : `https://www.sunbeltnetwork.com/business-search/business-results/page/${pageNum}/`;
            console.log(`Fetching Sunbelt Network page ${pageNum}: ${url}`);
            try {
              const httpsAgent = new https.Agent({ ALPNProtocols: ['http/1.1'] });
              const safariAgents = [
                'Safari/17612.3.14.1.6 CFNetwork/1327.0.4 Darwin/21.2.0'
              ];
              const userAgent = safariAgents[Math.floor(Math.random() * safariAgents.length)];
              const start = Date.now();
              const response = await axios.get(url, {
                httpsAgent,
                timeout: 30000,
                headers: { 'User-Agent': userAgent }
              });
              const elapsed = ((Date.now() - start) / 1000).toFixed(4);
              console.log(`status=${response.status}, elapsed_time=${elapsed}s, url=${url}`);

              const $ = cheerio.load(response.data);
              const snippets = [];
              $('article.latestBusinesses__item').each((_, el) => {
                const detailUrl = $(el).find('a[href*="/listing-details/"]').attr('href') || '';
                const fullUrl = detailUrl.startsWith('http') ? detailUrl : `https://www.sunbeltnetwork.com${detailUrl}`;
                snippets.push({ html: $.html(el), detailUrl: fullUrl });
              });
              console.log(`Found ${snippets.length} Sunbelt Network listings on page ${pageNum}`);

              const allDetailUrls = snippets.map(snippet => snippet.detailUrl);
              const existsResults = await batchCheckBusinessExists(allDetailUrls);

              let processedCount = 0;
              let skippedCount = 0;

              for (let i = 0; i < snippets.length; i++) {
                const { html, detailUrl } = snippets[i];
                const businessExists = existsResults[i];
                
                if (businessExists) {
                  console.log(`⏭️  Skipping existing business: ${detailUrl}`);
                  skippedCount++;
                  continue;
                }

                try {
                  let detailContent = '';
                  try {
                    console.log(`Fetching Sunbelt Network detail page: ${detailUrl}`);
                    processedCount++;
                    const detailResponse = await axios.get(detailUrl, {
                      httpsAgent,
                      timeout: 30000,
                      headers: { 'User-Agent': userAgent }
                    });
                    detailContent = detailResponse.data;
                    console.log(`Sunbelt Network detail page fetched successfully for ${detailUrl}`);
                  } catch (detailErr) {
                    console.error(`Failed to fetch Sunbelt Network detail page ${detailUrl}:`, detailErr.message);
                    detailContent = html;
                  }

                  if (detailContent.length > 50000) {
                    detailContent = detailContent.substring(0, 50000) + '...';
                  }

                  const aiResp = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: [
                      { role: 'system', content: systemPrompt },
                      { role: 'user', content: detailContent }
                    ],
                    response_format: { type: 'json_object' }
                  });
                  const listing = JSON.parse(aiResp.choices[0].message.content);
                  listing.scrapedData.source = 'Sunbelt Network';
                  listing.scrapedData.detailUrl = detailUrl || listing.scrapedData.detailUrl;
                  listing.businessId = detailUrl || listing.businessId;

                  if (!listing.sourceContent) {
                    listing.sourceContent = {
                      content: detailContent,
                      scrapedAt: new Date(),
                      financials: [],
                      detailedInfo: []
                    };
                  }

                  console.log(`Extracted Sunbelt Network listing: ${listing.businessId}, sector: ${listing.sector}, cashFlow: ${listing.cashFlow}, financials: ${listing.sourceContent?.financials?.length || 0}`);
                  allListings.push(listing);

                  await sleep(3000);
                } catch (err) {
                  console.error(`Sunbelt Network parse error on page ${pageNum}:`, err.message);
                }
              }
            } catch (err) {
              console.error(`Error fetching Sunbelt Network page ${pageNum}:`, err.message);
              console.log(`Skipping to next site due to Sunbelt Network page ${pageNum} failure`);
              throw new Error(`Failed to scrape Sunbelt Network page ${pageNum}`);
            }
            await sleep(5000);
          }
        }
      }
    ];

    // Process each site sequentially, skipping to the next on failure
    for (const site of siteScrapers) {
      try {
        console.log(`Starting scrape for ${site.name}`);
        await site.scrape();
        console.log(`Completed scrape for ${site.name}`);
        console.log(`📊 ${site.name} Summary: ${processedCount || 0} new, ${skippedCount || 0} skipped`);
        await sleep(30000);
      } catch (err) {
        console.error(`Failed to scrape ${site.name}: ${err.message}. Moving to next site...`);
        if (browser) {
          await browser.close();
          browser = null;
        }
        await sleep(10000);
      }
    }

    // Save listings and match preferences
    console.log(`Saving ${allListings.length} listings...`);
    let savedCount = 0;
    const usersWithPreferences = await UserPreferences.find();
    console.log(`Found ${usersWithPreferences.length} user preferences`);
    for (const listing of allListings) {
      try {
        await Business.updateOne(
          { businessId: listing.businessId },
          { $set: listing },
          { upsert: true }
        );
        savedCount++;

        for (const pref of usersWithPreferences) {
          const matches = (
            (!pref.sector || listing.sector === pref.sector) &&
            (!pref.priceRange?.min || listing.price >= pref.priceRange.min) &&
            (!pref.priceRange?.max || listing.price <= pref.priceRange.max) &&
            (!pref.location?.city || listing.location.city === pref.location.city) &&
            (!pref.location?.state || listing.location.state === pref.location.state) &&
            (pref.distressed === true ? listing.distressed === true : true) &&
            (pref.ownerAbsentee === true ? listing.ownerAbsentee === true : true) &&
            (pref.sbaPreApproved === true ? listing.sbaPreApproved === true : true) &&
            (pref.sellerFinancing === true ? listing.sellerFinancing === true : true) &&
            (pref.zeroDown === true ? listing.zeroDown === true : true) &&
            (pref.brickAndMortar === true ? listing.brickAndMortar === true : true)
          );

          if (matches) {
            console.log(`Match found for user ${pref.userId}:`, listing.businessId);
            await Business.updateOne(
              { businessId: listing.businessId },
              { $addToSet: { matchedUsers: pref.userId } }
            );
          }
        }
      } catch (err) {
        console.error(`Upsert error for ${listing.businessId}:`, err.message);
      }
      await sleep(100);
    }
    console.log(`Saved ${savedCount}/${allListings.length} listings`);

    const totalDocs = await Business.countDocuments();
    console.log(`Total docs in collection: ${totalDocs}`);
  } catch (error) {
    console.error('Scrape run error:', error.message);
  } finally {
    if (browser) await browser.close();
    if (mongoose.connection.readyState) await mongoose.disconnect();
    console.log('Scrape run completed:', new Date().toISOString());
  }
};

// Function to scrape a single listing by URL
const scrapeSingleListing = async (url, source) => {
  let browser;
  try {
    console.log(`Scraping single listing from ${source}: ${url}`);
    
    const systemPrompt = `Extract structured data from HTML of a business listing detail page... [use the same systemPrompt from scrapeBusinesses function]`;

    let detailContent = '';
    let financials = [];
    let detailedInfo = [];

    if (source === 'BizBuySell') {
      const httpsAgent = new https.Agent({ ALPNProtocols: ['http/1.1'] });
      const response = await axios.get(url, {
        httpsAgent,
        timeout: 30000,
        headers: { 
          'User-Agent': 'Safari/17612.3.14.1.6 CFNetwork/1327.0.4 Darwin/21.2.0' 
        }
      });
      detailContent = response.data;
      
      const $ = cheerio.load(detailContent);
      
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

    } else if (source === 'Sunbelt Network') {
      const httpsAgent = new https.Agent({ rejectUnauthorized: false, maxVersion: 'TLSv1.2' });
      const response = await axios.get(url, {
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        httpsAgent
      });
      detailContent = response.data;
      
      const $ = cheerio.load(detailContent);
      
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

    } else if (source === 'Flippa' || source === 'DealStream' || source === 'BusinessForSale') {
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        protocolTimeout: 120000
      });
      
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      await page.setViewport({ width: 1280, height: 800 });
      
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      detailContent = await page.content();
      
      // Use extractMetricsFromDescription helper
      const $ = cheerio.load(detailContent);
      const description = $('body').text().trim();
      const descMetrics = await extractMetricsFromDescription(description);
      financials = descMetrics.filter(m => 
        ['Asking Price', 'Gross Revenue', 'Revenue', 'Cash Flow'].includes(m.key)
      );
      detailedInfo = descMetrics.filter(m => 
        !['Asking Price', 'Gross Revenue', 'Revenue', 'Cash Flow'].includes(m.key)
      );
      
      await browser.close();
      browser = null;
    }

    // Process with AI
    let processedContent = detailContent;
    if (processedContent.length > 50000) {
      processedContent = processedContent.substring(0, 50000) + '...';
    }

    const aiResp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: processedContent }
      ],
      response_format: { type: 'json_object' }
    });

    const listing = JSON.parse(aiResp.choices[0].message.content);
    listing.scrapedData.source = source;
    listing.scrapedData.detailUrl = url;
    listing.businessId = url;
    listing.sourceContent = {
      content: detailContent,
      scrapedAt: new Date(),
      financials,
      detailedInfo
    };

    console.log(`Successfully scraped listing: ${listing.name}`);
    return listing;

  } catch (error) {
    console.error('Single listing scrape error:', error);
    if (error.response?.status === 404) {
      throw new Error('Listing not found (404). Please check the URL.');
    }
    throw new Error(`Failed to scrape listing: ${error.message}`);
  } finally {
    if (browser) await browser.close();
  }
};

module.exports = { scrapeBusinesses, scrapeSingleListing };