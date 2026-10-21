/**
 * Per-address lifetime real_paid read from core4 (`GET /addresses/{address}`),
 * extracted from the leaderboard (backend#1447) so the leaderboard and the station
 * earnings route (backend#1232) share ONE cache and ONE node-read budget.
 *
 * Node read budget (LEAD standing rule, <= 30 node reads per check; the node's rate
 * limiter protects block production). Nothing here fans out node reads per visitor:
 *  - at most EARNINGS_MAX_ADDRESSES NEW node reads per EARNINGS_OK_TTL_MS window in total,
 *    across every caller (over budget => null, no read, nothing cached);
 *  - at most EARNINGS_CONCURRENCY node reads in flight at once;
 *  - results are cached >= 5 minutes, failures >= 1 minute, and concurrent callers share one read.
 */
import { fetchCore4Json as defaultFetchCore4Json } from '../../shared/core4-route-client.js';

type Core4Fetch = (path: string, options?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; payload: any }>;

/** Wire addresses core4 accepts; anything else is never put in a core4 path. */
export const CORE4_ADDRESS_RE = /^(?:0x|wrf)[0-9a-fA-F]{40}$/;
const REAL_PAID_RE = /^\d{1,39}$/;

export const EARNINGS_MAX_ADDRESSES = 30;
const EARNINGS_CONCURRENCY = 4;
const EARNINGS_CACHE_MAX = 1024;
export const EARNINGS_OK_TTL_MS = 300_000;
const EARNINGS_UNAVAILABLE_TTL_MS = 60_000;

/** Base units as a decimal string, or null when the node did not answer. */
export type EarnedRead = string | null;

export interface AddressEarnedReader {
  /** One address; null = not proven (malformed, no credential, over budget, node failure). */
  readOne(address: string): Promise<EarnedRead>;
  /** Only the first EARNINGS_MAX_ADDRESSES well-formed unique addresses may reach the node. */
  readMany(addresses: string[]): Promise<Map<string, EarnedRead>>;
}

export function createAddressEarnedReader(deps: {
  fetchCore4Json?: Core4Fetch;
  readerToken?: () => string | undefined;
  now?: () => number;
} = {}): AddressEarnedReader {
  const fetchCore4Json = deps.fetchCore4Json ?? (defaultFetchCore4Json as Core4Fetch);
  const readerToken = deps.readerToken ?? (() => process.env.WRFCOIN_READER_TOKEN?.trim() || undefined);
  const now = deps.now ?? Date.now;

  const earnedCache = new Map<string, { expiresAt: number; value: Promise<EarnedRead> }>();
  let budgetWindowStart = Number.NEGATIVE_INFINITY;
  let budgetUsed = 0;
  let inFlight = 0;
  const slotWaiters: Array<() => void> = [];
  const acquireSlot = async (): Promise<void> => {
    if (inFlight < EARNINGS_CONCURRENCY) {
      inFlight += 1;
      return;
    }
    await new Promise<void>(resolve => slotWaiters.push(resolve));
  };
  const releaseSlot = (): void => {
    const next = slotWaiters.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else inFlight -= 1;
  };
  const takeBudget = (): boolean => {
    const t = now();
    if (t - budgetWindowStart >= EARNINGS_OK_TTL_MS) {
      budgetWindowStart = t;
      budgetUsed = 0;
    }
    if (budgetUsed >= EARNINGS_MAX_ADDRESSES) return false;
    budgetUsed += 1;
    return true;
  };

  /** The node's explicit "address not found" answer, and nothing else, means nothing was credited. */
  const isAddressNotFound = (upstream: { status: number; payload: any }): boolean =>
    upstream.status === 404
    && upstream.payload?.error?.code === 'NOT_FOUND'
    && /address not found/i.test(String(upstream.payload?.error?.message ?? ''));

  function readEarned(rawAddress: string, token: string): Promise<EarnedRead> {
    const address = rawAddress.toLowerCase(); // one cache entry and one read per address, any case
    const hit = earnedCache.get(address);
    if (hit && hit.expiresAt > now()) return hit.value;
    earnedCache.delete(address);
    // Over budget: no node read and nothing cached, so a later window can try again.
    if (!takeBudget()) return Promise.resolve(null);
    const entry = { expiresAt: Infinity, value: Promise.resolve<EarnedRead>(null) };
    entry.value = Promise.resolve().then(async (): Promise<EarnedRead> => {
      let result: EarnedRead = null;
      await acquireSlot();
      try {
        const upstream = await fetchCore4Json(`/addresses/${encodeURIComponent(address)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (isAddressNotFound(upstream)) {
          result = '0';
        } else if (upstream.ok) {
          const body = upstream.payload?.data ?? upstream.payload;
          const paid = body?.contribution_rewards?.real_paid;
          if (typeof paid === 'string' && REAL_PAID_RE.test(paid)) result = paid;
        }
        // Everything else (timeout, 401/403, 429, 5xx, other 404) stays null: never retried here.
      } catch {
        result = null;
      } finally {
        releaseSlot();
      }
      entry.expiresAt = now() + (result === null ? EARNINGS_UNAVAILABLE_TTL_MS : EARNINGS_OK_TTL_MS);
      return result;
    });
    earnedCache.set(address, entry);
    while (earnedCache.size > EARNINGS_CACHE_MAX) {
      const oldest = earnedCache.keys().next().value;
      if (oldest === undefined) break;
      earnedCache.delete(oldest);
    }
    return entry.value;
  }

  async function readMany(addresses: string[]): Promise<Map<string, EarnedRead>> {
    const out = new Map<string, EarnedRead>();
    const token = readerToken();
    const unique = [...new Set(addresses)];
    const eligible: string[] = [];
    for (const a of unique) {
      if (token && CORE4_ADDRESS_RE.test(a) && eligible.length < EARNINGS_MAX_ADDRESSES) eligible.push(a);
      else out.set(a, null);
    }
    const settled = await Promise.all(eligible.map(async a => [a, await readEarned(a, token as string)] as const));
    for (const [a, v] of settled) out.set(a, v);
    return out;
  }

  return {
    async readOne(address) {
      return (await readMany([address])).get(address) ?? null;
    },
    readMany,
  };
}

let defaultReader: AddressEarnedReader | null = null;

/** Process-wide reader shared by the leaderboard and the station earnings route. */
export function getDefaultAddressEarnedReader(): AddressEarnedReader {
  if (!defaultReader) defaultReader = createAddressEarnedReader();
  return defaultReader;
}
