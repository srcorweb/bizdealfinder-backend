require('dotenv').config();
const { scrapeBusinesses } = require('./scraping');

const runScraper = async () => {
  console.log('Starting manual scraper test...');
  console.log('Timestamp:', new Date().toISOString());
  
  try {
    await scrapeBusinesses();
    console.log('Manual scraper test completed successfully!');
  } catch (error) {
    console.error('Manual scraper test failed:', error.message);
    console.error('Stack trace:', error.stack);
  } finally {
    process.exit(0);
  }
};

// Run the scraper
runScraper();