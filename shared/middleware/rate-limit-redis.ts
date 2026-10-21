/**
 * Redis-Backed Rate Limiting Middleware for WRFCoin Platform
 * Task 103.3: Implements distributed rate limiting with Redis storage
 *
 * Features:
 * - Sliding window rate limiting using Redis sorted sets
 * - Trusted proxy validation for X-Forwarded-For header security
 * - Auto-blocking of suspicious IPs after repeated violations
 * - Rate limit headers (X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset)
 * - WebSocket connection rate limiting support
 */

import Redis from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'http';
import { BlockList, isIP } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';
// eslint-disable-next-line no-restricted-imports -- shared middleware uses centralized runtime logger.
import { appLogger } from '../../server/utils/logger.js';
import { redactCoordinateText } from '../../server/utils/log-coordinates.js';

// ============================================================================
// Configuration
// ============================================================================

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Trusted proxies that are allowed to set X-Forwarded-For
// In production, this should be configured based on infrastructure.
// Entries are single addresses or CIDR ranges (backend#1229): a docker bridge
// assigns proxy containers addresses dynamically, so the deployed frontend
// nginx can only be named by its network's subnet.
const TRUSTED_PROXIES: string[] = (process.env.TRUSTED_PROXIES || '127.0.0.1,::1,::ffff:127.0.0.1').split(',').map(ip => ip.trim()).filter(Boolean);
const TRUSTED_PROXY_LIST = buildTrustedProxyList(TRUSTED_PROXIES);

// Loopback, RFC 1918, link-local, ULA and unspecified ranges. A socket peer in
// these ranges is local infrastructure (a docker bridge gateway, a sibling
// proxy container, the host itself) that many clients can share, so it is
// never escalated to an IP ban unless a client address was derived beyond it
// (backend#1229).
const NON_GLOBAL_LIST = buildTrustedProxyList([
  '0.0.0.0/32', '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16',
  '::/128', '::1/128', 'fc00::/7', 'fe80::/10',
]);

// Auto-block configuration
const BLOCK_THRESHOLD = parseInt(process.env.RATE_LIMIT_BLOCK_THRESHOLD || '5', 10); // Block after N violations
const BLOCK_DURATION_SECONDS = parseInt(process.env.RATE_LIMIT_BLOCK_DURATION || '3600', 10); // 1 hour default
const VIOLATION_WINDOW_SECONDS = 3600; // Track violations over 1 hour

// ============================================================================
// Types
// ============================================================================

export interface RateLimitConfig {
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum requests allowed per window */
  maxRequests: number;
  /** Key prefix for Redis keys (default: 'ratelimit') */
  keyPrefix?: string;
  /** Custom key generator function */
  keyGenerator?: (req: Request | IncomingMessage) => string;
  /** Whether to skip successful requests from rate limit count */
  skipSuccessfulRequests?: boolean;
  /** Whether to skip failed requests from rate limit count */
  skipFailedRequests?: boolean;
  /** Message to return when rate limited */
  message?: string;
  /** Whether to enable auto-blocking of repeat violators */
  enableAutoBlock?: boolean;
  /** Custom handler for rate limit exceeded */
  handler?: (req: Request, res: Response, next: NextFunction, options: RateLimitResult) => void;
}

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Remaining requests in current window */
  remaining: number;
  /** Timestamp when the rate limit resets */
  resetAt: number;
  /** Total requests in current window */
  current: number;
  /** Maximum requests allowed */
  limit: number;
  /** Whether the client is currently blocked */
  blocked: boolean;
  /** Time until block expires (if blocked) */
  blockExpiresIn?: number;
}

export interface WebSocketRateLimitConfig {
  /** Maximum connections per window */
  maxConnections: number;
  /** Window in milliseconds */
  windowMs: number;
  /** Maximum messages per minute */
  maxMessagesPerMinute?: number;
}

// ============================================================================
// Redis Client
// ============================================================================

const RedisCtor = Redis as unknown as typeof import('ioredis').Redis;
let redisClient: RedisClient | null = null;
let redisConnectionAttempts = 0;
const MAX_REDIS_RETRY_ATTEMPTS = 5;

/**
 * Get or create Redis client for rate limiting
 */
export function getRedisClient(): RedisClient {
  if (redisClient && redisClient.status === 'ready') {
    return redisClient;
  }

  if (!redisClient) {
    redisClient = new RedisCtor(REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
      retryStrategy: (times) => {
        redisConnectionAttempts++;
        if (times > MAX_REDIS_RETRY_ATTEMPTS) {
          appLogger.error('Redis connection failed after retry attempts', { module: 'RateLimit', attempts: times });
          return null; // Stop retrying
        }
        const delay = Math.min(times * 100, 2000);
        appLogger.warn('Redis connection retry', { module: 'RateLimit', attempt: times, delayMs: delay });
        return delay;
      },
    });

    redisClient.on('connect', () => {
      appLogger.info('Redis client connected', { module: 'RateLimit' });
      redisConnectionAttempts = 0;
    });

    redisClient.on('error', (error) => {
      appLogger.error('Redis client error', { module: 'RateLimit', error: error.message });
    });

    redisClient.on('ready', () => {
      appLogger.info('Redis client ready', { module: 'RateLimit' });
    });

    // Attempt to connect
    redisClient.connect().catch((error) => {
      appLogger.error('Redis connection failed', { module: 'RateLimit', error: error.message });
    });
  }

  return redisClient;
}

/**
 * Close Redis connection gracefully
 */
export async function closeRedisConnection(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
      redisClient = null;
      appLogger.info('Redis connection closed', { module: 'RateLimit' });
    } catch (error) {
      appLogger.error('Error closing Redis connection', { module: 'RateLimit', error: error instanceof Error ? error.message : String(error) });
      redisClient?.disconnect();
      redisClient = null;
    }
  }
}

// ============================================================================
// Client IP Extraction with Trusted Proxy Validation
// ============================================================================

/**
 * Normalizes an IP address for consistent comparison
 * Handles IPv4-mapped IPv6 addresses (::ffff:127.0.0.1 -> 127.0.0.1)
 */
function normalizeIp(ip: string): string {
  if (!ip) return '';

  // Handle IPv4-mapped IPv6 addresses
  if (ip.startsWith('::ffff:')) {
    return ip.substring(7);
  }

  return ip;
}

function buildTrustedProxyList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [rawAddress, rawPrefix] = entry.split('/');
    const address = normalizeIp(rawAddress);
    const family = isIP(address);
    if (family === 0) {
      appLogger.warn('Ignoring invalid TRUSTED_PROXIES entry', { module: 'RateLimit', entry });
      continue;
    }
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (rawPrefix === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const prefix = Number(rawPrefix);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) {
      appLogger.warn('Ignoring invalid TRUSTED_PROXIES entry', { module: 'RateLimit', entry });
      continue;
    }
    list.addSubnet(address, prefix, type);
  }
  return list;
}

/**
 * Check if an IP is in the trusted proxies list (exact address or CIDR)
 */
export function isTrustedProxy(ip: string): boolean {
  const normalizedIp = normalizeIp(ip);
  const family = isIP(normalizedIp);
  if (family === 0) return false;
  return TRUSTED_PROXY_LIST.check(normalizedIp, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Extract the real client IP address from a request
 * Only trusts X-Forwarded-For from trusted proxies to prevent IP spoofing
 *
 * Security: This prevents attackers from bypassing rate limiting by
 * spoofing the X-Forwarded-For header from untrusted sources.
 *
 * The chain is walked right to left, from the socket peer outward, and the
 * first address that is NOT a trusted proxy is the client (backend#1229).
 * Each trusted proxy appends the address it received from, so only entries
 * to the right of an untrusted hop were written by our own proxies; anything
 * further left came from the client and must never choose the key. If every
 * hop is trusted, the result is the outermost proxy, which is a shared
 * address: callers must not ban it (see resolveClientIp).
 */
export function getClientIp(req: Request | IncomingMessage): string {
  return resolveClientIp(req).ip;
}

export interface ClientIpResolution {
  /** Rate-limit and ban key for the request. */
  ip: string;
  /**
   * True when `ip` may stand for many clients: it is a configured trusted
   * proxy (every hop was a proxy), or it is a non-global socket peer and no
   * client address was derived beyond it. Such a key is still rate-limited,
   * but it is never banned (backend#1229).
   */
  shared: boolean;
}

/**
 * Resolve the client address and whether it is shared by many clients.
 * See getClientIp for the X-Forwarded-For walk.
 */
export function resolveClientIp(req: Request | IncomingMessage): ClientIpResolution {
  // Get the direct connection IP
  const socket = (req as Request).socket || (req as IncomingMessage).socket;
  const connectionIp = normalizeIp(socket?.remoteAddress || '');
  let clientIp = connectionIp;

  const header = req.headers['x-forwarded-for'];
  const forwardedFor = Array.isArray(header) ? header.join(',') : header;
  if (forwardedFor) {
    const hops = forwardedFor.split(',').map(hop => normalizeIp(hop.trim()));
    while (clientIp && isTrustedProxy(clientIp) && hops.length > 0) {
      const next = hops.pop() as string;
      if (isIP(next) === 0) break;
      clientIp = next;
    }
  }

  if (!clientIp) {
    return { ip: '0.0.0.0', shared: true };
  }
  const shared = isTrustedProxy(clientIp)
    || (clientIp === connectionIp && isNonGlobalAddress(clientIp));
  return { ip: clientIp, shared };
}

function isNonGlobalAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true;
  return NON_GLOBAL_LIST.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * backend#1295: Express does not percent-decode req.path, but the weather
 * handlers parseFloat the DECODED param, so an encoded digit (44.9%38765) or an
 * exponent form (4498765e-5) reached Redis verbatim. Redact the decoded path
 * (decoded once, as Express does for params). When nothing needed
 * redacting the raw path is returned unchanged, so ordinary keys are stable.
 */
function redactedKeyPath(rawPath: string): string {
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // malformed escape: fall back to the raw text
  }
  const redacted = redactCoordinateText(decoded) as string;
  return redacted === decoded ? (redactCoordinateText(rawPath) as string) : redacted;
}

// Tailscale's ULA prefix: every device has its own /128 here, and a tailnet is one /48, so these addresses
// must keep one bucket per device (backend S-A3) instead of collapsing to a shared prefix.
const TAILNET_ULA_PREFIX = /^fd7a:115c:a1e0:/i;

/**
 * backend#1228: the bucket identity for a client address. An IPv6 client is keyed by its allocation prefix
 * (express-rate-limit's ipKeyGenerator, /56 by default), not its /128, so rotating addresses inside one
 * allocation cannot mint fresh buckets. IPv4 and tailnet addresses are unchanged. Used for the Redis bucket
 * key only; the auto-block bookkeeping still uses the exact address.
 */
export function rateLimitBucketIp(ip: string): string {
  if (isIP(ip) !== 6 || TAILNET_ULA_PREFIX.test(ip)) return ip;
  return ipKeyGenerator(ip);
}

/**
 * Generate a rate limit key for a request
 */
export function generateRateLimitKey(req: Request | IncomingMessage, prefix: string = 'ratelimit'): string {
  const clientIp = rateLimitBucketIp(getClientIp(req));
  // Include the path for more granular rate limiting. backend#1293: the path
  // can carry the caller's position (/api/weather/forecast/<lat,lon>), and this
  // key sits in Redis next to the IP, so coordinate-like decimals are coarsened
  // to 0.1 deg first. Mobile already sends 0.1 deg, so its buckets are unchanged.
  const rawPath = (req as Request).path || (req as IncomingMessage).url || '/';
  const path = redactedKeyPath(rawPath);
  return `${prefix}:${clientIp}:${path}`;
}

/**
 * backend#1440: key for a path-independent per-address budget. The default key above carries the request path,
 * so on its own one address's total is bounded per path, not per address. This key has the same address identity
 * (client address after the trusted-proxy walk, IPv6 collapsed to its allocation prefix, tailnet devices kept
 * apart) and no path, so varying the path cannot mint a fresh bucket.
 */
export function apiIpBudgetKey(req: Request | IncomingMessage): string {
  return `ip:${rateLimitBucketIp(getClientIp(req))}`;
}

// ============================================================================
// Core Rate Limiting Functions
// ============================================================================

/**
 * Check rate limit using Redis sliding window algorithm
 * Uses sorted sets for precise sliding window implementation
 */
export async function checkRateLimit(
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const redis = getRedisClient();
  const now = Date.now();
  const windowStart = now - config.windowMs;
  const redisKey = `${config.keyPrefix || 'ratelimit'}:${key}`;

  try {
    // Use Redis transaction for atomic operations
    const pipeline = redis.pipeline();

    // Remove entries older than the window
    pipeline.zremrangebyscore(redisKey, 0, windowStart);

    // Add current request with unique timestamp
    pipeline.zadd(redisKey, now, `${now}-${Math.random().toString(36).substring(2, 10)}`);

    // Count requests in current window
    pipeline.zcard(redisKey);

    // Set expiration to prevent stale keys
    pipeline.expire(redisKey, Math.ceil(config.windowMs / 1000));

    const results = await pipeline.exec();

    if (!results) {
      throw new Error('Redis pipeline execution failed');
    }

    // Get the count from the third command result
    const requestCount = (results[2]?.[1] as number) || 0;
    const remaining = Math.max(0, config.maxRequests - requestCount);
    const resetAt = now + config.windowMs;

    return {
      allowed: requestCount <= config.maxRequests,
      remaining,
      resetAt,
      current: requestCount,
      limit: config.maxRequests,
      blocked: false,
    };
  } catch (error) {
    appLogger.error('Redis error during rate limit check', { module: 'RateLimit', error: error instanceof Error ? error.message : String(error) });
    // Fail safe: Redis-backed rate limiting is a security boundary for public
    // testnet endpoints, so limiter storage failures must not disable it.
    return {
      allowed: false,
      remaining: 0,
      resetAt: now + config.windowMs,
      current: config.maxRequests,
      limit: config.maxRequests,
      blocked: false,
    };
  }
}

/**
 * Check if an IP is currently blocked
 */
export async function isIpBlocked(ip: string): Promise<{ blocked: boolean; expiresIn?: number }> {
  const redis = getRedisClient();
  const blockKey = `ratelimit:blocked:${normalizeIp(ip)}`;

  try {
    const ttl = await redis.ttl(blockKey);
    if (ttl > 0) {
      return { blocked: true, expiresIn: ttl };
    }
    return { blocked: false };
  } catch (error) {
    appLogger.error('Error checking IP block status', { module: 'RateLimit', error: error instanceof Error ? error.message : String(error) });
    return { blocked: false };
  }
}

/**
 * Record a rate limit violation and optionally block the IP
 * Returns true if the IP should be blocked
 */
export async function recordViolation(ip: string): Promise<boolean> {
  const redis = getRedisClient();
  const normalizedIp = normalizeIp(ip);
  const violationKey = `ratelimit:violations:${normalizedIp}`;
  const blockKey = `ratelimit:blocked:${normalizedIp}`;

  // backend#1229: a trusted proxy address is shared by every client behind
  // it, so banning it locks all of them out for one client's violations.
  if (isTrustedProxy(normalizedIp)) {
    appLogger.warn('Refusing to record a violation against a trusted proxy address', { module: 'RateLimit', ip: normalizedIp });
    return false;
  }

  try {
    // Check if already blocked
    const isBlocked = await redis.exists(blockKey);
    if (isBlocked) {
      return true;
    }

    // Increment violation count
    const violations = await redis.incr(violationKey);

    // Set expiration on first violation
    if (violations === 1) {
      await redis.expire(violationKey, VIOLATION_WINDOW_SECONDS);
    }

    // Check if threshold exceeded
    if (violations >= BLOCK_THRESHOLD) {
      // Block the IP
      await redis.setex(blockKey, BLOCK_DURATION_SECONDS, '1');

      appLogger.warn('IP auto-blocked after repeated violations', { module: 'RateLimit', ip: normalizedIp, violations });

      // Clean up violation counter
      await redis.del(violationKey);

      return true;
    }

    return false;
  } catch (error) {
    appLogger.error('Error recording violation', { module: 'RateLimit', error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Manually block an IP address
 */
export async function blockIp(ip: string, durationSeconds: number = BLOCK_DURATION_SECONDS): Promise<void> {
  const redis = getRedisClient();
  const normalizedIp = normalizeIp(ip);
  const blockKey = `ratelimit:blocked:${normalizedIp}`;

  if (isTrustedProxy(normalizedIp)) {
    appLogger.warn('Refusing to block a trusted proxy address', { module: 'RateLimit', ip: normalizedIp });
    return;
  }

  try {
    await redis.setex(blockKey, durationSeconds, '1');
    appLogger.info('IP blocked', { module: 'RateLimit', ip: normalizedIp, durationSeconds });
  } catch (error) {
    appLogger.error('Error blocking IP', { module: 'RateLimit', error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Unblock an IP address
 */
export async function unblockIp(ip: string): Promise<void> {
  const redis = getRedisClient();
  const normalizedIp = normalizeIp(ip);
  const blockKey = `ratelimit:blocked:${normalizedIp}`;
  const violationKey = `ratelimit:violations:${normalizedIp}`;

  try {
    await redis.del(blockKey, violationKey);
    appLogger.info('IP unblocked', { module: 'RateLimit', ip: normalizedIp });
  } catch (error) {
    appLogger.error('Error unblocking IP', { module: 'RateLimit', error: error instanceof Error ? error.message : String(error) });
  }
}

// ============================================================================
// Express Middleware Factory
// ============================================================================

/**
 * Default rate limit configurations for different use cases
 */
function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (Number.isSafeInteger(parsed) && parsed > 0) {
    return parsed;
  }

  appLogger.warn('Invalid positive-integer rate limit override; using default', {
    module: 'RateLimit',
    env: name,
    value: raw,
    fallback,
  });
  return fallback;
}

export const RATE_LIMIT_PRESETS = {
  // General API endpoints
  api: {
    windowMs: positiveIntegerEnv('RATE_LIMIT_API_WINDOW_MS', 60 * 1000),
    maxRequests: positiveIntegerEnv('RATE_LIMIT_API_MAX_REQUESTS', 100),
    keyPrefix: 'ratelimit:api',
  },
  // Per-address aggregate across ALL paths (backend#1440). Sits beside `api`, which stays per route. The default
  // is deliberately well above `api` so ordinary multi-endpoint pages never reach it; tune per deployment.
  apiIp: {
    windowMs: positiveIntegerEnv('RATE_LIMIT_API_IP_WINDOW_MS', 60 * 1000),
    maxRequests: positiveIntegerEnv('RATE_LIMIT_API_IP_MAX_REQUESTS', 600),
    keyPrefix: 'ratelimit:api-ip',
  },
  // Authentication endpoints (stricter)
  auth: {
    windowMs: positiveIntegerEnv('RATE_LIMIT_AUTH_WINDOW_MS', 15 * 60 * 1000),
    maxRequests: positiveIntegerEnv('RATE_LIMIT_AUTH_MAX_REQUESTS', 5),
    keyPrefix: 'ratelimit:auth',
  },
  // GraphQL queries
  graphql: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 50,
    keyPrefix: 'ratelimit:graphql',
  },
  // WebSocket connections
  websocket: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 10,
    keyPrefix: 'ratelimit:ws',
  },
  // Strict rate limit for sensitive operations
  strict: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 10,
    keyPrefix: 'ratelimit:strict',
  },
} as const;

/**
 * Create an Express middleware for rate limiting
 */
export function createRateLimitMiddleware(config: RateLimitConfig) {
  const options: RateLimitConfig = {
    ...config,
    windowMs: config.windowMs || 60000,
    maxRequests: config.maxRequests || 100,
    keyPrefix: config.keyPrefix || 'ratelimit',
    enableAutoBlock: config.enableAutoBlock !== false,
    message: config.message || 'Too many requests, please try again later.',
  };

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const { ip: clientIp, shared: sharedAddress } = resolveClientIp(req);

    try {
      // Check if IP is blocked. A shared address is never banned, so a ban
      // left on one (e.g. from before backend#1229) is not enforced either.
      const blockStatus = sharedAddress ? { blocked: false } : await isIpBlocked(clientIp);
      if (blockStatus.blocked) {
        res.setHeader('X-RateLimit-Blocked', 'true');
        res.setHeader('Retry-After', String(blockStatus.expiresIn || BLOCK_DURATION_SECONDS));

        res.status(429).json({
          success: false,
          error: {
            code: 'IP_BLOCKED',
            message: 'IP temporarily banned due to excessive rate limit violations',
            retryAfter: blockStatus.expiresIn,
          },
        });
        return;
      }

      // Generate rate limit key
      const key = options.keyGenerator
        ? options.keyGenerator(req)
        : generateRateLimitKey(req, options.keyPrefix);

      // Check rate limit
      const result = await checkRateLimit(key, options);

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

      if (!result.allowed) {
        // Record violation. Escalating a shared address to a ban would lock
        // out every client behind it for one client's violations (#1229).
        if (options.enableAutoBlock && sharedAddress) {
          appLogger.warn('Rate limit exceeded on a shared proxy address; not escalating to an IP ban', {
            module: 'RateLimit',
            ip: clientIp,
            peer: normalizeIp(req.socket?.remoteAddress || ''),
            hasForwardedFor: Boolean(req.headers['x-forwarded-for']),
          });
        } else if (options.enableAutoBlock) {
          const wasBlocked = await recordViolation(clientIp);
          if (wasBlocked) {
            res.setHeader('X-RateLimit-Blocked', 'true');
          }
        }

        const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
        res.setHeader('Retry-After', String(retryAfter));

        // Use custom handler if provided
        if (options.handler) {
          options.handler(req, res, next, result);
          return;
        }

        res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: options.message,
            limit: result.limit,
            remaining: 0,
            retryAfter,
          },
        });
        return;
      }

      next();
    } catch (error) {
      appLogger.error('Middleware error', { module: 'RateLimit', error: error instanceof Error ? error.message : String(error) });
      if (res.headersSent) {
        next(error);
        return;
      }

      res.setHeader('Retry-After', String(Math.ceil(options.windowMs / 1000)));
      res.status(503).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_UNAVAILABLE',
          message: 'Rate limiter unavailable, please try again later.',
        },
      });
    }
  };
}

// ============================================================================
// WebSocket Rate Limiting
// ============================================================================

// In-memory fallback for WebSocket rate limiting (used when Redis is unavailable)
const wsRateLimitCache = new Map<string, { count: number; windowStart: number }>();
const wsMessageRateLimitCache = new Map<string, { count: number; windowStart: number }>();

/**
 * Check WebSocket connection rate limit
 * Uses Redis when available, falls back to in-memory
 */
export async function checkWebSocketRateLimit(
  req: IncomingMessage,
  config: WebSocketRateLimitConfig = { maxConnections: 50, windowMs: 60000 },
): Promise<RateLimitResult> {
  const clientIp = getClientIp(req);

  // Check if IP is blocked first
  const blockStatus = await isIpBlocked(clientIp);
  if (blockStatus.blocked) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + (blockStatus.expiresIn || BLOCK_DURATION_SECONDS) * 1000,
      current: config.maxConnections,
      limit: config.maxConnections,
      blocked: true,
      blockExpiresIn: blockStatus.expiresIn,
    };
  }

  const redis = getRedisClient();
  const key = `ratelimit:ws:conn:${clientIp}`;

  // Try Redis first
  if (redis && redis.status === 'ready') {
    try {
      const result = await checkRateLimit(key, {
        windowMs: config.windowMs,
        maxRequests: config.maxConnections,
        keyPrefix: 'ratelimit:ws:conn',
      });

      return result;
    } catch (error) {
      appLogger.warn('Redis unavailable for WebSocket rate limit, using in-memory fallback', { module: 'RateLimit' });
    }
  }

  // Fallback to in-memory rate limiting
  const now = Date.now();
  const entry = wsRateLimitCache.get(clientIp) || { count: 0, windowStart: now };

  // Reset window if expired
  if (now - entry.windowStart > config.windowMs) {
    entry.count = 0;
    entry.windowStart = now;
  }

  entry.count++;
  wsRateLimitCache.set(clientIp, entry);

  const remaining = Math.max(0, config.maxConnections - entry.count);
  const resetAt = entry.windowStart + config.windowMs;

  return {
    allowed: entry.count <= config.maxConnections,
    remaining,
    resetAt,
    current: entry.count,
    limit: config.maxConnections,
    blocked: false,
  };
}

/**
 * Check WebSocket message rate limit
 */
export async function checkWebSocketMessageRateLimit(
  clientIp: string,
  maxMessagesPerMinute: number = 60,
): Promise<RateLimitResult> {
  const redis = getRedisClient();
  const key = `ratelimit:ws:msg:${normalizeIp(clientIp)}`;

  // Try Redis first
  if (redis && redis.status === 'ready') {
    try {
      return await checkRateLimit(key, {
        windowMs: 60000, // 1 minute
        maxRequests: maxMessagesPerMinute,
        keyPrefix: 'ratelimit:ws:msg',
      });
    } catch (error) {
      appLogger.warn('Redis unavailable for message rate limit, using in-memory fallback', { module: 'RateLimit' });
    }
  }

  // Fallback to in-memory
  const now = Date.now();
  const entry = wsMessageRateLimitCache.get(clientIp) || { count: 0, windowStart: now };

  if (now - entry.windowStart > 60000) {
    entry.count = 0;
    entry.windowStart = now;
  }

  entry.count++;
  wsMessageRateLimitCache.set(clientIp, entry);

  const remaining = Math.max(0, maxMessagesPerMinute - entry.count);

  return {
    allowed: entry.count <= maxMessagesPerMinute,
    remaining,
    resetAt: entry.windowStart + 60000,
    current: entry.count,
    limit: maxMessagesPerMinute,
    blocked: false,
  };
}

// ============================================================================
// Cleanup
// ============================================================================

// Clean up in-memory caches periodically.
// #977: unref'd — this runs as an IMPORT SIDE EFFECT, so every module pulling in
// the rate-limit middleware inherits a handle that keeps the event loop alive.
const rateLimitCacheCleanupTimer = setInterval(() => {
  const now = Date.now();

  // Use Array.from for compatibility with older TypeScript targets
  Array.from(wsRateLimitCache.entries()).forEach(([ip, entry]) => {
    if (now - entry.windowStart > 120000) { // 2 minutes
      wsRateLimitCache.delete(ip);
    }
  });

  Array.from(wsMessageRateLimitCache.entries()).forEach(([ip, entry]) => {
    if (now - entry.windowStart > 120000) {
      wsMessageRateLimitCache.delete(ip);
    }
  });
}, 60000); // Clean up every minute
rateLimitCacheCleanupTimer.unref();

// Graceful shutdown
process.on('SIGTERM', async () => {
  await closeRedisConnection();
});

process.on('SIGINT', async () => {
  await closeRedisConnection();
});

// ============================================================================
// Exports
// ============================================================================

export default {
  createRateLimitMiddleware,
  checkRateLimit,
  checkWebSocketRateLimit,
  checkWebSocketMessageRateLimit,
  getClientIp,
  resolveClientIp,
  isTrustedProxy,
  generateRateLimitKey,
  isIpBlocked,
  recordViolation,
  blockIp,
  unblockIp,
  getRedisClient,
  closeRedisConnection,
  RATE_LIMIT_PRESETS,
  TRUSTED_PROXIES,
};
