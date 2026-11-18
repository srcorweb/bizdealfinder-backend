const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AnonymizeUAPlugin = require('puppeteer-extra-plugin-anonymize-ua');
const { OpenAI } = require('openai');
const mongoose = require('mongoose');
require('dotenv').config();

puppeteer.use(StealthPlugin());
puppeteer.use(AnonymizeUAPlugin());

const Business = require('../models/business'); // Adjust path as needed
const UserPreferences = require('../models/userPreferences'); // Adjust path as needed
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const scrapeSBAListings = async () => {
  let browser;
  const allListings = [];
  
  try {
    console.log('Connecting to MongoDB...');
    const uri = 'mongodb+srv://willhawkins242:88AH3Xtx2Tv7JFzm@bizdealcluster.6t7fszb.mongodb.net/bizdeal?retryWrites=true&w=majority&tls=true&tlsAllowInvalidCertificates=false';
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    console.log(`MongoDB connected to ${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.db.databaseName}`);

    const systemPrompt = `Extract structured data from HTML of a business listing or detail page. Return a JSON object with:
    - businessId: string (full detail URL, e.g., "https://www.bizbuysell.com/...", prepend "https://www.bizbuysell.com" for BizBuySell, "https://dealstream.com" for DealStream, "https://www.sunbeltnetwork.com" for Sunbelt Network, "https://us.businessesforsale.com" for BusinessForSale, "https://flippa.com" for Flippa),
    - name: string (business title),
    - price: number (USD, 0 if "Not Disclosed"/"On request"/"N/A"/"Confidential", min of ranges, e.g., "$100k-$200k" -> 100000, convert "m" to millions, e.g., "$30m" -> 30000000),
    - revenue: number (USD, 0 if "Not Disclosed"/"Not applicable"/"N/A"/"On request"/"Confidential", min of ranges, convert monthly to annual if explicitly specified, e.g., "$3,275 p/mo" -> 39300, convert "m" to millions, e.g., "$36.829m" -> 36829000),
    - cashFlow: number (USD, 0 if "Not Disclosed"/"N/A"/"Confidential", treat as monthly, e.g., "$9m" -> 9000000, "$4,417" -> 4417, convert "m" to millions),
    - location: { city: string, state: string } (default "Unknown" if missing or "Confidential"; convert two-letter state codes to full names, e.g., "FL" -> "Florida", using: AL->Alabama, AK->Alaska, AZ->Arizona, AR->Arkansas, CA->California, CO->Colorado, CT->Connecticut, DE->Delaware, FL->Florida, GA->Georgia, HI->Hawaii, ID->Idaho, IL->Illinois, IN->Indiana, IA->Iowa, KS->Kansas, KY->Kentucky, LA->Louisiana, ME->Maine, MD->Maryland, MA->Massachusetts, MI->Michigan, MN->Minnesota, MS->Mississippi, MO->Missouri, MT->Montana, NE->Nebraska, NV->Nevada, NH->New Hampshire, NJ->New Jersey, NM->New Mexico, NY->New York, NC->North Carolina, ND->North Dakota, OH->Ohio, OK->Oklahoma, OR->Oregon, PA->Pennsylvania, RI->Rhode Island, SC->South Carolina, SD->South Dakota, TN->Tennessee, TX->Texas, UT->Utah, VT->Vermont, VA->Virginia, WA->Washington, WV->West Virginia, WI->Wisconsin, WY->Wyoming; for DealStream/Sunbelt Network/BusinessForSale/Flippa, set city to "Unknown" and use state name if location is a US state, else discard non-USA listings),
    - sbaPreApproved: boolean (true if text includes "SBA pre-approved", "SBA approved", "SBA loan eligible", "SBA financing available", "SBA Prequalified: Yes", "SBA Qualified", "SBA Pre-Qualified", or any SBA-related badge/icon is present, case-insensitive),
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

    Use defaults: 0 for numbers, false for booleans, "Unknown" for strings, "Services" for sector only as a last resort. Return JSON only, no markdown. Log the extracted JSON for debugging.`;

    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-http2', // Disable HTTP2 to avoid protocol errors
        '--disable-features=VizDisplayCompositor',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--no-first-run',
        '--disable-default-apps',
        '--disable-component-extensions-with-background-pages',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ],
      protocolTimeout: 180000, // Increased timeout
      slowMo: 100 // Add slight delay between actions
    });

    // Calculate pages needed for 1000 listings (assuming ~20 listings per page)
    const targetListings = 1000;
    const listingsPerPage = 20;
    const pagesNeeded = Math.ceil(targetListings / listingsPerPage);
    
    console.log(`Starting BizBuySell SBA scraping - targeting ${targetListings} listings across ${pagesNeeded} pages`);
    
    for (let pageNum = 1; pageNum <= pagesNeeded && allListings.filter(l => l.sbaPreApproved === true).length < targetListings; pageNum++) {
      const url = pageNum === 1 ? 'https://www.bizbuysell.com/businesses-for-sale/?q=az1zYmE%3D' : `https://www.bizbuysell.com/businesses-for-sale/${pageNum}/?q=az1zYmE%3D`;
      console.log(`\n🔍 Scraping BizBuySell SBA page ${pageNum}: ${url}`);
      let attempt = 0;
      let success = false;

      while (attempt < 3 && !success) {
        let page;
        try {
          page = await browser.newPage();
          
          // Enhanced page setup
          await page.setDefaultNavigationTimeout(6000);
          await page.setDefaultTimeout(6000);
          
          const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0'
          ];
          const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
          await page.setUserAgent(userAgent);
          await page.setViewport({ width: 1366, height: 768 });

          // Set extra headers to look more like a real browser
          await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Upgrade-Insecure-Requests': '1'
          });

          // Enhanced stealth measures
          await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            window.chrome = { runtime: {} };
            
            // Mock webGL
            const getParameter = WebGLRenderingContext.getParameter;
            WebGLRenderingContext.prototype.getParameter = function(parameter) {
              if (parameter === 37445) {
                return 'Intel Inc.';
              }
              if (parameter === 37446) {
                return 'Intel(R) Iris(TM) Graphics 6100';
              }
              return getParameter(parameter);
            };
          });

          console.log(`⏳ Attempt ${attempt + 1}/3 for page ${pageNum}`);

          // Navigate with multiple fallback strategies
          try {
            await page.goto(url, { 
              waitUntil: 'domcontentloaded', 
              timeout: 6000 
            });
          } catch (navError) {
            console.log(`Navigation error, trying networkidle0: ${navError.message}`);
            await page.goto(url, { 
              waitUntil: 'networkidle0', 
              timeout: 6000 
            });
          }
          
          // Wait a bit for any dynamic content
          await sleep(3000);
          
          // Add human-like behavior
          await page.evaluate(() => {
            window.scrollTo(0, Math.random() * 500);
            const x = Math.random() * 800;
            const y = Math.random() * 600;
            document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
          });
          await sleep(2000 + Math.random() * 3000);

          // Check if we're on the right page
          const pageTitle = await page.title();
          const currentUrl = await page.url();
          console.log(`📄 Page title: "${pageTitle}"`);
          console.log(`🌐 Current URL: ${currentUrl}`);

          // Check for various error conditions
          const pageContent = await page.content();
          const isErrorPage = pageContent.includes('www.bizbuysell.com</title>') && 
                             pageContent.includes('Copyright 2017 The Chromium Authors');
          
          if (isErrorPage) {
            console.log(`❌ Generic error page detected`);
            throw new Error('Generic error page - possible blocking');
          }

          const isVerificationPresent = await page.evaluate(() => {
            const title = document.querySelector('title')?.innerText || '';
            const bodyText = document.body?.innerText || '';
            return title.includes('Just a moment...') ||
                   title.includes('Checking your browser') ||
                   bodyText.includes('Checking your browser') ||
                   bodyText.includes('Please wait') ||
                   document.querySelector('#cf-challenge, .cf-please-wait, [id*="captcha"], [class*="captcha"]') !== null;
          });

          if (isVerificationPresent) {
            console.log(`🔒 Verification/captcha screen detected on page ${pageNum}, attempt ${attempt + 1}`);
            await page.screenshot({ path: `bizbuysell-sba-verification-page${pageNum}-attempt${attempt + 1}.png` });
            throw new Error('Verification screen detected');
          }

          // Try multiple selectors for listings
          const selectors = [
            'app-listing-diamond',
            '[data-testid="listing-card"]',
            '.listing-card',
            '.business-listing',
            'article[class*="listing"]'
          ];

          let foundSelector = null;
          for (const selector of selectors) {
            try {
              await page.waitForSelector(selector, { timeout: 10000 });
              foundSelector = selector;
              console.log(`✅ Found listings using selector: ${selector}`);
              break;
            } catch (e) {
              console.log(`❌ Selector "${selector}" not found`);
            }
          }

          if (!foundSelector) {
            // Take screenshot for debugging
            await page.screenshot({ path: `bizbuysell-sba-no-listings-page${pageNum}-attempt${attempt + 1}.png` });
            
            // Log some page info for debugging
            const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 1000) || 'No body text');
            console.log(`📝 Page body preview: ${bodyText}`);
            
            throw new Error('No listing selectors found on page');
          }

          success = true;

          const snippets = await page.evaluate((selector) => {
            const snippets = [];
            document.querySelectorAll(selector).forEach(el => {
              const linkEl = el.querySelector('a') || el;
              const detailUrl = linkEl.href || linkEl.getAttribute('href') || '';
              const fullUrl = detailUrl.startsWith('http') ? detailUrl : `https://www.bizbuysell.com${detailUrl}`;
              snippets.push({ html: el.innerHTML, detailUrl: fullUrl });
            });
            return snippets;
          }, foundSelector);

          console.log(`📊 Found ${snippets.length} BizBuySell listings on page ${pageNum}`);

          if (snippets.length === 0) {
            throw new Error('No listings found despite selector matching');
          }

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

              // Verify the listing actually has SBA pre-approved badge
              if (listing.sbaPreApproved === true) {
                console.log(`✅ Extracted SBA listing: ${listing.name || 'Unknown'} - ${listing.businessId}`);
                allListings.push(listing);
              } else {
                console.log(`❌ Skipping listing - no SBA badge detected: ${listing.name || 'Unknown'}`);
              }
            } catch (err) {
              console.error(`🔥 BizBuySell SBA parse error on page ${pageNum}:`, err.message);
            }
          }

        } catch (err) {
          console.error(`💥 BizBuySell SBA load/error on page ${pageNum}, attempt ${attempt + 1}:`, err.message);
          
          if (page) {
            try {
              const content = await page.content();
              console.log(`📄 Page content snippet: ${content.substring(0, 300)}...`);
              await page.screenshot({ path: `bizbuysell-sba-error-page${pageNum}-attempt${attempt + 1}.png` });
            } catch (screenshotErr) {
              console.log(`Screenshot failed: ${screenshotErr.message}`);
            }
          }
          
          if (attempt < 2) {
            const delay = 5000 * Math.pow(2, attempt) + Math.random() * 5000;
            console.log(`⏳ Retrying BizBuySell SBA page ${pageNum} after ${delay}ms delay...`);
            await sleep(delay);
          } else {
            console.log(`⚠️ Max retries reached for BizBuySell SBA page ${pageNum}. Moving to next page...`);
          }
          attempt++;
        } finally {
          if (page) {
            try {
              await page.close();
            } catch (closeErr) {
              console.log(`Page close error: ${closeErr.message}`);
            }
          }
        }
      }

      if (!success) {
        console.log(`❌ Failed to scrape BizBuySell SBA page ${pageNum} after 3 attempts. Continuing to next page...`);
      }

      // Add delay between pages
      const pageDelay = 8000 + Math.random() * 7000;
      console.log(`⏳ Waiting ${Math.round(pageDelay)}ms before next page...`);
      await sleep(pageDelay);
      
      // Log progress - only count listings that actually have SBA badge
      const sbaListingsCount = allListings.filter(l => l.sbaPreApproved === true).length;
      console.log(`📊 Progress: ${sbaListingsCount} verified SBA listings collected so far`);
      
      // Stop if we've reached our target
      if (sbaListingsCount >= targetListings) {
        console.log(`🎯 Target of ${targetListings} SBA listings reached!`);
        break;
      }
    }
    
    const finalSbaCount = allListings.filter(l => l.sbaPreApproved === true).length;
    console.log(`\n🎉 Completed BizBuySell SBA scraping. Total verified SBA listings: ${finalSbaCount}`);

    // Save listings to database
    if (finalSbaCount > 0) {
      console.log(`💾 Saving ${finalSbaCount} SBA listings to database...`);
      let savedCount = 0;
      const usersWithPreferences = await UserPreferences.find();
      
      for (const listing of allListings) {
        if (listing.sbaPreApproved !== true) continue; // Only save SBA listings
        
        try {
          await Business.updateOne(
            { businessId: listing.businessId },
            { $set: listing },
            { upsert: true }
          );
          savedCount++;

          // Match with user preferences
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
              console.log(`🎯 Match found for user ${pref.userId}:`, listing.businessId);
              await Business.updateOne(
                { businessId: listing.businessId },
                { $addToSet: { matchedUsers: pref.userId } }
              );
            }
          }
        } catch (err) {
          console.error(`❌ Database save error for ${listing.businessId}:`, err.message);
        }
      }
      
      console.log(`✅ Saved ${savedCount}/${finalSbaCount} SBA listings to database`);
    } else {
      console.log(`⚠️ No SBA listings to save to database`);
    }
    
  } catch (error) {
    console.error('💥 SBA scrape error:', error.message);
    console.error(error.stack);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.log(`Browser close error: ${closeErr.message}`);
      }
    }
    if (mongoose.connection.readyState) {
      await mongoose.disconnect();
    }
    console.log('🏁 SBA scrape completed:', new Date().toISOString());
  }
};

// Run the scraper if this file is executed directly
if (require.main === module) {
  scrapeSBAListings();
}

module.exports = { scrapeSBAListings };