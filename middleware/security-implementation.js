/**
 * Security Implementation - Active Security Headers and Rate Limiting
 * Implements comprehensive security measures for the Wrfcoin system
 */

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { securityLoggerMiddleware, appLogger } = require('../server/utils/logger');

// Comprehensive Security Headers
const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "'unsafe-eval'",
        'https://cdn.jsdelivr.net',
        'https://unpkg.com',
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://fonts.googleapis.com',
        'https://cdn.jsdelivr.net',
      ],
      fontSrc: [
        "'self'",
        'https://fonts.gstatic.com',
        'https://cdn.jsdelivr.net',
      ],
      imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc: ["'self'", 'wss:', 'ws:', 'https:', 'http:'],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
    },
  },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: {
    policy: ['strict-origin-when-cross-origin'],
  },
  frameguard: { action: 'deny' },
  dnsPrefetchControl: true,
  ieNoOpen: true,
  permittedCrossDomainPolicies: false,
});

// Multi-Tier Rate Limiting Configuration

// General API Rate Limiting: 100 requests per 15 minutes
const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: {
    error: 'Rate limit exceeded',
    limit: 100,
    window: '15 minutes',
    retryAfter: 'Please try again in 15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    securityLogger.warn('Rate limit exceeded', { ip: req.ip, path: req.path });
    res.status(429).json({
      error: 'Too many requests',
      limit: 100,
      window: '15 minutes',
    });
  },
});

// WebSocket Connection Limiting: 10 connections per minute
const wsConnectionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: {
    error: 'WebSocket connection limit exceeded',
    limit: 10,
    window: '1 minute',
  },
  handler: (req, res) => {
    securityLogger.warn('WebSocket rate limit exceeded', { ip: req.ip });
    res.status(429).json({
      error: 'Too many WebSocket connections',
      limit: 10,
      window: '1 minute',
    });
  },
});

// Cross-Chain Transfer Limiting: 50 transfers per hour
const transferLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  message: {
    error: 'Transfer rate limit exceeded',
    limit: 50,
    window: '1 hour',
  },
  handler: (req, res) => {
    securityLogger.warn('Transfer rate limit exceeded', { ip: req.ip, amount: req.body.amount });
    res.status(429).json({
      error: 'Too many cross-chain transfers',
      limit: 50,
      window: '1 hour',
    });
  },
});

// Weather Submission Limiting: 2 submissions per minute
const weatherLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 2,
  message: {
    error: 'Weather submission rate limit exceeded',
    limit: 2,
    window: '1 minute',
  },
  handler: (req, res) => {
    securityLogger.warn('Weather rate limit exceeded', { ip: req.ip });
    res.status(429).json({
      error: 'Too many weather submissions',
      limit: 2,
      window: '1 minute',
    });
  },
});

// Strict Rate Limiting for Sensitive Operations: 20 requests per 5 minutes
const strictLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20,
  message: {
    error: 'Strict rate limit exceeded for sensitive operation',
    limit: 20,
    window: '5 minutes',
  },
  handler: (req, res) => {
    securityLogger.warn('Strict rate limit exceeded for sensitive endpoint', { ip: req.ip, path: req.path });
    res.status(429).json({
      error: 'Rate limit exceeded for sensitive operations',
      limit: 20,
      window: '5 minutes',
    });
  },
});

// Input Validation Middleware
const validateTransferInput = [
  body('amount')
    .isFloat({ min: 0.0001, max: 10000 })
    .withMessage('Transfer amount must be between 0.0001 and 10,000'),
  body('fromChain')
    .isIn([
      'ethereum',
      'polygon',
      'bsc',
      'avalanche',
      'arbitrum',
      'optimism',
      'fantom',
    ])
    .withMessage('Invalid source chain'),
  body('toChain')
    .isIn([
      'ethereum',
      'polygon',
      'bsc',
      'avalanche',
      'arbitrum',
      'optimism',
      'fantom',
    ])
    .withMessage('Invalid target chain'),
  body('token')
    .isIn(['WRF', 'ETH', 'MATIC', 'BNB', 'AVAX'])
    .withMessage('Unsupported token'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      securityLogger.warn('Validation failed', { ip: req.ip, errors: errors.array() });
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array(),
      });
    }
    next();
  },
];

// Security Logging Middleware
const securityLoggerMiddleware = eventType => {
  return (req, res, next) => {
    securityLogger.info('Security Event', {
      eventType,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString(),
      path: req.path,
      method: req.method,
    });
    next();
  };
};

// Apply Security to Express App
const applySecurity = app => {
  // Apply security headers to all routes
  app.use(securityHeaders);

  // Apply general rate limiting to all API routes
  app.use('/api/', generalApiLimiter);

  // Apply specific rate limiters to targeted endpoints
  app.use('/api/websocket', wsConnectionLimiter);
  app.use('/api/crosschain/transfer', transferLimiter, validateTransferInput);
  app.use('/api/weather/submit', weatherLimiter);
  app.use('/api/wallet/', strictLimiter);
  app.use('/api/auth/', strictLimiter);

  appLogger.info('Security headers and rate limiting applied successfully', {
    rateLimits: {
      generalApi: '100 requests/15min',
      webSocket: '10 connections/min',
      crossChain: '50 transfers/hour',
      weather: '2 submissions/min',
      sensitiveOps: '20 requests/5min'
    }
  });
};

module.exports = {
  securityHeaders,
  generalApiLimiter,
  wsConnectionLimiter,
  transferLimiter,
  weatherLimiter,
  strictLimiter,
  validateTransferInput,
  securityLoggerMiddleware,
  applySecurity,
};
