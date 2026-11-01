/**
 * Payout notifications (backend#389): "get told when your node or station is paid".
 *
 *   GET    /api/notifications/config                    which channels this server can deliver (public)
 *   POST   /api/notifications/subscriptions             subscribe an address        (wallet login of that address)
 *   GET    /api/notifications/subscriptions/:address    list that address's subscriptions (wallet login)
 *   DELETE /api/notifications/subscriptions/:id         remove one                  (wallet login of its address)
 *   POST   /api/notifications/subscriptions/:id/test    send a test notification    (wallet login, 1/min per subscription)
 *   POST   /api/notifications/unsubscribe               remove by possession of the push endpoint or ntfy topic (no login)
 *   POST   /api/notifications/passkey/challenge         a single-use nonce for a passkey wallet       (no login)
 *   POST   /api/notifications/passkey/subscriptions     subscribe a passkey address  (WebAuthn assertion over the request)
 *   POST   /api/notifications/passkey/unsubscribe       remove one by its target hash (WebAuthn assertion over the request)
 *
 * Owner ruling 2026-11-01: we never hold emails or personal data. A subscription is an address plus either a
 * browser push subscription (an opaque endpoint at the browser vendor's push service and two public keys) or
 * an ntfy topic the user chose. Nothing else is stored: no IP, no user agent, no name. Subscribing needs the
 * wallet login token (/api/wallet-auth) of the address, so nobody can point notifications for an address at
 * a device without holding its key. A passkey wallet has no such token: it signs the request itself with its
 * passkey instead (services/payout-notify/passkey-proof.ts, owner approval 2026-11-01): a WebAuthn assertion
 * over a single-use server nonce, bound to the address, action and target. Delivery is in services/payout-notify
 * (no paid service: browser push services and ntfy.sh are free).
 *
 * Dormant unless PAYOUT_NOTIFY_ENABLED=true (503 otherwise; /config answers `enabled: false`), and needs
 * migration 0037 (the passkey routes add no table: their nonces live in Redis for five minutes). Web Push
 * needs WEB_PUSH_VAPID_PUBLIC_KEY/PRIVATE_KEY; ntfy is on unless PAYOUT_NOTIFY_NTFY_SERVER=off.
 */
import express, { type Request, type RequestHandler, type Response } from 'express';
import { peekWalletSubject } from '../middleware/authMiddleware.js';
import type { Pool } from '../services/chain-rewards/store.js';
import {
  ADDRESS_RE, NTFY_TOPIC_RE, channelConfig, createDeliverer, isAllowedPushEndpoint, parseChannel, targetHash,
  type Deliverer,
} from '../services/payout-notify/channels.js';
import { DEFAULT_INTERVAL_MS, deliverAll, payoutNotifyEnabled } from '../services/payout-notify/watcher.js';
import {
  NONCE_TTL_SEC, PASSKEY_NOTIFY_DOMAIN, createRedisNonceStore, isNonce, newNonce, parsePasskeyAuth, passkeyAuthAddress,
  passkeyNotifyChain, passkeyNotifyChallenge, verifyPasskeyAssertion, type NonceStore, type PasskeyNotifyAction,
} from '../services/payout-notify/passkey-proof.js';

export const MAX_PER_ADDRESS = 10;
export const DEFAULT_MAX_SUBSCRIPTIONS = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEST_COOLDOWN_MS = 60_000;

export interface NotificationDeps {
  pool?: Pool;
  deliverer?: Deliverer;
  /** `null` disables rate limiting (tests); undefined resolves the shared Redis limiter, failing closed. */
  rateLimit?: RequestHandler | null;
  now?: () => number;
  /** Passkey challenge nonces; defaults to Redis (REDIS_URL) so every process shares them. */
  nonceStore?: NonceStore;
}

function defaultNonceStore(): NonceStore {
  let redis: Promise<any> | null = null;
  return createRedisNonceStore(() => {
    redis ??= import('ioredis').then(m => {
      const client = new m.default(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 2 });
      client.on('error', () => { /* a command fails and the route answers 503; nothing to log per retry */ });
      return client;
    });
    return redis;
  });
}

async function defaultRateLimit(): Promise<RequestHandler> {
  const mod = await import('../../shared/middleware/rate-limit-redis.js');
  return mod.createRateLimitMiddleware({
    windowMs: 60 * 1000, maxRequests: 20, keyPrefix: 'ratelimit:notifications',
    message: 'Too many notification requests, please try again later.',
  });
}

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });

function maxSubscriptions(): number {
  const raw = Number(process.env.PAYOUT_NOTIFY_MAX_SUBSCRIPTIONS);
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= 100_000 ? raw : DEFAULT_MAX_SUBSCRIPTIONS;
}

/** What the owner of the address sees about a subscription: never the full push endpoint. */
function view(row: any) {
  let label = row.target;
  if (row.channel === 'webpush') { try { label = new URL(row.target).hostname; } catch { label = 'browser'; } }
  return {
    id: row.id, address: row.address, channel: row.channel, label, targetHash: row.target_hash,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    lastDeliveredAt: row.last_delivered_at instanceof Date ? row.last_delivered_at.toISOString() : row.last_delivered_at ?? null,
  };
}

export function createPayoutNotificationRouter(deps: NotificationDeps = {}): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '4kb' }));
  const now = deps.now ?? Date.now;
  const lastTest = new Map<string, number>();
  let poolPromise: Promise<Pool> | null = null;
  const getPool = (): Promise<Pool> => {
    if (deps.pool) return Promise.resolve(deps.pool);
    poolPromise ??= import('../../database/db.js').then(m => m.pool as unknown as Pool);
    return poolPromise;
  };
  const deliverer = deps.deliverer ?? createDeliverer();
  const nonces = deps.nonceStore ?? defaultNonceStore();
  let rateLimitPromise: Promise<RequestHandler | null> | null = null;
  const getRateLimit = (): Promise<RequestHandler | null> => {
    if (deps.rateLimit !== undefined) return Promise.resolve(deps.rateLimit);
    if (!rateLimitPromise) {
      rateLimitPromise = defaultRateLimit();
      rateLimitPromise.catch(() => { rateLimitPromise = null; });
    }
    return rateLimitPromise;
  };
  /** The lowercase address of a valid wallet login, or null. */
  const caller = (req: Request) => peekWalletSubject(req);
  /** `login: true` refuses a request without a valid wallet login first (401), before the flag or the limiter. */
  const guarded = (handle: (req: Request, res: Response) => Promise<unknown>, opts: { login?: boolean } = {}): RequestHandler => (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (opts.login && !caller(req)) return fail(res, 401, 'WALLET_LOGIN_REQUIRED', 'Sign in with the wallet for this address first.');
    if (!payoutNotifyEnabled()) return fail(res, 503, 'NOTIFICATIONS_DISABLED', 'Payout notifications are not enabled on this network.');
    getRateLimit().then(
      limit => {
        const run = () => handle(req, res).catch(() => {
          if (!res.headersSent) fail(res, 503, 'NOTIFICATIONS_UNAVAILABLE', 'Notifications are unavailable right now.');
        });
        if (!limit) return void run();
        limit(req, res, (err?: unknown) => (err ? next(err) : void run()));
      },
      () => fail(res, 503, 'RATE_LIMIT_UNAVAILABLE', 'Notifications are unavailable, please try again later.'),
    );
  };
  const query = async (sql: string, params: unknown[]) => {
    const client = await (await getPool()).connect();
    try { return (await client.query(sql, params)).rows; } finally { client.release(); }
  };

  /** Validate the channel and store the subscription for an address whose control is already proven. */
  async function subscribe(res: Response, address: string, body: unknown, expectHash?: (channel: string, hash: string) => Promise<boolean>) {
    const parsed = parseChannel(body);
    if ('error' in parsed) return fail(res, 400, 'VALIDATION_ERROR', parsed.error);
    const cfg = channelConfig();
    if (parsed.channel === 'webpush' && !cfg.webPush) return fail(res, 409, 'CHANNEL_UNAVAILABLE', 'Browser push is not configured on this server.');
    if (parsed.channel === 'ntfy' && !cfg.ntfyServer) return fail(res, 409, 'CHANNEL_UNAVAILABLE', 'ntfy is not configured on this server.');
    const target = parsed.channel === 'webpush' ? parsed.target.endpoint : parsed.topic;
    const hash = targetHash(target);
    if (expectHash && !(await expectHash(parsed.channel, hash))) return undefined;
    const counts = (await query(`SELECT count(*) FILTER (WHERE address=$1)::int AS mine, count(*)::int AS total,
        count(*) FILTER (WHERE address=$1 AND channel=$2 AND target_hash=$3)::int AS existing FROM payout_notification_subscriptions`,
    [address, parsed.channel, hash]))[0];
    if (!counts.existing && counts.mine >= MAX_PER_ADDRESS) return fail(res, 409, 'TOO_MANY_SUBSCRIPTIONS', `At most ${MAX_PER_ADDRESS} devices or topics per address.`);
    if (!counts.existing && counts.total >= maxSubscriptions()) return fail(res, 503, 'SUBSCRIPTIONS_FULL', 'This server is not taking new subscriptions right now.');
    const p256dh = parsed.channel === 'webpush' ? parsed.target.p256dh : null;
    const auth = parsed.channel === 'webpush' ? parsed.target.auth : null;
    const row = (await query(`INSERT INTO payout_notification_subscriptions (address, channel, target, target_hash, p256dh, auth)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (address, channel, target_hash) DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, consecutive_failures=0
      RETURNING id::text AS id, address, channel, target, target_hash, created_at, last_delivered_at`,
    [address, parsed.channel, target, hash, p256dh, auth]))[0];
    return res.status(counts.existing ? 200 : 201).json({ success: true, subscription: view(row) });
  }

  router.get('/config', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    const cfg = channelConfig();
    const enabled = payoutNotifyEnabled();
    return res.json({
      enabled,
      events: ['payout.credited'],
      checkEveryMinutes: Math.round((Number(process.env.PAYOUT_NOTIFY_INTERVAL_MS) >= 60_000 ? Number(process.env.PAYOUT_NOTIFY_INTERVAL_MS) : DEFAULT_INTERVAL_MS) / 60_000),
      webPush: { available: enabled && cfg.webPush !== null, publicKey: enabled ? cfg.webPush?.publicKey ?? null : null },
      ntfy: { available: enabled && cfg.ntfyServer !== null, server: enabled ? cfg.ntfyServer : null },
      stores: 'An address and a browser push subscription or an ntfy topic. No email, name or IP address.',
    });
  });

  router.post('/subscriptions', guarded(async (req, res) => {
    const address = typeof req.body?.address === 'string' ? req.body.address.toLowerCase() : '';
    if (!ADDRESS_RE.test(address)) return fail(res, 400, 'VALIDATION_ERROR', 'address must be a 0x chain address.');
    const who = caller(req);
    if (!who) return fail(res, 401, 'WALLET_LOGIN_REQUIRED', 'Sign in with the wallet for this address first.');
    if (who !== address) return fail(res, 403, 'WALLET_MISMATCH', 'The signed-in wallet is not this address.');
    return subscribe(res, address, req.body);
  }, { login: true }));

  router.get('/subscriptions/:address', guarded(async (req, res) => {
    const address = String(req.params.address ?? '').toLowerCase();
    if (!ADDRESS_RE.test(address)) return fail(res, 400, 'VALIDATION_ERROR', 'address must be a 0x chain address.');
    const who = caller(req);
    if (!who) return fail(res, 401, 'WALLET_LOGIN_REQUIRED', 'Sign in with the wallet for this address first.');
    if (who !== address) return fail(res, 403, 'WALLET_MISMATCH', 'The signed-in wallet is not this address.');
    const rows = await query(`SELECT id::text AS id, address, channel, target, target_hash, created_at, last_delivered_at
      FROM payout_notification_subscriptions WHERE address=$1 ORDER BY created_at`, [address]);
    const watch = (await query(`SELECT earned_total::text AS earned, height::text AS height, checked_at FROM payout_notification_watch WHERE address=$1`, [address]))[0];
    return res.json({ success: true, address, subscriptions: rows.map(view),
      lastCheck: watch ? { earned: watch.earned, height: watch.height, at: watch.checked_at instanceof Date ? watch.checked_at.toISOString() : watch.checked_at } : null });
  }, { login: true }));

  async function ownedSubscription(req: Request, res: Response): Promise<any | null> {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) { fail(res, 404, 'NOT_FOUND', 'No such subscription.'); return null; }
    const who = caller(req);
    if (!who) { fail(res, 401, 'WALLET_LOGIN_REQUIRED', 'Sign in with the wallet for this address first.'); return null; }
    const row = (await query(`SELECT id::text AS id, address, channel, target, target_hash, p256dh, auth, created_at, last_delivered_at
      FROM payout_notification_subscriptions WHERE id=$1::uuid`, [id]))[0];
    // Someone else's subscription answers exactly like a missing one.
    if (!row || row.address !== who) { fail(res, 404, 'NOT_FOUND', 'No such subscription.'); return null; }
    return row;
  }

  router.delete('/subscriptions/:id', guarded(async (req, res) => {
    const row = await ownedSubscription(req, res);
    if (!row) return;
    await query('DELETE FROM payout_notification_subscriptions WHERE id=$1::uuid AND address=$2', [row.id, row.address]);
    return res.json({ success: true, removed: 1 });
  }, { login: true }));

  router.post('/subscriptions/:id/test', guarded(async (req, res) => {
    const row = await ownedSubscription(req, res);
    if (!row) return;
    const at = now();
    const last = lastTest.get(row.id);
    if (last !== undefined && at - last < TEST_COOLDOWN_MS) {
      res.set('Retry-After', String(Math.ceil((TEST_COOLDOWN_MS - (at - last)) / 1000)));
      return fail(res, 429, 'TEST_COOLDOWN', 'One test per minute.');
    }
    if (lastTest.size > 10_000) lastTest.clear();
    lastTest.set(row.id, at);
    const siteUrl = process.env.PAYOUT_NOTIFY_SITE_URL?.trim() || 'https://wrfcoin.com';
    const delivered = await deliverAll(await getPool(), deliverer, [row], {
      title: 'WRFCoin test notification',
      body: `Notifications are on for ${row.address.slice(0, 6)}…${row.address.slice(-4)}. You will hear from us when it is paid.`,
      url: `${siteUrl.replace(/\/+$/, '')}/explore?address=${row.address}`,
      tag: 'test',
    });
    return res.json({ success: true, delivered: delivered === 1 });
  }, { login: true }));

  // Possession of the push endpoint (or the topic) is enough to stop notifications to it: the browser
  // that holds the endpoint or the person who chose the topic can always switch them off, signed in or not.
  router.post('/unsubscribe', guarded(async (req, res) => {
    const body = req.body ?? {};
    const address = typeof body.address === 'string' ? body.address.toLowerCase() : null;
    if (address !== null && !ADDRESS_RE.test(address)) return fail(res, 400, 'VALIDATION_ERROR', 'address must be a 0x chain address.');
    let channel: 'webpush' | 'ntfy';
    let target: string;
    if (body.channel === 'webpush' && isAllowedPushEndpoint(body.endpoint)) { channel = 'webpush'; target = body.endpoint; }
    else if (body.channel === 'ntfy' && typeof body.topic === 'string' && NTFY_TOPIC_RE.test(body.topic)) { channel = 'ntfy'; target = body.topic; }
    else return fail(res, 400, 'VALIDATION_ERROR', 'Give channel webpush with its endpoint, or channel ntfy with its topic.');
    const rows = await query(`DELETE FROM payout_notification_subscriptions WHERE channel=$1 AND target_hash=$2 AND ($3::text IS NULL OR address=$3)
      RETURNING id`, [channel, targetHash(target), address]);
    return res.json({ success: true, removed: rows.length });
  }));

  // ---- Passkey wallets (owner approval 2026-11-01) ----------------------------------------------------
  // No JWT: the request carries a WebAuthn assertion over a challenge that binds the domain tag, chain,
  // network, address, action, channel, target hash and a server nonce (passkey-proof.ts). The address must
  // be the one the asserted credential derives, exactly as core4 binds a passkey transfer's `from`.

  router.post('/passkey/challenge', guarded(async (req, res) => {
    const address = typeof req.body?.address === 'string' ? req.body.address.toLowerCase() : '';
    if (!ADDRESS_RE.test(address)) return fail(res, 400, 'VALIDATION_ERROR', 'address must be a 0x chain address.');
    const nonce = newNonce();
    const expiresAtSec = Math.floor(now() / 1000) + NONCE_TTL_SEC;
    if (!(await nonces.issue(address, nonce, expiresAtSec))) {
      res.set('Retry-After', String(NONCE_TTL_SEC));
      return fail(res, 429, 'TOO_MANY_CHALLENGES', 'Too many open challenges for this address. Try again in a few minutes.');
    }
    const { chainId, network } = passkeyNotifyChain();
    return res.status(201).json({
      success: true, domain: PASSKEY_NOTIFY_DOMAIN, chainId, network, address, nonce, expiresAt: expiresAtSec,
      actions: ['subscribe', 'unsubscribe'],
    });
  }));

  /**
   * true when the body's passkey proves `action` on (channel, hash) for `address`; otherwise answers and
   * returns false. The nonce is consumed only after the assertion verifies, so nobody can burn another
   * wallet's open challenge with a bad signature, and only one of two concurrent replays can consume it.
   */
  async function provePasskey(req: Request, res: Response, address: string, action: PasskeyNotifyAction, channel: string, hash: string): Promise<boolean> {
    const body = req.body ?? {};
    const auth = parsePasskeyAuth(body.passkey_auth);
    if (typeof auth === 'string') { fail(res, 400, 'VALIDATION_ERROR', auth); return false; }
    if (!isNonce(body.nonce)) { fail(res, 400, 'VALIDATION_ERROR', 'nonce must be the 64 hex characters from /passkey/challenge.'); return false; }
    if (passkeyAuthAddress(auth) !== address) {
      fail(res, 403, 'PASSKEY_ADDRESS_MISMATCH', 'This passkey does not control this address.');
      return false;
    }
    const expiresAtSec = await nonces.peek(address, body.nonce);
    if (expiresAtSec === null) {
      fail(res, 401, 'PASSKEY_CHALLENGE_EXPIRED', 'The challenge expired or was already used. Ask for a new one.');
      return false;
    }
    const { chainId, network } = passkeyNotifyChain();
    const challenge = passkeyNotifyChallenge({
      chainId, network, address, action, channel: channel as 'webpush' | 'ntfy', targetHash: hash, nonce: body.nonce, expiresAtSec,
    });
    if (verifyPasskeyAssertion(auth, challenge) !== null) {
      fail(res, 401, 'PASSKEY_ASSERTION_INVALID', 'The passkey signature does not match this request.');
      return false;
    }
    if (!(await nonces.consume(address, body.nonce))) {
      fail(res, 401, 'PASSKEY_CHALLENGE_EXPIRED', 'The challenge expired or was already used. Ask for a new one.');
      return false;
    }
    return true;
  }

  router.post('/passkey/subscriptions', guarded(async (req, res) => {
    const address = typeof req.body?.address === 'string' ? req.body.address.toLowerCase() : '';
    if (!ADDRESS_RE.test(address)) return fail(res, 400, 'VALIDATION_ERROR', 'address must be a 0x chain address.');
    return subscribe(res, address, req.body, (channel, hash) => provePasskey(req, res, address, 'subscribe', channel, hash));
  }));

  router.post('/passkey/unsubscribe', guarded(async (req, res) => {
    const body = req.body ?? {};
    const address = typeof body.address === 'string' ? body.address.toLowerCase() : '';
    if (!ADDRESS_RE.test(address)) return fail(res, 400, 'VALIDATION_ERROR', 'address must be a 0x chain address.');
    if (body.channel !== 'webpush' && body.channel !== 'ntfy') return fail(res, 400, 'VALIDATION_ERROR', 'channel must be webpush or ntfy.');
    if (typeof body.targetHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.targetHash)) return fail(res, 400, 'VALIDATION_ERROR', 'targetHash must be the subscription\'s 64 lowercase hex target hash.');
    if (!(await provePasskey(req, res, address, 'unsubscribe', body.channel, body.targetHash))) return undefined;
    const rows = await query('DELETE FROM payout_notification_subscriptions WHERE address=$1 AND channel=$2 AND target_hash=$3 RETURNING id',
      [address, body.channel, body.targetHash]);
    return res.json({ success: true, removed: rows.length });
  }));

  return router;
}

export default createPayoutNotificationRouter();
