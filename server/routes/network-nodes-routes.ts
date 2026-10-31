/**
 * Public "who produces blocks and who is bonded" read (owner demo queue 2026-11-01, item 3; replaces the
 * never-mounted 2025 server/routes/validators.js, whose Drizzle tables nothing fills; issues #210, #529).
 *
 *   GET /api/network/nodes
 *
 * Everything is read from the chain node with the backend's Reader credential; nothing comes from a
 * backend table. The ladder rungs (node -> bonded node -> attester -> producer) as the node exposes them:
 *
 *   producers  core4 has NO route that lists the producer set (it lives in consensus state only). The
 *              names, keys and payout addresses below are core4's own compiled testnet genesis roster,
 *              native-chain/src/bin/launch_api/genesis_producer_pins.rs TESTNET_GENESIS_PRODUCER_SET
 *              (core4 origin/main 8390566). Activity is proven from the chain, not from that file: the
 *              newest blocks are read one by one (/chain/block/<h>, producer_pubkey) and each key is
 *              counted. A key that signs blocks but is not in the roster is listed as an unnamed producer.
 *              Paid totals: /addresses/<payout> earned_balance_total.
 *   bonded     core4 has NO route that lists bonds. Deployment ids come from (a) the payout and
 *              provisional maps of the current and three previous node-settlement epochs
 *              (/node/settlement/<e>; the node prunes PAID epochs, so this finds recently paid or pending
 *              bonds only) and (b) NETWORK_NODES_BOND_IDS, an operator list of known deployment ids. Every
 *              id is then checked on chain (/node/bonds/<id>); only status REGISTERED is listed. Paid
 *              totals: earned_balance_total of the bond's payout account.
 *   attesters  /transactions/oracle/status: the seated oracle ids and the quorum.
 *   node       /network/info: chain identity and height (the node's own view).
 *
 * Honesty rules: a section whose reads fail is `{ status: "unavailable" }` with no rows; a value the node
 * did not give is null, never 0. Activity counts say how many blocks were scanned and how many could not
 * be read, so "0 of the last 64" is never confused with "unknown".
 *
 * Dormant unless NETWORK_NODES_READ_ENABLED=true (read per request; 404 otherwise).
 *
 * Load: one snapshot is built at most once per 60 s for every caller (single flight). A rebuild reads at
 * most: 1 network info + 16 new blocks (an initial fill reads up to 64, once) + 1 epoch probe + 4
 * settlement epochs + 24 bonds + (3 + 24) accounts + 1 oracle status, about 75 node reads a minute at
 * worst, under core4's 1000/min Reader budget. Per caller: 30 reads a minute per client address (shared
 * Redis limiter). The response is cacheable for 30 s.
 */
import express, { type Request, type RequestHandler, type Response } from 'express';

type Row = Record<string, any>;
type Core4Response = { ok: boolean; status: number; payload: any };
export type Core4Fetch = (path: string, options?: Record<string, unknown>) => Promise<Core4Response>;

export interface NetworkNodesDeps {
  fetchCore4Json?: Core4Fetch;
  readerToken?: () => string | undefined;
  now?: () => number;
  rateLimit?: RequestHandler;
  /** Defaults to core4's testnet genesis roster. */
  roster?: readonly ProducerPin[];
}

export type ProducerPin = { producerId: string; publicKey: string; payoutAddress: string };

/** core4 genesis_producer_pins.rs TESTNET_GENESIS_PRODUCER_SET (origin/main 8390566), copied verbatim. */
export const TESTNET_GENESIS_PRODUCER_ROSTER: readonly ProducerPin[] = Object.freeze([
  { producerId: 'n5-node-a', publicKey: '1e5180e7add06bbe07cf2698ec9d4882ae1cfb54b13de67bae92a4e625ceec1a', payoutAddress: '0x680d51f7543ca70029866956376306d47ce60ed0' },
  { producerId: 'producer-standby', publicKey: 'cd77a1f439ec6896727f585e81228795c8008c8f8db7763bb9c42afa8d119aaa', payoutAddress: '0x39ee2e595a55c71256282fe5c42a398594985b1a' },
  { producerId: 'mango-mini', publicKey: '1f7a4ec7699e361390cb89297a2b4441e676b17c95b122063eda25b1f64e0f1e', payoutAddress: '0xc536d2026661522cb8631b3c723d4af43784a990' },
]);

export const NETWORK_NODES_RATE_LIMIT = { windowMs: 60 * 1000, maxRequests: 30, keyPrefix: 'ratelimit:network-nodes' };
export const NETWORK_NODES_SNAPSHOT_TTL_MS = 60_000;
export const NETWORK_NODES_FAILURE_TTL_MS = 10_000;
/** Newest blocks whose producer is counted. */
export const PRODUCER_WINDOW_BLOCKS = 64;
/** New blocks read per rebuild once the window is filled. */
export const PRODUCER_NEW_BLOCKS_PER_REBUILD = 16;
export const SETTLEMENT_EPOCHS_SCANNED = 4;
export const MAX_BONDS = 24;
const CALL_TIMEOUT_MS = 4_000;
const BOND_ID_RE = /^[0-9a-f]{64}$/;
const BASE_UNITS_RE = /^(0|[1-9][0-9]{0,38})$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const ZERO_ID = '0'.repeat(64);

const enabled = () => process.env.NETWORK_NODES_READ_ENABLED === 'true';

/** NETWORK_NODES_BOND_IDS: comma/space separated 64-hex deployment ids; anything malformed is ignored. */
export function configuredBondIds(): string[] {
  const raw = process.env.NETWORK_NODES_BOND_IDS ?? '';
  return [...new Set(raw.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter((s) => BOND_ID_RE.test(s)))].slice(0, MAX_BONDS);
}

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });

async function defaultRateLimit(): Promise<RequestHandler> {
  const mod = await import('../../shared/middleware/rate-limit-redis.js');
  return mod.createRateLimitMiddleware({
    ...NETWORK_NODES_RATE_LIMIT,
    keyGenerator: mod.apiIpBudgetKey,
    message: 'Too many network node requests, please try again later.',
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

function units(value: unknown): string | null {
  return typeof value === 'string' && BASE_UNITS_RE.test(value) ? value : null;
}

/** A byte array (core4 serde of [u8; N]) or a hex string to lowercase hex; null otherwise or all zero. */
export function bytesHex(value: unknown, length: number): string | null {
  let hex: string | null = null;
  if (typeof value === 'string' && new RegExp(`^(0x)?[0-9a-fA-F]{${length * 2}}$`).test(value)) hex = value.toLowerCase().replace(/^0x/, '');
  else if (Array.isArray(value) && value.length === length && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    hex = value.map((b: number) => b.toString(16).padStart(2, '0')).join('');
  }
  return hex && /[^0]/.test(hex) ? hex : null;
}

function isoText(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export type BlockSeen = { height: number; producer: string | null; time: string | null };

export type NetworkNodesSnapshot = {
  chain: { networkId: string | null; chainId: string | null; height: number | null; status: 'ok' | 'unavailable' };
  producers: {
    status: 'ok' | 'unavailable';
    rosterSource: string;
    window: { fromHeight: number; toHeight: number; read: number; unreadable: number; unsigned: number } | null;
    members: Array<{
      producerId: string; publicKey: string; payoutAddress: string;
      blocksInWindow: number | null; lastBlock: { height: number; time: string | null } | null; earnedTotal: string | null;
    }>;
    unrostered: Array<{ publicKey: string; blocksInWindow: number; lastBlock: { height: number; time: string | null } }>;
  };
  bonded: {
    status: 'ok' | 'unavailable';
    epoch: number | null;
    discovery: { settlementEpochs: number[]; configured: number };
    nodes: Array<{
      deploymentId: string; alias: string | null; principal: string | null; escrowBalance: string | null; jailed: boolean | null;
      registeredEpoch: number | null; exitEffectiveHeight: number | null; payoutAddress: string | null; earnedTotal: string | null;
      lastPayout: { epoch: number; status: string; amount: string } | null;
    }>;
  };
  attesters: { status: 'ok' | 'unavailable'; quorum: number | null; ids: string[] };
  checkedAt: string;
};

export function createNetworkNodesRouter(deps: NetworkNodesDeps = {}): express.Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;
  const roster = deps.roster ?? TESTNET_GENESIS_PRODUCER_ROSTER;
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

  /** Producer of each block read so far, by height (kept to the window). */
  const blocks = new Map<number, BlockSeen | 'unreadable'>();
  let snapshot: { expiresAt: number; value: Promise<NetworkNodesSnapshot> } | null = null;

  async function build(token: string): Promise<NetworkNodesSnapshot> {
    const fetchCore4Json = await getFetch();
    const get = async (path: string): Promise<Row | null> => {
      try {
        const reply = await fetchCore4Json(path, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, timeoutMs: CALL_TIMEOUT_MS });
        return reply.ok ? body(reply.payload) : null;
      } catch {
        return null;
      }
    };

    // Node: chain identity and tip.
    const info = await get('/network/info');
    const tip = info ? safeInt(info.chain_height) : null;
    const chain: NetworkNodesSnapshot['chain'] = {
      networkId: typeof info?.network_id === 'string' ? info.network_id.slice(0, 64) : null,
      chainId: typeof info?.chain_id === 'string' || typeof info?.chain_id === 'number' ? String(info.chain_id).slice(0, 32) : null,
      height: tip,
      status: tip === null ? 'unavailable' : 'ok',
    };

    // Producers: newest blocks, read incrementally.
    let producers: NetworkNodesSnapshot['producers'] = {
      status: 'unavailable', rosterSource: 'core4 genesis_producer_pins.rs (testnet genesis roster)', window: null, members: [], unrostered: [],
    };
    if (tip !== null && tip >= 1) {
      const from = Math.max(1, tip - PRODUCER_WINDOW_BLOCKS + 1);
      for (const h of [...blocks.keys()]) if (h < from || h > tip) blocks.delete(h);
      const missing: number[] = [];
      for (let h = tip; h >= from; h -= 1) if (!blocks.has(h) || blocks.get(h) === 'unreadable') missing.push(h);
      const filled = blocks.size > 0;
      const toRead = missing.slice(0, filled ? PRODUCER_NEW_BLOCKS_PER_REBUILD : PRODUCER_WINDOW_BLOCKS);
      // At most 16 block reads in flight, so the one-off initial fill is not a 64-read burst.
      for (let i = 0; i < toRead.length; i += PRODUCER_NEW_BLOCKS_PER_REBUILD) {
        await Promise.all(toRead.slice(i, i + PRODUCER_NEW_BLOCKS_PER_REBUILD).map(async (h) => {
          const b = await get(`/chain/block/${h}`);
          if (b && safeInt(b.height) === h) {
            blocks.set(h, { height: h, producer: bytesHex(b.producer_pubkey, 32), time: isoText(b.timestamp) });
          } else blocks.set(h, 'unreadable');
        }));
      }
      const seen: BlockSeen[] = [];
      let unreadable = 0;
      for (let h = from; h <= tip; h += 1) {
        const b = blocks.get(h);
        if (b === undefined || b === 'unreadable') unreadable += 1;
        else seen.push(b);
      }
      const stats = new Map<string, { count: number; last: BlockSeen }>();
      let unsigned = 0;
      for (const b of seen) {
        if (!b.producer) { unsigned += 1; continue; }
        const s = stats.get(b.producer);
        if (!s) stats.set(b.producer, { count: 1, last: b });
        else { s.count += 1; if (b.height > s.last.height) s.last = b; }
      }
      const pinned = new Set(roster.map((m) => m.publicKey));
      producers = {
        status: seen.length > 0 ? 'ok' : 'unavailable',
        rosterSource: producers.rosterSource,
        window: { fromHeight: from, toHeight: tip, read: seen.length, unreadable, unsigned },
        members: roster.map((m) => {
          const s = stats.get(m.publicKey);
          return {
            ...m,
            blocksInWindow: seen.length > 0 ? (s?.count ?? 0) : null,
            lastBlock: s ? { height: s.last.height, time: s.last.time } : null,
            earnedTotal: null,
          };
        }),
        unrostered: [...stats.entries()].filter(([key]) => !pinned.has(key))
          .map(([publicKey, s]) => ({ publicKey, blocksInWindow: s.count, lastBlock: { height: s.last.height, time: s.last.time } })),
      };
    }

    // Bonded nodes.
    let bonded: NetworkNodesSnapshot['bonded'] = { status: 'unavailable', epoch: null, discovery: { settlementEpochs: [], configured: 0 }, nodes: [] };
    const probe = await get(`/node/bonds/${ZERO_ID}`);
    const epoch = probe ? safeInt(probe.epoch) : null;
    if (probe) {
      const ids = new Set<string>();
      const lastPayout = new Map<string, { epoch: number; status: string; amount: string }>();
      const epochs: number[] = [];
      if (epoch !== null) {
        for (let e = epoch; e >= 0 && epochs.length < SETTLEMENT_EPOCHS_SCANNED; e -= 1) epochs.push(e);
      }
      const settlements = await Promise.all(epochs.map((e) => get(`/node/settlement/${e}`)));
      settlements.forEach((s, i) => {
        if (!s || typeof s.status !== 'string' || s.status === 'UNKNOWN') return;
        for (const [field, label] of [['payouts_base_units', s.status], ['provisional_base_units', 'PROVISIONAL']] as const) {
          const map = s[field];
          if (!map || typeof map !== 'object') continue;
          for (const [id, amount] of Object.entries(map)) {
            const key = id.toLowerCase();
            const value = units(amount);
            if (!BOND_ID_RE.test(key) || value === null) continue;
            ids.add(key);
            if (!lastPayout.has(key)) lastPayout.set(key, { epoch: epochs[i], status: String(label).slice(0, 16), amount: value });
          }
        }
      });
      const configured = configuredBondIds();
      for (const id of configured) ids.add(id);
      const list = [...ids].slice(0, MAX_BONDS);
      const records = await Promise.all(list.map((id) => get(`/node/bonds/${id}`)));
      const nodes: NetworkNodesSnapshot['bonded']['nodes'] = [];
      records.forEach((r, i) => {
        if (!r || r.status !== 'REGISTERED' || r.deployment_id !== list[i]) return;
        const reg: Row = r.registration && typeof r.registration === 'object' ? r.registration : {};
        const binding: Row = reg.binding && typeof reg.binding === 'object' ? reg.binding : {};
        const payout = bytesHex(binding.payout_account, 20);
        nodes.push({
          deploymentId: list[i],
          alias: typeof binding.service_alias === 'string' && /^[\x20-\x7e]{1,64}$/.test(binding.service_alias) ? binding.service_alias : null,
          principal: units(r.principal_base_units),
          escrowBalance: units(r.escrow_balance_base_units),
          jailed: typeof r.jailed === 'boolean' ? r.jailed : null,
          registeredEpoch: safeInt(reg.registered_epoch),
          exitEffectiveHeight: safeInt(reg.exit_effective_height),
          payoutAddress: payout ? `0x${payout}` : null,
          earnedTotal: null,
          lastPayout: lastPayout.get(list[i]) ?? null,
        });
      });
      bonded = { status: 'ok', epoch, discovery: { settlementEpochs: epochs, configured: configured.length }, nodes };
    }

    // Paid totals, one account read per payout address.
    const addresses = new Set<string>();
    for (const m of producers.members) addresses.add(m.payoutAddress);
    for (const n of bonded.nodes) if (n.payoutAddress && ADDRESS_RE.test(n.payoutAddress)) addresses.add(n.payoutAddress);
    const earned = new Map<string, string | null>();
    await Promise.all([...addresses].map(async (a) => {
      const acct = await get(`/addresses/${a}`);
      earned.set(a, acct ? units(acct.earned_balance_total) : null);
    }));
    for (const m of producers.members) m.earnedTotal = earned.get(m.payoutAddress) ?? null;
    for (const n of bonded.nodes) n.earnedTotal = n.payoutAddress ? earned.get(n.payoutAddress) ?? null : null;

    // Attesters.
    const oracle = await get('/transactions/oracle/status');
    const ids = Array.isArray(oracle?.oracle_set)
      ? oracle!.oracle_set.filter((x: unknown) => typeof x === 'string' && /^[\x20-\x7e]{1,128}$/.test(x)).slice(0, 64)
      : null;
    const attesters: NetworkNodesSnapshot['attesters'] = ids
      ? { status: 'ok', quorum: safeInt(oracle!.oracle_quorum), ids }
      : { status: 'unavailable', quorum: null, ids: [] };

    return { chain, producers, bonded, attesters, checkedAt: new Date(now()).toISOString() };
  }

  function read(token: string): Promise<NetworkNodesSnapshot> {
    const at = now();
    if (snapshot && snapshot.expiresAt > at) return snapshot.value;
    const entry = { expiresAt: at + NETWORK_NODES_SNAPSHOT_TTL_MS, value: Promise.resolve(null as unknown as NetworkNodesSnapshot) };
    entry.value = build(token).then((value) => {
      const failed = value.chain.status !== 'ok' && value.producers.status !== 'ok';
      entry.expiresAt = now() + (failed ? NETWORK_NODES_FAILURE_TTL_MS : NETWORK_NODES_SNAPSHOT_TTL_MS);
      return value;
    }, (error) => { entry.expiresAt = 0; throw error; });
    snapshot = entry;
    return entry.value;
  }

  router.get('/nodes', (req, res, next) => {
    if (!enabled()) return res.status(404).json({ error: 'Not found' });
    getRateLimit().then(
      (limit) => limit(req, res, (err?: unknown) => (err ? next(err) : void handle(req, res))),
      () => fail(res, 503, 'RATE_LIMIT_UNAVAILABLE', 'Network node reads are unavailable, please try again later.'),
    );
  });

  async function handle(req: Request, res: Response) {
    if (Object.keys(req.query).length > 0) return fail(res, 400, 'VALIDATION_ERROR', 'This read takes no query parameters.');
    const token = readerToken();
    if (!token) return fail(res, 503, 'CORE4_READER_CREDENTIAL_UNCONFIGURED', 'Chain reads are unavailable on this server.');
    try {
      const value = await read(token);
      if (value.chain.status !== 'ok' && value.producers.status !== 'ok' && value.bonded.status !== 'ok' && value.attesters.status !== 'ok') {
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

export default createNetworkNodesRouter();
