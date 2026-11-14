/**
 * Public network status read (owner decision 2026-11-01: Grafana/Prometheus stay a private operator
 * cockpit; the public gets a status page in the site's own style serving a few safe numbers).
 *
 *   GET /api/public/network-status
 *
 * Only aggregate numbers, all read from the chain node with the backend's Reader credential:
 *
 *   blocks     tip height, when the tip was made and how long ago, blocks made in the last hour and the
 *              last day against the ~77 s cadence (NETWORK_STATUS_TARGET_BLOCK_SECONDS), and the longest
 *              gap between the newest 100 blocks. /network/info, /chain/blocks?limit=100 and, for the day
 *              count, a binary search of /chain/block/<h> timestamps (heights are immutable, so each one
 *              is read once and remembered).
 *   network    chain id, sync status and the node's peer count (/network/info). Never the peer id, the
 *              genesis hash or any address.
 *   producers  how many producers of the set in force signed a block in the newest 64 blocks
 *              (/network/producers?window=64), by their public producer label (the same labels /nodes
 *              already shows). No keys, payout addresses, hosts or IPs.
 *   nodePay    the current node-pay epoch and the newest PAID epoch among the last 8
 *              (/node/bonds/<zero> for the epoch, /node/settlement/<e>). The node prunes old paid epochs,
 *              so "none in the last 8" is said as such, never as "never paid".
 *   upgrades   features scheduled but not yet active, with their activation heights (/network/upgrade),
 *              and a governance-signed upgrade notice when one is installed.
 *
 * Honesty rules: a section whose reads fail is `{ status: "unavailable" }`; a value the node did not give
 * is null, never 0.
 *
 * Dormant unless NETWORK_STATUS_READ_ENABLED=true (read per request; 404 otherwise).
 *
 * Load: one snapshot per 60 s for every caller (single flight). A rebuild reads 1 network info +
 * 1 block list + up to 13 block headers (usually 1-2 once warm) + 1 producers + 1 epoch probe +
 * 8 settlements + 1 upgrade, under 30 node reads a minute. Per caller: 30 reads a minute per client
 * address (shared Redis limiter). The response is cacheable for 30 s.
 */
import express, { type Request, type RequestHandler, type Response } from 'express';

type Row = Record<string, any>;
type Core4Response = { ok: boolean; status: number; payload: any };
export type Core4Fetch = (path: string, options?: Record<string, unknown>) => Promise<Core4Response>;

export interface NetworkStatusDeps {
  fetchCore4Json?: Core4Fetch;
  readerToken?: () => string | undefined;
  now?: () => number;
  rateLimit?: RequestHandler;
}

export const NETWORK_STATUS_RATE_LIMIT = { windowMs: 60 * 1000, maxRequests: 30, keyPrefix: 'ratelimit:network-status' };
export const NETWORK_STATUS_SNAPSHOT_TTL_MS = 60_000;
export const NETWORK_STATUS_FAILURE_TTL_MS = 10_000;
export const DEFAULT_TARGET_BLOCK_SECONDS = 77;
export const RECENT_BLOCKS = 100;
export const PRODUCER_WINDOW_BLOCKS = 64;
export const SETTLEMENT_EPOCHS_SCANNED = 8;
export const MAX_PENDING_FEATURES = 24;
/** The day search looks back at most this many blocks (~3.5 days at 77 s). */
export const DAY_SEARCH_SPAN = 4_000;
const HOUR_S = 3_600;
const DAY_S = 86_400;
const CALL_TIMEOUT_MS = 4_000;
const MAX_REMEMBERED_TIMES = 512;
const ZERO_ID = '0'.repeat(64);
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const FEATURE_RE = /^[a-z0-9_]{1,64}$/;

const enabled = () => process.env.NETWORK_STATUS_READ_ENABLED === 'true';

export function targetBlockSeconds(): number {
  const raw = Number.parseInt(process.env.NETWORK_STATUS_TARGET_BLOCK_SECONDS ?? '', 10);
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= 3_600 ? raw : DEFAULT_TARGET_BLOCK_SECONDS;
}

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });

async function defaultRateLimit(): Promise<RequestHandler> {
  const mod = await import('../../shared/middleware/rate-limit-redis.js');
  return mod.createRateLimitMiddleware({
    ...NETWORK_STATUS_RATE_LIMIT,
    keyGenerator: mod.apiIpBudgetKey,
    message: 'Too many network status requests, please try again later.',
  });
}

async function defaultFetch(): Promise<Core4Fetch> {
  const { fetchCore4Json } = await import('../../shared/core4-route-client.js');
  return fetchCore4Json as unknown as Core4Fetch;
}

function body(payload: any): Row | null {
  const data = payload && typeof payload === 'object' && payload.ok === true && 'data' in payload ? payload.data : payload;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

function safeInt(value: unknown): number | null {
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timeMs(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

const unavailable = { status: 'unavailable' as const };

export type NetworkStatusSnapshot = {
  network: { status: 'ok'; chainId: string | null; networkId: string | null; syncStatus: string | null; peerCount: number | null } | typeof unavailable;
  blocks:
    | {
        status: 'ok';
        targetBlockSeconds: number;
        tipHeight: number;
        lastBlockAt: string | null;
        lastBlockAgeSeconds: number | null;
        lastHour: { produced: number | null; expected: number };
        lastDay: { produced: number | null; expected: number; atLeast: boolean };
        longestGapSeconds: { value: number | null; overBlocks: number };
      }
    | typeof unavailable;
  producers:
    | { status: 'ok'; windowBlocks: number; total: number; online: number; members: Array<{ label: string; online: boolean; blocksInWindow: number; lastHeight: number | null }> }
    | typeof unavailable;
  nodePay: { status: 'ok'; currentEpoch: number | null; lastPaidEpoch: number | null; epochsScanned: number[] } | typeof unavailable;
  upgrades:
    | {
        status: 'ok';
        activeFeatures: number;
        pending: Array<{ feature: string; activationHeight: number; blocksRemaining: number | null }>;
        signedNotice: { activationHeight: number; blocksRemaining: number | null } | null;
      }
    | typeof unavailable;
  checkedAt: string;
};

export function createNetworkStatusRouter(deps: NetworkStatusDeps = {}): express.Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;
  const readerToken = deps.readerToken ?? (() => process.env.WRFCOIN_READER_TOKEN?.trim() || undefined);
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

  /** Block time by height (immutable once made), kept small. */
  const times = new Map<number, number>();
  /** Newest height found to be older than a day on the last build: the next search starts there. */
  let dayFloor: number | null = null;
  let snapshot: { expiresAt: number; value: Promise<NetworkStatusSnapshot> } | null = null;

  async function build(token: string): Promise<NetworkStatusSnapshot> {
    const fetchCore4Json = await getFetch();
    const get = async (path: string, query?: Record<string, unknown>): Promise<Row | null> => {
      try {
        const reply = await fetchCore4Json(path, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, timeoutMs: CALL_TIMEOUT_MS, ...(query ? { query } : {}),
        });
        return reply.ok ? body(reply.payload) : null;
      } catch {
        return null;
      }
    };
    const at = now();
    const target = targetBlockSeconds();

    const [info, recent, producersView, probe, upgrade] = await Promise.all([
      get('/network/info'),
      get('/chain/blocks', { limit: RECENT_BLOCKS }),
      get('/network/producers', { window: PRODUCER_WINDOW_BLOCKS }),
      get(`/node/bonds/${ZERO_ID}`),
      get('/network/upgrade'),
    ]);

    // Network.
    const network: NetworkStatusSnapshot['network'] = info
      ? {
          status: 'ok',
          chainId: typeof info.chain_id === 'string' || typeof info.chain_id === 'number' ? String(info.chain_id).slice(0, 32) : null,
          networkId: typeof info.network_id === 'string' ? info.network_id.slice(0, 32) : null,
          syncStatus: typeof info.sync_status === 'string' && /^[a-z_]{1,32}$/.test(info.sync_status) ? info.sync_status : null,
          peerCount: safeInt(info.peer_count),
        }
      : unavailable;

    // Blocks.
    let blocks: NetworkStatusSnapshot['blocks'] = unavailable;
    const list: Array<{ height: number; t: number }> = [];
    if (recent && Array.isArray(recent.blocks)) {
      for (const b of recent.blocks) {
        const h = safeInt(b?.height);
        const t = timeMs(b?.timestamp);
        if (h !== null && t !== null) { list.push({ height: h, t }); times.set(h, t); }
      }
      list.sort((a, b) => a.height - b.height);
    }
    const tip = safeInt(recent?.chain_height) ?? (list.length ? list[list.length - 1].height : null) ?? safeInt(info?.chain_height);
    if (tip !== null && list.length > 0) {
      const newest = list[list.length - 1];
      const tipTime = newest.height === tip ? newest.t : null;
      let longest: number | null = null;
      for (let i = 1; i < list.length; i += 1) {
        if (list[i].height !== list[i - 1].height + 1) continue;
        const gap = Math.max(0, Math.round((list[i].t - list[i - 1].t) / 1000));
        if (longest === null || gap > longest) longest = gap;
      }
      const hourCut = at - HOUR_S * 1000;
      // The list holds the newest 100 blocks (~2 h at the target pace); if its oldest block is still
      // inside the hour the count is not complete, so it is unknown.
      const hourProduced = list[0].t <= hourCut || list[0].height <= 1 ? list.filter((b) => b.t > hourCut).length : null;
      const day = await countSince(get, tip, at - DAY_S * 1000);
      blocks = {
        status: 'ok',
        targetBlockSeconds: target,
        tipHeight: tip,
        lastBlockAt: tipTime === null ? null : new Date(tipTime).toISOString(),
        lastBlockAgeSeconds: tipTime === null ? null : Math.max(0, Math.round((at - tipTime) / 1000)),
        lastHour: { produced: hourProduced, expected: Math.floor(HOUR_S / target) },
        lastDay: { produced: day ? day.count : null, expected: Math.floor(DAY_S / target), atLeast: day ? day.atLeast : false },
        longestGapSeconds: { value: longest, overBlocks: list.length },
      };
    }
    while (times.size > MAX_REMEMBERED_TIMES) times.delete(times.keys().next().value as number);

    // Producers (labels only).
    let producers: NetworkStatusSnapshot['producers'] = unavailable;
    if (producersView && Array.isArray(producersView.producers)) {
      const windowTo = safeInt(producersView.activity_window?.to_height);
      const windowFrom = safeInt(producersView.activity_window?.from_height);
      const members = producersView.producers
        .filter((p: Row) => p && typeof p.producer_id === 'string' && LABEL_RE.test(p.producer_id))
        .slice(0, 32)
        .map((p: Row) => {
          const last = safeInt(p.last_produced_height);
          const count = safeInt(p.blocks_in_window) ?? 0;
          const inWindow = last !== null && windowFrom !== null && windowTo !== null && last >= windowFrom && last <= windowTo;
          return { label: p.producer_id as string, online: count > 0 && inWindow, blocksInWindow: count, lastHeight: last };
        });
      producers = {
        status: 'ok',
        windowBlocks: safeInt(producersView.activity_window?.blocks_scanned) ?? PRODUCER_WINDOW_BLOCKS,
        total: members.length,
        online: members.filter((m: { online: boolean }) => m.online).length,
        members,
      };
    }

    // Node pay.
    let nodePay: NetworkStatusSnapshot['nodePay'] = unavailable;
    const epoch = probe ? safeInt(probe.epoch) : null;
    if (epoch !== null) {
      const epochs: number[] = [];
      for (let e = epoch; e >= 0 && epochs.length < SETTLEMENT_EPOCHS_SCANNED; e -= 1) epochs.push(e);
      const records = await Promise.all(epochs.map((e) => get(`/node/settlement/${e}`)));
      if (records.some((r) => r !== null)) {
        const paid = epochs.find((e, i) => records[i]?.status === 'PAID');
        nodePay = { status: 'ok', currentEpoch: epoch, lastPaidEpoch: paid ?? null, epochsScanned: epochs };
      }
    }

    // Upgrades.
    let upgrades: NetworkStatusSnapshot['upgrades'] = unavailable;
    if (upgrade && upgrade.scheduled && Array.isArray(upgrade.scheduled.entries)) {
      const entries: Row[] = upgrade.scheduled.entries.filter((e: Row) => e && typeof e.feature === 'string' && FEATURE_RE.test(e.feature));
      const pending = entries
        .filter((e) => e.active_at_next === false && safeInt(e.activation_height) !== null)
        .map((e) => ({ feature: e.feature as string, activationHeight: safeInt(e.activation_height) as number, blocksRemaining: safeInt(e.blocks_remaining) }))
        .sort((a, b) => a.activationHeight - b.activationHeight || a.feature.localeCompare(b.feature))
        .slice(0, MAX_PENDING_FEATURES);
      const noticeHeight = safeInt(upgrade.activation_height);
      upgrades = {
        status: 'ok',
        activeFeatures: entries.filter((e) => e.active_at_next === true).length,
        pending,
        signedNotice: noticeHeight === null ? null : { activationHeight: noticeHeight, blocksRemaining: safeInt(upgrade.blocks_remaining) },
      };
    }

    return { network, blocks, producers, nodePay, upgrades, checkedAt: new Date(at).toISOString() };
  }

  /**
   * Blocks made after `cutoff`: the lowest height newer than the cutoff, found by binary search over block
   * timestamps between the remembered floor (or tip - DAY_SEARCH_SPAN) and the tip. `atLeast` when even
   * the search's lowest height is newer (the day holds more than the span). Null when a read fails.
   */
  async function countSince(get: (path: string) => Promise<Row | null>, tip: number, cutoff: number): Promise<{ count: number; atLeast: boolean } | null> {
    const timeAt = async (h: number): Promise<number | null> => {
      const known = times.get(h);
      if (known !== undefined) return known;
      const b = await get(`/chain/block/${h}`);
      const t = b && safeInt(b.height) === h ? timeMs(b.timestamp) : null;
      if (t !== null) times.set(h, t);
      return t;
    };
    let lo = Math.max(1, tip - DAY_SEARCH_SPAN);
    if (dayFloor !== null && dayFloor >= lo && dayFloor <= tip) lo = dayFloor;
    const loTime = await timeAt(lo);
    if (loTime === null) return null;
    if (loTime > cutoff) {
      if (lo === dayFloor) { dayFloor = null; return countSince(get, tip, cutoff); }
      return { count: tip - lo + 1, atLeast: lo > 1 };
    }
    // Invariant: time(lo) <= cutoff; find the highest such height.
    const tipTime = await timeAt(tip);
    if (tipTime === null) return null;
    if (tipTime <= cutoff) { dayFloor = tip; return { count: 0, atLeast: false }; }
    // Gallop up from lo (the floor moves about one block per rebuild, so this is 1-2 reads once warm),
    // then bisect the bracket.
    let hi = tip;
    for (let step = 1; lo + step < tip; step *= 2) {
      const t = await timeAt(lo + step);
      if (t === null) return null;
      if (t > cutoff) { hi = lo + step; break; }
      lo += step;
    }
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const t = await timeAt(mid);
      if (t === null) return null;
      if (t <= cutoff) lo = mid;
      else hi = mid;
    }
    dayFloor = lo;
    return { count: tip - lo, atLeast: false };
  }

  function read(token: string): Promise<NetworkStatusSnapshot> {
    const at = now();
    if (snapshot && snapshot.expiresAt > at) return snapshot.value;
    const entry = { expiresAt: at + NETWORK_STATUS_SNAPSHOT_TTL_MS, value: Promise.resolve(null as unknown as NetworkStatusSnapshot) };
    entry.value = build(token).then((value) => {
      entry.expiresAt = now() + (value.blocks.status !== 'ok' ? NETWORK_STATUS_FAILURE_TTL_MS : NETWORK_STATUS_SNAPSHOT_TTL_MS);
      return value;
    }, (error) => { entry.expiresAt = 0; throw error; });
    snapshot = entry;
    return entry.value;
  }

  router.get('/', (req, res, next) => {
    if (!enabled()) return res.status(404).json({ error: 'Not found' });
    getRateLimit().then(
      (limit) => limit(req, res, (err?: unknown) => (err ? next(err) : void handle(req, res))),
      () => fail(res, 503, 'RATE_LIMIT_UNAVAILABLE', 'Network status is unavailable, please try again later.'),
    );
  });

  async function handle(req: Request, res: Response) {
    if (Object.keys(req.query).length > 0) return fail(res, 400, 'VALIDATION_ERROR', 'This read takes no query parameters.');
    const token = readerToken();
    if (!token) return fail(res, 503, 'CORE4_READER_CREDENTIAL_UNCONFIGURED', 'Chain reads are unavailable on this server.');
    try {
      const value = await read(token);
      const sections = [value.network, value.blocks, value.producers, value.nodePay, value.upgrades];
      if (sections.every((s) => s.status !== 'ok')) {
        res.set('Cache-Control', 'no-store');
        return fail(res, 502, 'UPSTREAM_ERROR', 'The chain node could not answer.');
      }
      res.set('Cache-Control', 'public, max-age=30');
      return res.json(value);
    } catch {
      res.set('Cache-Control', 'no-store');
      return fail(res, 502, 'UPSTREAM_ERROR', 'The chain node could not answer.');
    }
  }

  return router;
}

export default createNetworkStatusRouter();
