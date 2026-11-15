/**
 * Free-play forecast duels — backend#228, #1424 (owner demo queue 2026-11-01, item 10).
 *
 *   GET  /api/duels                 board: open duels, live duels, the last 20 finished      (public)
 *   GET  /api/duels/mine            the caller's duels                                       (wallet JWT)
 *   GET  /api/duels/:id             one duel                                                 (public)
 *   POST /api/duels                 open { stationAlias, targetAt, opponent? }              (wallet JWT)
 *   POST /api/duels/:id/accept      take the other side                                      (wallet JWT)
 *   POST /api/duels/:id/forecast    link your forecast commit before the lock { commitId }   (wallet JWT)
 *   POST /api/duels/:id/record      hand in a linked commit's record after the reveal        (no login:
 *                                   { commitId, nonce, timestamp, data }                       it proves itself)
 *
 * No stakes, no escrow, no payout: the chain's own forecast reward judges (services/forecast-duels.ts).
 * Funded duels are a separate consensus feature and are not built here.
 * Dormant unless FORECAST_DUELS_ENABLED=true (read per request; 404 otherwise). Needs migration
 * 0041_forecast_duels, applied by hand (the backend does not run migrations at startup), and
 * WRFCOIN_READER_TOKEN for the node checks. Limits: 30 requests/min per client (shared Redis limiter,
 * fail-closed); node checks for link/record capped process-wide at 30/min.
 *
 * The 2026-04 router (create with a stakeAmount, join, result) is replaced.
 */
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { authenticateToken } from '../middleware/auth-middleware.js';
import {
  DuelError,
  acceptDuel,
  createDuel,
  duelsEnabled,
  isDuelId,
  linkCommit,
  listBoard,
  listMine,
  normalizeAddress,
  parseCreate,
  readDuel,
  submitRecord,
  type Core4Get,
  type Query,
} from '../services/forecast-duels.js';

export const DUEL_RATE_LIMIT = { windowMs: 60 * 1000, maxRequests: 30, keyPrefix: 'ratelimit:forecast-duels' };
export const DUEL_NODE_CHECKS_PER_MIN = 30;

export interface DuelRouterDeps {
  query?: Query;
  get?: Core4Get;
  now?: () => number;
  rateLimit?: RequestHandler;
  authenticate?: RequestHandler;
}

async function defaultQuery(): Promise<Query> {
  const { pool } = await import('../../database/db.js');
  return (sql, params) => pool.query(sql, params ?? []) as Promise<{ rows: any[] }>;
}

export async function defaultDuelCore4Get(): Promise<Core4Get> {
  const { fetchCore4Json } = await import('../../shared/core4-route-client.js');
  return async (path, q) => {
    const token = process.env.WRFCOIN_READER_TOKEN?.trim();
    if (!token) throw new Error('reader credential unset');
    return fetchCore4Json(path, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, timeoutMs: 5_000, ...(q ? { query: q } : {}) }) as Promise<{ ok: boolean; status: number; payload: any }>;
  };
}

async function defaultRateLimit(): Promise<RequestHandler> {
  const mod = await import('../../shared/middleware/rate-limit-redis.js');
  return mod.createRateLimitMiddleware({ ...DUEL_RATE_LIMIT, keyGenerator: mod.apiIpBudgetKey, message: 'Too many duel requests, please try again later.' });
}

const fail = (res: Response, status: number, code: string, message: string) => res.status(status).json({ success: false, error: { code, message } });
type WalletRequest = Request & { user?: { address?: string } };

export function createDuelRouter(deps: DuelRouterDeps = {}): express.Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;
  const authenticate = deps.authenticate ?? authenticateToken;
  let queryPromise: Promise<Query> | null = null;
  const getQuery = () => (queryPromise ||= deps.query ? Promise.resolve(deps.query) : defaultQuery());
  let getPromise: Promise<Core4Get> | null = null;
  const getCore4 = () => (getPromise ||= deps.get ? Promise.resolve(deps.get) : defaultDuelCore4Get());
  let limitPromise: Promise<RequestHandler> | null = null;
  const getLimit = () => {
    if (!limitPromise) {
      limitPromise = deps.rateLimit ? Promise.resolve(deps.rateLimit) : defaultRateLimit();
      limitPromise.catch(() => { limitPromise = null; });
    }
    return limitPromise;
  };
  const budget = { windowStart: Number.NEGATIVE_INFINITY, used: 0 };
  const takeNodeCheck = (res: Response): boolean => {
    const at = now();
    if (at - budget.windowStart >= 60_000) { budget.windowStart = at; budget.used = 0; }
    if (budget.used >= DUEL_NODE_CHECKS_PER_MIN) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((budget.windowStart + 60_000 - at) / 1000))));
      fail(res, 503, 'UPSTREAM_BUDGET_EXHAUSTED', 'Duels are busy, please try again later.');
      return false;
    }
    if (!deps.get && !process.env.WRFCOIN_READER_TOKEN?.trim()) {
      fail(res, 503, 'CORE4_READER_CREDENTIAL_UNCONFIGURED', 'Chain reads are unavailable on this server.');
      return false;
    }
    budget.used += 1;
    return true;
  };

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!duelsEnabled()) return void res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store');
    getLimit().then((limit) => limit(req, res, next), () => fail(res, 503, 'RATE_LIMIT_UNAVAILABLE', 'Duels are unavailable, please try again later.'));
  });

  const handle = (fn: (req: WalletRequest, res: Response, query: Query) => Promise<unknown>): RequestHandler => (req, res) => {
    getQuery().then((query) => fn(req as WalletRequest, res, query)).catch((error: unknown) => {
      if (res.headersSent) return;
      if (error instanceof DuelError) return fail(res, error.status, error.code, error.message);
      return fail(res, 503, 'UNAVAILABLE', 'Duels are unavailable right now.');
    });
  };
  const wallet = (req: WalletRequest): string => {
    const address = normalizeAddress(req.user?.address);
    if (!address) throw new DuelError(403, 'WALLET_LOGIN_REQUIRED', 'Sign in with your wallet to duel');
    return address;
  };
  const duelId = (req: Request): string => {
    if (!isDuelId(req.params.id)) throw new DuelError(400, 'INVALID_DUEL_ID', 'A duel id is a UUID');
    return req.params.id;
  };

  router.get('/', handle(async (_req, res, query) => res.json(await listBoard(query, now()))));
  router.get('/mine', authenticate, handle(async (req, res, query) => res.json({ duels: await listMine(query, wallet(req), now()) })));
  router.get('/:id', handle(async (req, res, query) => {
    const duel = await readDuel(query, duelId(req), now());
    if (!duel) return fail(res, 404, 'NO_SUCH_DUEL', 'No duel with that id');
    return res.json({ duel });
  }));
  router.post('/', express.json({ limit: '1kb' }), authenticate, handle(async (req, res, query) => {
    const address = wallet(req);
    res.status(201).json({ duel: await createDuel(query, address, parseCreate(req.body, now()), now()) });
  }));
  router.post('/:id/accept', express.json({ limit: '1kb' }), authenticate, handle(async (req, res, query) => {
    res.json({ duel: await acceptDuel(query, wallet(req), duelId(req), now()) });
  }));
  router.post('/:id/forecast', express.json({ limit: '1kb' }), authenticate, handle(async (req, res, query) => {
    const address = wallet(req);
    const id = duelId(req);
    if (!takeNodeCheck(res)) return undefined;
    return res.json({ duel: await linkCommit(query, await getCore4(), address, id, req.body?.commitId, now()) });
  }));
  router.post('/:id/record', express.json({ limit: '8kb' }), handle(async (req, res, query) => {
    const id = duelId(req);
    if (!takeNodeCheck(res)) return undefined;
    return res.json({ duel: await submitRecord(query, await getCore4(), id, req.body ?? {}, now()) });
  }));

  return router;
}

export default createDuelRouter();
