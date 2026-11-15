/**
 * Weekly forecast competition (backend#251), points only.
 *
 *   GET /api/competitions                 this week plus recent weeks, each with its top three
 *   GET /api/competitions/current         this week's standings
 *   GET /api/competitions/:week           standings for one ISO week, e.g. 2026-W45
 *
 * Read-only and unauthenticated. Standings are computed from the chain-rewards indexer's forecast rows,
 * the same data as /api/forecasters (see services/chain-rewards/competition-stats.ts for the points
 * rule). Nothing here accepts a submission, a stake or a prize: there is no write path from a request
 * except freezing a finished week, which the read model does itself once the index has passed it.
 *
 * Dormant unless CHAIN_REWARD_INDEX_ENABLED=true AND FORECAST_COMPETITIONS_ENABLED=true (503 otherwise);
 * the second flag is set only after migration 0036 is applied. Anonymous callers see the short address and
 * the opaque `c_` profile key, the operator bearer and the wallet's own login see the full address
 * (backend#1361/#1386 rule, same projection as /api/forecasters).
 */
import express, { type RequestHandler } from 'express';
import { peekWalletSubject } from '../middleware/authMiddleware.js';
import { hasOperatorToken } from '../middleware/operator-token-auth.js';
import { profileKeyFor, shortAddress } from '../utils/contributor-alias.js';
import {
  competitionsEnabled, defaultCompetitionSource,
  type CompetitionSource, type StandingRow,
} from '../services/chain-rewards/competition-stats.js';

export interface CompetitionDeps {
  source?: CompetitionSource;
  /** `null` disables rate limiting (tests); undefined resolves the shared Redis limiter lazily, failing open. */
  rateLimit?: RequestHandler | null;
}

async function defaultRateLimit(): Promise<RequestHandler | null> {
  try {
    const mod = await import('../../shared/middleware/rate-limit-redis.js');
    return mod.createRateLimitMiddleware({
      windowMs: 60 * 1000, maxRequests: 60, keyPrefix: 'ratelimit:competitions',
      message: 'Too many competition requests, please try again later.',
    });
  } catch { return null; }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const RECENT_WEEKS = 6;
const WEEK_RE = /^[0-9]{4}-W[0-9]{2}$/;

const disabled = (res: express.Response) => res.status(503).json({
  status: 'unavailable', error: { code: 'COMPETITIONS_DISABLED' }, reason: 'Forecast competitions are not enabled on this network.',
});
const unavailable = (res: express.Response) => res.status(503).json({
  status: 'unavailable', error: { code: 'COMPETITIONS_UNAVAILABLE' }, reason: 'The forecast index is not current.',
});

export function createCompetitionRouter(deps: CompetitionDeps = {}): express.Router {
  const router = express.Router();
  const source = deps.source ?? defaultCompetitionSource();

  let rateLimitPromise: Promise<RequestHandler | null> | null = null;
  const getRateLimit = (): Promise<RequestHandler | null> => {
    if (deps.rateLimit !== undefined) return Promise.resolve(deps.rateLimit);
    if (!rateLimitPromise) rateLimitPromise = defaultRateLimit();
    return rateLimitPromise;
  };
  const limited = (handle: RequestHandler): RequestHandler => async (req, res, next) => {
    if (!competitionsEnabled()) return disabled(res);
    const rl = await getRateLimit();
    if (!rl) return handle(req, res, next);
    rl(req, res, (err?: unknown) => { if (err) return next(err as Error); void handle(req, res, next); });
  };

  /** Anonymous: short address + profile key. Operator or the wallet's own login: the full address too. */
  function projector(req: express.Request, res: express.Response) {
    const own = peekWalletSubject(req);
    const operator = hasOperatorToken(req);
    res.set('Cache-Control', operator || own ? 'private, no-store' : 'public, max-age=60');
    return (row: StandingRow) => {
      const isYou = own !== null && own.toLowerCase() === row.address;
      const { address, ...rest } = row;
      return { ...rest, profileKey: profileKeyFor(address), shortAddress: shortAddress(address), address: operator || isYou ? address : null, isYou };
    };
  }

  function parseLimit(raw: unknown): number | null {
    const text = raw === undefined ? String(DEFAULT_LIMIT) : String(raw);
    if (!/^[1-9][0-9]{0,2}$/.test(text) || Number(text) > MAX_LIMIT) return null;
    return Number(text);
  }

  async function sendStandings(req: express.Request, res: express.Response, week: string) {
    const limit = parseLimit(req.query.limit);
    if (limit === null) return res.status(400).json({ error: { code: 'INVALID_COMPETITION_QUERY', message: `limit must be 1..${MAX_LIMIT}` } });
    try {
      const body = await source.standings(week);
      if (!body) return res.status(404).json({ error: { code: 'COMPETITION_NOT_FOUND', message: 'No competition for that week on this chain.' } });
      const project = projector(req, res);
      const all = body.rows.map(project);
      // The caller's own row is returned even when it is outside the requested top `limit`.
      const you = all.find(r => r.isYou) ?? null;
      return res.json({ success: true, ...body, rows: all.slice(0, limit), you, limit });
    } catch { return unavailable(res); }
  }

  router.get('/', limited(async (req, res) => {
    try {
      const body = await source.recent(RECENT_WEEKS);
      const project = projector(req, res);
      return res.json({ success: true, current: body.current, weeks: body.weeks.map(w => ({ ...w, leaders: w.leaders.map(project) })) });
    } catch { return unavailable(res); }
  }));

  router.get('/current', limited((req, res) => sendStandings(req, res, source.currentWeek())));

  router.get('/:week', limited((req, res) => {
    const week = String(req.params.week ?? '');
    if (!WEEK_RE.test(week)) return res.status(404).json({ error: { code: 'COMPETITION_NOT_FOUND', message: 'Weeks look like 2026-W45.' } });
    return sendStandings(req, res, week);
  }));

  return router;
}

export default createCompetitionRouter();
