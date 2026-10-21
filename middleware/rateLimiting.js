/**
 * Rate Limiting Configuration
 * Protects against abuse and DoS attacks
 *
 * SECURITY: Uses Redis-backed store for distributed rate limiting across
 * multiple server instances (Task 95.13-95.14)
 */

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const RedisStore = require('rate-limit-redis');
const { createClient } = require('redis');
const { securityLogger } = require('../server/utils/logger');
const { getSecureClientIp } = require('../server/utils/rateLimitEnhanced');

// SECURITY: Trusted proxy configuration
// Only accept X-Forwarded-For from known load balancers/proxies
const TRUSTED_PROXIES = (process.env.TRUSTED_PROXIES || '127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16').split(',');

/**
 * Check if an IP is in a trusted proxy range
 * Supports both exact match and CIDR notation
 */
function isInTrustedProxy(ip) {
  if (!ip) return false;

  for (const proxy of TRUSTED_PROXIES) {
    const trimmedProxy = proxy.trim();

    // Exact match
    if (trimmedProxy === ip) return true;

    // CIDR match (simplified for common ranges)
    if (trimmedProxy.includes('/')) {
      const [network, bits] = trimmedProxy.split('/');
      const networkParts = network.split('.').map(Number);
      const ipParts = ip.split('.').map(Number);
      const mask = parseInt(bits, 10);

      if (networkParts.length === 4 && ipParts.length === 4) {
        const networkNum = (networkParts[0] << 24) + (networkParts[1] << 16) + (networkParts[2] << 8) + networkParts[3];
        const ipNum = (ipParts[0] << 24) + (ipParts[1] << 16) + (ipParts[2] << 8) + ipParts[3];
        const maskNum = (0xffffffff << (32 - mask)) >>> 0;

        if ((networkNum & maskNum) === (ipNum & maskNum)) return true;
      }
    }
  }
  return false;
}

/**
 * SECURITY: Secure key generator that validates X-Forwarded-For header
 * Only trusts proxy headers from known trusted proxies
 */
function secureKeyGenerator(req) {
  // Walk X-Forwarded-For right to left from the socket peer and take the first address that is
  // not a trusted proxy (the same rule as Express's req.ip and getSecureClientIp). The leftmost
  // entry is client-supplied whenever a hop APPENDS rather than overwrites, so it must never
  // choose the key. A tailnet IPv6 is mapped to its unique IPv4 (see tailnetIpv4).
  return ipKeyGenerator(getSecureClientIp(req) || req.ip || 'unknown');
}

// Redis client for distributed rate limiting
let redisClient = null;
let redisStore = null;

/**
 * Initialize Redis connection for rate limiting
 * Falls back to memory store if Redis is unavailable
 */
async function initializeRedis() {
  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    redisClient = createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            securityLogger.warn('Redis reconnection limit reached, using memory store', { service: 'rate-limit' });
            return new Error('Redis reconnection limit reached');
          }
          return Math.min(retries * 100, 3000);
        },
      },
    });

    redisClient.on('error', (err) => {
      securityLogger.warn('Redis error', { service: 'rate-limit', error: err.message });
    });

    redisClient.on('connect', () => {
      securityLogger.info('Connected to Redis for distributed rate limiting', { service: 'rate-limit' });
    });

    await redisClient.connect();

    redisStore = new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
      prefix: 'rl:wrfcoin:',
    });

    securityLogger.info('Redis store initialized for distributed rate limiting', { service: 'rate-limit' });
  } catch (error) {
    securityLogger.warn('Redis not available, using memory store', { service: 'rate-limit', error: error.message });
    securityLogger.warn('Memory store does not work across multiple instances', { service: 'rate-limit' });
    redisStore = null;
  }
}

// Initialize Redis connection
initializeRedis();

/**
 * SECURITY: Sanitized error response
 * Don't expose internal details about rate limiting strategy
 */
function createRateLimitMessage(type) {
  return {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please try again later.',
      type: type,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a rate limiter with Redis store if available
 */
function createLimiter(config) {
  return rateLimit({
    windowMs: config.windowMs,
    max: config.max,
    standardHeaders: true,
    legacyHeaders: false,
    store: redisStore, // Uses Redis if available, falls back to memory
    keyGenerator: secureKeyGenerator,
    message: createRateLimitMessage(config.type || 'general'),
    handler: (req, res, next, options) => {
      // SECURITY: Log rate limit hits for monitoring
      securityLogger.warn('Rate limit exceeded', {
        type: config.type || 'general',
        ip: secureKeyGenerator(req),
        path: req.path,
        method: req.method
      });

      res.status(429).json(options.message);
    },
  });
}

// General API rate limiting
const generalLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  type: 'general',
});

// WebSocket connection limiting
const wsConnectionLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 connections per minute per IP
  type: 'websocket',
});

// Cross-chain transfer limiting (more restrictive for security)
const transferLimiter = createLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // 50 transfers per hour
  type: 'transfer',
});

// Weather data submission limiting
const weatherLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 2, // 2 submissions per minute (one every 30 seconds)
  type: 'weather',
});

// Auth endpoint limiting (stricter to prevent brute force)
const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per 15 minutes
  type: 'auth',
});

// ============================================================================
// Meshtastic LoRa Rate Limiters (Task 109)
// Key by Meshtastic node ID instead of IP address
// ============================================================================

/**
 * Create a Meshtastic-specific rate limiter that keys by node ID
 */
function createMeshtasticLimiter(config) {
  return rateLimit({
    windowMs: config.windowMs,
    max: config.max,
    standardHeaders: true,
    legacyHeaders: false,
    store: redisStore, // Uses Redis if available, falls back to memory
    keyGenerator: (req) => {
      // Key by Meshtastic node ID from request body
      const nodeId = req.body?.meshtasticNodeId || 'unknown';
      return `meshtastic:${config.prefix}:${nodeId}`;
    },
    message: createRateLimitMessage(config.type || 'meshtastic'),
    handler: (req, res, next, options) => {
      // SECURITY: Log rate limit hits for monitoring
      const nodeId = req.body?.meshtasticNodeId || 'unknown';
      securityLogger.warn('Meshtastic rate limit exceeded', {
        type: config.type || 'meshtastic',
        nodeId: nodeId,
        gatewayId: req.body?.gatewayId || 'unknown',
        path: req.path,
        method: req.method
      });

      res.status(429).json(options.message);
    },
  });
}

// Meshtastic transaction chunk rate limiting
// 60 chunks per minute per node to allow multi-chunk transactions
const meshtasticChunkLimiter = createMeshtasticLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 chunks per minute per node
  prefix: 'chunk',
  type: 'meshtastic_chunk',
});

// Meshtastic transaction rate limiting
// 20 complete transactions per hour per node
const meshtasticTxLimiter = createMeshtasticLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 transactions per hour per node
  prefix: 'tx',
  type: 'meshtastic_tx',
});

// Meshtastic observation rate limiting (for consistency with weatherLimiter)
const meshtasticObsLimiter = createMeshtasticLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 2, // 2 observations per minute per node
  prefix: 'obs',
  type: 'meshtastic_obs',
});

// Cleanup function for graceful shutdown
async function cleanup() {
  if (redisClient) {
    try {
      await redisClient.quit();
      securityLogger.info('Redis connection closed', { service: 'rate-limit' });
    } catch (error) {
      securityLogger.error('Error closing Redis connection', { service: 'rate-limit', error: error.message });
    }
  }
}

// Graceful shutdown handlers
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

module.exports = {
  generalLimiter,
  wsConnectionLimiter,
  transferLimiter,
  weatherLimiter,
  authLimiter,
  // Meshtastic rate limiters (Task 109)
  meshtasticChunkLimiter,
  meshtasticTxLimiter,
  meshtasticObsLimiter,
  cleanup,
  // Export for testing
  secureKeyGenerator,
  isInTrustedProxy,
  createMeshtasticLimiter,
};
