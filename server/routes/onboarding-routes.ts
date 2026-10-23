import { Router, Request, Response } from 'express';
import crypto, { randomInt } from 'crypto';
import {
  extractCore4Data,
  fetchCore4Json,
} from '../../shared/core4-route-client.js';
import { createRedisClient } from '../utils/create-redis.js';
import {
  isEvmWalletAddress,
  isNativeWrfcoinAddress,
  isValidWrfcoinAddress,
  normalizeWalletAddress,
} from '../../shared/wallet-address.js';
import { appLogger } from '../utils/logger.js';
import { createWindowCounter, rateLimitKey } from '../utils/rate-limit-key.js';

const router = Router();

interface Challenge {
  answer: number;
  createdAt: number;
}

const challenges = new Map<string, Challenge>();

// Challenge issuance is rate-relevant (a claim needs one) and the store is in memory: bound it per client /64
// (matching the edge's 30/min onboarding intent) and in total (oldest evicted), so a client rotating addresses inside
// one /64 cannot mint unbounded challenges.
const CHALLENGE_RATE_PER_MINUTE = 30;
let maxOutstandingChallenges = 10_000;
const challengeRate = createWindowCounter(CHALLENGE_RATE_PER_MINUTE, 60 * 1000, () => Date.now());
/** Test-only: shrink the outstanding-challenge cap. */
export function setMaxOutstandingChallengesForTests(n: number): void {
  maxOutstandingChallenges = n;
}

const RATE_LIMIT_NAMESPACE = 'faucet:claim';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Removes expired math-CAPTCHA challenges (audit/api-report-2026-09-09.md P3).
 * `/faucet/claim` already deletes an entry on any claim attempt (success,
 * wrong answer, or found-but-expired) — this sweep is the only thing that
 * removes an entry that was requested via `/faucet/challenge` and then
 * simply never claimed, which would otherwise sit in the Map forever.
 * Exported so tests can call it deterministically instead of racing a real
 * timer.
 */
export function sweepExpiredChallenges(now: number = Date.now()): number {
  let removed = 0;
  for (const [id, challenge] of challenges) {
    if (now - challenge.createdAt > CHALLENGE_TTL_MS) {
      challenges.delete(id);
      removed += 1;
    }
  }
  return removed;
}

// unref() so this interval never keeps the process alive on its own (tests,
// graceful shutdown) — it only fires while something else is keeping the
// event loop open anyway.
const challengeSweepTimer = setInterval(() => sweepExpiredChallenges(), CHALLENGE_TTL_MS);
challengeSweepTimer.unref();

/** Test-only: current challenge count, without exposing the Map itself. */
export function getChallengeCountForTests(): number {
  return challenges.size;
}
const ADDRESS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Public-testnet Sybil budget: rotating wallets must not replenish an IP /64's
// five-claim allowance every hour. Redis reserves this rolling daily budget
// atomically with the existing per-wallet cooldown and retains it on ambiguity.
const IP_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const IP_RATE_LIMIT = 5;
const DISPENSE_AMOUNT = '100';
const FAUCET_TIMEOUT_MS = 5000;
const FAUCET_DISCLAIMER =
  'This is a test network. It may be reset without notice. Balances and tokens have no monetary value. No migration to mainnet is promised or implied. Please attach no production bridges, exchange listings or irreplaceable assets. https://wrfcoin-testnet.taila1c049.ts.net/testnet-disclaimer.html';

interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    ...args: Array<string | number | Buffer | null>
  ): Promise<'OK' | null | undefined>;
  del(key: string): Promise<number>;
  eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  zremrangebyscore(key: string, min: string | number, max: number): Promise<number>;
  zadd(key: string, score: number, value: string): Promise<number>;
  zcard(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<number>;
}

let redisClient: RedisClientLike | null = null;
function getRedisClient(): RedisClientLike {
  if (!redisClient) {
    redisClient = createRedisClient({
      // Required since #929. The factory's own contract names rate limits as
      // fail-closed state: an outage must be propagated so the claim is
      // refused, never silently allowed. That is this PR's whole thesis.
      failureMode: 'fail-closed',
      lazyConnect: true,
    }) as unknown as RedisClientLike;
  }
  return redisClient;
}

function addressKey(address: string): string {
  return `${RATE_LIMIT_NAMESPACE}:address:${address}`;
}

function ipKey(ip: string): string {
  return `${RATE_LIMIT_NAMESPACE}:ip:${ip}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function withRateLimitStore<T>(operation: (store: RedisClientLike) => Promise<T>): Promise<T> {
  const redis = getRedisClient();
  try {
    return await operation(redis);
  } catch (error) {
    throw new FaucetClaimError(
      503,
      'FAUCET_RATE_LIMIT_STORE_UNAVAILABLE',
      'Faucet claim rate limiting store is temporarily unavailable'
    );
  }
}



/**
 * Undo a reservation made by `reserveClaim`. Called ONLY when the dispenser
 * positively confirms nothing was sent (`FaucetClaimError.safeToRollback`);
 * on an ambiguous failure the reservation is deliberately left in place.
 *
 * `previousClaimedAt` restores the prior cooldown rather than clearing it, so
 * a rolled-back retry cannot reset an address's 24h window.
 */
async function releaseClaim(
  address: string,
  ip: string,
  now: number,
  previousClaimedAt: number | null
): Promise<void> {
  const keyAddress = addressKey(address);
  const keyIp = ipKey(ip);
  await withRateLimitStore(async (redis) => {
    if (previousClaimedAt === null) {
      await redis.del(keyAddress);
    } else {
      const remainingMs = previousClaimedAt + ADDRESS_COOLDOWN_MS - now;
      if (remainingMs > 0) {
        await redis.set(
          keyAddress,
          String(previousClaimedAt),
          'EX',
          Math.max(1, Math.floor(remainingMs / 1000))
        );
      } else {
        await redis.del(keyAddress);
      }
    }
    // Remove only THIS request's IP entry; concurrent claims keep theirs.
    await redis.zremrangebyscore(keyIp, now, now);
  });
}

/**
 * Atomically decide AND reserve, in one round trip (#924 CRITICAL-1).
 *
 * The previous shape was: read the address key, then read the IP count, then
 * unconditionally write both. Three separate awaited calls — so two requests
 * for the same address could both observe "not claimed", both pass the IP
 * count, and both go on to dispense. Reviewed exact-head control produced
 * `[200, 200]` with the dispenser running twice.
 *
 * Redis runs a Lua script atomically against a single-threaded server, so the
 * check and the write cannot interleave. The IP quota is inside the same
 * script deliberately: fixing only the address key would leave the identical
 * race on the per-IP limit.
 */
const RESERVE_CLAIM_LUA = `
local last = redis.call('GET', KEYS[1])
local now = tonumber(ARGV[1])
if last then
  local lastN = tonumber(last)
  if lastN and (now - lastN) < tonumber(ARGV[2]) then
    return {0, 'ALREADY_CLAIMED', last, lastN + tonumber(ARGV[2]) - now}
  end
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[3]))
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then
  local oldest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
  return {0, 'RATE_LIMITED', last or '', tonumber(oldest[2]) + tonumber(ARGV[3]) - now}
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[6]))
redis.call('ZADD', KEYS[2], now, ARGV[5])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[7]))
return {1, 'RESERVED', last or ''}
`;

export type ReserveOutcome = {
  /** Prior cooldown value, for a conservative rollback. */
  previousClaimedAt: number | null;
} & (
  | { ok: true }
  | {
      ok: false;
      reason: 'ALREADY_CLAIMED' | 'RATE_LIMITED';
      /** Remaining wait from the atomic decision, rounded up and at least 1 second. */
      retryAfterSeconds: number;
    }
);

async function reserveClaim(
  address: string,
  ip: string,
  now: number
): Promise<ReserveOutcome> {
  return withRateLimitStore<ReserveOutcome>(async (redis) => {
    const raw = (await redis.eval(
      RESERVE_CLAIM_LUA,
      2,
      addressKey(address),
      ipKey(ip),
      String(now),
      String(ADDRESS_COOLDOWN_MS),
      String(IP_RATE_WINDOW_MS),
      String(IP_RATE_LIMIT),
      `${now}-${crypto.randomUUID()}`,
      String(Math.floor(ADDRESS_COOLDOWN_MS / 1000)),
      String(Math.floor(IP_RATE_WINDOW_MS / 1000))
    )) as [number | string, string, string, number | string];

    const granted = Number(raw?.[0]) === 1;
    const priorRaw = raw?.[2];
    const prior = priorRaw ? Number.parseInt(String(priorRaw), 10) : NaN;
    if (granted) {
      return { ok: true, previousClaimedAt: Number.isFinite(prior) ? prior : null };
    }
    const waitMs = Number(raw?.[3]);
    if (!Number.isFinite(waitMs)) {
      throw new Error('Invalid faucet reservation retry interval');
    }
    return {
      ok: false,
      reason: String(raw?.[1]) === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'ALREADY_CLAIMED',
      previousClaimedAt: Number.isFinite(prior) ? prior : null,
      retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
    };
  });
}


class FaucetClaimError extends Error {
  status: number;
  code: string;
  // True only when we can positively confirm the dispenser did NOT send
  // tokens (e.g. no faucet configured at all, or the dispenser completed a
  // round trip and explicitly declined). False for anything ambiguous, like
  // a network error/timeout or a 200 response we couldn't parse — in those
  // cases the dispenser may have already sent tokens, so the claim
  // reservation must NOT be rolled back (see the /faucet/claim handler).
  safeToRollback: boolean;

  constructor(status: number, code: string, message: string, safeToRollback = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.safeToRollback = safeToRollback;
  }
}

export function getFaucetServiceUrl(): string | null {
  const configured =
    process.env.FAUCET_SERVICE_URL?.trim() ||
    process.env.ONBOARDING_FAUCET_SERVICE_URL?.trim();

  return configured ? configured.replace(/\/+$/, '') : null;
}

function getPayloadMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string' && payload.trim()) {
    return payload;
  }

  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const nestedError =
    'error' in payload && payload.error && typeof payload.error === 'object'
      ? payload.error
      : null;

  if (nestedError && 'message' in nestedError && typeof nestedError.message === 'string') {
    return nestedError.message;
  }

  if ('message' in payload && typeof payload.message === 'string') {
    return payload.message;
  }

  if ('error' in payload && typeof payload.error === 'string') {
    return payload.error;
  }

  return fallback;
}

function getPayloadCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const nestedError =
    'error' in payload && payload.error && typeof payload.error === 'object'
      ? payload.error
      : null;

  if (nestedError && 'code' in nestedError && typeof nestedError.code === 'string') {
    return nestedError.code;
  }

  if ('code' in payload && typeof payload.code === 'string') {
    return payload.code;
  }

  return null;
}

function getEnvelopeData(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  if ('data' in payload && payload.data && typeof payload.data === 'object') {
    return payload.data as Record<string, unknown>;
  }

  // The infra faucet (testnet/services/faucet/server.js) answers a successful
  // dispense with `{ ok, amount, ..., receipt: { txHash, balance, amount } }`.
  // Missing this envelope turned every real payout into an ambiguous 503
  // "Faucet temporarily unavailable" with the tokens already sent.
  if ('receipt' in payload && payload.receipt && typeof payload.receipt === 'object') {
    return payload.receipt as Record<string, unknown>;
  }

  return payload as Record<string, unknown>;
}

// The infra faucet exempts requests carrying its operator bearer token from
// captcha verification (#857 Option B) — this proxy already enforces its own
// math-captcha, 24h address cooldown, and IP rate-limit. Mirrors the faucet's
// FAUCET_API_TOKEN || WRFCOIN_OPERATOR_TOKEN fallback so both sides agree on
// the same secret without extra provisioning.
export function getFaucetServiceToken(): string | null {
  const token =
    process.env.FAUCET_SERVICE_TOKEN?.trim() ||
    process.env.WRFCOIN_OPERATOR_TOKEN?.trim();
  return token || null;
}

async function dispenseFaucetTokens(walletAddress: string, clientIp: string) {
  const faucetUrl = getFaucetServiceUrl();

  if (!faucetUrl) {
    // No dispenser configured at all — no network call was ever attempted,
    // so it's safe to release the reservation on retry.
    throw new FaucetClaimError(
      503,
      'FAUCET_EMPTY',
      'Faucet temporarily unavailable',
      true
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FAUCET_TIMEOUT_MS);

  const serviceToken = getFaucetServiceToken();

  try {
    const response = await fetch(faucetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-ip': clientIp,
        ...(serviceToken ? { authorization: `Bearer ${serviceToken}` } : {}),
      },
      body: JSON.stringify({
        walletAddress,
        address: walletAddress,
        amount: DISPENSE_AMOUNT,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    let payload: unknown = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      // The dispenser completed the round trip and explicitly declined the
      // request (rate-limited, empty, rejected, etc). A response that made
      // it back to us at all means the dispenser reached a final decision
      // and didn't leave us in an unknown state — safe to release the
      // reservation on retry.
      throw new FaucetClaimError(
        response.status === 429 ? 429 : response.status >= 500 ? 503 : response.status,
        getPayloadCode(payload) ??
          (response.status === 429 ? 'RATE_LIMITED' : 'FAUCET_EMPTY'),
        getPayloadMessage(payload, 'Faucet temporarily unavailable'),
        true
      );
    }

    const data = getEnvelopeData(payload);
    const txHash =
      data.txHash ??
      data.transactionHash ??
      data.hash ??
      data.tx_id ??
      data.txId;

    if (typeof txHash !== 'string' || txHash.length === 0) {
      // Ambiguous: the dispenser returned a 2xx (its success signal) but we
      // couldn't extract a txHash from the body. Tokens may well have been
      // sent — do NOT mark this safeToRollback.
      throw new FaucetClaimError(
        503,
        'FAUCET_EMPTY',
        'Faucet temporarily unavailable'
      );
    }

    return {
      txHash,
      amount:
        data.amount === undefined || data.amount === null
          ? DISPENSE_AMOUNT
          : String(data.amount),
      balance:
        data.balance === undefined || data.balance === null
          ? null
          : String(data.balance),
    };
  } catch (error) {
    if (error instanceof FaucetClaimError) {
      throw error;
    }

    // Ambiguous: fetch() threw (network error, DNS failure, or our own
    // FAUCET_TIMEOUT_MS abort). We never received a response, so we cannot
    // tell whether the dispenser processed the request before we gave up.
    // Do NOT mark this safeToRollback.
    throw new FaucetClaimError(
      503,
      'FAUCET_EMPTY',
      'Faucet temporarily unavailable'
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWalletBalance(walletAddress: string): Promise<string | null> {
  if (!isEvmWalletAddress(walletAddress)) {
    return null;
  }

  try {
    const response = await fetchCore4Json(
      `/addresses/${encodeURIComponent(walletAddress)}`
    );

    if (!response.ok) {
      return null;
    }

    const data = extractCore4Data(response.payload) as Record<string, unknown> | null;
    const balance = data?.spendable_balance ?? data?.balance ?? null;
    return balance === null || balance === undefined ? null : String(balance);
  } catch {
    return null;
  }
}

router.post('/faucet/challenge', (req: Request, res: Response) => {
  if (!challengeRate(rateLimitKey(req.ip || '0.0.0.0'))) {
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Too many captcha requests from this network. Try again shortly.' },
    });
    return;
  }
  while (challenges.size >= maxOutstandingChallenges) {
    const oldest = challenges.keys().next().value;
    if (oldest === undefined) break;
    challenges.delete(oldest);
  }
  const a = randomInt(1, 21);
  const b = randomInt(1, 21);
  const challengeId = crypto.randomBytes(16).toString('hex');

  challenges.set(challengeId, {
    answer: a + b,
    createdAt: Date.now(),
  });

  res.status(200).json({
    challengeId,
    question: `What is ${a} + ${b}?`,
    disclaimer: FAUCET_DISCLAIMER,
  });
});

/**
 * #902 CRITICAL-2: express 4 does NOT catch a rejected promise from a bare
 * `async` handler. This route's Redis pre-checks and reservation run before
 * the inner try/catch, so a store outage rejected out of the handler, became
 * an unhandled rejection, and the request HUNG with no response — never the
 * 503 the fail-closed design advertises. (Reproduced against express@4.22.1;
 * this app registers neither `express-async-errors` nor an asyncHandler.)
 *
 * Wrapping at registration guarantees every rejection path answers, including
 * ones added later, rather than relying on each new await being inside a try.
 */
function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response) => void {
  return (req, res) => {
    handler(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        return;
      }
      const faucetError =
        error instanceof FaucetClaimError
          ? error
          : new FaucetClaimError(
              503,
              'FAUCET_UNAVAILABLE',
              'Faucet temporarily unavailable'
            );
      appLogger.error('Faucet route rejected outside a try block', {
        code: faucetError.code,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(faucetError.status).json({
        error: { code: faucetError.code, message: faucetError.message },
      });
    });
  };
}

// Shared by drip claims and bond-grant proxy requests; one-use and same TTL.
export function consumeFaucetChallenge(challengeId: unknown, answer: unknown): string | null {
  const id = typeof challengeId === 'string' ? challengeId : '';
  const challenge = challenges.get(id);
  challenges.delete(id);
  if (!challenge || Date.now() - challenge.createdAt > CHALLENGE_TTL_MS) return 'Challenge not found or expired';
  if (Number(answer) !== challenge.answer) return 'Incorrect captcha answer';
  return null;
}

router.post('/faucet/claim', asyncRoute(async (req: Request, res: Response) => {
  const { walletAddress, challengeId, answer } = req.body;

  if (!walletAddress || !isValidWrfcoinAddress(walletAddress)) {
    res.status(400).json({
      error: {
        code: 'INVALID_ADDRESS',
        message: 'Wallet address must be a valid WRFCoin native or EVM address',
      },
    });
    return;
  }

  // The infra dispenser only pays EVM-format (0x…) addresses; letting a
  // native address through would consume the caller's captcha + cooldown and
  // then 400 opaquely downstream (infra#611). Must stay ahead of the
  // challenge lookup. Remove once the dispenser learns native (infra#621).
  if (isNativeWrfcoinAddress(walletAddress)) {
    res.status(400).json({
      error: {
        code: 'EVM_ADDRESS_REQUIRED',
        message:
          'The faucet currently dispenses to EVM-format (0x…) addresses only. ' +
          "Re-submit with your wallet's 0x address; native wrf… support is tracked in wrfcoin/infra#621.",
      },
    });
    return;
  }

  const captchaMessage = consumeFaucetChallenge(challengeId, answer);
  if (captchaMessage) {
    res.status(400).json({ error: { code: 'CAPTCHA_FAILED', message: captchaMessage } });
    return;
  }

  const normalizedAddress = normalizeWalletAddress(walletAddress);

  const now = Date.now();
  const ip = req.ip || '0.0.0.0';
  // The per-IP quota buckets IPv6 clients by /64 (and IPv4-mapped IPv6 as IPv4); the dispenser still gets the real address.
  const rateKey = rateLimitKey(ip);

  // Decide AND reserve in one atomic Redis round trip. Splitting these was the
  // #924 CRITICAL: two same-address requests both read "not claimed", both
  // passed the IP count, and both dispensed.
  const reservation = await reserveClaim(normalizedAddress, rateKey, now);
  if (reservation.ok === false) {
    res.setHeader('Retry-After', String(reservation.retryAfterSeconds));
    res.status(429).json({
      error:
        reservation.reason === 'RATE_LIMITED'
          ? {
              code: 'RATE_LIMITED',
              message: 'Too many claims from this IP address. Try again later.',
            }
          : {
              code: 'ALREADY_CLAIMED',
              message: 'This address has already claimed tokens within the last 24 hours',
            },
    });
    return;
  }
  const lastClaim = reservation.previousClaimedAt;

  // Reserve the claim BEFORE calling out to the (async) dispenser (#884/#887).
  //
  // This ordering is main's and is deliberately preserved through the #902
  // rebase. The branch originally recorded the claim AFTER a successful
  // dispense, which is the check-then-dispense-then-record shape #884/#887
  // removed: two concurrent requests for the same address both pass the guards
  // above, both dispense, and only then does either write a claim. Restoring
  // it would silently re-open the double-dispense window.
  //
  // What the rebase DOES change is the store: the reservation is now the
  // durable Redis write rather than the in-memory maps, so it survives a
  // restart. Reserve first; release below if the dispenser proves nothing was
  // sent.

  try {
    const dispenseResult = await dispenseFaucetTokens(walletAddress, ip);
    const liveBalance =
      dispenseResult.balance ?? (await fetchWalletBalance(walletAddress));

    res.status(200).json({
      txHash: dispenseResult.txHash,
      amount: dispenseResult.amount,
      balance: liveBalance,
      disclaimer: FAUCET_DISCLAIMER,
    });
  } catch (error) {
    const faucetError =
      error instanceof FaucetClaimError
        ? error
        : new FaucetClaimError(
            503,
            'FAUCET_EMPTY',
            'Faucet temporarily unavailable'
          );

    // Only release the reservation when we can positively confirm nothing
    // was dispensed (see FaucetClaimError.safeToRollback). Otherwise, keep
    // it — better to make a genuinely-failed claimant wait out the cooldown
    // than to risk letting the same address/IP double-claim on retry.
    if (faucetError.safeToRollback) {
      // Durable equivalent of main's in-memory rollback. Releasing must never
      // turn a dispenser failure into a 500, so a store outage here is logged
      // and swallowed: the reservation simply stands, which is the same
      // conservative outcome as `safeToRollback === false`.
      try {
        await releaseClaim(normalizedAddress, rateKey, now, lastClaim);
      } catch (releaseError) {
        appLogger.warn('Faucet claim reservation could not be released; it will stand', {
          address: normalizedAddress,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
        });
      }
    }

    res.status(faucetError.status).json({
      error: {
        code: faucetError.code,
        message: faucetError.message,
      },
    });
  }
}));

export default router;
