const Business = require('../models/business');
const natural = require('natural');

const processSearchQuery = async (query) => {
  console.log("Raw query:", query); // Debug
  const tokenizer = new natural.WordTokenizer();
  const tokens = tokenizer.tokenize(query.toLowerCase());

  let filters = {
    name: null,
    location: { city: null, state: null },
    price: { min: null, max: null }
  };

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].match(/\d+k/)) {
      const value = parseFloat(tokens[i].replace(/k/, '000'));
      if (tokens[i-1] === 'under') filters.price.max = value;
    }
    if (tokens[i] === 'in' && i < tokens.length - 1) {
      filters.location.city = tokens.slice(i + 1, tokens.indexOf('under') !== -1 ? tokens.indexOf('under') : tokens.length).join(' ');
    } else {
      // Use the raw query as name filter if no "in" or price
      filters.name = query;
    }
  }

  let dbQuery = {};
  if (filters.name) dbQuery.name = { $regex: filters.name, $options: 'i' };
  if (filters.location.city) dbQuery['location.city'] = { $regex: filters.location.city, $options: 'i' };
  if (filters.price.max) dbQuery.price = { $lte: filters.price.max };

  console.log("Search query:", dbQuery);
  const results = await Business.find(dbQuery).limit(10);
  console.log("Results found:", results);
  return results;
};

module.exports = { processSearchQuery };