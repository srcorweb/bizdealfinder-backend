const mongoose = require('mongoose');
const AppSumoCode = require('../models/appSumoCode');
require('dotenv').config();

mongoose.connect(process.env.DB_DATABASE || 'mongodb://localhost:27017/bizdealfinder');

const generateRandomCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'AS-';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const generateCodes = async () => {
  try {
    console.log('🚀 Starting AppSumo code generation...');

    const codeConfig = [
      { tier: 1, count: 5 },
      { tier: 2, count: 3 },
      { tier: 3, count: 1 }
    ];

    const allCodes = [];

    for (const config of codeConfig) {
      console.log(`Generating ${config.count} codes for Tier ${config.tier}...`);

      for (let i = 0; i < config.count; i++) {
        let code;
        let isUnique = false;

        while (!isUnique) {
          code = generateRandomCode();
          const existingCode = await AppSumoCode.findOne({ code });
          if (!existingCode) {
            isUnique = true;
          }
        }

        allCodes.push({
          code,
          tier: config.tier
        });
      }
    }

    console.log(`💾 Inserting ${allCodes.length} codes into database...`);
    await AppSumoCode.insertMany(allCodes);

    console.log('✅ Successfully generated AppSumo codes:');
    console.log(`   - Tier 1: ${codeConfig[0].count} codes`);
    console.log(`   - Tier 2: ${codeConfig[1].count} codes`);
    console.log(`   - Tier 3: ${codeConfig[2].count} codes`);
    console.log(`   - Total: ${allCodes.length} codes`);

    console.log('\n📋 Sample codes generated:');
    const sampleCodes = await AppSumoCode.find().limit(10);
    sampleCodes.forEach(code => {
      console.log(`   ${code.code} - Tier ${code.tier}`);
    });

    process.exit(0);
  } catch (error) {
    console.error('❌ Error generating codes:', error);
    process.exit(1);
  }
};

const exportToCsv = async () => {
  try {
    const fs = require('fs');
    const codes = await AppSumoCode.find().sort({ tier: 1, code: 1 });

    let csvContent = 'Code,Tier,Status\n';
    codes.forEach(code => {
      csvContent += `${code.code},${code.tier},${code.isRedeemed ? 'Redeemed' : 'Available'}\n`;
    });

    fs.writeFileSync('appsumo_codes.csv', csvContent);
    console.log('📊 Codes exported to appsumo_codes.csv');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error exporting codes:', error);
    process.exit(1);
  }
};

const command = process.argv[2];

if (command === 'generate') {
  generateCodes();
} else if (command === 'export') {
  exportToCsv();
} else {
  console.log('Usage:');
  console.log('  node generateAppSumoCodes.js generate  - Generate new codes');
  console.log('  node generateAppSumoCodes.js export    - Export codes to CSV');
  process.exit(1);
}