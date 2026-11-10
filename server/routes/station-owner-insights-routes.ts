/**
 * Station insights for the station's owner (Epic 8).
 *
 *   GET /api/stations/:alias/compare/history   how the station has compared with the nearest
 *                                              National Weather Service station over 30 days
 *
 * Owner only. A comparison over time says things like "this station usually reads 3 degrees
 * warm", which is for the person who runs the station, not for the public page. The caller must
 * be logged in as the wallet that owns the station (weather_stations.owner_address), or carry the
 * operator/reader bearer:
 *
 *   feature off                -> 404 (same body as an unknown route)
 *   unknown alias              -> 404
 *   no wallet login            -> 401
 *   a different wallet         -> 403
 *
 * Responses are `Cache-Control: private, no-store` and carry no station id, owner, wallet or
 * coordinate. Errors are fixed text.
 *
 * OFF unless STATION_COMPARE_HISTORY_ENABLED=true (needs migration 0046, see
 * services/station-compare-history.ts).
 */
import express from 'express';
import { peekWalletSubject } from '../middleware/authMiddleware.js';
import { hasOperatorOrReaderToken } from '../middleware/operator-token-auth.js';
import { isStationAlias, resolveStationAlias } from '../utils/station-alias.js';
import { createWindowCounter, rateLimitKey } from '../utils/rate-limit-key.js';
import {
  readSamples,
  stationCompareHistoryEnabled,
  summarizeHistory,
  type Query,
} from '../services/station-compare-history.js';

type DbExecutor = { execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export const STATION_OWNER_SQL = 'SELECT lower(trim(owner_address)) AS owner_address FROM weather_stations WHERE station_id = $1 LIMIT 1';

type Problem = { status: number; code: string; message: string };
const NOT_FOUND: Problem = { status: 404, code: 'NOT_FOUND', message: 'not found' };
const fail = (res: express.Response, p: Problem) => res.status(p.status).json({ error: { code: p.code, message: p.message } });

export function createStationOwnerInsightsRouter(deps: {
  db?: DbExecutor;
  now?: () => number;
  /** Verified wallet login of the caller, lowercased; defaults to the JWT subject. */
  walletOf?: (req: express.Request) => string | null;
  isOperator?: (req: express.Request) => boolean;
  historyEnabled?: () => boolean;
  limits?: { readPerIp?: number; windowMs?: number };
} = {}): express.Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;
  const db: DbExecutor = deps.db ?? {
    execute: async (sql, params) => (await import('../../database/index.js')).executeQuery(sql, params),
  };
  const query: Query = (sql, params) => db.execute(sql, params) as Promise<{ rows: any[] }>;
  const walletOf = deps.walletOf ?? ((req: express.Request) => peekWalletSubject(req));
  const isOperator = deps.isOperator ?? ((req: express.Request) => hasOperatorOrReaderToken(req));
  const historyEnabled = deps.historyEnabled ?? stationCompareHistoryEnabled;
  const readPerIp = createWindowCounter(deps.limits?.readPerIp ?? 60, deps.limits?.windowMs ?? 15 * 60_000, now);

  /**
   * Resolves the alias and checks the caller owns the station. Answers the request itself and
   * returns null when the caller may not see it. Order matters: the feature gate comes first so
   * a switched-off feature costs no database read and looks like an unknown route.
   */
  async function ownedStation(req: express.Request, res: express.Response, enabled: () => boolean): Promise<string | null> {
    if (!enabled()) { fail(res, NOT_FOUND); return null; }
    res.set('Cache-Control', 'private, no-store');
    if (!readPerIp(rateLimitKey(String(req.ip ?? 'unknown')))) {
      fail(res, { status: 429, code: 'RATE_LIMITED', message: 'too many requests, try again later' });
      return null;
    }
    const raw = String(req.params.stationId ?? '');
    const operator = isOperator(req);
    let stationId: string | null = null;
    if (isStationAlias(raw)) {
      const resolved = await resolveStationAlias(async (sql: string, params: unknown[]) => (await db.execute(sql, params)).rows, raw);
      if (resolved.status === 'found') stationId = resolved.stationId;
    } else if (operator && /^[a-zA-Z0-9_-]{1,64}$/.test(raw)) {
      stationId = raw;
    }
    if (stationId === null) { fail(res, { status: 404, code: 'STATION_NOT_FOUND', message: 'unknown station' }); return null; }
    if (operator) return stationId;
    const wallet = walletOf(req);
    if (!wallet) { fail(res, { status: 401, code: 'LOGIN_REQUIRED', message: 'log in with the wallet that owns this station' }); return null; }
    const owner = (await db.execute(STATION_OWNER_SQL, [stationId])).rows[0]?.owner_address;
    if (typeof owner !== 'string' || owner.length === 0 || owner !== wallet) {
      fail(res, { status: 403, code: 'OWNER_ONLY', message: 'only the wallet that owns this station can see this' });
      return null;
    }
    return stationId;
  }

  const failSafe = (handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response) => {
      try {
        await handler(req, res);
      } catch {
        // Fixed text: an error message could carry SQL or the internal station id.
        if (!res.headersSent) fail(res, { status: 503, code: 'STATION_DATA_UNAVAILABLE', message: 'station data temporarily unavailable' });
      }
    };

  router.get('/stations/:stationId/compare/history', failSafe(async (req, res) => {
    const stationId = await ownedStation(req, res, historyEnabled);
    if (stationId === null) return;
    const samples = await readSamples(query, stationId, now());
    res.json({ ...summarizeHistory(samples, Math.floor(now() / 1000)), source: 'core4+nws' });
  }));

  return router;
}
