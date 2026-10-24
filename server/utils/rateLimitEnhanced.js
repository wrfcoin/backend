/**
 * Enhanced Rate Limiting for Wrfcoin Backend
 * Implements sophisticated rate limiting with user tiers, adaptive throttling,
 * and optional Redis backing for distributed deployments.
 *
 * Task 103.3: Added Redis support for distributed rate limiting
 *
 * Features:
 * - User tier-based rate limits (anonymous, user, premium, admin)
 * - Adaptive throttling based on system pressure
 * - Redis-backed storage for distributed deployments (optional)
 * - Trusted proxy validation for X-Forwarded-For headers
 * - Auto-blocking of suspicious IPs after repeated violations
 */

const { BlockList, isIP } = require('node:net');

// Trusted proxy configuration (same as rate-limit-redis.ts). Entries are single
// addresses or CIDR ranges (backend#1229).
const TRUSTED_PROXIES = (process.env.TRUSTED_PROXIES || '127.0.0.1,::1,::ffff:127.0.0.1').split(',').map(ip => ip.trim()).filter(Boolean);

/**
 * Normalize an IP address for consistent comparison
 */
function normalizeIp(ip) {
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) {
    return ip.substring(7);
  }
  return ip;
}

/**
 * Tailscale gives every node an IPv6 address derived from its IPv4 (tsaddr
 * Tailscale4To6Range fd7a:115c:a1e0:ab12:4843:cd96:6200::/104: the last three bytes
 * are the IPv4's b.c.d, and the IPv4 is 100.b.c.d). All nodes of a tailnet therefore share
 * their first 104 bits, so express-rate-limit's IPv6 /56 collapse (backend#1228) would put
 * every tailnet device that connects over IPv6 into ONE bucket. Map such an address back to
 * its unique IPv4 identity; every other address is returned unchanged.
 */
const TAILSCALE_4TO6_PREFIX = 'fd7a:115c:a1e0:ab12:4843:cd96:62';
function tailnetIpv4(ip) {
  if (typeof ip !== 'string' || isIP(ip) !== 6) return ip;
  const groups = expandIpv6(ip);
  if (!groups) return ip;
  const hex = groups.map((g) => g.toString(16).padStart(4, '0')).join('');
  const prefix = TAILSCALE_4TO6_PREFIX.replace(/:/g, '');
  if (!hex.startsWith(prefix)) return ip;
  const tail = hex.slice(prefix.length); // 6 hex digits: b, c, d
  if (tail.length !== 6) return ip;
  return `100.${parseInt(tail.slice(0, 2), 16)}.${parseInt(tail.slice(2, 4), 16)}.${parseInt(tail.slice(4, 6), 16)}`;
}

function expandIpv6(ip) {
  const bare = ip.split('%')[0];
  const halves = bare.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tailParts = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tailParts.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const all = halves.length === 1 ? head : [...head, ...Array(missing).fill('0'), ...tailParts];
  const nums = all.map((g) => parseInt(g, 16));
  return nums.length === 8 && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null;
}

function buildTrustedProxyList(entries) {
  const list = new BlockList();
  for (const entry of entries) {
    const [rawAddress, rawPrefix] = entry.split('/');
    const address = normalizeIp(rawAddress);
    const family = isIP(address);
    if (family === 0) {
      // eslint-disable-next-line no-console -- this module logs via console throughout
      console.warn(`[EnhancedRateLimit] Ignoring invalid TRUSTED_PROXIES entry: ${entry}`);
      continue;
    }
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (rawPrefix === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const prefix = Number(rawPrefix);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) {
      // eslint-disable-next-line no-console -- this module logs via console throughout
      console.warn(`[EnhancedRateLimit] Ignoring invalid TRUSTED_PROXIES entry: ${entry}`);
      continue;
    }
    list.addSubnet(address, prefix, type);
  }
  return list;
}

const TRUSTED_PROXY_LIST = buildTrustedProxyList(TRUSTED_PROXIES);

/**
 * Check if an IP is in the trusted proxies list (exact address or CIDR)
 */
function isTrustedProxy(ip) {
  const normalizedIp = normalizeIp(ip);
  const family = isIP(normalizedIp);
  if (family === 0) return false;
  return TRUSTED_PROXY_LIST.check(normalizedIp, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Extract the real client IP address from a request
 * Only trusts X-Forwarded-For from trusted proxies to prevent IP spoofing
 *
 * Walks the chain right to left from the socket peer and returns the first
 * address that is not a trusted proxy (backend#1229), the same rule Express
 * applies to req.ip when 'trust proxy' is set to isTrustedProxy. Entries left
 * of the first untrusted hop are client-supplied and are ignored.
 */
function getSecureClientIp(req) {
  const socket = req.socket || req.connection;
  const connectionIp = socket?.remoteAddress || '';
  let clientIp = normalizeIp(connectionIp);

  const header = req.headers['x-forwarded-for'];
  const forwardedFor = Array.isArray(header) ? header.join(',') : header;
  if (forwardedFor) {
    const hops = forwardedFor.split(',').map(hop => normalizeIp(hop.trim()));
    while (clientIp && isTrustedProxy(clientIp) && hops.length > 0) {
      const next = hops.pop();
      if (isIP(next) === 0) break;
      clientIp = next;
    }
  }

  return tailnetIpv4(clientIp) || '0.0.0.0';
}

class EnhancedRateLimit {
  constructor(options = {}) {
    this.windows = new Map(); // Track request windows (in-memory)
    this.userTiers = new Map(); // User privilege tiers
    this.suspiciousIPs = new Set(); // Track suspicious activity (in-memory fallback)
    this.violationCounts = new Map(); // Track violations for auto-blocking
    this.warnedProxyViolations = new Set(); // Proxy addresses already warned about (log once)

    // Redis client (optional)
    this.redis = null;
    this.redisEnabled = false;

    this.config = {
      // Default limits per minute
      anonymous: options.anonymous || 100,
      user: options.user || 300,
      premium: options.premium || 1000,
      admin: options.admin || 5000,

      // Burst allowances
      burstMultiplier: options.burstMultiplier || 2,
      burstWindowMs: options.burstWindowMs || 60000,

      // Adaptive throttling
      adaptiveThreshold: options.adaptiveThreshold || 0.8,
      throttleReduction: options.throttleReduction || 0.5,

      // Suspicious activity detection and auto-blocking
      suspiciousThreshold: options.suspiciousThreshold || 5,
      suspiciousBanDuration: options.suspiciousBanDuration || 3600000, // 1 hour
      enableAutoBlock: options.enableAutoBlock !== false, // Enabled by default

      // Window settings
      windowMs: options.windowMs || 60000,
      skipSuccessfulRequests: options.skipSuccessfulRequests || false,
      skipFailedRequests: options.skipFailedRequests || false,

      // Redis configuration
      useRedis: options.useRedis || false,
      redisKeyPrefix: options.redisKeyPrefix || 'ratelimit:enhanced',
    };

    // Initialize Redis if requested
    if (this.config.useRedis) {
      this.initializeRedis(options.redisClient || options.redisUrl);
    }
  }

  /**
   * Initialize Redis connection for distributed rate limiting
   */
  async initializeRedis(redisClientOrUrl) {
    try {
      if (typeof redisClientOrUrl === 'string') {
        // URL provided, create new client
        const Redis = require('ioredis');
        this.redis = new Redis(redisClientOrUrl, {
          maxRetriesPerRequest: 3,
          lazyConnect: true,
          enableReadyCheck: true,
        });
      } else if (redisClientOrUrl) {
        // Existing client provided
        this.redis = redisClientOrUrl;
      } else {
        // Try to use environment variable
        const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
        const Redis = require('ioredis');
        this.redis = new Redis(redisUrl, {
          maxRetriesPerRequest: 3,
          lazyConnect: true,
          enableReadyCheck: true,
        });
      }

      this.redis.on('connect', () => {
        console.log('[EnhancedRateLimit] Redis connected');
        this.redisEnabled = true;
      });

      this.redis.on('error', (error) => {
        console.error('[EnhancedRateLimit] Redis error:', error.message);
        this.redisEnabled = false;
      });

      this.redis.on('ready', () => {
        this.redisEnabled = true;
      });

      // Attempt connection
      if (this.redis.status !== 'ready') {
        await this.redis.connect();
      }
    } catch (error) {
      console.warn('[EnhancedRateLimit] Redis initialization failed, using in-memory fallback:', error.message);
      this.redisEnabled = false;
    }
  }

  // Set user tier for enhanced limits
  setUserTier(userId, tier) {
    this.userTiers.set(userId, tier);
  }

  // Get effective limit for user
  getEffectiveLimit(req) {
    const userId = this.getUserId(req);
    const userTier = this.userTiers.get(userId) || 'anonymous';
    const baseLimit = this.config[userTier] || this.config.anonymous;

    // Apply adaptive throttling if system is under pressure
    if (this.isSystemUnderPressure()) {
      return Math.floor(baseLimit * this.config.throttleReduction);
    }

    return baseLimit;
  }

  // Check if system is under pressure
  isSystemUnderPressure() {
    const memUsage = process.memoryUsage();
    const heapUsedPercent = memUsage.heapUsed / memUsage.heapTotal;
    return heapUsedPercent > this.config.adaptiveThreshold;
  }

  // Get user identifier with secure IP extraction
  getUserId(req) {
    return (
      req.user?.id ||
      req.headers['x-user-id'] ||
      getSecureClientIp(req)
    );
  }

  // Get rate limit key
  getRateLimitKey(req) {
    const userId = this.getUserId(req);
    const endpoint = req.route?.path || req.path;
    return `${userId}:${endpoint}`;
  }

  /**
   * Check if IP is blocked (supports Redis and in-memory)
   */
  async isIpBlocked(ip) {
    const normalizedIp = normalizeIp(ip);

    // Check Redis first if enabled
    if (this.redisEnabled && this.redis) {
      try {
        const blockKey = `${this.config.redisKeyPrefix}:blocked:${normalizedIp}`;
        const ttl = await this.redis.ttl(blockKey);
        if (ttl > 0) {
          return { blocked: true, expiresIn: ttl };
        }
      } catch (error) {
        console.warn('[EnhancedRateLimit] Redis block check failed:', error.message);
      }
    }

    // Fallback to in-memory
    return { blocked: this.suspiciousIPs.has(normalizedIp), expiresIn: null };
  }

  /**
   * Block an IP address (supports Redis and in-memory)
   */
  async blockIp(ip, reason) {
    const normalizedIp = normalizeIp(ip);
    const durationSeconds = Math.ceil(this.config.suspiciousBanDuration / 1000);

    // backend#1229: a trusted proxy address is shared by every client behind it.
    if (isTrustedProxy(normalizedIp)) {
      // eslint-disable-next-line no-console -- this module logs via console throughout
      console.warn(`[EnhancedRateLimit] Refusing to block trusted proxy address ${normalizedIp}: ${reason}`);
      return;
    }

    console.warn(`[EnhancedRateLimit] Blocking IP ${normalizedIp}: ${reason}`);

    // Store in Redis if enabled
    if (this.redisEnabled && this.redis) {
      try {
        const blockKey = `${this.config.redisKeyPrefix}:blocked:${normalizedIp}`;
        await this.redis.setex(blockKey, durationSeconds, '1');
      } catch (error) {
        console.warn('[EnhancedRateLimit] Redis block failed:', error.message);
      }
    }

    // Also store in-memory as fallback
    this.suspiciousIPs.add(normalizedIp);
    setTimeout(() => {
      this.suspiciousIPs.delete(normalizedIp);
    }, this.config.suspiciousBanDuration);
  }

  /**
   * Record a rate limit violation and check if IP should be blocked
   */
  async recordViolation(ip) {
    const normalizedIp = normalizeIp(ip);

    // backend#1229: never count escalation against a shared trusted proxy
    // address; it is limited per request only.
    if (isTrustedProxy(normalizedIp)) {
      if (!this.warnedProxyViolations.has(normalizedIp)) {
        this.warnedProxyViolations.add(normalizedIp);
        // eslint-disable-next-line no-console -- this module logs via console throughout
        console.warn(`[EnhancedRateLimit] Not escalating violations on trusted proxy address ${normalizedIp}`);
      }
      return false;
    }

    // Use Redis if enabled
    if (this.redisEnabled && this.redis) {
      try {
        const violationKey = `${this.config.redisKeyPrefix}:violations:${normalizedIp}`;
        const violations = await this.redis.incr(violationKey);

        // Set expiration on first violation
        if (violations === 1) {
          await this.redis.expire(violationKey, 3600); // 1 hour window
        }

        if (violations >= this.config.suspiciousThreshold) {
          await this.blockIp(normalizedIp, `Excessive violations: ${violations}`);
          await this.redis.del(violationKey);
          return true;
        }

        return false;
      } catch (error) {
        console.warn('[EnhancedRateLimit] Redis violation recording failed:', error.message);
      }
    }

    // Fallback to in-memory
    const current = this.violationCounts.get(normalizedIp) || 0;
    const newCount = current + 1;
    this.violationCounts.set(normalizedIp, newCount);

    if (newCount >= this.config.suspiciousThreshold) {
      await this.blockIp(normalizedIp, `Excessive violations: ${newCount}`);
      this.violationCounts.delete(normalizedIp);
      return true;
    }

    return false;
  }

  /**
   * Check rate limit using Redis sliding window (if available)
   */
  async checkRedisRateLimit(key, limit) {
    if (!this.redisEnabled || !this.redis) {
      return null; // Signal to use in-memory fallback
    }

    try {
      const redisKey = `${this.config.redisKeyPrefix}:${key}`;
      const now = Date.now();
      const windowStart = now - this.config.windowMs;

      const pipeline = this.redis.pipeline();
      pipeline.zremrangebyscore(redisKey, 0, windowStart);
      pipeline.zadd(redisKey, now, `${now}-${Math.random().toString(36).substring(2, 10)}`);
      pipeline.zcard(redisKey);
      pipeline.expire(redisKey, Math.ceil(this.config.windowMs / 1000));

      const results = await pipeline.exec();
      const requestCount = results[2]?.[1] || 0;

      return {
        requests: requestCount,
        allowed: requestCount <= limit,
        remaining: Math.max(0, limit - requestCount),
        resetTime: now + this.config.windowMs,
      };
    } catch (error) {
      console.warn('[EnhancedRateLimit] Redis rate limit check failed:', error.message);
      return null; // Signal to use in-memory fallback
    }
  }

  // Main middleware function
  middleware() {
    return async (req, res, next) => {
      // Use secure IP extraction with trusted proxy validation
      const ip = getSecureClientIp(req);

      // Check if IP is blocked
      const blockStatus = await this.isIpBlocked(ip);
      if (blockStatus.blocked) {
        res.setHeader('X-RateLimit-Blocked', 'true');
        if (blockStatus.expiresIn) {
          res.setHeader('Retry-After', String(blockStatus.expiresIn));
        }
        return res.status(429).json({
          success: false,
          error: {
            code: 'IP_BLOCKED',
            message: 'Rate limit exceeded - IP temporarily banned',
            retryAfter: blockStatus.expiresIn || Math.ceil(this.config.suspiciousBanDuration / 1000),
          },
        });
      }

      const key = this.getRateLimitKey(req);
      const limit = this.getEffectiveLimit(req);
      const now = Date.now();

      // Try Redis first if enabled
      const redisResult = await this.checkRedisRateLimit(key, limit);

      let requests, windowStart, resetTime;

      if (redisResult !== null) {
        // Use Redis result
        requests = redisResult.requests;
        resetTime = redisResult.resetTime;
      } else {
        // Fallback to in-memory
        windowStart = Math.floor(now / this.config.windowMs) * this.config.windowMs;

        if (!this.windows.has(key)) {
          this.windows.set(key, {
            requests: 0,
            windowStart: windowStart,
            firstRequest: now,
            lastRequest: now,
            violations: 0,
          });
        }

        const window = this.windows.get(key);

        // Reset window if it's a new time window
        if (window.windowStart < windowStart) {
          window.requests = 0;
          window.windowStart = windowStart;
          window.violations = 0;
        }

        window.requests++;
        window.lastRequest = now;
        requests = window.requests;
        resetTime = windowStart + this.config.windowMs;
      }

      const remaining = Math.max(0, limit - requests);

      // Add rate limit headers
      res.set({
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': String(remaining),
        'X-RateLimit-Reset': String(Math.ceil(resetTime / 1000)),
        'X-RateLimit-User-Tier': this.userTiers.get(this.getUserId(req)) || 'anonymous',
      });

      // Check if limit exceeded
      if (requests > limit) {
        // Record violation for auto-blocking
        if (this.config.enableAutoBlock) {
          await this.recordViolation(ip);
        }

        const retryAfter = Math.ceil((resetTime - now) / 1000);
        res.setHeader('Retry-After', String(retryAfter));

        return res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Rate limit exceeded',
            limit: limit,
            remaining: 0,
            resetTime: new Date(resetTime).toISOString(),
            retryAfter: retryAfter,
          },
        });
      }

      // Continue to next middleware
      next();
    };
  }

  // Get current stats
  async getStats() {
    const activeWindows = this.windows.size;
    const suspiciousCount = this.suspiciousIPs.size;

    let redisStats = null;
    if (this.redisEnabled && this.redis) {
      try {
        const info = await this.redis.info('memory');
        const usedMemory = info.match(/used_memory_human:(.+)/)?.[1]?.trim();
        redisStats = {
          connected: true,
          usedMemory,
        };
      } catch (error) {
        redisStats = { connected: false, error: error.message };
      }
    }

    return {
      activeWindows,
      suspiciousIPs: suspiciousCount,
      systemPressure: this.isSystemUnderPressure(),
      memoryUsage: process.memoryUsage(),
      config: this.config,
      redisEnabled: this.redisEnabled,
      redisStats,
    };
  }

  // Clean up old windows
  cleanup() {
    const now = Date.now();
    const cutoff = now - this.config.windowMs * 2; // Keep 2 windows of history

    for (const [key, window] of this.windows.entries()) {
      if (window.lastRequest < cutoff) {
        this.windows.delete(key);
      }
    }

    // Clean up old violation counts
    for (const [ip, _count] of this.violationCounts.entries()) {
      // In-memory violations expire after the window
      if (now - (this.lastViolationTime?.get(ip) || 0) > 3600000) {
        this.violationCounts.delete(ip);
      }
    }
  }

  // Start periodic cleanup
  startCleanup() {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.windowMs);
  }

  // Stop cleanup
  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  /**
   * Close Redis connection gracefully
   */
  async close() {
    if (this.redis) {
      try {
        await this.redis.quit();
        console.log('[EnhancedRateLimit] Redis connection closed');
      } catch (error) {
        console.warn('[EnhancedRateLimit] Error closing Redis:', error.message);
        this.redis.disconnect();
      }
      this.redis = null;
      this.redisEnabled = false;
    }
    this.stopCleanup();
  }
}

// Export utilities for external use
module.exports = EnhancedRateLimit;
module.exports.getSecureClientIp = getSecureClientIp;
module.exports.normalizeIp = normalizeIp;
module.exports.tailnetIpv4 = tailnetIpv4;
module.exports.isTrustedProxy = isTrustedProxy;
module.exports.TRUSTED_PROXIES = TRUSTED_PROXIES;
