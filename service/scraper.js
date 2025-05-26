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

const scrapeBusinesses = async () => {
  let browser;
  try {
    console.log('Connecting to MongoDB...');
    const uri = process.env.DB_DATABASE || 'mongodb://localhost:27017/bizdeal';
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    console.log(`MongoDB connected to ${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.db.databaseName}`);

    const systemPrompt = `Extract structured data from HTML of a business listing or detail page. Return a JSON object with:
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
    - description: string (first 500 characters of the listing description, default "No description available" if missing),
    - scrapedData: { source: string, priceText: string, revenueText: string, detailUrl: string }.

    For cash flow extraction:
    - Sunbelt Network: Extract from ".latestBusinesses__values--box" with span "Cash Flow" (e.g., "$9m").
    - BizBuySell: Extract from "app-listing-diamond" or detail page ".financials p" with title "Cash Flow" (e.g., "Cash Flow: $XXX").
    - Flippa: Extract from "#properties-summary" with "Monthly Profit" (e.g., "USD $4,417 /mo").
    - DealStream: Extract from ".list-group-item.post" with "Cash Flow" (e.g., "Cash Flow: $XXX").
    - BusinessForSale: Extract from ".result" with "Cash Flow" (e.g., "Cash Flow: $XXX").
    Treat cash flow as monthly unless explicitly annual (e.g., "per year"). Convert "m" to millions, "k" to thousands.

    For Flippa listings, process both summary (div[id^="listing-"]) and detail page sections:
    - Summary: Extract title, price, description.
    - Detail: Extract from "#properties-summary" (e.g., Monthly Profit, Revenue) and description text (first 500 characters).
    Truncate combined HTML to 50,000 characters to avoid token limits. Focus on financials and description.

    For BizBuySell, prepend "https://www.bizbuysell.com" to relative URLs. For DealStream, prepend "https://dealstream.com". For Sunbelt Network, prepend "https://www.sunbeltnetwork.com". For BusinessForSale, prepend "https://us.businessesforsale.com". For Flippa, prepend "https://flippa.com". Discard non-USA listings for DealStream, Sunbelt Network, BusinessForSale, and Flippa by checking if location includes a US state or "United States". Use defaults: 0 for numbers, false for booleans, "Unknown" for strings, "Services" for sector only as a last resort. Return JSON only, no markdown. Log the extracted JSON for debugging.`;

    const allListings = [];
    const maxPages = 1;
    const maxRetries = 2;

    // 1) BusinessForSale.com via Puppeteer
    {
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

            for (const { html, detailUrl } of bfsSnippets) {
              try {
                const aiResp = await openai.chat.completions.create({
                  model: 'gpt-4o-mini',
                  messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: html }
                  ],
                  response_format: { type: 'json_object' }
                });
                const listing = JSON.parse(aiResp.choices[0].message.content);
                listing.scrapedData.source = 'BusinessForSale';
                listing.scrapedData.detailUrl = detailUrl || listing.scrapedData.detailUrl;
                listing.businessId = detailUrl || listing.businessId;
                console.log(`Extracted listing: ${listing.businessId}, sector: ${listing.sector}, cashFlow: ${listing.cashFlow}`);
                allListings.push(listing);
              } catch (err) {
                console.error(`BusinessForSale parse error on page ${pageNum}:`, err.message);
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
              console.log(`Max retries reached for BusinessForSale page ${pageNum}. Skipping...`);
            }
            attempt++;
          } finally {
            await page.close();
          }
        }
        await sleep(10000);
      }

      await browser.close();
      browser = null;
    }

    // 2) DealStream.com via Puppeteer
    {
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

      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        const dsUrl = pageNum === 1 ? 'https://dealstream.com/search?location=United+States' : `https://dealstream.com/search?page=${pageNum}`;
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

            for (const { html, detailUrl } of dsSnippets) {
              try {
                const aiResp = await openai.chat.completions.create({
                  model: 'gpt-4o-mini',
                  messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: html }
                  ],
                  response_format: { type: 'json_object' }
                });
                const listing = JSON.parse(aiResp.choices[0].message.content);
                listing.scrapedData.source = 'DealStream';
                listing.scrapedData.detailUrl = detailUrl || listing.scrapedData.detailUrl;
                listing.businessId = detailUrl || listing.businessId;
                console.log(`Extracted listing: ${listing.businessId}, sector: ${listing.sector}, cashFlow: ${listing.cashFlow}`);
                allListings.push(listing);
              } catch (err) {
                console.error(`DealStream parse error on page ${pageNum}:`, err.message);
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
              console.log(`Max retries reached for DealStream page ${pageNum}. Skipping...`);
            }
            attempt++;
          } finally {
            await page.close();
          }
        }
        await sleep(10000);
      }

      await browser.close();
      browser = null;
    }

    // 3) BizBuySell.com via Axios + Cheerio forcing HTTP/1.1
    {
      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        const url = pageNum === 1 ? 'https://www.bizbuysell.com/businesses-for-sale/' : `https://www.bizbuysell.com/businesses-for-sale/${pageNum}/`;
        console.log(`Fetching BizBuySell page ${pageNum}: ${url}`);
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
          $('app-listing-diamond').each((_, el) => {
            const detailUrl = $(el).find('a').attr('href') || '';
            const fullUrl = detailUrl.startsWith('http') ? detailUrl : `https://www.bizbuysell.com${detailUrl}`;
            snippets.push({ html: $.html(el), detailUrl: fullUrl });
          });
          console.log(`Found ${snippets.length} BizBuySell listings on page ${pageNum}`);

          for (const { html, detailUrl } of snippets) {
            try {
              const aiResp = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: html }
                ],
                response_format: { type: 'json_object' }
              });
              const listing = JSON.parse(aiResp.choices[0].message.content);
              listing.scrapedData.source = 'BizBuySell';
              listing.scrapedData.detailUrl = detailUrl || listing.scrapedData.detailUrl;
              listing.businessId = detailUrl || listing.businessId;
              console.log(`Extracted listing: ${listing.businessId}, sector: ${listing.sector}, cashFlow: ${listing.cashFlow}`);
              allListings.push(listing);
            } catch (err) {
              console.error(`BizBuySell parse error on page ${pageNum}:`, err.message);
            }
          }
        } catch (err) {
          console.error(`Error fetching BizBuySell page ${pageNum}:`, err.message);
        }
        await sleep(5000);
      }
    }

    // 4) Flippa.com via Puppeteer
    {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
        protocolTimeout: 120000
      });

      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        let attempt = 0;
        let success = false;
        const flippaUrl = pageNum === 1 ? 'https://flippa.com/online-businesses-united-states' : `https://flippa.com/online-businesses-united-states?page%5Bnumber%5D=${pageNum}`;
        console.log(`Scraping Flippa page ${pageNum}: ${flippaUrl}`);

        while (attempt < maxRetries && !success) {
          const page = await browser.newPage();
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
          await page.setViewport({ width: 1280, height: 800 });

          try {
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

            for (const { html, detailUrl } of flipSnippets) {
              try {
                // Scrape detail page and extract specific elements
                const detailPage = await browser.newPage();
                await detailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                await detailPage.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 60000 });

                const detailHtml = await detailPage.content();
                const $ = cheerio.load(detailHtml);

                // Extract relevant sections
                const propertiesSummary = $('#properties-summary').html() || '';
                const description = $('.listing-description').text().trim().slice(0, 500) || 'No description available';
                const detailExtract = `
                  <div id="properties-summary">${propertiesSummary}</div>
                  <div class="listing-description">${description}</div>
                `;

                // Combine and truncate
                let combinedHtml = `${html}\n<!-- Detail Page Extract -->\n${detailExtract}`;
                if (combinedHtml.length > 50000) {
                  combinedHtml = combinedHtml.slice(0, 50000) + '...';
                }

                const aiResp = await openai.chat.completions.create({
                  model: 'gpt-4o-mini',
                  messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: combinedHtml }
                  ],
                  response_format: { type: 'json_object' }
                });
                const listing = JSON.parse(aiResp.choices[0].message.content);
                listing.scrapedData.source = 'Flippa';
                listing.scrapedData.detailUrl = detailUrl || listing.scrapedData.detailUrl;
                listing.businessId = detailUrl || listing.businessId;
                console.log(`Extracted listing: ${listing.businessId}, sector: ${listing.sector}, cashFlow: ${listing.cashFlow}`);
                allListings.push(listing);
                await detailPage.close();
              } catch (err) {
                console.error(`Flippa parse error for ${detailUrl} on page ${pageNum}:`, err.message);
              }
            }
          } catch (err) {
            console.error(`Flippa load/error on page ${pageNum}, attempt ${attempt + 1}:`, err.message);
            attempt++;
            if (attempt === maxRetries) {
              console.log(`Max retries reached for Flippa page ${pageNum}. Skipping...`);
            }
          } finally {
            await page.close();
          }
          await sleep(10000);
        }
      }

      await browser.close();
      browser = null;
    }

    // 5) SunbeltNetwork.com via Axios + Cheerio
    {
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

          for (const { html, detailUrl } of snippets) {
            try {
              const aiResp = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: html }
                ],
                response_format: { type: 'json_object' }
              });
              const listing = JSON.parse(aiResp.choices[0].message.content);
              listing.scrapedData.source = 'Sunbelt Network';
              listing.scrapedData.detailUrl = detailUrl || listing.scrapedData.detailUrl;
              listing.businessId = detailUrl || listing.businessId;
              console.log(`Extracted listing: ${listing.businessId}, sector: ${listing.sector}, cashFlow: ${listing.cashFlow}`);
              allListings.push(listing);
            } catch (err) {
              console.error(`Sunbelt Network parse error on page ${pageNum}:`, err.message);
            }
          }
        } catch (err) {
          console.error(`Error fetching Sunbelt Network page ${pageNum}:`, err.message);
        }
        await sleep(5000);
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

module.exports = { scrapeBusinesses };
scrapeBusinesses();