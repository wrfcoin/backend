/**
 * Payout watcher (backend#389): "get told when your node or station is paid".
 *
 * Node settlement credits a bonded node's payout account inside state apply, with no transaction, so no
 * block index ever sees node pay. The one public place every kind of pay shows is the account's
 * `earned_balance_total` (core4 GET /addresses/<addr>; it only goes up, spending does not lower it), which
 * is what /api/public/balance reads (backend#34). So the watcher polls that total for each address that has
 * at least one subscription and treats an increase as "this address was paid":
 *   - the first read of an address only records a baseline (no notification for history);
 *   - an increase is recorded once in payout_notification_events (primary key address + new total, so a
 *     restart or a second process cannot notify twice) and then delivered to that address's subscriptions;
 *   - when the chain-rewards index is on, producer/attester payouts it saw for the address between the
 *     two reads are named in the message; the rest is "node, station or forecast pay".
 *
 * Load on the node is bounded: at most PAYOUT_NOTIFY_MAX_ADDRESSES account reads per pass (default 200),
 * paced 250 ms apart, one pass per PAYOUT_NOTIFY_INTERVAL_MS (default 5 min). Chain 888 makes a block about
 * every 77 s and pays nodes once per 512-block epoch, so five minutes is prompt enough.
 *
 * OFF unless PAYOUT_NOTIFY_ENABLED=true. Needs migration 0037 and WRFCOIN_READER_TOKEN. Never logs an
 * address, endpoint, topic or upstream text.
 */
import type { Client, Pool } from '../chain-rewards/store.js';
import { createDeliverer, type Deliverer, type NotificationMessage, type StoredSubscription } from './channels.js';

export const payoutNotifyEnabled = () => process.env.PAYOUT_NOTIFY_ENABLED === 'true';
export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_ADDRESSES = 200;
export const PACE_MS = 250;
export const MAX_CONSECUTIVE_FAILURES = 10;
export const EVENT_RETENTION_DAYS = 30;
const BASE_UNITS_RE = /^(0|[1-9][0-9]{0,38})$/;

export interface AccountRead { earned: string | null; height: number }
export type ReadAccount = (address: string) => Promise<AccountRead | null>;
export interface Attribution { role: string; amount: string; height: string }
export type Attribute = (address: string, afterHeight: number, throughHeight: number) => Promise<Attribution[]>;

/** "1.25" from base units (8 decimals), trailing zeros trimmed. */
export function wrf(baseUnits: string): string {
  const n = BigInt(baseUnits);
  const frac = (n % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${(n / 100000000n).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function payoutMessage(address: string, before: string, after: string, height: number, attribution: Attribution[],
  siteUrl = process.env.PAYOUT_NOTIFY_SITE_URL?.trim() || 'https://wrfcoin.com'): NotificationMessage {
  const delta = (BigInt(after) - BigInt(before)).toString();
  const named = attribution.filter(a => BASE_UNITS_RE.test(a.amount) && BigInt(a.amount) > 0n);
  const namedTotal = named.reduce((n, a) => n + BigInt(a.amount), 0n);
  const parts = named.map(a => `${a.role} reward ${wrf(a.amount)} WRF (block ${Number(a.height).toLocaleString('en-US')})`);
  const rest = BigInt(delta) - namedTotal;
  if (rest > 0n) parts.push(`${named.length ? 'plus ' : ''}${wrf(rest.toString())} WRF of node, station or forecast pay`);
  return {
    title: 'WRFCoin payout',
    body: `${short(address)} was paid ${wrf(delta)} WRF on the testnet (seen at block ${height.toLocaleString('en-US')}). ` +
      `${parts.length > 1 || named.length ? `${parts.join('; ')}. ` : ''}Earned in total: ${wrf(after)} WRF.`,
    url: `${siteUrl.replace(/\/+$/, '')}/explore?address=${address}`,
    tag: `payout-${address.slice(2, 14)}`,
  };
}

async function withClient<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

export async function subscriptionsFor(client: Client, address: string): Promise<StoredSubscription[]> {
  return (await client.query(`SELECT id::text AS id, address, channel, target, p256dh, auth FROM payout_notification_subscriptions
    WHERE address=$1 AND consecutive_failures<$2 ORDER BY created_at`, [address, MAX_CONSECUTIVE_FAILURES])).rows as StoredSubscription[];
}

/** Deliver to every live subscription; drop the ones the push service says are gone. */
export async function deliverAll(pool: Pool, deliverer: Deliverer, subs: StoredSubscription[], message: NotificationMessage): Promise<number> {
  let delivered = 0;
  for (const sub of subs) {
    const outcome = await deliverer.deliver(sub, message);
    await withClient(pool, c => (outcome === 'gone'
      ? c.query('DELETE FROM payout_notification_subscriptions WHERE id=$1', [sub.id])
      : outcome === 'delivered'
        ? c.query('UPDATE payout_notification_subscriptions SET consecutive_failures=0, last_delivered_at=now() WHERE id=$1', [sub.id])
        : c.query('UPDATE payout_notification_subscriptions SET consecutive_failures=consecutive_failures+1 WHERE id=$1', [sub.id])));
    if (outcome === 'delivered') delivered++;
  }
  return delivered;
}

export async function runPayoutNotifyOnce(options: {
  pool: Pool; readAccount: ReadAccount; deliverer: Deliverer; attribute?: Attribute;
  maxAddresses?: number; sleep?: (ms: number) => Promise<void>;
}): Promise<{ addresses: number; reads: number; baselines: number; payouts: number; delivered: number; readFailures: number }> {
  const { pool, readAccount, deliverer } = options;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const summary = { addresses: 0, reads: 0, baselines: 0, payouts: 0, delivered: 0, readFailures: 0 };
  const addresses = await withClient(pool, async c => (await c.query(`SELECT DISTINCT address FROM payout_notification_subscriptions
    WHERE consecutive_failures<$1 ORDER BY address LIMIT $2`, [MAX_CONSECUTIVE_FAILURES, options.maxAddresses ?? DEFAULT_MAX_ADDRESSES])).rows.map((r: any) => r.address as string));
  summary.addresses = addresses.length;

  for (const address of addresses) {
    if (summary.reads > 0) await sleep(PACE_MS);
    summary.reads++;
    let account: AccountRead | null = null;
    try { account = await readAccount(address); } catch { account = null; }
    if (!account || account.earned === null || !BASE_UNITS_RE.test(account.earned)) { summary.readFailures++; continue; }
    const { earned, height } = account;

    const watch = await withClient(pool, async c => (await c.query(
      'SELECT earned_total::text AS earned, height::text AS height FROM payout_notification_watch WHERE address=$1', [address])).rows[0]);
    if (!watch) {
      await withClient(pool, c => c.query(`INSERT INTO payout_notification_watch (address, earned_total, height) VALUES ($1,$2::numeric,$3)
        ON CONFLICT (address) DO NOTHING`, [address, earned, height]));
      summary.baselines++;
      continue;
    }
    if (BigInt(earned) <= BigInt(watch.earned)) {
      // Unchanged (or lower: a chain reset). Either way the new value is the baseline; never notify a drop.
      await withClient(pool, c => c.query('UPDATE payout_notification_watch SET earned_total=$2::numeric, height=$3, checked_at=now() WHERE address=$1',
        [address, earned, height]));
      continue;
    }
    let attribution: Attribution[] = [];
    if (options.attribute) {
      try { attribution = await options.attribute(address, Number(watch.height), height); } catch { attribution = []; }
    }
    // Record first, then advance the baseline in the same transaction: a crash after this point can at
    // worst skip a delivery, never send one twice.
    const inserted = await withClient(pool, async c => {
      await c.query('BEGIN');
      try {
        const rows = (await c.query(`INSERT INTO payout_notification_events (address, earned_before, earned_after, height, attribution)
          VALUES ($1,$2::numeric,$3::numeric,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING address`,
        [address, watch.earned, earned, height, JSON.stringify(attribution)])).rows;
        await c.query('UPDATE payout_notification_watch SET earned_total=$2::numeric, height=$3, checked_at=now() WHERE address=$1', [address, earned, height]);
        await c.query('COMMIT');
        return rows.length === 1;
      } catch (e) { await c.query('ROLLBACK'); throw e; }
    });
    if (!inserted) continue;
    summary.payouts++;
    const subs = await withClient(pool, c => subscriptionsFor(c, address));
    summary.delivered += await deliverAll(pool, deliverer, subs, payoutMessage(address, watch.earned, earned, height, attribution));
  }

  await withClient(pool, async c => {
    await c.query(`DELETE FROM payout_notification_events WHERE detected_at < now() - make_interval(days => $1)`, [EVENT_RETENTION_DAYS]);
    await c.query(`DELETE FROM payout_notification_watch w WHERE NOT EXISTS (SELECT 1 FROM payout_notification_subscriptions s WHERE s.address=w.address)`);
  });
  return summary;
}

// ── Production wiring ─────────────────────────────────────────────────────

const unwrap = (payload: any) =>
  payload && typeof payload === 'object' && ('ok' in payload || 'success' in payload) && 'data' in payload ? payload.data : payload;

/** core4 tip + account, read with the backend's Reader credential (same reads as /api/public/balance). */
export function createAccountReader(token: string, fetchCore4Json: (path: string, options?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; payload: any }>): ReadAccount {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  return async address => {
    const tip = await fetchCore4Json('/blockchain', { headers });
    const height = tip.ok ? unwrap(tip.payload)?.height : undefined;
    if (!Number.isSafeInteger(height) || height < 0) return null;
    const account = await fetchCore4Json(`/addresses/${encodeURIComponent(address)}`, { headers });
    if (account.status === 404 && account.payload?.error?.code === 'NOT_FOUND') return { earned: '0', height };
    if (!account.ok) return null;
    const data = unwrap(account.payload) ?? {};
    if (typeof data.address === 'string' && data.address.toLowerCase() !== address) return null;
    const earned = data.earned_balance_total;
    return { earned: typeof earned === 'string' && BASE_UNITS_RE.test(earned) ? earned : null, height };
  };
}

/** Producer/attester payouts the chain-rewards index recorded for the address in (after, through]. */
export function createIndexAttribution(pool: Pool, chain: string, genesis: string): Attribute {
  return async (address, afterHeight, throughHeight) => withClient(pool, async c => (await c.query(
    `SELECT role, sum(amount)::text AS amount, max(height)::text AS height FROM chain_role_payouts
     WHERE chain_id=$1 AND genesis_hash=$2 AND payee_address=$3 AND height>$4 AND height<=$5 GROUP BY role ORDER BY role`,
    [chain, genesis, address, afterHeight, throughHeight])).rows.map((r: any) => ({ role: r.role, amount: r.amount, height: r.height })));
}

let timer: ReturnType<typeof setTimeout> | null = null;
let active = false;
export async function startPayoutNotifier(options: {
  env?: Record<string, string | undefined>;
  logger?: { info(message: string, meta?: any): void; warn(message: string, meta?: any): void };
} = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  if (env.PAYOUT_NOTIFY_ENABLED !== 'true' || active) return active;
  const token = env.WRFCOIN_READER_TOKEN?.trim();
  if (!token) { options.logger?.warn('Payout notifier not started: configuration unavailable'); return false; }
  const rawInterval = Number(env.PAYOUT_NOTIFY_INTERVAL_MS);
  const interval = Number.isSafeInteger(rawInterval) && rawInterval >= 60_000 ? rawInterval : DEFAULT_INTERVAL_MS;
  const rawMax = Number(env.PAYOUT_NOTIFY_MAX_ADDRESSES);
  const maxAddresses = Number.isSafeInteger(rawMax) && rawMax >= 1 && rawMax <= 1000 ? rawMax : DEFAULT_MAX_ADDRESSES;
  try {
    const { pool } = await import('../../../database/db.js');
    const { fetchCore4Json } = await import('../../../shared/core4-route-client.js');
    const readAccount = createAccountReader(token, fetchCore4Json as any);
    const chain = env.CHAIN_REWARD_INDEX_CHAIN_ID ?? '', genesis = env.CHAIN_REWARD_INDEX_GENESIS_HASH ?? '';
    const attribute = env.CHAIN_REWARD_INDEX_ENABLED === 'true' && /^[0-9]{1,20}$/.test(chain) && /^[0-9a-f]{64}$/.test(genesis)
      ? createIndexAttribution(pool as unknown as Pool, chain, genesis) : undefined;
    const deliverer = createDeliverer();
    const tick = async () => {
      if (!active) return;
      try {
        const summary = await runPayoutNotifyOnce({ pool: pool as unknown as Pool, readAccount, deliverer, attribute, maxAddresses });
        options.logger?.info('Payout notifier pass', summary);
      } catch { options.logger?.warn('Payout notifier pass failed'); }
      if (active) { timer = setTimeout(() => { void tick(); }, interval); timer.unref?.(); }
    };
    active = true;
    timer = setTimeout(() => { void tick(); }, 30_000); timer.unref?.();
    return true;
  } catch { options.logger?.warn('Payout notifier not started: configuration unavailable'); return false; }
}
export function stopPayoutNotifier(): void {
  active = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
