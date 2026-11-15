/**
 * Public balance read for the passkey wallet (owner ruling 2026-10-28 (b)).
 *
 *   GET /api/public/balance/:address   ->   { address, balance, height, earned }
 *
 * A passkey wallet holds no ed25519 key, so it cannot get the wallet JWT that /api/wallet/:address
 * needs, and core4 GET /addresses/<addr> needs a Reader bearer. This route reads the account with the
 * backend's own Reader credential and returns four fields only:
 *   - address: the lowercase form core4 answers with;
 *   - balance: the spendable amount in base units as a decimal string (core4 `spendable_balance`, the
 *     value a transfer is checked against and the one /api/wallet/:address calls `balance`);
 *   - height:  a tip height read before the account (shared, at most 5 s old), so the balance is at
 *     least that fresh;
 *   - earned:  everything ever credited to the account as earnings, in base units as a decimal string
 *     (core4 `earned_balance_total`; it never goes down when coins are spent). Node settlement pays
 *     bonded nodes by crediting the payout account inside state apply, with no transaction, so block
 *     indexes never see node pay and this total is the one public place it shows (owner demo
 *     2026-10-31). `null` when the node did not send the field (an older node), never a guessed 0.
 * No nonce, stake, per-reward history or transactions. A caller credential is never forwarded and the server
 * credential never leaves this process: upstream text is not relayed and this route logs nothing.
 *
 * Dormant unless PUBLIC_BALANCE_READ_ENABLED=true (read per request; 404 otherwise).
 *
 * Load on the node is bounded for the whole process, not per caller. core4 gives the backend one
 * per-IP read budget (1000/min with the Reader bearer, rate_limit.rs) that every backend read
 * shares, so a public route must not be able to spend it:
 *   - account reads (cache misses) are capped process-wide at PUBLIC_BALANCE_UPSTREAM_MAX_PER_MIN
 *     (default 120, at most 500) per fixed minute; past the cap the answer is 503 with Retry-After
 *     and the node is not asked;
 *   - the tip (/blockchain) is read at most once per 5 s for all addresses;
 * so this route costs the node at most cap + 12 reads per minute, whatever the callers do.
 * Per caller: 30 reads per minute per client address (path-independent bucket, so cycling addresses
 * mints no budget) with Retry-After on 429; the client address comes from X-Forwarded-For only
 * through TRUSTED_PROXIES, which must list the real reverse proxy (otherwise every client shares
 * one bucket). Per address: a 5 s single-flight cache, so polling one address is free after the
 * first read. A node that cannot answer is 502 (refused / malformed) or 504 (timed out), never a
 * 200 with a zero. The one zero this returns is core4's own NOT_FOUND for an account not in state.
 */
import express, { type Request, type RequestHandler, type Response } from 'express';

type Core4Response = { ok: boolean; status: number; payload: any };
export type Core4Fetch = (path: string, options?: Record<string, unknown>) => Promise<Core4Response>;
export type PublicBalance = { address: string; balance: string; height: number; earned: string | null };
type ReadResult =
  | { kind: 'ok'; value: PublicBalance }
  | { kind: 'upstream_error' }
  | { kind: 'upstream_timeout' }
  | { kind: 'budget_exhausted'; retryAfterSeconds: number };
type TipResult = { kind: 'ok'; height: number } | { kind: 'upstream_error' } | { kind: 'upstream_timeout' };

export interface PublicBalanceDeps {
  fetchCore4Json?: Core4Fetch;
  readerToken?: () => string | undefined;
  now?: () => number;
  /** `undefined` resolves the shared Redis limiter lazily. There is no "off" value: a missing limiter fails closed. */
  rateLimit?: RequestHandler;
}

export const PUBLIC_BALANCE_RATE_LIMIT = { windowMs: 60 * 1000, maxRequests: 30, keyPrefix: 'ratelimit:public-balance' };
export const PUBLIC_BALANCE_CACHE_TTL_MS = 5_000;
export const PUBLIC_BALANCE_UPSTREAM_WINDOW_MS = 60_000;
const DEFAULT_UPSTREAM_MAX_PER_MIN = 120;
const MAX_UPSTREAM_MAX_PER_MIN = 500;
const MAX_CACHED_ADDRESSES = 10_000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BASE_UNITS_RE = /^(0|[1-9][0-9]{0,38})$/;

const enabled = () => process.env.PUBLIC_BALANCE_READ_ENABLED === 'true';
/** Process-wide account reads per minute: a positive integer up to 500, else the default 120. */
export function upstreamMaxPerMinute(): number {
  const raw = process.env.PUBLIC_BALANCE_UPSTREAM_MAX_PER_MIN?.trim() ?? '';
  const value = /^[1-9][0-9]{0,5}$/.test(raw) ? Number(raw) : DEFAULT_UPSTREAM_MAX_PER_MIN;
  return Math.min(value, MAX_UPSTREAM_MAX_PER_MIN);
}
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
  let tipCache: { expiresAt: number; value: Promise<TipResult> } | null = null;
  const budget = { windowStart: Number.NEGATIVE_INFINITY, used: 0 };

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

  // Only the server credential: no caller header (not even a request id) reaches a read whose
  // result is shared through a cache.
  const serverHeaders = (token: string) => ({ authorization: `Bearer ${token}`, accept: 'application/json' });

  async function loadTip(token: string): Promise<TipResult> {
    try {
      const fetchCore4Json = await getFetch();
      const tip = await fetchCore4Json('/blockchain', { headers: serverHeaders(token) });
      const height = tip.ok ? unwrap(tip.payload)?.height : undefined;
      return Number.isSafeInteger(height) && height >= 0 ? { kind: 'ok', height } : { kind: 'upstream_error' };
    } catch (error) {
      return { kind: isTimeout(error) ? 'upstream_timeout' : 'upstream_error' };
    }
  }

  /** One tip read per 5 s for every address (failures held for the same 5 s). */
  function readTip(token: string): Promise<TipResult> {
    const at = now();
    if (tipCache && tipCache.expiresAt > at) return tipCache.value;
    const value = loadTip(token);
    tipCache = { expiresAt: at + PUBLIC_BALANCE_CACHE_TTL_MS, value };
    return value;
  }

  /** Take one account read from the process-wide fixed-window budget, or say when it reopens. */
  function takeBudget(at: number): { ok: true } | { ok: false; retryAfterSeconds: number } {
    if (at - budget.windowStart >= PUBLIC_BALANCE_UPSTREAM_WINDOW_MS) { budget.windowStart = at; budget.used = 0; }
    if (budget.used >= upstreamMaxPerMinute()) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((budget.windowStart + PUBLIC_BALANCE_UPSTREAM_WINDOW_MS - at) / 1000)) };
    }
    budget.used += 1;
    return { ok: true };
  }

  async function load(address: string, token: string): Promise<ReadResult> {
    const headers = serverHeaders(token);
    try {
      const tip = await readTip(token);
      if (tip.kind !== 'ok') return tip;
      const { height } = tip;
      const fetchCore4Json = await getFetch();
      const account = await fetchCore4Json(`/addresses/${encodeURIComponent(address)}`, { headers });
      if (account.status === 404 && account.payload?.error?.code === 'NOT_FOUND') {
        // core4's answer for an account that is not in state: nothing has ever been credited to it.
        return { kind: 'ok', value: { address, balance: '0', height, earned: '0' } };
      }
      if (!account.ok) return { kind: 'upstream_error' };
      const data = unwrap(account.payload) ?? {};
      // Spendable only: the gross `balance` includes locked stake and would overstate what can be sent.
      const raw = data.spendable_balance;
      if (typeof raw !== 'string' || !BASE_UNITS_RE.test(raw)) return { kind: 'upstream_error' };
      if (typeof data.address === 'string' && data.address.toLowerCase() !== address) return { kind: 'upstream_error' };
      // Absent (an older node) is "unknown"; present but malformed means the answer is not trustworthy.
      const earnedRaw = data.earned_balance_total;
      if (earnedRaw !== undefined && earnedRaw !== null && (typeof earnedRaw !== 'string' || !BASE_UNITS_RE.test(earnedRaw))) {
        return { kind: 'upstream_error' };
      }
      const earned = typeof earnedRaw === 'string' ? earnedRaw : null;
      return { kind: 'ok', value: { address, balance: raw, height, earned } };
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
    // Past the process-wide budget the node is not asked, and nothing is cached for the address.
    const allowed = takeBudget(at);
    if ('retryAfterSeconds' in allowed) return Promise.resolve({ kind: 'budget_exhausted', retryAfterSeconds: allowed.retryAfterSeconds });
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
      const { address, balance, height, earned } = result.value;
      return res.json({ address, balance, height, earned });
    }
    if (result.kind === 'budget_exhausted') {
      res.set('Retry-After', String(result.retryAfterSeconds));
      return fail(res, 503, 'UPSTREAM_BUDGET_EXHAUSTED', 'Balance reads are busy, please try again later.');
    }
    if (result.kind === 'upstream_timeout') return fail(res, 504, 'UPSTREAM_TIMEOUT', 'The chain node did not answer in time.');
    return fail(res, 502, 'UPSTREAM_ERROR', 'The chain node could not answer.');
  }

  return router;
}

export default createPublicBalanceRouter();
