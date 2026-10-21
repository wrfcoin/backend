/**
 * Read-only Pythia predictive-oracle sidecar routes.
 *
 * The "Pythia" sidecar (repo `wrfcoin/wrfsentinel`, epic #18 / story #20) runs
 * out-of-process and periodically snapshots its predictive-oracle state into the
 * shared Redis. This router is a THIN, READ-ONLY window onto that cache — it
 * never writes to Redis, and it owns no schema. The Redis key layout below is
 * frozen and defined by the sidecar; we code against it exactly.
 *
 * Redis schema (all values produced by the sidecar):
 *   pythia:events:<domain>          STRING  {"events":[...],"cached_at":<epoch ms>}
 *   pythia:predictions:<horizon>    STRING  {"predictions":[...],"cached_at":<epoch ms>}
 *   pythia:meta                     HASH    last_event_ts,last_heartbeat_at,
 *                                           last_snapshot_at,engine_healthy,
 *                                           engine_commit,worker_started_at
 *   pythia:bounty:active            HASH    intent_id -> JSON intent
 *   pythia:bounty:intents           STREAM  fields: intent = JSON string
 *   pythia:verify:verdict:<id>      STRING  JSON verdict
 *
 * Routes (mounted at /api/pythia):
 *   GET /predictions?horizon=24h|week|month|year   (default 24h; `1w` aliases week)
 *   GET /events?domain=<domain>                    (default natural_hazards)
 *   GET /health                                    pythia:meta + feed staleness
 *   GET /bounties                                  active hash + last 50 intents
 *   GET /verdicts/:requestId                       a single verify verdict, or 404
 *
 * Every handler is read-only and fails soft: any Redis error becomes a 503
 * `{error:"redis_unavailable"}` rather than crashing the request pipeline.
 */

import { Router, Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { createRedisClient } from '../utils/create-redis.js';
// Source boot (tsx) needs the real CommonJS source. copy-build-assets.mjs
// rewrites this import to its emitted .cjs peer for native Node dist boot.
// A dist-only specifier here leaves source-mode safeMount unable to load it.
import { generalLimiter } from '../../middleware/rateLimiting.js';
import { hasOperatorOrReaderToken } from '../middleware/operator-token-auth.js';

const router = Router();

// These routes are unauthenticated by design (they mirror the sibling public
// read routes), so a limiter is the only thing standing between an anonymous
// caller and unmetered Redis reads. `generalLimiter` (15 min / 100 req per IP)
// is the same limiter `oracle-routes.js` applies to its public reads.
router.use(generalLimiter);

/**
 * Read a positive integer from the environment.
 *
 * `Number.parseInt` returns NaN for a non-numeric value, and NaN loses every
 * comparison — so a typo'd `PYTHIA_MAX_FEED_AGE_MS` would make `/health` report
 * `stale: false` forever, which is the exact opposite of what a staleness probe
 * is for. Anything not a positive integer falls back to the documented default.
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Valid prediction horizons. `1w` is an accepted alias that maps to the same
// payload as `week` (the sidecar stores it under the `week` key).
const HORIZON_KEYS: Record<string, string> = {
  '24h': '24h',
  week: 'week',
  '1w': 'week',
  month: 'month',
  year: 'year',
};
const DEFAULT_HORIZON = '24h';

// Recognised event domains. Anything else is rejected as a bad request.
const EVENT_DOMAINS = new Set([
  'natural_hazards',
  'conflict',
  'health',
  'infrastructure',
  'economy',
  'microclimate',
  'hydrology',
  'other',
]);
const DEFAULT_DOMAIN = 'natural_hazards';

// A missing heartbeat older than this (ms) marks the feed stale in /health.
const PYTHIA_MAX_FEED_AGE_MS = positiveIntFromEnv('PYTHIA_MAX_FEED_AGE_MS', 900000);

// Number of recent bounty-intent stream entries surfaced by /bounties.
const BOUNTY_INTENTS_LIMIT = 50;

// Hard cap on active bounty intents returned by /bounties. The sidecar owns
// `pythia:bounty:active` and we do not control its growth, so an unbounded
// HGETALL would let one unauthenticated request pull the entire hash into
// memory and onto the wire. We page with HSCAN and stop at this many entries.
const BOUNTY_ACTIVE_LIMIT = positiveIntFromEnv('PYTHIA_BOUNTY_ACTIVE_LIMIT', 100);

// Bound on HSCAN round-trips per request, so a hash full of non-matching or
// churning entries can never turn one request into an unbounded command loop.
const BOUNTY_SCAN_MAX_ITERATIONS = 20;

// Entries requested per HSCAN round-trip.
const BOUNTY_SCAN_COUNT = 100;

// Per-command timeout (ms). The shared factory defaults to
// `maxRetriesPerRequest: null` + infinite reconnect, which makes a command
// against an unreachable Redis QUEUE FOREVER rather than reject — so without a
// bound our try/catch never fires and the request hangs. A commandTimeout
// guarantees a down Redis surfaces as a fast rejection -> 503.
const PYTHIA_REDIS_COMMAND_TIMEOUT_MS = positiveIntFromEnv(
  'PYTHIA_REDIS_COMMAND_TIMEOUT_MS',
  3000,
);

/**
 * Lazily-constructed singleton Redis client.
 *
 * We construct on first request (not at module load) so that importing this
 * router — e.g. during safeMount — never fails and never opens a socket *from
 * this file*. The factory uses `lazyConnect`, so no connection is attempted
 * until the first command.
 *
 * Caveat, stated so the guarantee is not overclaimed: the `generalLimiter`
 * import above pulls the shared rate limiter, which self-invokes
 * `initializeRedis()` at module load and does open a connection (falling back
 * to a memory store on failure, so it cannot throw). That is not new cost —
 * `oracle-routes` is safeMounted in the live entrypoint and already loads the
 * same singleton — but it does mean "importing this router opens no socket at
 * all" would be false as a whole-process claim.
 *
 * We override the factory's fail-slow defaults: a bounded `maxRetriesPerRequest`
 * plus a `commandTimeout` so a degraded/unreachable Redis rejects promptly and
 * every handler can degrade to 503 rather than hanging. The happy path is
 * unaffected — `enableOfflineQueue` stays on so the first command after boot
 * connects and queues briefly until ready.
 */
let redisClient: Redis | null = null;
function getRedis(): Redis {
  if (!redisClient) {
    redisClient = createRedisClient({
      // #929 made this required so no caller inherits an ambiguous posture.
      //
      // `fail-closed`, not `fail-open-cache`, even though this really is a
      // disposable read cache. The distinction the factory draws is what the
      // caller does on an OUTAGE: fail-open-cache means "treat it as a cache
      // miss and load the authoritative value instead". These handlers have no
      // authoritative source to fall back to — the sidecar's Redis is the only
      // copy — so an outage is propagated as 503 and the request is refused.
      //
      // A missing KEY is different and stays empty-safe (`{predictions: [],
      // stale: true}`): that is a genuine cache miss, not an outage. Conflating
      // the two would report a dead sidecar as "no data yet", which is exactly
      // the staleness lie the /health probe exists to prevent.
      failureMode: 'fail-closed',
      maxRetriesPerRequest: 1,
      extra: { commandTimeout: PYTHIA_REDIS_COMMAND_TIMEOUT_MS },
    });
    // A singleton emits an 'error' event on every failed (re)connect. Without a
    // listener ioredis logs noisy "Unhandled error event" lines; swallow it
    // here — command-level rejections already drive our 503 handling.
    redisClient.on('error', () => {
      /* connection errors are surfaced per-command as 503 */
    });
  }
  return redisClient;
}

/** Uniform Redis-failure response: read paths degrade to 503, never 500. */
function redisUnavailable(res: Response): Response {
  return res.status(503).json({ error: 'redis_unavailable' });
}

/** Parse a JSON string defensively; return null on malformed input. */
function safeParse<T>(raw: string | null | undefined): T | null {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * GET /predictions?horizon=24h|week|month|year
 *
 * Returns the cached prediction payload for the requested horizon. When the
 * key is absent the response is empty-safe: `{predictions:[], cached_at:null,
 * stale:true}` so callers can render "no data yet" without special-casing 404.
 */
router.get('/predictions', async (req: Request, res: Response) => {
  const requested = typeof req.query.horizon === 'string' ? req.query.horizon : DEFAULT_HORIZON;
  const mapped = HORIZON_KEYS[requested];
  if (!mapped) {
    return res.status(400).json({
      error: 'invalid_horizon',
      allowed: Object.keys(HORIZON_KEYS),
    });
  }

  try {
    const raw = await getRedis().get(`pythia:predictions:${mapped}`);
    const parsed = safeParse<{ predictions?: unknown[]; cached_at?: number }>(raw);
    if (!parsed) {
      return res.json({ predictions: [], cached_at: null, stale: true });
    }
    return res.json({
      predictions: Array.isArray(parsed.predictions) ? parsed.predictions : [],
      cached_at: parsed.cached_at ?? null,
      horizon: mapped,
      stale: false,
    });
  } catch {
    return redisUnavailable(res);
  }
});

/**
 * GET /events?domain=<domain>
 *
 * Returns the cached event payload for a domain, empty-safe when the key is
 * absent (`{events:[], cached_at:null, stale:true}`).
 */
router.get('/events', async (req: Request, res: Response) => {
  const domain = typeof req.query.domain === 'string' ? req.query.domain : DEFAULT_DOMAIN;
  if (!EVENT_DOMAINS.has(domain)) {
    return res.status(400).json({
      error: 'invalid_domain',
      allowed: [...EVENT_DOMAINS],
    });
  }

  try {
    const raw = await getRedis().get(`pythia:events:${domain}`);
    const parsed = safeParse<{ events?: unknown[]; cached_at?: number }>(raw);
    if (!parsed) {
      return res.json({ events: [], cached_at: null, stale: true });
    }
    return res.json({
      events: Array.isArray(parsed.events) ? parsed.events : [],
      cached_at: parsed.cached_at ?? null,
      domain,
      stale: false,
    });
  } catch {
    return redisUnavailable(res);
  }
});

/**
 * GET /health
 *
 * Reflects the sidecar's `pythia:meta` hash plus a derived `feed_age_ms`
 * (now - last_heartbeat_at) and a `stale` flag. A missing/blank heartbeat is
 * treated as maximally stale.
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    const meta = await getRedis().hgetall('pythia:meta');
    // ioredis returns {} for a missing hash.
    const hasMeta = meta && Object.keys(meta).length > 0;

    const heartbeat = hasMeta ? Number.parseInt(meta.last_heartbeat_at ?? '', 10) : NaN;
    const feedAgeMs = Number.isFinite(heartbeat) ? Date.now() - heartbeat : null;
    const stale = feedAgeMs === null || feedAgeMs > PYTHIA_MAX_FEED_AGE_MS;

    // backend#1224: `meta` carries the sidecar git commit and heartbeats —
    // operator detail. Anonymous callers keep the staleness verdict.
    return res.json({
      meta: hasMeta && hasOperatorOrReaderToken(req) ? meta : null,
      feed_age_ms: feedAgeMs,
      stale,
      max_feed_age_ms: PYTHIA_MAX_FEED_AGE_MS,
    });
  } catch {
    return redisUnavailable(res);
  }
});

/**
 * Page through `pythia:bounty:active` with HSCAN, stopping at `limit` entries.
 *
 * Deliberately NOT HGETALL: this endpoint is unauthenticated, the sidecar owns
 * the hash, and nothing in this repo bounds its size — so HGETALL would let a
 * single anonymous request pull an arbitrarily large hash across the wire.
 * HSCAN bounds both the per-round-trip payload and, via
 * `BOUNTY_SCAN_MAX_ITERATIONS`, the number of round-trips.
 *
 * Returns the collected entries plus whether more remain, so the caller can
 * report truncation honestly rather than presenting a partial list as complete.
 */
async function scanActiveBounties(
  redis: Redis,
  limit: number,
): Promise<{ entries: Array<[string, string]>; truncated: boolean }> {
  const entries: Array<[string, string]> = [];
  let cursor = '0';
  let iterations = 0;

  do {
    const [nextCursor, flat] = (await redis.hscan(
      'pythia:bounty:active',
      cursor,
      'COUNT',
      BOUNTY_SCAN_COUNT,
    )) as [string, string[]];
    cursor = nextCursor;
    iterations += 1;

    for (let i = 0; i + 1 < flat.length; i += 2) {
      if (entries.length >= limit) {
        // More data exists beyond the cap.
        return { entries, truncated: true };
      }
      entries.push([flat[i], flat[i + 1]]);
    }
  } while (cursor !== '0' && iterations < BOUNTY_SCAN_MAX_ITERATIONS);

  // A non-zero cursor here means we stopped on the iteration guard, not because
  // the hash was exhausted — that is still truncation.
  return { entries, truncated: cursor !== '0' };
}

/**
 * GET /bounties
 *
 * Surfaces the live `pythia:bounty:active` hash (each value parsed from JSON,
 * capped at BOUNTY_ACTIVE_LIMIT) alongside the most recent
 * `pythia:bounty:intents` stream entries (newest first, capped at
 * BOUNTY_INTENTS_LIMIT).
 *
 * Both collections are bounded and the response reports its own limits, so a
 * caller can tell a complete list from a truncated one.
 */
router.get('/bounties', async (_req: Request, res: Response) => {
  try {
    const redis = getRedis();
    const [activeScan, streamEntries] = await Promise.all([
      scanActiveBounties(redis, BOUNTY_ACTIVE_LIMIT),
      // XREVRANGE key + - COUNT N -> newest-first list of [id, [field, value, ...]]
      redis.xrevrange('pythia:bounty:intents', '+', '-', 'COUNT', BOUNTY_INTENTS_LIMIT),
    ]);

    const active = activeScan.entries.map(([intentId, json]) => ({
      intent_id: intentId,
      intent: safeParse(json),
    }));

    const intents = (streamEntries as Array<[string, string[]]>).map(([id, fields]) => {
      // Flatten the [field, value, field, value, ...] array into an object.
      const record: Record<string, string> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) {
        record[fields[i]] = fields[i + 1];
      }
      return { id, intent: safeParse(record.intent) };
    });

    return res.json({
      active,
      intents,
      active_limit: BOUNTY_ACTIVE_LIMIT,
      active_truncated: activeScan.truncated,
      intents_limit: BOUNTY_INTENTS_LIMIT,
    });
  } catch {
    return redisUnavailable(res);
  }
});

/**
 * GET /verdicts/:requestId
 *
 * Returns a single verification verdict, or 404 when no verdict is cached for
 * the given request id.
 */
router.get('/verdicts/:requestId', async (req: Request, res: Response) => {
  const { requestId } = req.params;
  try {
    const raw = await getRedis().get(`pythia:verify:verdict:${requestId}`);
    const parsed = safeParse(raw);
    if (!parsed) {
      return res.status(404).json({ error: 'verdict_not_found', request_id: requestId });
    }
    return res.json(parsed);
  } catch {
    return redisUnavailable(res);
  }
});

export default router;
