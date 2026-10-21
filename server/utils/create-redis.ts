/**
 * Shared Redis Client Factory (#449)
 *
 * Centralises Redis connection construction so that every service picks up
 * REDIS_URL (set by Docker Compose) first, and falls back to the
 * REDIS_HOST / REDIS_PORT / REDIS_PASSWORD env vars for local development.
 *
 * Usage:
 *   import { createRedisClient } from '../../server/utils/create-redis.js';
 *   const redis = createRedisClient({
 *     failureMode: 'fail-closed',
 *   });
 *
 * Every caller must choose a failure mode:
 * - `fail-closed`: Redis is a security or correctness dependency.  An outage
 *   must be propagated so the request/job is refused.
 * - `fail-open-cache`: Redis contains only a disposable read cache.  The caller
 *   may catch an outage exactly like a cache miss and load the authoritative
 *   value instead.  It must never be used for auth, rate limits, claims,
 *   permissions, locks, sessions, or other security state.
 */

import Redis from 'ioredis';

export type RedisFailureMode = 'fail-closed' | 'fail-open-cache';

export type PolicyAwareRedis = Redis & {
  /**
   * The caller's declared outage policy.  This is runtime-visible for
   * diagnostics and tests; the factory never silently swallows command errors.
   */
  readonly failureMode: RedisFailureMode;
};

export interface CreateRedisOptions {
  /**
   * Required outage policy.  Requiring this at construction prevents a new
   * caller from accidentally inheriting an ambiguous security posture.
   */
  failureMode: RedisFailureMode;
  /** Override Redis database index (default: 0) */
  db?: number;
  /** ioredis enableReadyCheck (default: false for lazy connections) */
  enableReadyCheck?: boolean;
  /** ioredis connect timeout (default: 2000ms) */
  connectTimeout?: number;
  /** ioredis maxRetriesPerRequest (default: 3 for bounded retry behavior) */
  maxRetriesPerRequest?: number | null;
  /** ioredis lazyConnect (default: true) */
  lazyConnect?: boolean;
  /** Additional ioredis options merged last */
  extra?: Record<string, unknown>;
}

/**
 * Create an ioredis client, preferring REDIS_URL when available.
 *
 * In Docker Compose the `redis` service is addressed via the service name
 * which is embedded in REDIS_URL (e.g. redis://redis:6379).  When REDIS_URL
 * is absent the factory falls back to REDIS_HOST / REDIS_PORT which defaults
 * to `localhost:6379` for bare-metal development.
 *
 * The bounded defaults make command outages reject promptly in both modes.
 * `fail-closed` callers must propagate that rejection or translate it into a
 * refusal response.  Only `fail-open-cache` callers may catch it and continue
 * by loading an authoritative source.
 */
export function createRedisClient(options: CreateRedisOptions): PolicyAwareRedis {
  const {
    failureMode,
    db,
    enableReadyCheck = false,
    maxRetriesPerRequest = 3,
    lazyConnect = true,
    connectTimeout = 2000,
    extra,
  } = options;

  const common = {
    ...extra,
    enableReadyCheck,
    maxRetriesPerRequest,
    connectTimeout,
    lazyConnect,
    ...(db !== undefined && { db }),
  };

  const client = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, common)
    : new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
        ...common,
      });

  Object.defineProperty(client, 'failureMode', {
    value: failureMode,
    enumerable: true,
    configurable: false,
    writable: false,
  });

  return client as PolicyAwareRedis;
}
