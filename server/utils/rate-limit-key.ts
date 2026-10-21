/**
 * Shared limiter helpers: the client key (IPv6 on its /64) and a hard-bounded in-memory window counter.
 *
 * NOTE: the same two helpers live inside server/routes/station-owner-routes.ts on wrfcoin/backend#1459 (not yet
 * merged); this file is the shared copy. Once both are on main, #1459's copy should import from here.
 */
import { isIP } from 'node:net';

/**
 * The limiter key for a client address: IPv4 on the full address, IPv4-mapped IPv6 (::ffff:a.b.c.d, also the hex form)
 * as that IPv4, and any other IPv6 on its /64 prefix, so one subscriber that controls a whole /64 cannot rotate
 * addresses to get a fresh budget. Never throws: ports are stripped and every unparseable value shares ONE key ("unparseable"), so garbage cannot mint fresh budgets.
 */
export function rateLimitKey(ip: string): string {
  if (!ip) return 'unknown';
  // Strip a port first: "a.b.c.d:port" and "[v6]:port" (a bare IPv6 address is never host:port), then a "%zone".
  const trimmed = ip.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(trimmed);
  const hostPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(trimmed);
  const bare = (bracketed ? bracketed[1] : hostPort ? hostPort[1] : trimmed).split('%')[0];
  if (isIP(bare) === 4) return bare;
  // Everything that is still unparseable shares ONE key, so garbage can never mint a fresh budget.
  if (isIP(bare) !== 6) return 'unparseable';
  // expand "::" into explicit zero groups; an embedded dotted IPv4 tail counts as two 16-bit groups
  let text = bare;
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[2].split('.').map(Number);
    text = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (groups.length !== 8) return 'unparseable';
  const g = groups.map((x) => parseInt(x, 16));
  if (g.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return 'unparseable';
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/** Fixed-window counter keyed by string, hard-capped at `maxKeys` entries: expired entries go first, then the oldest. */
export function createWindowCounter(max: number, windowMs: number, now: () => number, maxKeys = 10_000) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const hit = (key: string): boolean => {
    const t = now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      hits.delete(key);
      if (hits.size >= maxKeys) {
        for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
        // still full of live entries: evict the oldest inserted (Map keeps insertion order) until there is room
        while (hits.size >= maxKeys) {
          const oldest = hits.keys().next().value;
          if (oldest === undefined) break;
          hits.delete(oldest);
        }
      }
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= max;
  };
  hit.size = () => hits.size;
  return hit;
}
