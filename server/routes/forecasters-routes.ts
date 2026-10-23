/**
 * Public forecaster track record (wrfcoin/core4#3604, Phase A item A4).
 *
 *   GET /api/forecasters?period=7d|30d|all&limit=1..100   leaderboard + network totals for the window
 *   GET /api/forecasters/:keyOrAddress                     one forecaster's track record
 *
 * Read-only, unauthenticated, fed by the chain-rewards indexer's forecast rows (see
 * services/chain-rewards/forecaster-stats.ts). OFF unless CHAIN_REWARD_INDEX_ENABLED=true (503, like
 * /api/earnings). Anonymous callers get the short address and the opaque `c_` profile key
 * (backend#1361/#1386 rule); the operator bearer and the wallet's own login see the full address.
 * Numbers the chain does not expose yet (skill, per-forecaster paid WRF) are returned as
 * `{ status: 'not_yet_available', reason }`, never as 0. Station ids in the recent list are the public
 * `st_` alias for anonymous callers (ids can carry personal names); the raw id only for privileged viewers.
 * The raw-address form of `:keyOrAddress` is admitted for the operator bearer only: answered for anyone
 * else it would map a wallet to its site-wide `c_` key (operator-profile-routes.ts has the same guard).
 * Public lookup is by `c_` key until the owner rules on own-profile-by-address.
 */
import express, { type RequestHandler } from 'express';
import { peekWalletSubject } from '../middleware/authMiddleware.js';
import { hasOperatorToken } from '../middleware/operator-token-auth.js';
import { isProfileKey, profileKeyFor, shortAddress } from '../utils/contributor-alias.js';
// Station ids can carry personal names (owner ruling 2026-09-27): anonymous callers get the opaque alias.
import { stationAlias } from '../utils/station-alias.js';
import {
  FORECASTER_PERIODS, defaultForecasterStatsSource, forecastersEnabled,
  type ForecasterPeriod, type ForecasterStatsSource,
} from '../services/chain-rewards/forecaster-stats.js';

export interface ForecastersDeps {
  source?: ForecasterStatsSource;
  /** `null` disables rate limiting (tests); undefined resolves the shared Redis limiter lazily, failing open. */
  rateLimit?: RequestHandler | null;
}

async function defaultRateLimit(): Promise<RequestHandler | null> {
  try {
    const mod = await import('../../shared/middleware/rate-limit-redis.js');
    return mod.createRateLimitMiddleware({
      windowMs: 60 * 1000, maxRequests: 60, keyPrefix: 'ratelimit:forecasters',
      message: 'Too many forecaster requests, please try again later.',
    });
  } catch { return null; }
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function createForecastersRouter(deps: ForecastersDeps = {}): express.Router {
  const router = express.Router();
  const source = deps.source ?? defaultForecasterStatsSource();

  let rateLimitPromise: Promise<RequestHandler | null> | null = null;
  const getRateLimit = (): Promise<RequestHandler | null> => {
    if (deps.rateLimit !== undefined) return Promise.resolve(deps.rateLimit);
    if (!rateLimitPromise) rateLimitPromise = defaultRateLimit();
    return rateLimitPromise;
  };
  const limited = (handle: RequestHandler): RequestHandler => async (req, res, next) => {
    const rl = await getRateLimit();
    if (!rl) return handle(req, res, next);
    rl(req, res, (err?: unknown) => { if (err) return next(err as Error); void handle(req, res, next); });
  };

  // Full address only for the operator bearer or the wallet's own login (backend#1361 rule).
  function project(req: express.Request, res: express.Response, address: string) {
    const own = peekWalletSubject(req);
    const privileged = hasOperatorToken(req) || (own !== null && own.toLowerCase() === address);
    res.set('Cache-Control', privileged ? 'private, no-store' : 'public, max-age=60');
    const profileKey = profileKeyFor(address);
    return { profileKey, shortAddress: shortAddress(address), address: privileged ? address : null,
      isYou: own !== null && own.toLowerCase() === address };
  }

  router.get('/', limited(async (req, res) => {
    if (!forecastersEnabled()) return res.status(503).json({ status: 'unavailable', error: { code: 'FORECASTERS_DISABLED' }, reason: 'The forecast index is not enabled on this network.' });
    const period = String(req.query.period ?? '7d');
    if (!FORECASTER_PERIODS.includes(period as ForecasterPeriod)) return res.status(400).json({ error: { code: 'INVALID_FORECASTERS_QUERY', message: 'period must be 7d, 30d or all' } });
    const rawLimit = req.query.limit === undefined ? String(DEFAULT_LIMIT) : String(req.query.limit);
    if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > MAX_LIMIT) return res.status(400).json({ error: { code: 'INVALID_FORECASTERS_QUERY', message: `limit must be 1..${MAX_LIMIT}` } });
    try {
      const body = await source.leaderboard(period as ForecasterPeriod, Number(rawLimit));
      const own = peekWalletSubject(req);
      const operator = hasOperatorToken(req);
      res.set('Cache-Control', operator || own ? 'private, no-store' : 'public, max-age=60');
      return res.json({ success: true, ...body, rows: body.rows.map((row: any) => {
        const isYou = own !== null && own.toLowerCase() === row.address;
        const { address, ...rest } = row;
        return { ...rest, profileKey: profileKeyFor(address), shortAddress: shortAddress(address), address: operator || isYou ? address : null, isYou };
      }) });
    } catch { return res.status(503).json({ status: 'unavailable', error: { code: 'FORECASTERS_UNAVAILABLE' }, reason: 'The forecast index is not current.' }); }
  }));

  router.get('/:keyOrAddress', limited(async (req, res) => {
    if (!forecastersEnabled()) return res.status(503).json({ status: 'unavailable', error: { code: 'FORECASTERS_DISABLED' }, reason: 'The forecast index is not enabled on this network.' });
    const input = String(req.params.keyOrAddress ?? '');
    if (!ADDRESS_RE.test(input) && !isProfileKey(input)) return res.status(404).json({ error: { code: 'FORECASTER_NOT_FOUND' } });
    // Same 404 as an unknown key, before any read: an address lookup must not become an address -> key oracle.
    if (ADDRESS_RE.test(input) && !hasOperatorToken(req)) return res.status(404).json({ error: { code: 'FORECASTER_NOT_FOUND' } });
    try {
      const address = await source.resolveAddress(input);
      if (!address) return res.status(404).json({ error: { code: 'FORECASTER_NOT_FOUND' } });
      const body = await source.trackRecord(address);
      const { address: _full, ...rest } = body;
      const viewer = project(req, res, address);
      const privileged = viewer.address !== null;
      const recent = Array.isArray(rest.recent)
        ? rest.recent.map((r: any) => ({ ...r, stationId: privileged ? r.stationId : stationAlias(r.stationId), stationIdIsAlias: !privileged }))
        : rest.recent;
      return res.json({ success: true, ...rest, recent, ...viewer });
    } catch { return res.status(503).json({ status: 'unavailable', error: { code: 'FORECASTERS_UNAVAILABLE' }, reason: 'The forecast index is not current.' }); }
  }));

  return router;
}

export default createForecastersRouter();
