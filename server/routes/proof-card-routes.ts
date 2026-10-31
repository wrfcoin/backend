/**
 * Public proof card for one station reading (backend#229; owner demo queue 2026-11-01, item 2).
 *
 *   GET /api/proofs/:commitId[?h=<height>]
 *
 * "A person shares a station reading and the link opens a public card that shows the block it
 * landed in." Every field comes from the chain node, never from a backend table:
 *
 *   1. core4 GET /transactions/contributions/{commit_id}/reward-evidence (Reader) gives the
 *      contribution status (station, type, reveal height while the reveal record is still held),
 *      the reward record and the block that applied it, and the chain identity / finalized height.
 *   2. core4 GET /transactions/contributions/{station_id}/observations (Reader) is scanned for the
 *      ContributionReveal transaction carrying this commit id. That gives the block height the
 *      reading landed in and the reading itself (core4's own numeric allowlist).
 *      Where to look: the `h` hint from the share link, else the reveal height core4 still holds,
 *      else up to three 64-block windows back from the reward block (the reveal precedes it).
 *   3. core4 GET /chain/block/{height} gives that block's hash, time and producer key.
 *
 * The 2026-04 version read the legacy `weather_data` table, which nothing on testnet writes, and
 * called any row with a tx_hash "verified on chain". It is replaced, not patched.
 *
 * Honesty rules:
 *   - A reveal that cannot be located inside the bounded scan is `inclusion.status: "not_located"`,
 *     never a guessed height; a commit with no reveal yet is `"not_revealed"`.
 *   - A block read that fails leaves `hash`/`timestamp`/`producerPubkey` null; the height still
 *     comes from the chain scan.
 *   - `reward.rewarded` is core4's own fail-closed verdict, passed through, never inferred here.
 *   - The raw station id never leaves this process (owner ruling 2026-09-27, Q5): the card names
 *     the station by its public alias and the body goes through scrubRawId as a last line.
 *   - The payout address is not on the card: a reading card is about the reading.
 *
 * Dormant unless PROOF_CARDS_ENABLED=true (read per request; 404 otherwise).
 *
 * Load on the node is bounded for the whole process (same discipline as public-balance-routes):
 *   - card loads (cache misses) are capped at PROOF_CARDS_UPSTREAM_MAX_PER_MIN (default 30, at most
 *     120) per fixed minute; one load is at most 6 node reads (1 evidence + 4 observation pages +
 *     1 block), so the route costs the node at most 180 reads per minute at the default and 720
 *     at the ceiling, under core4's 1000/min Reader budget; past the cap the answer is 503 with
 *     Retry-After and the node is not asked;
 *   - per caller: 30 reads per minute per client address (shared Redis limiter, Retry-After on 429);
 *   - per card: single-flight cache, 5 minutes once the reading is in a finalized block and its
 *     reward decision is final, 15 s while anything can still change, 5 s for a failure.
 */
import express, { type Request, type RequestHandler, type Response } from 'express';
import { stationAlias, scrubRawId as scrubRawIdImpl } from '../utils/station-alias.js';

const scrubRawId = scrubRawIdImpl as <T>(value: T, rawId: string) => T;

type Row = Record<string, any>;
type Core4Response = { ok: boolean; status: number; payload: any };
export type Core4Fetch = (path: string, options?: Record<string, unknown>) => Promise<Core4Response>;

export interface ProofCardDeps {
  fetchCore4Json?: Core4Fetch;
  readerToken?: () => string | undefined;
  now?: () => number;
  /** `undefined` resolves the shared Redis limiter lazily. A missing limiter fails closed. */
  rateLimit?: RequestHandler;
}

export const PROOF_CARD_RATE_LIMIT = { windowMs: 60 * 1000, maxRequests: 30, keyPrefix: 'ratelimit:proof-card' };
export const PROOF_CARD_UPSTREAM_WINDOW_MS = 60_000;
export const PROOF_CARD_SETTLED_TTL_MS = 300_000;
export const PROOF_CARD_OPEN_TTL_MS = 15_000;
export const PROOF_CARD_FAILURE_TTL_MS = 5_000;
/** core4 get_station_observations stops after 64 heights per call. */
export const PROOF_SCAN_WINDOW_HEIGHTS = 64;
/** Windows walked back from the reward block when no reveal height is known. */
export const PROOF_SCAN_REWARD_WINDOWS = 3;
/** Observation pages one card load may read. */
export const PROOF_SCAN_MAX_CALLS = 4;
const DEFAULT_UPSTREAM_MAX_PER_MIN = 30;
const MAX_UPSTREAM_MAX_PER_MIN = 120;
const MAX_CACHED_CARDS = 2_048;
const CALL_TIMEOUT_MS = 4_000;

const COMMIT_ID_RE = /^[0-9a-f]{64}$/;
const HINT_RE = /^[1-9][0-9]{0,11}$/;
const BLOCK_HASH_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const BASE_UNITS_RE = /^(0|[1-9][0-9]{0,38})$/;
const SHORT_TOKEN_RE = /^[a-z_]{1,64}$/;
const IDENT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PROVENANCE = new Set(['real', 'synthetic', 'unclassified']);
const REWARD_STATUSES = new Set(['not_evaluated', 'pending_quorum', 'excluded_non_real', 'finalized_zero', 'paid']);
const CONTRIBUTION_STATUSES = new Set([
  'revealed_attested',
  'revealed_pending_attestation',
  'committed_pending_reveal',
  'attested_without_pending_records',
  'reward_finalized',
  'reward_pending_quorum',
]);

export type ProofCard = {
  commitId: string;
  stationAlias: string | null;
  status: string | null;
  reading: {
    observedAt: string | null;
    temperatureC: number | null;
    humidityPct: number | null;
    pressureHpa: number | null;
    windSpeedMs: number | null;
    precipitationMm: number | null;
    dewpointC: number | null;
    provenanceClass: string | null;
  } | null;
  inclusion: {
    status: 'included' | 'not_revealed' | 'not_located';
    block: {
      height: number;
      hash: string | null;
      timestamp: string | null;
      producerPubkey: string | null;
      finalized: boolean | null;
    } | null;
  };
  attestation: { approvals: number; hasQuorum: boolean; quorum: number | null } | null;
  reward: {
    status: string | null;
    amountBaseUnits: string | null;
    finalized: boolean;
    rewarded: boolean;
    blocker: string | null;
    block: { height: number; hash: string | null; finalized: boolean } | null;
  };
  chain: {
    networkId: string | null;
    chainId: string | null;
    genesisHash: string | null;
    height: number | null;
    finalizedHeight: number | null;
  };
};

type LoadResult =
  | { kind: 'ok'; card: ProofCard; settled: boolean }
  | { kind: 'not_found' }
  | { kind: 'upstream_error' }
  | { kind: 'upstream_timeout' }
  | { kind: 'budget_exhausted'; retryAfterSeconds: number };

const enabled = () => process.env.PROOF_CARDS_ENABLED === 'true';

/** Process-wide card loads per minute: a positive integer up to 120, else the default 30. */
export function proofCardUpstreamMaxPerMinute(): number {
  const raw = process.env.PROOF_CARDS_UPSTREAM_MAX_PER_MIN?.trim() ?? '';
  const value = /^[1-9][0-9]{0,5}$/.test(raw) ? Number(raw) : DEFAULT_UPSTREAM_MAX_PER_MIN;
  return Math.min(value, MAX_UPSTREAM_MAX_PER_MIN);
}

const notFound = (res: Response) => res.status(404).json({ error: 'Not found' });
const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });

async function defaultRateLimit(): Promise<RequestHandler> {
  const mod = await import('../../shared/middleware/rate-limit-redis.js');
  return mod.createRateLimitMiddleware({
    ...PROOF_CARD_RATE_LIMIT,
    keyGenerator: mod.apiIpBudgetKey,
    message: 'Too many proof card requests, please try again later.',
  });
}

async function defaultFetch(): Promise<Core4Fetch> {
  const { fetchCore4Json } = await import('../../shared/core4-route-client.js');
  return fetchCore4Json as unknown as Core4Fetch;
}

const isTimeout = (error: unknown) => {
  const e = error as { name?: string; code?: string } | null;
  return e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.code === 'ETIMEDOUT';
};

class Upstream extends Error {
  constructor(readonly timeout: boolean) { super('upstream'); }
}

function safeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function enumOrNull(value: unknown, allowed: Set<string>): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function isoFromSeconds(value: unknown): string | null {
  const n = finiteOrNull(value);
  if (n === null || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isoFromText(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function hashOrNull(value: unknown): string | null {
  return typeof value === 'string' && BLOCK_HASH_RE.test(value) ? value.toLowerCase().replace(/^0x/, '') : null;
}

/**
 * core4 serializes Block.producer_pubkey ([u8; 32]) as a JSON array of integers. All zeros means
 * an unsigned block, which has no producer to name. A hex string is accepted too.
 */
export function producerPubkeyHex(value: unknown): string | null {
  if (typeof value === 'string') return /^(0x)?[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase().replace(/^0x/, '') : null;
  if (!Array.isArray(value) || value.length !== 32) return null;
  if (!value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return null;
  if (value.every((b) => b === 0)) return null;
  return value.map((b: number) => b.toString(16).padStart(2, '0')).join('');
}

/** core4 envelope_success is {ok, data}; reward-evidence answers its struct bare. */
function body(payload: any): Row | null {
  const data = payload && typeof payload === 'object' && payload.ok === true && 'data' in payload ? payload.data : payload;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

export function createProofCardRouter(deps: ProofCardDeps = {}): express.Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;
  const readerToken = deps.readerToken ?? (() => process.env.WRFCOIN_READER_TOKEN?.trim() || undefined);
  const cache = new Map<string, { expiresAt: number; value: Promise<LoadResult> }>();
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

  function takeBudget(at: number): { ok: true } | { ok: false; retryAfterSeconds: number } {
    if (at - budget.windowStart >= PROOF_CARD_UPSTREAM_WINDOW_MS) { budget.windowStart = at; budget.used = 0; }
    if (budget.used >= proofCardUpstreamMaxPerMinute()) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((budget.windowStart + PROOF_CARD_UPSTREAM_WINDOW_MS - at) / 1000)) };
    }
    budget.used += 1;
    return { ok: true };
  }

  async function load(commitId: string, hint: number | null, token: string): Promise<LoadResult> {
    try {
      const fetchCore4Json = await getFetch();
      // Only the server credential: no caller header reaches a read whose result is cached and shared.
      const get = async (path: string, query?: Record<string, unknown>): Promise<Core4Response> => {
        try {
          return await fetchCore4Json(path, {
            headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
            timeoutMs: CALL_TIMEOUT_MS,
            ...(query ? { query } : {}),
          });
        } catch (error) {
          throw new Upstream(isTimeout(error));
        }
      };

      // 1. The node's own evidence for this commit.
      const evidenceReply = await get(`/transactions/contributions/${commitId}/reward-evidence`);
      if (evidenceReply.status === 404 && evidenceReply.payload?.error?.code === 'NOT_FOUND') return { kind: 'not_found' };
      if (!evidenceReply.ok) return { kind: 'upstream_error' };
      const evidence = body(evidenceReply.payload);
      if (!evidence || typeof evidence.rewarded !== 'boolean' || evidence.commit_id !== commitId) return { kind: 'upstream_error' };
      const contribution: Row = evidence.contribution && typeof evidence.contribution === 'object' ? evidence.contribution : {};
      const chain: Row = evidence.chain && typeof evidence.chain === 'object' ? evidence.chain : {};
      const stationId = typeof contribution.station_id === 'string' && contribution.station_id.length > 0 ? contribution.station_id : null;
      // A card is for a station reading; a forecast has no reading to show.
      if (typeof contribution.contribution_type === 'string' && contribution.contribution_type !== 'contribution') {
        return { kind: 'not_found' };
      }
      const status = enumOrNull(contribution.status, CONTRIBUTION_STATUSES);
      const finalizedHeight = safeInt(chain.finalized_height);
      const rewardRow: Row | null = evidence.reward && typeof evidence.reward === 'object' ? evidence.reward : null;
      const rewardBlockRow: Row | null = evidence.block && typeof evidence.block === 'object' ? evidence.block : null;
      const rewardBlockHeight = rewardBlockRow ? safeInt(rewardBlockRow.height) : null;

      // 2. Find the reveal transaction on chain.
      let found: Row | null = null;
      let calls = 0;
      const scan = async (after: number, upTo: number): Promise<void> => {
        let cursorAfter = after;
        let cursorOffset = 0;
        while (!found && calls < PROOF_SCAN_MAX_CALLS && cursorAfter < upTo) {
          calls += 1;
          const reply = await get(`/transactions/contributions/${encodeURIComponent(stationId as string)}/observations`, {
            after: cursorAfter, offset: cursorOffset, limit: 100,
          });
          if (!reply.ok) throw new Upstream(false);
          const data = body(reply.payload);
          if (!data || !Array.isArray(data.items)) throw new Upstream(false);
          for (const item of data.items as Row[]) {
            const h = safeInt(item?.height);
            if (item?.commit_id === commitId && h !== null && h > after) { found = item; return; }
          }
          const nextAfter = safeInt(data.next_after);
          const nextOffset = safeInt(data.next_offset);
          // A cursor that does not advance would repeat the same page.
          if (nextAfter === null || nextOffset === null || nextAfter < cursorAfter
            || (nextAfter === cursorAfter && nextOffset <= cursorOffset)) return;
          if (data.has_more === false) return;
          cursorAfter = nextAfter;
          cursorOffset = nextOffset;
        }
      };

      const revealedAt = safeInt(contribution.revealed_at);
      const notRevealed = status === 'committed_pending_reveal';
      if (stationId && !notRevealed) {
        const tried = new Set<number>();
        for (const start of [hint, revealedAt]) {
          if (found || start === null || start < 1 || tried.has(start)) continue;
          tried.add(start);
          await scan(start - 1, start);
        }
        if (!found && rewardBlockHeight !== null) {
          for (let w = 0; w < PROOF_SCAN_REWARD_WINDOWS && !found && calls < PROOF_SCAN_MAX_CALLS; w += 1) {
            const upTo = rewardBlockHeight - w * PROOF_SCAN_WINDOW_HEIGHTS;
            if (upTo < 1) break;
            await scan(Math.max(0, upTo - PROOF_SCAN_WINDOW_HEIGHTS), upTo);
          }
        }
      }

      // 3. The block it landed in.
      let inclusion: ProofCard['inclusion'] = { status: notRevealed ? 'not_revealed' : 'not_located', block: null };
      let reading: ProofCard['reading'] = null;
      let attestation: ProofCard['attestation'] = null;
      const hit = found as Row | null;
      if (hit) {
        const height = safeInt(hit.height) as number;
        let hash: string | null = null;
        let timestamp: string | null = null;
        let producerPubkey: string | null = null;
        try {
          const blockReply = await get(`/chain/block/${height}`);
          const block = blockReply.ok ? body(blockReply.payload) : null;
          if (block && safeInt(block.height) === height) {
            hash = hashOrNull(block.hash);
            timestamp = isoFromText(block.timestamp);
            producerPubkey = producerPubkeyHex(block.producer_pubkey);
          }
        } catch {
          // The height is chain-proven by the scan; the block's own fields stay null (Unavailable).
        }
        inclusion = {
          status: 'included',
          block: { height, hash, timestamp, producerPubkey, finalized: finalizedHeight === null ? null : height <= finalizedHeight },
        };
        const values: Row = hit.values && typeof hit.values === 'object' ? hit.values : {};
        reading = {
          observedAt: isoFromSeconds(hit.observed_at),
          temperatureC: finiteOrNull(values.temperature_c),
          humidityPct: finiteOrNull(values.humidity_percent),
          pressureHpa: finiteOrNull(values.pressure_hpa),
          windSpeedMs: finiteOrNull(values.wind_speed_ms),
          precipitationMm: finiteOrNull(values.precipitation_mm),
          dewpointC: finiteOrNull(values.dewpoint_c),
          provenanceClass: enumOrNull(hit.provenance_class, PROVENANCE),
        };
        const a: Row | null = hit.attestation && typeof hit.attestation === 'object' ? hit.attestation : null;
        if (a && safeInt(a.approvals) !== null && typeof a.has_quorum === 'boolean') {
          attestation = { approvals: a.approvals, hasQuorum: a.has_quorum, quorum: safeInt(contribution.oracle_quorum) };
        }
      }
      if (!attestation && contribution.has_quorum === true && safeInt(contribution.approvals) !== null) {
        attestation = { approvals: contribution.approvals, hasQuorum: true, quorum: safeInt(contribution.oracle_quorum) };
      }

      const amount = typeof rewardRow?.amount === 'string' && BASE_UNITS_RE.test(rewardRow.amount) ? rewardRow.amount : null;
      const rewardBlock = rewardBlockRow && rewardBlockHeight !== null
        ? { height: rewardBlockHeight, hash: hashOrNull(rewardBlockRow.hash), finalized: rewardBlockRow.finalized === true }
        : null;
      const card: ProofCard = {
        commitId,
        stationAlias: stationId ? stationAlias(stationId) : null,
        status,
        reading,
        inclusion,
        attestation,
        reward: {
          status: enumOrNull(contribution.reward_status, REWARD_STATUSES),
          amountBaseUnits: amount,
          finalized: contribution.reward_finalized === true,
          rewarded: evidence.rewarded === true,
          blocker: typeof evidence.rewarded_blocker === 'string' && SHORT_TOKEN_RE.test(evidence.rewarded_blocker)
            ? evidence.rewarded_blocker : null,
          block: rewardBlock,
        },
        chain: {
          networkId: typeof chain.network_id === 'string' && IDENT_RE.test(chain.network_id) ? chain.network_id : null,
          chainId: typeof chain.chain_id === 'string' && IDENT_RE.test(chain.chain_id) ? chain.chain_id : null,
          genesisHash: hashOrNull(chain.genesis_hash),
          height: safeInt(chain.height),
          finalizedHeight,
        },
      };
      const settled = inclusion.status === 'included' && inclusion.block?.finalized === true
        && card.reward.finalized && (rewardBlock === null || rewardBlock.finalized);
      return { kind: 'ok', card: stationId ? scrubRawId(card, stationId) : card, settled };
    } catch (error) {
      return { kind: error instanceof Upstream && error.timeout ? 'upstream_timeout' : 'upstream_error' };
    }
  }

  function read(commitId: string, hint: number | null, token: string): Promise<LoadResult> {
    const at = now();
    const key = `${commitId}:${hint ?? ''}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > at) return hit.value;
    cache.delete(key);
    if (cache.size >= MAX_CACHED_CARDS) {
      for (const [k, entry] of cache) if (entry.expiresAt <= at) cache.delete(k);
      while (cache.size >= MAX_CACHED_CARDS) cache.delete(cache.keys().next().value as string);
    }
    // Past the process-wide budget the node is not asked and nothing is cached.
    const allowed = takeBudget(at);
    if ('retryAfterSeconds' in allowed) return Promise.resolve({ kind: 'budget_exhausted', retryAfterSeconds: allowed.retryAfterSeconds });
    // Single flight: the entry is installed before the node is asked, with a finite in-flight expiry.
    const entry = { expiresAt: at + PROOF_CARD_OPEN_TTL_MS, value: Promise.resolve<LoadResult>({ kind: 'upstream_error' }) };
    entry.value = load(commitId, hint, token).then((result) => {
      const ttl = result.kind === 'ok'
        ? (result.settled ? PROOF_CARD_SETTLED_TTL_MS : PROOF_CARD_OPEN_TTL_MS)
        : result.kind === 'not_found' ? PROOF_CARD_OPEN_TTL_MS : PROOF_CARD_FAILURE_TTL_MS;
      entry.expiresAt = now() + ttl;
      return result;
    });
    cache.set(key, entry);
    return entry.value;
  }

  router.get('/:commitId', (req, res, next) => {
    if (!enabled()) return notFound(res);
    getRateLimit().then(
      (limit) => limit(req, res, (err?: unknown) => (err ? next(err) : void handle(req, res))),
      () => fail(res, 503, 'RATE_LIMIT_UNAVAILABLE', 'Proof cards are unavailable, please try again later.'),
    );
  });

  async function handle(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store');
    const commitId = String(req.params.commitId ?? '');
    if (!COMMIT_ID_RE.test(commitId)) return fail(res, 400, 'VALIDATION_ERROR', 'Expected a 64-character lowercase hex commit id.');
    const rawHint = req.query.h;
    if (Object.keys(req.query).some((k) => k !== 'h') || (rawHint !== undefined && (typeof rawHint !== 'string' || !HINT_RE.test(rawHint)))) {
      return fail(res, 400, 'VALIDATION_ERROR', 'The only query parameter is h, a block height.');
    }
    const hint = typeof rawHint === 'string' ? Number(rawHint) : null;
    const token = readerToken();
    if (!token) return fail(res, 503, 'CORE4_READER_CREDENTIAL_UNCONFIGURED', 'Chain reads are unavailable on this server.');
    const result = await read(commitId, hint, token);
    if (result.kind === 'ok') return res.json(result.card);
    if (result.kind === 'not_found') return fail(res, 404, 'PROOF_NOT_FOUND', 'The chain has no station reading with this commit id.');
    if (result.kind === 'budget_exhausted') {
      res.set('Retry-After', String(result.retryAfterSeconds));
      return fail(res, 503, 'UPSTREAM_BUDGET_EXHAUSTED', 'Proof cards are busy, please try again later.');
    }
    if (result.kind === 'upstream_timeout') return fail(res, 504, 'UPSTREAM_TIMEOUT', 'The chain node did not answer in time.');
    return fail(res, 502, 'UPSTREAM_ERROR', 'The chain node could not answer.');
  }

  return router;
}

export default createProofCardRouter();
