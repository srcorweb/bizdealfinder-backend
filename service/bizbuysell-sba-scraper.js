const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const { OpenAI } = require('openai');
const mongoose = require('mongoose');
const fs = require('fs').promises;
require('dotenv').config();

// Import your models - adjust paths as needed
const Business = require('../models/business');
const UserPreferences = require('../models/userPreferences');

// Initialize OpenAI - make sure to set your API key in .env file
const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const scrapeBizBuySellSBA = async () => {
  console.log('Starting BizBuySell SBA scraper test...');

  try {
    console.log('Connecting to MongoDB...');
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/bizdeal';
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    console.log(`MongoDB connected to ${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.db.databaseName}`);
  } catch (mongoError) {
    console.error('Failed to connect to MongoDB:', mongoError.message);
    throw mongoError;
  }
  
  const systemPrompt = `Extract structured data from HTML of a business listing detail page. This is a DETAIL PAGE scrape, so extract comprehensive information. Return a JSON object with:
  - businessId: string (full detail URL, e.g., "https://www.bizbuysell.com/...", prepend "https://www.bizbuysell.com" for BizBuySell),
  - name: string (business title),
  - price: number (USD, 0 if "Not Disclosed"/"On request"/"N/A"/"Confidential", min of ranges, e.g., "$100k-$200k" -> 100000, convert "m" to millions, e.g., "$30m" -> 30000000),
  - revenue: number (USD, extract from "Gross Revenue", "Annual Revenue", "Revenue", "Sales", or similar fields; 0 only if explicitly "Not Disclosed"/"N/A"/"Confidential"; convert k to thousands, m to millions, e.g., "$367k" -> 367000, "$367,000" -> 367000),
  - cashFlow: number (USD, extract from "Cash Flow", "Cash Flow (SDE)", "SDE", "EBITDA", "Net Income", or similar fields; 0 only if explicitly "Not Disclosed"/"N/A"/"Confidential"; convert k to thousands, m to millions, e.g., "$160k" -> 160000, "$160,000" -> 160000),
  - location: { city: string, state: string } (default "Unknown" if missing or "Confidential"; convert two-letter state codes to full names, e.g., "FL" -> "Florida", using: AL->Alabama, AK->Alaska, AZ->Arizona, AR->Arkansas, CA->California, CO->Colorado, CT->Connecticut, DE->Delaware, FL->Florida, GA->Georgia, HI->Hawaii, ID->Idaho, IL->Illinois, IN->Indiana, IA->Iowa, KS->Kansas, KY->Kentucky, LA->Louisiana, ME->Maine, MD->Maryland, MA->Massachusetts, MI->Michigan, MN->Minnesota, MS->Mississippi, MO->Missouri, MT->Montana, NE->Nebraska, NV->Nevada, NH->New Hampshire, NJ->New Jersey, NM->New Mexico, NY->New York, NC->North Carolina, ND->North Dakota, OH->Ohio, OK->Oklahoma, OR->Oregon, PA->Pennsylvania, RI->Rhode Island, SC->South Carolina, SD->South Dakota, TN->Tennessee, TX->Texas, UT->Utah, VT->Vermont, VA->Virginia, WA->Washington, WV->West Virginia, WI->Wisconsin, WY->Wyoming),
  - sbaPreApproved: boolean (true if text includes "SBA pre-approved", "SBA approved", "SBA loan eligible", "SBA financing available", "SBA Prequalified: Yes", case-insensitive),
  - sellerFinancing: boolean (true if text includes "Financing Available", "owner financed", "seller financing", "owner financing", "financing by owner", "seller offers payment plan", "owner will finance", case-insensitive),
  - zeroDown: boolean (true if text includes "zero down", "no down payment", "no upfront payment", "full financing available", "0% down", "no initial payment", case-insensitive),
  - distressed: boolean (true if text includes "distressed", "urgent sale", "must sell", "quick sale needed", "motivated seller", "liquidation", case-insensitive),
  - ownerAbsentee: boolean (true if text includes "absentee", "owner absentee", "runs itself", "passive income", "owner not involved", "managed remotely", case-insensitive),
  - brickAndMortar: boolean (true unless text explicitly mentions "online", "e-commerce", "digital business", case-insensitive),
  - sector: string (strictly choose from: Agriculture, Energy, Engineering, Food, Franchise Resales, Leisure, Manufacturing, Online, Real Estate, Retail, Services, Tech & Media, Wholesale & Distribution; intelligently infer from the title and description),
  - description: string (full business description from detail page, up to 2000 characters, default "No description available" if missing),
  - sourceContent: {
      content: string (full HTML content for caching, truncated to 50000 chars),
      scrapedAt: Date (current timestamp),
      financials: array of objects with key/value pairs for financial metrics like [{"key": "Asking Price", "value": "$175,000"}, {"key": "Revenue", "value": "$519,928"}],
      detailedInfo: array of objects with key/value pairs for business details like [{"key": "Years Established", "value": "15"}, {"key": "Employees", "value": "8"}]
    },
  - scrapedData: { source: string, priceText: string, revenueText: string, detailUrl: string }.

  Return JSON only, no markdown.`;

  const allListings = [];
  const maxPages = 3; // Reduced for testing
  let totalSbaListings = 0;
  
  try {
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const url = pageNum === 1 ? 'https://www.bizbuysell.com/businesses-for-sale/?q=az1zYmE%3D' : `https://www.bizbuysell.com/businesses-for-sale/${pageNum}/?q=az1zYmE%3D`;
      console.log(`Fetching BizBuySell SBA page ${pageNum}: ${url}`);
      
      let attempt = 0;
      let success = false;
      const maxRetries = 3;

      while (attempt < maxRetries && !success) {
        try {
          const httpsAgent = new https.Agent({ 
            ALPNProtocols: ['http/1.1'],
            rejectUnauthorized: false,
            keepAlive: true,
            timeout: 30000
          });
          const safariAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Safari/17612.3.14.1.6 CFNetwork/1327.0.4 Darwin/21.2.0'
          ];
          const userAgent = safariAgents[Math.floor(Math.random() * safariAgents.length)];
          
          console.log(`Fetching BizBuySell SBA page ${pageNum} (attempt ${attempt + 1}): ${url}`);
          const start = Date.now();
          
          const response = await axios.get(url, {
            httpsAgent,
            timeout: 30000,
            maxRedirects: 5,
            validateStatus: (status) => status < 400,
            headers: { 
              'User-Agent': userAgent,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.5',
              'Connection': 'keep-alive',
              'Upgrade-Insecure-Requests': '1'
            }
          });
          
          // Validate response
          if (!response.data || response.data.length < 1000) {
            throw new Error('Empty or insufficient response data');
          }

          // Check for blocked content
          if (response.data.includes('Access Denied') || 
              response.data.includes('Blocked') || 
              response.data.includes('captcha') ||
              response.data.includes('Just a moment')) {
            throw new Error('Access blocked or CAPTCHA detected');
          }

          success = true;
          const elapsed = ((Date.now() - start) / 1000).toFixed(4);
          console.log(`status=${response.status}, elapsed_time=${elapsed}s, content_length=${response.data.length}, url=${url}`);

          const $ = cheerio.load(response.data);
          const snippets = [];
          
          // Debug: Check multiple possible selectors
          console.log('Checking for different listing selectors...');
          const appListingShowcaseCount = $('app-listing-showcase').length;
          const appListingCount = $('app-listing-diamond').length;
          const listingItemCount = $('.listing-item').length;
          const businessCardCount = $('.business-card').length;

          console.log(`app-listing-showcase: ${appListingShowcaseCount}`);
          console.log(`app-listing-diamond: ${appListingCount}`);
          console.log(`listing-item: ${listingItemCount}`);
          console.log(`business-card: ${businessCardCount}`);

          console.log('Checking for different listing selectors...');
          // Use the correct BizBuySell selectors first
          const selectors = [
            { name: 'app-listing-showcase', selector: 'app-listing-showcase' },
            { name: 'app-listing-diamond', selector: 'app-listing-diamond' },
            { name: 'listing-showcase', selector: '.listing-showcase' },
            { name: 'listing-item', selector: '.listing-item' },
            { name: 'business-card', selector: '.business-card' },
            { name: 'result-item', selector: '.result-item' }
          ];

          let bestSelector = null;
          let maxCount = 0;

          for (const { name, selector } of selectors) {
            const count = $(selector).length;
            console.log(`${name}: ${count}`);
            if (count > maxCount) {
              maxCount = count;
              bestSelector = { name, selector };
            }
          }

          console.log(`Best selector found: ${bestSelector?.name} with ${maxCount} elements`);

          // Always prioritize direct business links over container elements
          const businessLinks = $('a[href*="/business-opportunity/"], a[href*="/business/"]');
          console.log(`Found ${businessLinks.length} direct business links`);

          if (businessLinks.length > 0) {
            console.log('Using direct business links approach');
            bestSelector = { name: 'business-links', selector: 'a[href*="/business-opportunity/"], a[href*="/business/"]' };
            maxCount = businessLinks.length;
          } else if (maxCount === 0) {
            console.log('No standard selectors found, searching for elements with business links...');
            const linkElements = $('a[href*="/business-opportunity/"], a[href*="/business/"]');
            console.log(`Found ${linkElements.length} business links`);
            
            if (linkElements.length > 0) {
              bestSelector = { name: 'business-links', selector: 'a[href*="/business-opportunity/"], a[href*="/business/"]' };
              maxCount = linkElements.length;
            }
          }

          // EXTRACT SNIPPETS USING THE BEST SELECTOR
          if (bestSelector && maxCount > 0) {
            console.log(`Using selector: ${bestSelector.name} (${bestSelector.selector})`);
            
            $(bestSelector.selector).each((_, el) => {
              let detailUrl = '';
              
              if (bestSelector.name === 'business-links') {
                // Direct link element
                detailUrl = $(el).attr('href') || '';
              } else if (bestSelector.name === 'app-listing-showcase') {
                // BizBuySell specific: look for the showcase link
                detailUrl = $(el).find('a.showcase').attr('href') || $(el).find('a').attr('href') || '';
              } else {
                // Container element, find link inside
                detailUrl = $(el).find('a').attr('href') || '';
              }
              
              // Only process elements with valid business opportunity links
              if (detailUrl && (detailUrl.includes('/business-opportunity/') || detailUrl.includes('/business/'))) {
                const fullUrl = detailUrl.startsWith('http') ? detailUrl : `https://www.bizbuysell.com${detailUrl}`;
                console.log(`Found valid business link: ${fullUrl}`);
                snippets.push({ html: $.html(el), detailUrl: fullUrl });
              }
            });
          }

          console.log(`Found ${snippets.length} BizBuySell SBA listings on page ${pageNum}`);

          // Debug: Save page content if no listings found
          if (snippets.length === 0) {
            await fs.writeFile(`debug-page-${pageNum}.html`, response.data);
            console.log(`No listings found. Page content saved to debug-page-${pageNum}.html`);
            
            // Analyze page structure more thoroughly
            console.log('Page analysis:');
            console.log(`- Title: ${$('title').text()}`);
            console.log(`- Has pagination: ${$('.pagination, .pager, [class*="page"]').length > 0}`);
            console.log(`- Has listings container: ${$('[class*="listing"], [class*="result"], [class*="business"]').length}`);

            // Sample some of the HTML to understand structure
            console.log('Sampling HTML structure:');
            const sampleElements = $('[class*="listing"], [class*="result"], [class*="business"]').slice(0, 3);
            sampleElements.each((i, el) => {
              const $el = $(el);
              console.log(`Sample ${i + 1}:`);
              console.log(`  - Class: ${$el.attr('class')}`);
              console.log(`  - Has link: ${$el.find('a').length > 0}`);
              console.log(`  - Link href: ${$el.find('a').attr('href') || 'N/A'}`);
              console.log(`  - Text preview: ${$el.text().substring(0, 100)}...`);
            });
            console.log(`- Page indicates no results: ${$('body').text().toLowerCase().includes('no results') || $('body').text().toLowerCase().includes('no businesses found')}`);
            
            // Check if this is actually a valid SBA results page
            const pageText = response.data.toLowerCase();
            if (pageText.includes('no results') || pageText.includes('no businesses found') || pageText.includes('sorry, no listings')) {
              console.log('End of results detected. Breaking...');
              break;
            }
            
            // If the page structure seems wrong, try a different URL format
            if (!pageText.includes('businesses for sale') && !pageText.includes('bizbuysell')) {
              console.log('Page content doesn\'t seem to be a BizBuySell results page. Trying alternative URL...');
              
              // Try without the page number in path
              const alternativeUrl = `https://www.bizbuysell.com/businesses-for-sale/?q=az1zYmE%3D&page=${pageNum}`;
              console.log(`Trying alternative URL: ${alternativeUrl}`);
              
              try {
                const altResponse = await axios.get(alternativeUrl, {
                  httpsAgent,
                  timeout: 30000,
                  maxRedirects: 5,
                  validateStatus: (status) => status < 400,
                  headers: { 
                    'User-Agent': userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                  }
                });
                
                const $alt = cheerio.load(altResponse.data);
                $alt('app-listing-showcase').each((_, el) => {
                  const detailUrl = $(el).find('a').attr('href') || '';
                  const fullUrl = detailUrl.startsWith('http') ? detailUrl : `https://www.bizbuysell.com${detailUrl}`;
                  snippets.push({ html: $.html(el), detailUrl: fullUrl });
                });
                
                if (snippets.length > 0) {
                  console.log(`Alternative URL worked! Found ${snippets.length} listings`);
                }
              } catch (altErr) {
                console.log(`Alternative URL also failed: ${altErr.message}`);
              }
            }
          }

          // Process each listing
          for (const { html, detailUrl } of snippets) {
            try {
              let detailContent = '';
              
              try {
                console.log(`Fetching BizBuySell SBA detail page: ${detailUrl}`);
                const detailResponse = await axios.get(detailUrl, {
                  httpsAgent,
                  timeout: 30000,
                  headers: { 'User-Agent': userAgent }
                });
                detailContent = detailResponse.data;
                console.log(`BizBuySell SBA detail page fetched successfully for ${detailUrl}`);
              } catch (detailErr) {
                console.error(`Failed to fetch BizBuySell SBA detail page ${detailUrl}:`, detailErr.message);
                detailContent = html; // Fallback to listing HTML
              }

              // Extract structured financial data from BizBuySell HTML
              const $detail = cheerio.load(detailContent);
              let extractedFinancials = {};

              $detail('.financials .specs p').each((_, el) => {
                const $el = $detail(el);
                const title = $el.find('.title').text().trim().toLowerCase();
                const value = $el.find('.normal, .price').first().text().trim();
                
                if (title.includes('asking price')) {
                  extractedFinancials.askingPrice = value;
                } else if (title.includes('gross revenue')) {
                  extractedFinancials.grossRevenue = value;
                } else if (title.includes('cash flow')) {
                  extractedFinancials.cashFlow = value;
                } else if (title.includes('ebitda')) {
                  extractedFinancials.ebitda = value;
                } else if (title.includes('established')) {
                  extractedFinancials.established = value;
                }
              });

              let financialSummary = 'EXTRACTED FINANCIAL DATA:\n';
              Object.entries(extractedFinancials).forEach(([key, value]) => {
                financialSummary += `${key}: ${value}\n`;
              });

              console.log('Extracted financials:', extractedFinancials);

              let processedContent = financialSummary + '\n\n' + detailContent;

              if (processedContent.length > 50000) {
                processedContent = processedContent.substring(0, 50000) + '...';
              }

              const aiResp = await openai.chat.completions.create({
                model: 'gpt-4o',  // More powerful model for better extraction
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: `Extract business information from this HTML. Pay special attention to financial metrics like Asking Price, Gross Revenue, Cash Flow (SDE), EBITDA, and Rent:\n\n${processedContent}` }
                ],
                response_format: { type: 'json_object' },
                temperature: 0.1
              });
              
              const listing = JSON.parse(aiResp.choices[0].message.content);

              // Use pre-extracted financial data as fallback
              if ((listing.revenue === 0 || listing.cashFlow === 0) && Object.keys(extractedFinancials).length > 0) {
                console.log('AI extraction missed financial data, using pre-extracted values...');
                
                if (listing.revenue === 0 && extractedFinancials.grossRevenue) {
                  const revenueValue = extractedFinancials.grossRevenue.replace(/[$,]/g, '');
                  if (revenueValue && !isNaN(revenueValue)) {
                    listing.revenue = parseInt(revenueValue);
                    console.log(`Using pre-extracted revenue: $${listing.revenue}`);
                  }
                }
                
                if (listing.cashFlow === 0 && extractedFinancials.cashFlow) {
                  const cashFlowValue = extractedFinancials.cashFlow.replace(/[$,]/g, '');
                  if (cashFlowValue && !isNaN(cashFlowValue)) {
                    listing.cashFlow = parseInt(cashFlowValue);
                    console.log(`Using pre-extracted cash flow: $${listing.cashFlow}`);
                  }
                }
                
                // Also extract price if missed
                if (listing.price === 0 && extractedFinancials.askingPrice) {
                  const priceValue = extractedFinancials.askingPrice.replace(/[$,]/g, '');
                  if (priceValue && !isNaN(priceValue)) {
                    listing.price = parseInt(priceValue);
                    console.log(`Using pre-extracted price: $${listing.price}`);
                  }
                }
              }

              if (!listing.scrapedData) {
                listing.scrapedData = {};
              }

              listing.scrapedData = {
                source: 'BizBuySell',
                detailUrl: detailUrl,
                priceText: extractedFinancials.askingPrice || 'Not found',
                revenueText: extractedFinancials.grossRevenue || 'Not found',
                cashFlowText: extractedFinancials.cashFlow || 'Not found'
              };
              listing.businessId = detailUrl || listing.businessId;
              listing.sbaPreApproved = true; // Force SBA approved to true for SBA-specific scrape
              
              // Ensure sourceContent has proper structure
              if (!listing.sourceContent) {
                listing.sourceContent = {
                  content: detailContent,
                  scrapedAt: new Date(),
                  financials: [],
                  detailedInfo: []
                };
              }
              
              console.log(`✅ Extracted BizBuySell SBA listing:`);
              console.log(`   Business ID: ${listing.businessId}`);
              console.log(`   Name: ${listing.name}`);
              console.log(`   Price: $${listing.price.toLocaleString()}`);
              console.log(`   Revenue: $${listing.revenue.toLocaleString()}`);
              console.log(`   Cash Flow: $${listing.cashFlow.toLocaleString()}`);
              console.log(`   Raw price text: ${listing.scrapedData?.priceText || 'N/A'}`);
              console.log(`   Raw revenue text: ${listing.scrapedData?.revenueText || 'N/A'}`);
              console.log(`   Location: ${listing.location.city}, ${listing.location.state}`);
              console.log(`   Sector: ${listing.sector}`);
              console.log(`   SBA Pre-approved: ${listing.sbaPreApproved}`);
              console.log(`   Financials count: ${listing.sourceContent?.financials?.length || 0}`);
              console.log('---');
              
              allListings.push(listing);
              totalSbaListings++;

              await sleep(2000); // Rate limiting
            } catch (err) {
              console.error(`❌ BizBuySell SBA parse error on page ${pageNum}:`, err.message);
            }
          }
          
        } catch (err) {
          console.error(`Error fetching BizBuySell SBA page ${pageNum}, attempt ${attempt + 1}:`, err.message);
          attempt++;
          if (attempt < maxRetries) {
            console.log(`Retrying BizBuySell SBA page ${pageNum} in ${5000 * attempt}ms...`);
            await sleep(5000 * attempt);
          } else {
            console.log(`Max retries reached for BizBuySell SBA page ${pageNum}. Moving to next page...`);
            break; // Skip to next page instead of failing entire scrape
          }
        }
      }
      
      // Add delay between pages
      await sleep(8000);
      console.log(`BizBuySell SBA scraper progress: ${totalSbaListings} total listings collected so far`);
      
      // Optional: Stop after reaching a certain number for testing
      if (totalSbaListings >= 20) {
        console.log(`Target of 20 SBA listings reached for testing! Ending BizBuySell SBA scrape.`);
        break;
      }
    }

    // Save listings to MongoDB and match preferences
    console.log(`\n📊 SCRAPING COMPLETE`);
    console.log(`Total listings scraped: ${allListings.length}`);

    console.log(`Saving ${allListings.length} listings to MongoDB...`);
    let savedCount = 0;
    const usersWithPreferences = await UserPreferences.find();
    console.log(`Found ${usersWithPreferences.length} user preferences for matching`);

    for (const listing of allListings) {
      try {
        await Business.updateOne(
          { businessId: listing.businessId },
          { $set: listing },
          { upsert: true }
        );
        savedCount++;

        // Match against user preferences
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
        console.error(`MongoDB upsert error for ${listing.businessId}:`, err.message);
      }
      await sleep(100); // Rate limiting for database operations
    }

    console.log(`Saved ${savedCount}/${allListings.length} listings to MongoDB`);

    const totalDocs = await Business.countDocuments();
    console.log(`Total documents in collection: ${totalDocs}`);

    // Also save to file as backup
    const results = {
      scrapedAt: new Date().toISOString(),
      totalListings: allListings.length,
      savedToMongoDB: savedCount,
      listings: allListings
    };

    await fs.writeFile('bizbuysell-sba-results.json', JSON.stringify(results, null, 2));
    console.log(`Backup results also saved to: bizbuysell-sba-results.json`);

    // Print summary statistics
    const sectors = {};
    const locations = {};
    let totalPrice = 0;
    let totalRevenue = 0;
    let totalCashFlow = 0;

    allListings.forEach(listing => {
      sectors[listing.sector] = (sectors[listing.sector] || 0) + 1;
      const locationKey = `${listing.location.city}, ${listing.location.state}`;
      locations[locationKey] = (locations[locationKey] || 0) + 1;
      totalPrice += listing.price || 0;
      totalRevenue += listing.revenue || 0;
      totalCashFlow += listing.cashFlow || 0;
    });

    console.log(`\n📈 SUMMARY STATISTICS:`);
    console.log(`Average Price: $${Math.round(totalPrice / allListings.length).toLocaleString()}`);
    console.log(`Average Revenue: $${Math.round(totalRevenue / allListings.length).toLocaleString()}`);
    console.log(`Average Cash Flow: $${Math.round(totalCashFlow / allListings.length).toLocaleString()}`);
    
    console.log(`\nTop Sectors:`);
    Object.entries(sectors)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .forEach(([sector, count]) => console.log(`  ${sector}: ${count}`));
    
    console.log(`\nTop Locations:`);
    Object.entries(locations)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .forEach(([location, count]) => console.log(`  ${location}: ${count}`));

    } catch (error) {
      console.error('❌ Scrape run error:', error.message);
      console.error(error.stack);
    } finally {
      if (mongoose.connection.readyState) {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB');
      }
      console.log('BizBuySell SBA scrape completed:', new Date().toISOString());
    }
};

// Run the scraper
if (require.main === module) {
  scrapeBizBuySellSBA()
    .then(() => {
      console.log('✅ BizBuySell SBA scraper test completed successfully!');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Scraper failed:', error.message);
      process.exit(1);
    });
}

module.exports = { scrapeBizBuySellSBA };