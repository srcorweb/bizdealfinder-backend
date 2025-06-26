const mongoose = require('mongoose');
const axios = require('axios');
const https = require('https');
require('dotenv').config();

const Business = require('../models/business');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const checkListingStatus = async (url, source) => {
  try {
    const httpsAgent = new https.Agent({
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: false,
      timeout: 15000
    });

    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Safari/17612.3.14.1.6 CFNetwork/1327.0.4 Darwin/21.2.0'
    ];
    const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

    const response = await axios.get(url, {
      httpsAgent,
      timeout: 15000,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      validateStatus: (status) => status < 500
    });

    if (response.status === 404) {
      return { isActive: false, reason: '404 Not Found' };
    }

    const content = response.data.toLowerCase();

    const removedIndicators = [
      'listing not found',
      'business sold',
      'no longer available',
      'listing expired',
      'listing removed',
      'page not found',
      'this listing has been removed',
      'sorry, this listing is no longer available',
      'this business has been sold'
    ];

    for (const indicator of removedIndicators) {
      if (content.includes(indicator)) {
        return { isActive: false, reason: `Contains: "${indicator}"` };
      }
    }

    if (source === 'BizBuySell' && (
      content.includes('this listing is not available') ||
      content.includes('listing has expired')
    )) {
      return { isActive: false, reason: 'BizBuySell specific removal indicator' };
    }

    if (source === 'DealStream' && (
      content.includes('deal not found') ||
      content.includes('listing closed')
    )) {
      return { isActive: false, reason: 'DealStream specific removal indicator' };
    }

    if (source === 'Flippa' && (
      content.includes('auction ended') ||
      content.includes('listing closed')
    )) {
      return { isActive: false, reason: 'Flippa specific removal indicator' };
    }

    return { isActive: true, reason: 'Active listing' };

  } catch (error) {
    if (error.response?.status === 404) {
      return { isActive: false, reason: '404 Not Found' };
    }

    console.log(`Error checking ${url}: ${error.message}`);
    return { isActive: true, reason: `Error checking (assumed active): ${error.message}` };
  }
};

const cleanupInactiveListings = async () => {
  try {
    console.log('Starting cleanup of inactive business listings...');
    const uri = process.env.DB_DATABASE || 'mongodb://localhost:27017/bizdeal';
    // const uri = 'mongodb+srv://willhawkins242:88AH3Xtx2Tv7JFzm@bizdealcluster.6t7fszb.mongodb.net/bizdeal?retryWrites=true&w=majority&tls=true&tlsAllowInvalidCertificates=false' || 'mongodb://localhost:27017/bizdeal';
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    console.log(`MongoDB connected for cleanup`);

    const businesses = await Business.find({}, {
      businessId: 1,
      name: 1,
      'scrapedData.source': 1,
      'scrapedData.detailUrl': 1
    }).lean();

    console.log(`Found ${businesses.length} listings to check`);

    let removedCount = 0;
    let checkedCount = 0;
    const batchSize = 10;

    for (let i = 0; i < businesses.length; i += batchSize) {
      const batch = businesses.slice(i, i + batchSize);

      console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(businesses.length/batchSize)}`);

      const promises = batch.map(async (business) => {
        const url = business.businessId;
        const source = business.scrapedData?.source || 'Unknown';

        try {
          const status = await checkListingStatus(url, source);
          checkedCount++;

          if (!status.isActive) {
            console.log(`🗑️  Removing inactive listing: ${business.name} : ${url} - ${status.reason}`);
            await Business.deleteOne({ _id: business._id });
            removedCount++;
          } else {
            console.log(`✅ Active listing: ${business.name}`);
          }
        } catch (error) {
          console.error(`Error processing ${business.name}: ${error.message}`);
        }
      });

      await Promise.all(promises);

      if (i + batchSize < businesses.length) {
        console.log('Sleeping 5 seconds before next batch...');
        await sleep(5000);
      }
    }

    const totalRemaining = await Business.countDocuments();
    console.log(`\n📊 Cleanup Summary:`);
    console.log(`- Listings checked: ${checkedCount}`);
    console.log(`- Listings removed: ${removedCount}`);
    console.log(`- Listings remaining: ${totalRemaining}`);

  } catch (error) {
    console.error('Cleanup error:', error.message);
  } finally {
    if (mongoose.connection.readyState) await mongoose.disconnect();
    console.log('Cleanup completed:', new Date().toISOString());
  }
};

if (require.main === module) {
  cleanupInactiveListings();
}

module.exports = { cleanupInactiveListings };