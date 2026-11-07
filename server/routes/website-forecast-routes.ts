/**
 * Make a forecast from the website (epic 7, demo week of 12-07; design 2026-11-05, owner-approved 2026-11-07).
 *
 *   GET  /api/forecasts/status   { enabled, leads, variables } (public)
 *   POST /api/forecasts/draft    wallet login. { stationAlias, variable, leadHours, value } -> the canonical
 *                                forecast data, a random nonce and the commit id, for the browser to check and sign
 *   POST /api/forecasts/submit   wallet login. { data, nonce, timestamp, commitId, authPubkey, authSignature }:
 *                                checks the commit (see checkSubmission), relays it to the node and keeps the
 *                                reveal package; the reveal worker reveals in the next block
 *   GET  /api/forecasts/mine     wallet login. The wallet's forecasts, chain progress and practice score
 *
 * OFF unless WEBSITE_FORECAST_ENABLED=true (read per request; every path answers 404 while off, and the
 * reveal worker does not start). Needs migration 0043_website_forecasts (applied by hand), the Contributor
 * and Reader node credentials, and a node with the key-bound relay route (see node-forecast-client.ts).
 *
 * Limits: 30 requests/min per client (shared Redis limiter, fail-closed) and 10 drafts/submissions per
 * 10 minutes per wallet (in memory). One forecast per wallet, station, lead and UTC day (database index).
 */
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { authenticateToken } from '../middleware/auth-middleware.js';
import type { Query } from '../services/forecast-verification/observed-verification.js';
import type { NodeForecastClient } from '../services/website-forecast/node-forecast-client.js';
import {
  LEAD_HOURS, WEB_VARIABLES, ADDRESS_RE, checkSubmission, makeDraft, parseDraftInput, utcDay, websiteForecastEnabled,
} from '../services/website-forecast/website-forecast.js';
import {
  findForecastForDay, insertCommitting, listMine, resolveRegisteredStation, setStatus,
} from '../services/website-forecast/website-forecast-store.js';

export const WEBSITE_FORECAST_RATE_LIMIT = { windowMs: 60 * 1000, maxRequests: 30, keyPrefix: 'ratelimit:website-forecast' };
export const WALLET_ACTIONS_PER_WINDOW = 10;
const WALLET_WINDOW_MS = 10 * 60 * 1000;

export interface WebsiteForecastRouterDeps {
  query?: Query;
  node?: NodeForecastClient;
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
    ...WEBSITE_FORECAST_RATE_LIMIT,
    keyGenerator: mod.apiIpBudgetKey,
    message: 'Too many forecast requests, please try again later.',
  });
}

const fail = (res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  res.status(status).json({ success: false, error: { code, message, ...extra } });

type WalletRequest = Request & { user?: { address?: string } };

export function createWebsiteForecastRouter(deps: WebsiteForecastRouterDeps = {}): express.Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;
  const authenticate = deps.authenticate ?? authenticateToken;
  let queryPromise: Promise<Query> | null = null;
  const getQuery = () => (queryPromise ||= deps.query ? Promise.resolve(deps.query) : defaultQuery());
  let nodePromise: Promise<NodeForecastClient> | null = null;
  const getNode = () => (nodePromise ||= deps.node
    ? Promise.resolve(deps.node)
    : import('../services/website-forecast/node-forecast-client.js').then((m) => m.defaultNodeForecastClient()));
  let limitPromise: Promise<RequestHandler> | null = null;
  const getLimit = () => {
    if (!limitPromise) {
      limitPromise = deps.rateLimit ? Promise.resolve(deps.rateLimit) : defaultRateLimit();
      limitPromise.catch(() => { limitPromise = null; });
    }
    return limitPromise;
  };
  const walletWindows = new Map<string, { start: number; used: number }>();
  const chargeWallet = (address: string): boolean => {
    const at = now();
    if (walletWindows.size > 10_000) {
      for (const [k, w] of walletWindows) if (at - w.start >= WALLET_WINDOW_MS) walletWindows.delete(k);
    }
    const w = walletWindows.get(address);
    if (!w || at - w.start >= WALLET_WINDOW_MS) { walletWindows.set(address, { start: at, used: 1 }); return true; }
    if (w.used >= WALLET_ACTIONS_PER_WINDOW) return false;
    w.used += 1;
    return true;
  };

  // Flag and limiter run before anything else, including authentication.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!websiteForecastEnabled()) return void res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store');
    getLimit().then(
      (limit) => limit(req, res, next),
      () => fail(res, 503, 'RATE_LIMIT_UNAVAILABLE', 'Forecasting is unavailable, please try again later.'),
    );
  });

  const handle = (fn: (req: WalletRequest, res: Response, query: Query) => Promise<unknown>): RequestHandler => (req, res) => {
    getQuery().then((query) => fn(req as WalletRequest, res, query)).catch(() => {
      if (!res.headersSent) fail(res, 503, 'UNAVAILABLE', 'Forecasting is unavailable right now.');
    });
  };

  /** The acting wallet comes only from the verified login token. */
  const walletOf = (req: WalletRequest): string | null => {
    const address = typeof req.user?.address === 'string' ? req.user.address.toLowerCase() : '';
    return ADDRESS_RE.test(address) ? address : null;
  };

  router.get('/status', (_req, res) => {
    res.json({ enabled: true, leads: LEAD_HOURS, variables: WEB_VARIABLES });
  });

  router.post('/draft', express.json({ limit: '2kb' }), authenticate, handle(async (req, res, query) => {
    const forecaster = walletOf(req);
    if (!forecaster) return fail(res, 401, 'WALLET_REQUIRED', 'Log in with a 12-word wallet to make a forecast.');
    const input = parseDraftInput(req.body ?? {});
    if (input.ok === false) return fail(res, input.status, input.code, input.message);
    if (!chargeWallet(forecaster)) return fail(res, 429, 'TOO_MANY_FORECASTS', 'Too many forecast attempts. Wait a few minutes.');
    const stationId = await resolveRegisteredStation(query, input.value.stationAlias);
    if (!stationId) return fail(res, 404, 'STATION_NOT_FOUND', 'No registered station has this alias.');
    const nowSec = Math.floor(now() / 1000);
    const existing = await findForecastForDay(query, forecaster, stationId, input.value.leadHours, utcDay(nowSec));
    if (existing) {
      return fail(res, 409, 'ALREADY_FORECAST', 'You already forecast this station and lead today. One per day counts.', { commitId: existing });
    }
    return res.json(makeDraft({ ...input.value, forecaster, stationId, nowSec }));
  }));

  router.post('/submit', express.json({ limit: '8kb' }), authenticate, handle(async (req, res, query) => {
    const forecaster = walletOf(req);
    if (!forecaster) return fail(res, 401, 'WALLET_REQUIRED', 'Log in with a 12-word wallet to make a forecast.');
    const checked = checkSubmission(req.body ?? {}, forecaster, Math.floor(now() / 1000));
    if (checked.ok === false) return fail(res, checked.status, checked.code, checked.message);
    const s = checked.value;
    if (!chargeWallet(forecaster)) return fail(res, 429, 'TOO_MANY_FORECASTS', 'Too many forecast attempts. Wait a few minutes.');
    // The station must still be registered (the draft resolved it; the alias is derived from the id).
    if (await resolveRegisteredStation(query, s.record.stationAlias) !== s.record.stationId) {
      return fail(res, 404, 'STATION_NOT_FOUND', 'No registered station has this alias.');
    }
    if (!process.env.WRFCOIN_CONTRIBUTOR_TOKEN?.trim() && !deps.node) {
      return fail(res, 503, 'CORE4_CONTRIBUTOR_CREDENTIAL_UNCONFIGURED', 'Forecast relay is not configured on this server.');
    }
    const nowSec = Math.floor(now() / 1000);
    if (!(await insertCommitting(query, s, nowSec))) {
      const existing = await findForecastForDay(query, forecaster, s.record.stationId, s.leadHours, s.forecastDay);
      return fail(res, 409, 'ALREADY_FORECAST', 'You already forecast this station and lead today. One per day counts.',
        { commitId: existing ?? s.record.commitId });
    }
    const node = await getNode();
    const result = await node.submitCommit({
      forecaster, station_id: s.record.stationId, commit_hash: s.record.commitId, auth_pubkey: s.authPubkey, auth_signature: s.authSignature,
    });
    if (result.kind === 'refused') {
      await setStatus(query, nowSec, s.record.commitId, ['committing'], 'failed', { failure: `commit_refused${result.code ? `:${result.code}` : ''}` });
      return fail(res, 422, 'NODE_REFUSED', result.message ?? 'The chain node refused this forecast.', { nodeCode: result.code });
    }
    if (result.kind === 'unavailable' && result.status !== null) {
      // The node answered and did not take it: free the slot so the person can try again.
      await setStatus(query, nowSec, s.record.commitId, ['committing'], 'failed', { failure: 'node_unavailable' });
      return fail(res, 502, 'UPSTREAM_ERROR', 'The chain node did not accept the forecast right now. Try again in a minute.');
    }
    if (result.kind === 'accepted') {
      await setStatus(query, nowSec, s.record.commitId, ['committing'], 'committed', { commitTxHash: result.txHash });
    }
    // accepted, or no answer at all (timeout): the reveal worker finds the commit on chain or gives up.
    return res.status(202).json({
      commitId: s.record.commitId,
      status: result.kind === 'accepted' ? 'committed' : 'committing',
      commitTxHash: result.kind === 'accepted' ? result.txHash : null,
      stationAlias: s.record.stationAlias,
      // Unix seconds, like the draft (the frontend computes with them); /mine rows use ISO strings.
      issuedAt: s.record.issuedAt,
      validAt: s.record.validAt,
    });
  }));

  router.get('/mine', authenticate, handle(async (req, res, query) => {
    const forecaster = walletOf(req);
    if (!forecaster) return fail(res, 401, 'WALLET_REQUIRED', 'Log in with a 12-word wallet to see your forecasts.');
    return res.json({ forecasts: await listMine(query, forecaster) });
  }));

  return router;
}

export default createWebsiteForecastRouter();
