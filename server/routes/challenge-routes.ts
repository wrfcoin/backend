/**
 * Friend challenges — backend#249, rebuilt for the phone screen that already exists (mobile
 * lib/features/challenges, gated off in mobile#260). Owner demo queue 2026-11-01, item 8.
 *
 *   GET  /api/challenges               the challenges the caller's wallet is in        (wallet JWT)
 *   POST /api/challenges               create { title, description, format, targetScore, durationHours }
 *   POST /api/challenges/join          join   { inviteCode }                           (wallet JWT)
 *   POST /api/challenges/sync          return the latest counts (the phone's "registerCollection";
 *                                      any client count is ignored: counts come from the chain)
 *   GET  /api/challenges/code/:code    one challenge's public board (the web share page), no login
 *
 * Points only, wallet identity only, counts from the chain: see services/friend-challenges.ts.
 * Dormant unless FRIEND_CHALLENGES_ENABLED=true (read per request; 404 otherwise). Needs migration
 * 0040_friend_challenges, applied by hand (the backend does not run migrations at startup).
 * Limits: 30 requests/min per client on every path (shared Redis limiter, fail-closed); a wallet runs at
 * most 5 open challenges; head-to-head is 2 people, a team challenge at most 20.
 *
 * The 2026-04 router (GET /active, POST /:id/claim writing a 50 WRF "reward" with no payout) is replaced.
 */
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { authenticateToken } from '../middleware/auth-middleware.js';
import {
  ChallengeError,
  createChallenge,
  friendChallengesEnabled,
  joinByCode,
  listForWallet,
  normalizeAddress,
  normalizeInviteCode,
  parseCreateInput,
  readByCode,
  type Query,
} from '../services/friend-challenges.js';

export const FRIEND_CHALLENGE_RATE_LIMIT = { windowMs: 60 * 1000, maxRequests: 30, keyPrefix: 'ratelimit:friend-challenges' };

export interface FriendChallengeRouterDeps {
  query?: Query;
  now?: () => number;
  rateLimit?: RequestHandler;
  authenticate?: RequestHandler;
}

async function defaultQuery(): Promise<Query> {
  const { pool } = await import('../../database/db.js');
  return (sql, params) => pool.query(sql, params ?? []) as Promise<{ rows: any[] }>;
}

async function defaultRateLimit(): Promise<RequestHandler> {
  const mod = await import('../../shared/middleware/rate-limit-redis.js');
  return mod.createRateLimitMiddleware({
    ...FRIEND_CHALLENGE_RATE_LIMIT,
    keyGenerator: mod.apiIpBudgetKey,
    message: 'Too many challenge requests, please try again later.',
  });
}

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });

type WalletRequest = Request & { user?: { address?: string; role?: string } };

export function createFriendChallengeRouter(deps: FriendChallengeRouterDeps = {}): express.Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;
  const authenticate = deps.authenticate ?? authenticateToken;
  let queryPromise: Promise<Query> | null = null;
  const getQuery = () => (queryPromise ||= deps.query ? Promise.resolve(deps.query) : defaultQuery());
  let limitPromise: Promise<RequestHandler> | null = null;
  const getLimit = () => {
    if (!limitPromise) {
      limitPromise = deps.rateLimit ? Promise.resolve(deps.rateLimit) : defaultRateLimit();
      limitPromise.catch(() => { limitPromise = null; });
    }
    return limitPromise;
  };

  // Flag and limiter run before anything else, including authentication.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!friendChallengesEnabled()) return void res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store');
    getLimit().then(
      (limit) => limit(req, res, next),
      () => fail(res, 503, 'RATE_LIMIT_UNAVAILABLE', 'Challenges are unavailable, please try again later.'),
    );
  });

  const handle = (fn: (req: WalletRequest, res: Response, query: Query) => Promise<unknown>): RequestHandler => (req, res) => {
    getQuery().then((query) => fn(req as WalletRequest, res, query)).catch((error: unknown) => {
      if (res.headersSent) return;
      if (error instanceof ChallengeError) return fail(res, error.status, error.code, error.message);
      return fail(res, 503, 'UNAVAILABLE', 'Challenges are unavailable right now.');
    });
  };

  /** The acting wallet comes only from the verified login token. */
  const wallet = (req: WalletRequest): string => {
    const address = normalizeAddress(req.user?.address);
    if (!address) throw new ChallengeError(403, 'WALLET_LOGIN_REQUIRED', 'Sign in with your wallet to use challenges');
    return address;
  };

  router.get('/code/:code', handle(async (req, res, query) => {
    const code = normalizeInviteCode(req.params.code);
    if (!code) return fail(res, 400, 'INVALID_CODE', 'An invite code looks like ABCD-2345');
    const challenge = await readByCode(query, code, now());
    if (!challenge) return fail(res, 404, 'NO_SUCH_CODE', 'No challenge matched that invite code');
    return res.json({ challenge });
  }));

  router.get('/', authenticate, handle(async (req, res, query) => {
    res.json({ challenges: await listForWallet(query, wallet(req), now()) });
  }));

  router.post('/', express.json({ limit: '4kb' }), authenticate, handle(async (req, res, query) => {
    const address = wallet(req);
    const input = parseCreateInput(req.body);
    res.status(201).json({ challenges: await createChallenge(query, address, input, now()) });
  }));

  router.post('/join', express.json({ limit: '1kb' }), authenticate, handle(async (req, res, query) => {
    const address = wallet(req);
    const code = normalizeInviteCode(req.body?.inviteCode);
    if (!code) return fail(res, 400, 'INVALID_CODE', 'An invite code looks like ABCD-2345');
    return res.json({ challenges: await joinByCode(query, address, code, now()) });
  }));

  router.post('/sync', express.json({ limit: '1kb' }), authenticate, handle(async (req, res, query) => {
    res.json({ challenges: await listForWallet(query, wallet(req), now()) });
  }));

  return router;
}

export default createFriendChallengeRouter();
