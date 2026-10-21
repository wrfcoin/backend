/**
 * Advanced Rate Limiting Implementation for Wrfcoin Core
 * Provides distributed rate limiting with Redis support and multiple strategies
 */

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const RedisStore = require('rate-limit-redis');
const Redis = require('redis');

class WrfcoinRateLimiter {
  constructor() {
    this.redisClient = null;
    this.store = null;
    this.limiters = new Map();
    this.initializeRedis();
  }

  // Initialize Redis connection for distributed rate limiting
  async initializeRedis() {
    try {
      // Use in-memory store if Redis is not available
      if (process.env.REDIS_URL) {
        this.redisClient = Redis.createClient({
          url: process.env.REDIS_URL,
          password: process.env.REDIS_PASSWORD || '',
          retry_strategy: times => Math.min(times * 50, 2000),
        });

        this.redisClient.on('error', err => {
          console.warn(
            'Redis rate limiter error, falling back to memory store:',
            err.message
          );
          this.store = null;
        });

        this.redisClient.on('connect', () => {
          console.log('Rate limiter connected to Redis');
          this.store = new RedisStore({
            client: this.redisClient,
            prefix: 'wrfcoin:rl:',
          });
        });

        await this.redisClient.connect();
      }
    } catch (error) {
      console.warn(
        'Redis not available for rate limiting, using memory store:',
        error.message
      );
      this.store = null;
    }
  }

  // Create rate limiter with specific configuration
  createLimiter(name, options = {}) {
    const config = {
      windowMs: options.windowMs || 15 * 60 * 1000, // 15 minutes
      max: options.max || 1000, // requests per window
      message: options.message || {
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests, please try again later',
          retryAfter: Math.ceil((options.windowMs || 15 * 60 * 1000) / 1000),
        },
      },
      standardHeaders: true,
      legacyHeaders: false,
      store: this.store, // Use Redis store if available
      keyGenerator: options.keyGenerator || this.defaultKeyGenerator,
      skip: options.skip || this.defaultSkip,
      onLimitReached: options.onLimitReached || this.defaultOnLimitReached,
      ...options,
    };

    const limiter = rateLimit(config);
    this.limiters.set(name, { limiter, config });

    return limiter;
  }

  // Default key generator (IP-based)
  defaultKeyGenerator(req) {
    return ipKeyGenerator(req.ip || req.connection.remoteAddress || 'unknown');
  }

  // Default skip function
  defaultSkip(req) {
    // Skip rate limiting for health checks
    if (req.path === '/health' || req.path === '/ping') {
      return true;
    }

    // Skip for whitelisted IPs
    const whitelist = process.env.RATE_LIMIT_WHITELIST?.split(',') || [];
    return whitelist.includes(req.ip);
  }

  // Default limit reached handler
  defaultOnLimitReached(req, res, options) {
    console.warn('Rate limit exceeded', {
      ip: req.ip,
      path: req.path,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString(),
    });
  }

  // User-based key generator
  userKeyGenerator(req) {
    const userId = req.user?.id || req.headers['x-user-id'];
    return userId ? `user:${userId}` : this.defaultKeyGenerator(req);
  }

  // API key-based generator
  apiKeyGenerator(req) {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    return apiKey ? `api:${apiKey}` : this.defaultKeyGenerator(req);
  }

  // Get general API rate limiter
  getGeneralLimiter() {
    if (!this.limiters.has('general')) {
      this.createLimiter('general', {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 1000, // 1000 requests per 15 minutes
        message: {
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'API rate limit exceeded. Please try again later.',
            retryAfter: 900, // 15 minutes in seconds
          },
        },
      });
    }
    return this.limiters.get('general').limiter;
  }

  // Get strict rate limiter for sensitive endpoints
  getStrictLimiter() {
    if (!this.limiters.has('strict')) {
      this.createLimiter('strict', {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 100, // 100 requests per 15 minutes
        keyGenerator: this.userKeyGenerator.bind(this),
        message: {
          success: false,
          error: {
            code: 'STRICT_RATE_LIMIT_EXCEEDED',
            message: 'Strict rate limit exceeded for sensitive operations.',
            retryAfter: 900,
          },
        },
      });
    }
    return this.limiters.get('strict').limiter;
  }

  // Get authentication rate limiter
  getAuthLimiter() {
    if (!this.limiters.has('auth')) {
      this.createLimiter('auth', {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 20, // 20 login attempts per 15 minutes
        skipSuccessfulRequests: true,
        message: {
          success: false,
          error: {
            code: 'AUTH_RATE_LIMIT_EXCEEDED',
            message:
              'Too many authentication attempts. Please try again later.',
            retryAfter: 900,
          },
        },
      });
    }
    return this.limiters.get('auth').limiter;
  }

  // Get blockchain operation limiter
  getBlockchainLimiter() {
    if (!this.limiters.has('blockchain')) {
      this.createLimiter('blockchain', {
        windowMs: 60 * 1000, // 1 minute
        max: 50, // 50 blockchain operations per minute
        keyGenerator: this.userKeyGenerator.bind(this),
        message: {
          success: false,
          error: {
            code: 'BLOCKCHAIN_RATE_LIMIT_EXCEEDED',
            message: 'Blockchain operation rate limit exceeded.',
            retryAfter: 60,
          },
        },
      });
    }
    return this.limiters.get('blockchain').limiter;
  }

  // Get cross-chain bridge limiter
  getCrossChainLimiter() {
    if (!this.limiters.has('crosschain')) {
      this.createLimiter('crosschain', {
        windowMs: 5 * 60 * 1000, // 5 minutes
        max: 10, // 10 cross-chain operations per 5 minutes
        keyGenerator: this.userKeyGenerator.bind(this),
        message: {
          success: false,
          error: {
            code: 'CROSS_CHAIN_RATE_LIMIT_EXCEEDED',
            message: 'Cross-chain operation rate limit exceeded.',
            retryAfter: 300,
          },
        },
      });
    }
    return this.limiters.get('crosschain').limiter;
  }

  // Get file upload limiter
  getUploadLimiter() {
    if (!this.limiters.has('upload')) {
      this.createLimiter('upload', {
        windowMs: 60 * 60 * 1000, // 1 hour
        max: 100, // 100 uploads per hour
        keyGenerator: this.userKeyGenerator.bind(this),
        message: {
          success: false,
          error: {
            code: 'UPLOAD_RATE_LIMIT_EXCEEDED',
            message: 'File upload rate limit exceeded.',
            retryAfter: 3600,
          },
        },
      });
    }
    return this.limiters.get('upload').limiter;
  }

  // Get WebSocket connection limiter
  getWebSocketLimiter() {
    if (!this.limiters.has('websocket')) {
      this.createLimiter('websocket', {
        windowMs: 5 * 60 * 1000, // 5 minutes
        max: 20, // 20 WebSocket connections per 5 minutes
        message: {
          success: false,
          error: {
            code: 'WEBSOCKET_RATE_LIMIT_EXCEEDED',
            message: 'WebSocket connection rate limit exceeded.',
            retryAfter: 300,
          },
        },
      });
    }
    return this.limiters.get('websocket').limiter;
  }

  // Create custom limiter
  createCustomLimiter(name, windowMs, maxRequests, keyGenerator = null) {
    return this.createLimiter(name, {
      windowMs,
      max: maxRequests,
      keyGenerator: keyGenerator || this.defaultKeyGenerator.bind(this),
      message: {
        success: false,
        error: {
          code: 'CUSTOM_RATE_LIMIT_EXCEEDED',
          message: `Rate limit exceeded for ${name}`,
          retryAfter: Math.ceil(windowMs / 1000),
        },
      },
    });
  }

  // Middleware factory for specific endpoints
  createEndpointLimiter(endpoint, options = {}) {
    const limiterName = `endpoint:${endpoint}`;
    return this.createLimiter(limiterName, {
      windowMs: options.windowMs || 15 * 60 * 1000,
      max: options.max || 100,
      keyGenerator: options.keyGenerator || this.defaultKeyGenerator.bind(this),
      ...options,
    });
  }

  // Get rate limit status for debugging
  async getRateLimitStatus(key = 'default') {
    if (!this.redisClient) {
      return { error: 'Redis not available for status check' };
    }

    try {
      const hits = await this.redisClient.get(`wrfcoin:rl:${key}`);
      return {
        key,
        hits: parseInt(hits) || 0,
        store: this.store ? 'redis' : 'memory',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  // Clean up resources
  async cleanup() {
    if (this.redisClient) {
      await this.redisClient.quit();
    }
  }

  // Get all limiter configurations
  getLimiterConfigs() {
    const configs = {};
    for (const [name, { config }] of this.limiters.entries()) {
      configs[name] = {
        windowMs: config.windowMs,
        max: config.max,
        store: this.store ? 'redis' : 'memory',
      };
    }
    return configs;
  }
}

// Create singleton instance
const rateLimiter = new WrfcoinRateLimiter();

// Graceful shutdown
process.on('SIGTERM', async () => {
  await rateLimiter.cleanup();
});

process.on('SIGINT', async () => {
  await rateLimiter.cleanup();
});

module.exports = {
  WrfcoinRateLimiter,
  rateLimiter,
};
