/**
 * OpenForis-Specific Rate Limiting Middleware
 *
 * Implements tiered rate limiting for OpenForis API endpoints with
 * Redis-based storage for scalability and different limits per endpoint type.
 */

import { Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { createClient, RedisClientType } from 'redis';
import { rateLimiter } from '../../utils/rate-limiter.js';
import { appLogger } from '../utils/logger.js';

// Extended Request interface for OpenForis context
interface OpenForisRequest extends Request {
  rateLimitInfo?: {
    tier: string;
    limit: number;
    windowMs: number;
    remaining: number;
  };
}

// Rate limiting configuration for different OpenForis operations
interface OpenForisRateLimitConfig {
  // General API access
  general: {
    windowMs: number;
    max: number;
  };
  // Project operations (create, update)
  projects: {
    windowMs: number;
    max: number;
  };
  // Survey submissions
  surveys: {
    windowMs: number;
    max: number;
  };
  // Earth Map analysis (computationally expensive)
  analysis: {
    windowMs: number;
    max: number;
  };
  // Climate data queries
  climate: {
    windowMs: number;
    max: number;
  };
  // Blockchain export operations
  blockchain: {
    windowMs: number;
    max: number;
  };
}

// Default rate limiting configuration
const DEFAULT_OPENFORIS_LIMITS: OpenForisRateLimitConfig = {
  general: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // 200 requests per 15 minutes
  },
  projects: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 50, // 50 project operations per hour
  },
  surveys: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 100, // 100 survey submissions per hour
  },
  analysis: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20, // 20 analysis operations per hour (expensive)
  },
  climate: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300, // 300 climate queries per 15 minutes
  },
  blockchain: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 25, // 25 blockchain exports per hour
  },
};

// User tier configuration for different rate limits
interface UserTier {
  name: string;
  multiplier: number; // Multiplier for default limits
  description: string;
}

const USER_TIERS: Record<string, UserTier> = {
  free: {
    name: 'Free Tier',
    multiplier: 1,
    description: 'Standard rate limits for free users',
  },
  premium: {
    name: 'Premium Tier',
    multiplier: 2,
    description: 'Double rate limits for premium users',
  },
  enterprise: {
    name: 'Enterprise Tier',
    multiplier: 5,
    description: 'High rate limits for enterprise users',
  },
  admin: {
    name: 'Administrator',
    multiplier: 10,
    description: 'Administrative access with highest limits',
  },
};

class OpenForisRateLimiter {
  private redisClient: RedisClientType | null = null;
  private store: any = null;
  private config: OpenForisRateLimitConfig;
  private limiters: Map<string, any> = new Map();

  constructor(customConfig?: Partial<OpenForisRateLimitConfig>) {
    this.config = { ...DEFAULT_OPENFORIS_LIMITS, ...customConfig };
    this.initializeRedis();
  }

  private async initializeRedis(): Promise<void> {
    try {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

      this.redisClient = createClient({
        url: redisUrl,
        socket: {
          reconnectStrategy: retries => Math.min(retries * 50, 2000),
        },
      });

      this.redisClient.on('error', err => {
        appLogger.warn('OpenForis Rate Limiter Redis error, falling back to memory store', {
          operation: 'openforis:rate-limiter:redis:error',
          error: err.message,
        });
        this.store = null;
      });

      this.redisClient.on('connect', () => {
        appLogger.info('OpenForis Rate Limiter connected to Redis', {
          operation: 'openforis:rate-limiter:redis:connect',
        });
        this.store = new RedisStore({
          sendCommand: (...args: string[]) =>
            this.redisClient!.sendCommand(args),
          prefix: 'openforis:rl:',
        });
      });

      await this.redisClient.connect();
    } catch (error) {
      appLogger.warn('Redis not available for OpenForis rate limiting, using memory store', {
        operation: 'openforis:rate-limiter:redis:unavailable',
        error: (error as Error).message,
      });
      this.store = null;
    }
  }

  /**
   * Determine user tier based on role and permissions
   */
  private getUserTier(req: OpenForisRequest): string {
    if (!req.user) {
      return 'free'; // Anonymous users get free tier
    }

    const { role } = req.user;
    const permissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];

    // Admin role gets admin tier
    if (role === 'admin' || permissions.includes('admin')) {
      return 'admin';
    }

    // Enterprise users (multiple premium permissions)
    if (
      permissions.includes('enterprise') ||
      (permissions.includes('premium') &&
        permissions.includes('bulk_operations'))
    ) {
      return 'enterprise';
    }

    // Premium users
    if (permissions.includes('premium') || role === 'premium') {
      return 'premium';
    }

    return 'free';
  }

  /**
   * Generate rate limiting key based on user identification
   */
  private generateKey(req: OpenForisRequest, prefix: string): string {
    // Use user ID if authenticated
    if (req.user?.id) {
      return `${prefix}:user:${req.user.id}`;
    }

    // Use API key if provided
    if (req.apiKey) {
      return `${prefix}:api:${(req.apiKey as any).key || req.apiKey.id || 'unknown'}`;
    }

    // Fall back to IP address
    return `${prefix}:ip:${ipKeyGenerator(req.ip || 'unknown')}`;
  }

  /**
   * Create rate limiter for specific OpenForis operation type
   */
  private createLimiter(operationType: keyof OpenForisRateLimitConfig): any {
    const baseConfig = this.config[operationType];

    return rateLimit({
      windowMs: baseConfig.windowMs,
      max: ((req: OpenForisRequest) => {
        const tier = this.getUserTier(req);
        const multiplier = USER_TIERS[tier].multiplier;
        const limit = Math.floor(baseConfig.max * multiplier);

        // Add rate limit info to request for logging
        req.rateLimitInfo = {
          tier,
          limit,
          windowMs: baseConfig.windowMs,
          remaining: 0, // Will be updated by express-rate-limit
        };

        return limit;
      }) as any,
      keyGenerator: ((req: OpenForisRequest) =>
        this.generateKey(req, operationType)) as any,
      store: this.store,
      standardHeaders: true,
      legacyHeaders: false,
      message: (req: OpenForisRequest) => {
        // SECURITY: Don't expose tier, limit, or window details (Task 95.12)
        // These could help attackers understand rate limiting strategy
        const retryAfter = Math.ceil(baseConfig.windowMs / 1000);

        // Log full details server-side for debugging
        const tier = this.getUserTier(req);
        appLogger.warn('Rate limit exceeded', {
          operation: 'openforis:rate-limiter:exceeded',
          operationType,
          tier,
          userId: req.user?.id || 'anonymous',
          ip: req.ip,
        });

        return {
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please try again later.',
            retryAfter,
          },
          timestamp: new Date().toISOString(),
        };
      },
      // onLimitReached: (req: OpenForisRequest) => {
      //   console.warn('OpenForis rate limit exceeded', {
      //     operation: operationType,
      //     userTier: this.getUserTier(req),
      //     userId: req.user?.id || 'anonymous',
      //     ip: req.ip,
      //     path: req.path,
      //     timestamp: new Date().toISOString(),
      //   });
      // },
      skip: ((req: OpenForisRequest) => {
        // Skip rate limiting for health checks
        if (req.path === '/api/openforis/status') {
          return true;
        }

        // Skip for admin users in development mode
        if (
          process.env.NODE_ENV === 'development' &&
          req.user?.role === 'admin'
        ) {
          return true;
        }

        return false;
      }) as any,
    });
  }

  /**
   * Get general rate limiter for OpenForis API
   */
  getGeneralLimiter(): any {
    if (!this.limiters.has('general')) {
      this.limiters.set('general', this.createLimiter('general'));
    }
    return this.limiters.get('general');
  }

  /**
   * Get project operations rate limiter
   */
  getProjectLimiter(): any {
    if (!this.limiters.has('projects')) {
      this.limiters.set('projects', this.createLimiter('projects'));
    }
    return this.limiters.get('projects');
  }

  /**
   * Get survey submission rate limiter
   */
  getSurveyLimiter(): any {
    if (!this.limiters.has('surveys')) {
      this.limiters.set('surveys', this.createLimiter('surveys'));
    }
    return this.limiters.get('surveys');
  }

  /**
   * Get analysis operation rate limiter (most restrictive)
   */
  getAnalysisLimiter(): any {
    if (!this.limiters.has('analysis')) {
      this.limiters.set('analysis', this.createLimiter('analysis'));
    }
    return this.limiters.get('analysis');
  }

  /**
   * Get climate data query rate limiter
   */
  getClimateLimiter(): any {
    if (!this.limiters.has('climate')) {
      this.limiters.set('climate', this.createLimiter('climate'));
    }
    return this.limiters.get('climate');
  }

  /**
   * Get blockchain export rate limiter
   */
  getBlockchainLimiter(): any {
    if (!this.limiters.has('blockchain')) {
      this.limiters.set('blockchain', this.createLimiter('blockchain'));
    }
    return this.limiters.get('blockchain');
  }

  /**
   * Middleware to add rate limit information to response headers
   */
  addRateLimitHeaders(): (
    req: OpenForisRequest,
    res: Response,
    next: NextFunction
  ) => void {
    return (req: OpenForisRequest, res: Response, next: NextFunction) => {
      if (req.rateLimitInfo) {
        res.setHeader('X-RateLimit-Tier', req.rateLimitInfo.tier);
        res.setHeader('X-RateLimit-Limit', req.rateLimitInfo.limit);
        res.setHeader('X-RateLimit-Window', req.rateLimitInfo.windowMs);
      }
      next();
    };
  }

  /**
   * Get rate limit status for monitoring
   */
  async getRateLimitStatus(
    userId?: string,
    operationType?: string
  ): Promise<any> {
    if (!this.redisClient) {
      return { error: 'Redis not available for status check' };
    }

    try {
      const pattern = operationType
        ? `openforis:rl:${operationType}:*${userId || '*'}*`
        : `openforis:rl:*${userId || '*'}*`;

      const keys = await this.redisClient.keys(pattern);
      const status: any = {};

      for (const key of keys) {
        const value = await this.redisClient.get(key);
        const hits = typeof value === 'string' ? parseInt(value, 10) : 0;
        status[key] = {
          hits,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        pattern,
        results: status,
        totalKeys: keys.length,
        store: this.store ? 'redis' : 'memory',
      };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    try {
      if (this.redisClient) {
        await this.redisClient.quit();
      }
    } catch (error) {
      appLogger.error('Error cleaning up OpenForis rate limiter', {
        operation: 'openforis:rate-limiter:cleanup:error',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
    }
  }
}

// Create singleton instance
export const openForisRateLimiter = new OpenForisRateLimiter();

// Export types and class
export { OpenForisRateLimiter, OpenForisRateLimitConfig, OpenForisRequest };

// Graceful shutdown
process.on('SIGTERM', async () => {
  await openForisRateLimiter.cleanup();
});

process.on('SIGINT', async () => {
  await openForisRateLimiter.cleanup();
});
