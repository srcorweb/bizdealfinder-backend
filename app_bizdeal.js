require("dotenv").config();
const express = require("express");
const path = require("path");
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const fileUpload = require('express-fileupload');
const cors = require("cors");
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const { format, transports } = require('winston');
const { scrapeBusinesses } = require('./service/scraper');
const cron = require('node-cron');
const axios = require('axios');

require("./config/db");
const { authMiddleware } = require('./requests/middleware/AuthMiddleware');
const authRouter = require('./controllers/user/userRoute');
const businessRoute = require('./controllers/business/businessRoute');
const userRoute = require('./controllers/user/userRoute');

const app = express();

app.set('trust proxy', false);

const logger = winston.createLogger({
  level: 'info',
  format: format.combine(
    format.colorize(),
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(({ timestamp, level, message, ...meta }) => {
      return `${timestamp} [${level}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
    })
  ),
  transports: [new transports.Console()],
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('Request completed', {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      responseTime: `${Date.now() - start}ms`,
    });
  });
  next();
});

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests
  message: 'Too many requests, please try again later.',
  handler: (req, res) => {
    logger.warn(`Rate limit exceeded for IP: ${req.ip}`);
    res.status(429).send('Too many requests, please try again later.');
  }
});

// Apply rate limiter selectively, excluding specific endpoints
app.use((req, res, next) => {
  const excludedPaths = [
    '/business/ai-search',
    '/business/saved',
    '/business/suggest',
    '/business/generate-loading-text'
  ];
  const isExcluded = excludedPaths.some(path => req.path.startsWith(path));
  if (isExcluded) {
    return next();
  }
  return limiter(req, res, next);
});

const corsOpts = {
  origin: (origin, callback) => {
    const allowedOrigins = process.env.APP_TYPE === 'production' ? process.env.CORS_ALLOWED_ORIGINS.split(',') : "*";
    if (allowedOrigins === "*" || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
};

app.use(cors(corsOpts));

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(fileUpload({
  limits: { fileSize: 50 * 1024 * 1024 },
  safeFileNames: true,
  preserveExtension: true,
}));
app.use(bodyParser.json());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Apply authMiddleware selectively
app.use((req, res, next) => {
  if (req.path === '/auth/verify-email') {
    return next(); // Skip authMiddleware for verify-email
  }
  return authMiddleware(req, res, next);
});

app.use('/auth', authRouter);
app.use('/business', businessRoute);
app.use('/user', userRoute);

const checkMatches = async (newListings) => {
  try {
    const response = await axios.post('http://localhost:3000/business/check-matches', { listings: newListings });
    console.log('Matches response:', response.data);
  } catch (error) {
    console.error('Error checking matches:', error.message);
  }
};

cron.schedule('0 */3 * * *', async () => {
  console.log('Running scraper and checking matches...');
  const newListings = await scrapeBusinesses();
  await checkMatches(newListings);
});

app.use((err, req, res, next) => {
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;