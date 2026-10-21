/**
 * Deployment Script for Carbon Credit API
 * Deploys the Carbon Credit API service with proper configuration
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
const { carbonCreditAPI } = require('../backend/api/carbon-credit-api');

// Environment configuration
const PORT = process.env.PORT || 4001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5000';

// Logger setup
const logger = winston.createLogger({
  level: NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'carbon-credit-api' },
  transports: [
    new winston.transports.File({
      filename: 'logs/carbon-api-error.log',
      level: 'error',
    }),
    new winston.transports.File({
      filename: 'logs/carbon-api-combined.log',
    }),
  ],
});

// Add console transport for development
if (NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  );
}

// Create Express app
const app = express();

// Trust proxy for proper IP detection behind load balancers
app.set('trust proxy', 1);

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  })
);

// CORS configuration
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      FRONTEND_URL,
      'http://localhost:3000',
      'http://localhost:5000',
      'https://app.wrfcoin.org',
      'https://testnet.wrfcoin.org',
    ];

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn('CORS blocked origin', { origin });
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
};

app.use(cors(corsOptions));

// Rate limiting
const createRateLimit = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    max,
    message: {
      success: false,
      error: message,
      timestamp: new Date().toISOString(),
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn('Rate limit exceeded', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        path: req.path,
      });
      res.status(429).json({
        success: false,
        error: message,
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown',
      });
    },
  });

// Different rate limits for different endpoints
app.use(
  '/api/amm/swap',
  createRateLimit(60 * 1000, 10, 'Swap rate limit exceeded')
);
app.use(
  '/api/amm/add-liquidity',
  createRateLimit(60 * 1000, 10, 'Liquidity operation rate limit exceeded')
);
app.use(
  '/api/yield-farming/stake',
  createRateLimit(60 * 1000, 5, 'Staking rate limit exceeded')
);
app.use(
  '/api/insurance/create-policy',
  createRateLimit(60 * 1000, 3, 'Insurance creation rate limit exceeded')
);
app.use(
  '/api',
  createRateLimit(15 * 60 * 1000, 100, 'General API rate limit exceeded')
);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info('HTTP Request', {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration,
      userAgent: req.get('User-Agent'),
      ip: req.ip,
      requestId: req.headers['x-request-id'] || 'unknown',
    });
  });

  next();
});

// Request ID middleware
app.use((req, res, next) => {
  if (!req.headers['x-request-id']) {
    req.headers['x-request-id'] =
      `api-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  next();
});

// Health check endpoint — probes all dependencies
app.get('/health', async (req, res) => {
  const [blockchain, database, redis] = await Promise.all([
    checkBlockchainHealth(),
    checkDatabaseHealth(),
    checkRedisHealth(),
  ]);

  const dependencies = { blockchain, database, redis };
  const allHealthy = Object.values(dependencies).every(s => s === 'healthy');

  const healthStatus = {
    status: allHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    environment: NODE_ENV,
    nodeVersion: process.version,
    memoryUsage: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      unit: 'MB',
    },
    dependencies,
  };

  res.status(allHealthy ? 200 : 503).json(healthStatus);
});

// Readiness probe — returns 503 if critical dependencies are unhealthy
app.get('/ready', async (req, res) => {
  const database = await checkDatabaseHealth();

  if (database !== 'healthy') {
    return res.status(503).json({
      ready: false,
      reason: 'Critical dependency unhealthy',
      dependencies: { database },
    });
  }

  res.status(200).json({ ready: true });
});

// API routes
app.use('/api', carbonCreditAPI);

// 404 handler
app.use('*', (req, res) => {
  logger.warn('404 Not Found', {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
  });

  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    timestamp: new Date().toISOString(),
    requestId: req.headers['x-request-id'] || 'unknown',
  });
});

// Global error handler
app.use((error, req, res, next) => {
  const requestId = req.headers['x-request-id'] || 'unknown';

  logger.error('Unhandled API Error', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    requestId,
  });

  // Don't leak error details in production
  const errorMessage =
    NODE_ENV === 'production' ? 'Internal server error' : error.message;

  res.status(500).json({
    success: false,
    error: errorMessage,
    timestamp: new Date().toISOString(),
    requestId,
  });
});

// Graceful shutdown handling
const gracefulShutdown = signal => {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  server.close(err => {
    if (err) {
      logger.error('Error during server shutdown', { error: err.message });
      process.exit(1);
    }

    logger.info('Server closed successfully');
    process.exit(0);
  });

  // Force exit after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
};

// Process event handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', error => {
  logger.error('Uncaught Exception', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', {
    reason: reason?.message || reason,
    promise: promise?.toString(),
  });
  process.exit(1);
});

// Start server
const server = app.listen(PORT, () => {
  logger.info('Carbon Credit API Server started', {
    port: PORT,
    environment: NODE_ENV,
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
  });

  // Display startup information
  logger.info('Carbon Credit API Server Started Successfully!');
  logger.info('Server configuration', {
    port: PORT,
    environment: NODE_ENV,
    healthCheck: `http://localhost:${PORT}/health`,
    apiBaseUrl: `http://localhost:${PORT}/api`
  });
  logger.info('Available endpoints', {
    endpoints: [
      'GET /api/carbon-credits/batches - Get carbon credit batches',
      'POST /api/carbon-credits/transfer - Transfer carbon credits',
      'POST /api/carbon-credits/batches/:id/retire - Retire carbon credits',
      'GET /api/amm/pools - Get AMM pools',
      'POST /api/amm/swap - Execute token swap',
      'GET /api/yield-farming/pools - Get farming pools',
      'POST /api/yield-farming/stake - Stake tokens',
      'GET /api/insurance/policies - Get insurance policies',
      'POST /api/insurance/create-policy - Create insurance policy',
      'GET /api/oracles/carbon-prices - Get carbon prices',
      'GET /api/oracles/weather-data - Get weather data'
    ]
  });
  logger.info('Documentation available at /docs/API_DOCUMENTATION.md');
  logger.info('Ready to accept requests!');
});

// Export for testing
module.exports = { app, server };

// Blockchain health check — probes the configured RPC endpoint
async function checkBlockchainHealth() {
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL;
  if (!rpcUrl) return 'not_configured';
  try {
    const http = require('http');
    const https = require('https');
    const url = new URL(rpcUrl);
    const client = url.protocol === 'https:' ? https : http;
    return await new Promise((resolve) => {
      const req = client.request(url, { method: 'POST', timeout: 3000, headers: { 'Content-Type': 'application/json' } }, (res) => {
        resolve(res.statusCode < 500 ? 'healthy' : 'unhealthy');
        res.resume();
      });
      req.on('error', () => resolve('unhealthy'));
      req.on('timeout', () => { req.destroy(); resolve('unhealthy'); });
      req.write(JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }));
      req.end();
    });
  } catch (error) {
    logger.error('Blockchain health check failed', { error: error.message });
    return 'unhealthy';
  }
}

// Database health check — tests connection with a simple query
async function checkDatabaseHealth() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return 'not_configured';
  try {
    const { Client } = require('pg');
    const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 3000 });
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return 'healthy';
  } catch (error) {
    logger.error('Database health check failed', { error: error.message });
    return 'unhealthy';
  }
}

// Redis health check — tests connection with PING
async function checkRedisHealth() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return 'not_configured';
  try {
    const Redis = require('ioredis');
    const redis = new Redis(redisUrl, { connectTimeout: 3000, lazyConnect: true });
    await redis.connect();
    const result = await redis.ping();
    await redis.quit();
    return result === 'PONG' ? 'healthy' : 'unhealthy';
  } catch (error) {
    logger.error('Redis health check failed', { error: error.message });
    return 'unhealthy';
  }
}
