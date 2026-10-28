/**
 * Public balance read for the passkey wallet (owner ruling 2026-10-28 (b)).
 *
 *   GET /api/public/balance/:address   ->   { address, balance, height }
 *
 * A passkey wallet holds no ed25519 key, so it cannot get the wallet JWT that /api/wallet/:address
 * needs, and core4 GET /addresses/<addr> needs a Reader bearer. This route reads the account with the
 * backend's own Reader credential and returns three fields only:
 *   - address: the lowercase form core4 answers with;
 *   - balance: the spendable amount in base units as a decimal string (core4 `spendable_balance`, the
 *     value a transfer is checked against and the one /api/wallet/:address calls `balance`);
 *   - height:  the tip height read BEFORE the account, so the balance is at least that fresh.
 * No nonce, stake, earnings or history. A caller credential is never forwarded and the server
 * credential never leaves this process: upstream text is not relayed and this route logs nothing.
 *
 * Dormant unless PUBLIC_BALANCE_READ_ENABLED=true (read per request; 404 otherwise). 30 reads per
 * minute per client address (path-independent bucket, so cycling addresses cannot mint budget) with
 * Retry-After on 429. Each address is cached for 5 s, single-flight, so polling clients cost the node
 * at most one read pair per address per window (core4 also caps reads per IP; see rate_limit.rs).
 * A node that cannot answer is 502 (refused / malformed) or 504 (timed out), never a 200 with a zero.
 * The one zero this returns is core4's own NOT_FOUND for an account that is not in state.
 */
import express, { type Request, type RequestHandler, type Response } from 'express';

type Core4Response = { ok: boolean; status: number; payload: any };
export type Core4Fetch = (path: string, options?: Record<string, unknown>) => Promise<Core4Response>;
export type PublicBalance = { address: string; balance: string; height: number };
type ReadResult =
  | { kind: 'ok'; value: PublicBalance }
  | { kind: 'upstream_error' }
  | { kind: 'upstream_timeout' };

export interface PublicBalanceDeps {
  fetchCore4Json?: Core4Fetch;
  readerToken?: () => string | undefined;
  now?: () => number;
  /** `undefined` resolves the shared Redis limiter lazily. There is no "off" value: a missing limiter fails closed. */
  rateLimit?: RequestHandler;
}

export const PUBLIC_BALANCE_RATE_LIMIT = { windowMs: 60 * 1000, maxRequests: 30, keyPrefix: 'ratelimit:public-balance' };
export const PUBLIC_BALANCE_CACHE_TTL_MS = 5_000;
const MAX_CACHED_ADDRESSES = 10_000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BASE_UNITS_RE = /^(0|[1-9][0-9]{0,38})$/;

const enabled = () => process.env.PUBLIC_BALANCE_READ_ENABLED === 'true';
const notFound = (res: Response) => res.status(404).json({ error: 'Not found' });
const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });

async function defaultRateLimit(): Promise<RequestHandler> {
  const mod = await import('../../shared/middleware/rate-limit-redis.js');
  return mod.createRateLimitMiddleware({
    ...PUBLIC_BALANCE_RATE_LIMIT,
    keyGenerator: mod.apiIpBudgetKey,
    message: 'Too many balance requests, please try again later.',
  });
}

async function defaultFetch(): Promise<Core4Fetch> {
  const { fetchCore4Json } = await import('../../shared/core4-route-client.js');
  return fetchCore4Json as unknown as Core4Fetch;
}

const unwrap = (payload: any) =>
  payload && typeof payload === 'object' && ('ok' in payload || 'success' in payload) && 'data' in payload ? payload.data : payload;

const isTimeout = (error: unknown) => {
  const e = error as { name?: string; code?: string } | null;
  return e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.code === 'ETIMEDOUT';
};

export function createPublicBalanceRouter(deps: PublicBalanceDeps = {}): express.Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;
  const readerToken = deps.readerToken ?? (() => process.env.WRFCOIN_READER_TOKEN?.trim() || undefined);
  const cache = new Map<string, { expiresAt: number; value: Promise<ReadResult> }>();

  let fetchPromise: Promise<Core4Fetch> | null = null;
  const getFetch = () => (fetchPromise ||= deps.fetchCore4Json ? Promise.resolve(deps.fetchCore4Json) : defaultFetch());
  let rateLimitPromise: Promise<RequestHandler> | null = null;
  const getRateLimit = () => {
    if (!rateLimitPromise) {
      rateLimitPromise = deps.rateLimit ? Promise.resolve(deps.rateLimit) : defaultRateLimit();
      rateLimitPromise.catch(() => { rateLimitPromise = null; });
    }
    return rateLimitPromise;
  };

  async function load(address: string, token: string): Promise<ReadResult> {
    // Only the server credential: no caller header (not even a request id) reaches a read whose
    // result is shared through the cache.
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    try {
      const fetchCore4Json = await getFetch();
      const tip = await fetchCore4Json('/blockchain', { headers });
      const height = tip.ok ? unwrap(tip.payload)?.height : undefined;
      if (!Number.isSafeInteger(height) || height < 0) return { kind: 'upstream_error' };

      const account = await fetchCore4Json(`/addresses/${encodeURIComponent(address)}`, { headers });
      if (account.status === 404 && account.payload?.error?.code === 'NOT_FOUND') {
        // core4's answer for an account that is not in state: nothing has ever been credited to it.
        return { kind: 'ok', value: { address, balance: '0', height } };
      }
      if (!account.ok) return { kind: 'upstream_error' };
      const data = unwrap(account.payload) ?? {};
      const raw = data.spendable_balance ?? data.balance;
      if (typeof raw !== 'string' || !BASE_UNITS_RE.test(raw)) return { kind: 'upstream_error' };
      if (typeof data.address === 'string' && data.address.toLowerCase() !== address) return { kind: 'upstream_error' };
      return { kind: 'ok', value: { address, balance: raw, height } };
    } catch (error) {
      return { kind: isTimeout(error) ? 'upstream_timeout' : 'upstream_error' };
    }
  }

  function read(address: string, token: string): Promise<ReadResult> {
    const at = now();
    const hit = cache.get(address);
    if (hit && hit.expiresAt > at) return hit.value;
    if (cache.size >= MAX_CACHED_ADDRESSES) {
      for (const [key, entry] of cache) if (entry.expiresAt <= at) cache.delete(key);
      while (cache.size >= MAX_CACHED_ADDRESSES) cache.delete(cache.keys().next().value as string);
    }
    // Failures are cached too, for the same 5 s: a broken node is not re-asked by every poll.
    const value = load(address, token);
    cache.set(address, { expiresAt: at + PUBLIC_BALANCE_CACHE_TTL_MS, value });
    return value;
  }

  router.get('/:address', (req, res, next) => {
    if (!enabled()) return notFound(res);
    getRateLimit().then(
      (limit) => limit(req, res, (err?: unknown) => (err ? next(err) : void handle(req, res))),
      () => fail(res, 503, 'RATE_LIMIT_UNAVAILABLE', 'Balance reads are unavailable, please try again later.'),
    );
  });

  async function handle(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store');
    const input = String(req.params.address ?? '');
    if (!ADDRESS_RE.test(input)) return fail(res, 400, 'VALIDATION_ERROR', 'Expected a core4 hex wallet address.');
    const token = readerToken();
    if (!token) return fail(res, 503, 'CORE4_READER_CREDENTIAL_UNCONFIGURED', 'Chain reads are unavailable on this server.');
    const result = await read(input.toLowerCase(), token);
    if (result.kind === 'ok') {
      const { address, balance, height } = result.value;
      return res.json({ address, balance, height });
    }
    if (result.kind === 'upstream_timeout') return fail(res, 504, 'UPSTREAM_TIMEOUT', 'The chain node did not answer in time.');
    return fail(res, 502, 'UPSTREAM_ERROR', 'The chain node could not answer.');
  }

  return router;
}

export default createPublicBalanceRouter();
