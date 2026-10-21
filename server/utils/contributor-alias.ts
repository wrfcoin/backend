/**
 * Public contributor aliases and shortened addresses (backend#1361).
 *
 * The public leaderboard used to hand every anonymous caller each contributor's
 * full wallet address next to a display name, and the site linked each row to a
 * profile keyed by that address. Owner ruling: anonymous callers get a short
 * address and the display name only; the full address is for the operator token
 * and for the wallet's own login.
 *
 * `profileKeyFor` is the stable public key that replaces the address in links:
 * an HMAC of the lowercase address under a dedicated sub-key. The sub-key is derived once
 * from the server secret (`HMAC-SHA256(secret, "wrf-profile-alias-key-v1")`), so the alias
 * path never touches the raw auth secret. It is not enumerable (unlike users.id), not
 * reversible, needs no migration and no new environment variable (it starts from JWT_SECRET;
 * WRFCOIN_PUBLIC_ALIAS_SECRET overrides it). Rotating the secret changes the keys, so only
 * saved links break.
 */
import crypto from 'node:crypto';

const ALIAS_KEY_LABEL = 'wrf-profile-alias-key-v1';
const ALIAS_HEX = 24;
const PROFILE_KEY_RE = /^c_[0-9a-f]{24}$/;

/** `0xa1a1…a1a1`: first 6 and last 4 characters. */
export function shortAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function isProfileKey(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_KEY_RE.test(value);
}

function aliasSecret(): string | null {
  const secret = process.env.WRFCOIN_PUBLIC_ALIAS_SECRET || process.env.JWT_SECRET || '';
  return secret.length >= 32 ? secret : null;
}

// Derived once per secret value (a change of secret, as in tests or after rotation, re-derives).
let derived: { secret: string; key: Buffer } | null = null;
function aliasKey(): Buffer | null {
  const secret = aliasSecret();
  if (!secret) return null;
  if (!derived || derived.secret !== secret) {
    derived = { secret, key: crypto.createHmac('sha256', secret).update(ALIAS_KEY_LABEL).digest() };
  }
  return derived.key;
}

/** Null when no server secret is configured (no key is better than a guessable one). */
export function profileKeyFor(address: string): string | null {
  const key = aliasKey();
  if (!key || typeof address !== 'string' || address.length === 0) return null;
  const digest = crypto.createHmac('sha256', key).update(address.toLowerCase()).digest('hex');
  return `c_${digest.slice(0, ALIAS_HEX)}`;
}

type Executor = { execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

const CACHE_MS = 60_000;
const MISS_REFRESH_MS = 10_000;

/**
 * Resolves a profile key back to a wallet address from the users table.
 *
 * The scan of the users table is bounded no matter how many requests arrive:
 *  - one rebuild at a time: concurrent callers share the same in-flight promise;
 *  - a rebuild is attempted at most every 60 s for an expired map, and at most every 10 s
 *    for a miss, and the 10 s throttle also applies after a FAILED rebuild (callers inside
 *    that window use the map they already have, which may be empty, rather than hammering
 *    a database that just failed).
 * A failed rebuild is an error only for the callers that were waiting on it.
 */
export function createProfileKeyResolver(db: Executor, extraAddresses?: () => Promise<string[]>) {
  let map = new Map<string, string>();
  let builtAt = 0;
  let lastAttempt = -Infinity;
  let inflight: Promise<void> | null = null;

  function rebuild(): Promise<void> {
    if (inflight) return inflight;
    lastAttempt = Date.now();
    inflight = (async () => {
      try {
        const result = await db.execute('SELECT wallet_address FROM users WHERE wallet_address IS NOT NULL');
        const next = new Map<string, string>();
        const rows = [...result.rows, ...(extraAddresses ? (await extraAddresses()).map(wallet_address => ({ wallet_address })) : [])];
        for (const row of rows) {
          const address = row.wallet_address;
          if (typeof address !== 'string') continue;
          const key = profileKeyFor(address);
          if (key) next.set(key, address);
        }
        map = next;
        builtAt = Date.now();
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return async function resolve(key: string): Promise<string | null> {
    if (!isProfileKey(key)) return null;
    const now = Date.now();
    if (inflight) {
      await inflight;
    } else if (now - builtAt > CACHE_MS && now - lastAttempt >= MISS_REFRESH_MS) {
      await rebuild();
    }
    let address = map.get(key);
    if (!address && !inflight && Date.now() - lastAttempt >= MISS_REFRESH_MS) {
      await rebuild();
      address = map.get(key);
    }
    return address ?? null;
  };
}
