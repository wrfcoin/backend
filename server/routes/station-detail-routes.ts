import express from 'express';
import { baseUnitsToWrf } from '../../shared/currency.js';
import { stationEarningsUnits } from '../../shared/amount-unit-contract.js';
import { fetchCore4Json as defaultFetchCore4Json } from '../../shared/core4-route-client.js';
import {
  CORE4_ADDRESS_RE,
  createAddressEarnedReader,
  getDefaultAddressEarnedReader,
  type AddressEarnedReader,
} from '../services/address-lifetime-earned.js';
import { peekWalletSubject } from '../middleware/authMiddleware.js';
import { hasOperatorOrReaderToken } from '../middleware/operator-token-auth.js';
import { isStationAlias, resolveStationAlias, scrubRawId as scrubRawIdImpl } from '../utils/station-alias.js';
import {
  createChainTailReader,
  getDefaultChainTailReader,
  isCore4Unavailable,
  type ChainTailReader,
} from '../services/chain-station-tail.js';

type Row = Record<string, unknown>;
type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
};
type Core4Result = { ok: boolean; status: number; payload: any };
type Core4Fetch = (path: string, options?: Record<string, unknown>) => Promise<Core4Result>;

function defaultDb(): DbExecutor {
  let executeQuery: DbExecutor['execute'] | null = null;
  return {
    execute: async (sql, params) => {
      if (!executeQuery) {
        const mod = await import('../../database/index.js');
        executeQuery = mod.executeQuery;
      }
      return executeQuery(sql, params);
    },
  };
}

function limitFrom(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? '25'), 10);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : 25;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function observation(row: Row) {
  return {
    timestamp: row.timestamp ?? null,
    temperatureC: nullableNumber(row.temperature_c ?? row.temperature),
    humidityPct: nullableNumber(row.humidity_pct ?? row.humidity),
    pressureHpa: nullableNumber(row.pressure_hpa ?? row.pressure),
    windSpeedMs: nullableNumber(row.wind_speed_ms ?? row.wind_speed),
    windDirectionDeg: nullableNumber(row.wind_direction_deg ?? row.wind_direction),
    rainRateMmHr: nullableNumber(row.rain_rate_mm_hr ?? row.precipitation),
    uvIndex: nullableNumber(row.uv_index),
    pm25UgM3: nullableNumber(row.pm25_ug_m3),
  };
}

const INVALID_CURSOR = Symbol('invalid-cursor');

// Upstream error codes an anonymous caller may see (codes only, never text).
const ANONYMOUS_UPSTREAM_CODES = new Set([
  'INVALID_CURSOR',
  'INVALID_LIMIT',
  'NOT_FOUND',
  'UNPROCESSABLE_ENTITY',
  'RATE_LIMITED',
  'BAD_REQUEST',
]);

function cursorFrom(value: unknown): number | null | typeof INVALID_CURSOR {
  if (value === undefined || value === '') return null;
  const text = String(value);
  if (!/^\d{1,15}$/.test(text)) return INVALID_CURSOR;
  return Number(text);
}

// core4 unavailability that justifies the database fallback (isCore4Unavailable,
// shared with the tail reader): credential rejected (401/403), route absent on
// an older node (404/405), or a 5xx. Any other 4xx (INVALID_CURSOR, invalid
// station id) is a real answer.

// Shape of core4 native-chain launch_api get_station_observations
// (routes/transactions.rs), wrapped by envelope_success as {ok, data, meta}.
function core4Window(payload: any) {
  const data = payload?.ok === true ? payload.data : null;
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
  return {
    items: data.items as Row[],
    cursor: {
      nextAfter: nullableNumber(data.next_after),
      nextOffset: nullableNumber(data.next_offset),
      hasMore: typeof data.has_more === 'boolean' ? data.has_more : null,
      chainHeight: nullableNumber(data.chain_height),
    },
  };
}

// core4 reports only an explicit numeric allowlist in `values`; anything it
// does not report stays null rather than being borrowed from another field.
function core4Observation(item: Row) {
  const values = item.values && typeof item.values === 'object' ? item.values as Row : {};
  const observedAt = nullableNumber(item.observed_at);
  return {
    timestamp: observedAt === null ? null : new Date(observedAt * 1000).toISOString(),
    observedAt,
    height: nullableNumber(item.height),
    commitId: item.commit_id ?? null,
    temperatureC: nullableNumber(values.temperature_c),
    humidityPct: nullableNumber(values.humidity_percent),
    pressureHpa: nullableNumber(values.pressure_hpa),
    windSpeedMs: nullableNumber(values.wind_speed_ms),
    windDirectionDeg: null,
    rainRateMmHr: null,
    precipitationMm: nullableNumber(values.precipitation_mm),
    dewpointC: nullableNumber(values.dewpoint_c),
    uvIndex: null,
    pm25UgM3: null,
    provenanceClass: item.provenance_class ?? null,
    attestation: item.attestation ?? null,
  };
}

// ---------------------------------------------------------------------------
// Anonymous projections (#1258 review round 60). Anonymous alias responses are
// built from explicit ALLOWLISTS with validated types: no upstream or DB value
// is passed through structurally. As a last line, scrubRawId() removes any key
// or string value that contains the internal station id in any letter case.
// Authenticated projections are unchanged.
// ---------------------------------------------------------------------------

const PROVENANCE_CLASSES = new Set(['real', 'synthetic', 'unclassified']);
// core4 contribution_status() statuses (launch_api routes/transactions.rs).
const CHAIN_STATUSES = new Set([
  'revealed_attested',
  'revealed_pending_attestation',
  'committed_pending_reveal',
  'attested_without_pending_records',
  'reward_finalized',
  'reward_pending_quorum',
  'not_found',
]);
const SUBMISSION_STATUSES = new Set(['pending', 'committed', 'revealed', 'expired', 'failed', 'rejected', 'verified']);
// Quality factor keys the backend writes or the frontend renders.
const QUALITY_DIMENSION_KEYS = new Set([
  'range', 'temporal', 'spatial', 'crossParameter', 'completeness', 'freshness', 'accuracy',
  'consistency', 'timeliness', 'inputConfidence', 'stationQuality', 'dataRangeValid',
]);
const ADVISORY_TIERS = new Set(['gold', 'silver', 'bronze', 'unrated', 'excellent', 'good', 'fair', 'poor']);
const HASH_RE = /^(0x)?[0-9a-fA-F]{8,128}$/;

function enumOrNull(value: unknown, allowed: Set<string>): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

// ISO-8601-shaped only: V8's Date parser is lenient enough to read arbitrary
// text (e.g. a station id ending in digits) as a date.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isoOrNull(value: unknown): string | null {
  let d: Date | null = null;
  if (value instanceof Date) d = value;
  else if (typeof value === 'number' && Number.isFinite(value)) d = new Date(value);
  else if (typeof value === 'string' && ISO_DATE_RE.test(value)) d = new Date(value);
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function hashOrNull(value: unknown): string | null {
  return typeof value === 'string' && HASH_RE.test(value) ? value : null;
}

function anonymousAttestation(value: unknown): { approvals: number; has_quorum: boolean } | null {
  if (!value || typeof value !== 'object') return null;
  const a = value as Row;
  const approvals = typeof a.approvals === 'number' && Number.isInteger(a.approvals) && a.approvals >= 0 ? a.approvals : null;
  const hasQuorum = typeof a.has_quorum === 'boolean' ? a.has_quorum : null;
  if (approvals === null || hasQuorum === null) return null;
  return { approvals, has_quorum: hasQuorum };
}

function anonymousCore4Observation(item: Row) {
  const o = core4Observation(item);
  return {
    timestamp: isoOrNull(o.timestamp),
    observedAt: o.observedAt,
    height: o.height,
    commitId: hashOrNull(item.commit_id),
    temperatureC: o.temperatureC,
    humidityPct: o.humidityPct,
    pressureHpa: o.pressureHpa,
    windSpeedMs: o.windSpeedMs,
    windDirectionDeg: null,
    rainRateMmHr: null,
    precipitationMm: o.precipitationMm,
    dewpointC: o.dewpointC,
    uvIndex: null,
    pm25UgM3: null,
    provenanceClass: enumOrNull(item.provenance_class, PROVENANCE_CLASSES),
    attestation: anonymousAttestation(item.attestation),
  };
}

function anonymousDbObservation(row: Row) {
  const o = observation(row);
  return { ...o, timestamp: isoOrNull(row.timestamp) };
}

function dimensionLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** Re-exported for callers/tests that import it from this module. */
export const scrubRawId = scrubRawIdImpl as <T>(value: T, rawId: string) => T;

/** core4 client timeout (5 s, shared/core4-route-client.js DEFAULT_TIMEOUT_MS) plus margin. */
export const CHAIN_STATUS_INFLIGHT_DEADLINE_MS = 7_000;

/** Owner address of one station and how many weather_stations rows share it (trimmed, case-insensitive). */
export const STATION_OWNER_SHARING_SQL = `SELECT lower(trim(w.owner_address)) AS owner_address,
           (SELECT count(*)::int FROM weather_stations o WHERE lower(trim(o.owner_address)) = lower(trim(w.owner_address))) AS stations_sharing
      FROM weather_stations w WHERE w.station_id = $1 LIMIT 1`;

export function createStationDetailRouter(deps: {
  db?: DbExecutor;
  fetchCore4Json?: Core4Fetch;
  readerToken?: () => string | undefined;
  now?: () => number;
  chainStatusCacheMaxEntries?: number;
  /** Does this request carry an operator/reader bearer? (raw station ids allowed) */
  isAuthenticated?: (req: express.Request) => boolean;
  /** Newest-chain-observations reader (backend#1280); shared process-wide by default. */
  chainTail?: ChainTailReader;
  /** Per-address lifetime reader (backend#1232); shared with the leaderboard by default. */
  addressEarned?: AddressEarnedReader;
} = {}): express.Router {
  const router = express.Router();
  const db = deps.db ?? defaultDb();
  const fetchCore4Json = deps.fetchCore4Json ?? defaultFetchCore4Json;
  const readerToken = deps.readerToken ?? (() => process.env.WRFCOIN_READER_TOKEN?.trim() || undefined);
  const now = deps.now ?? Date.now;
  // An injected core4 client gets its own reader so tests never share the
  // process-wide cache; production shares one with the station list.
  const chainTail = deps.chainTail
    ?? (deps.fetchCore4Json || deps.readerToken || deps.now
      ? createChainTailReader({ fetchCore4Json, readerToken, now })
      : getDefaultChainTailReader());
  const addressEarned = deps.addressEarned
    ?? (deps.fetchCore4Json || deps.readerToken || deps.now
      ? createAddressEarnedReader({ fetchCore4Json, readerToken, now })
      : getDefaultAddressEarnedReader());
  const maxEntries = Math.max(1, Math.min(2048, Math.floor(deps.chainStatusCacheMaxEntries ?? 2048)));
  const chainStatuses = new Map<string, { expiresAt: number; value: Promise<unknown> }>();

  function chainStatusFor(hash: string): Promise<unknown> {
    const cached = chainStatuses.get(hash);
    if (cached && cached.expiresAt > now()) {
      // Refresh insertion order for bounded least-recently-used eviction.
      chainStatuses.delete(hash);
      chainStatuses.set(hash, cached);
      return cached.value;
    }
    chainStatuses.delete(hash);
    // An in-flight entry gets a FINITE deadline (the production client aborts at
    // 5 s, plus margin), so an injected client that never settles cannot pin the
    // entry forever. Settling replaces it with the status TTL below (#1264).
    const entry = { expiresAt: now() + CHAIN_STATUS_INFLIGHT_DEADLINE_MS, value: Promise.resolve<unknown>(null) };
    // Install the promise before invoking the client, so simultaneous pages and
    // duplicate rows share one in-flight read. All statuses expire: do not assume
    // a terminal-state vocabulary or chain-reorg policy at this read boundary.
    entry.value = Promise.resolve().then(async () => {
      let status: unknown = null;
      try {
        const upstream = await fetchCore4Json(`/transactions/commit/${encodeURIComponent(hash)}/status`);
        if (upstream.ok) status = upstream.payload?.status ?? upstream.payload?.data?.status ?? null;
      } catch {
        // Preserve the existing honest null response during core4 unavailability.
      }
      entry.expiresAt = now() + (status === null ? 5_000 : 20_000);
      return status;
    });
    chainStatuses.set(hash, entry);
    while (chainStatuses.size > maxEntries) {
      const oldest = chainStatuses.keys().next().value;
      if (oldest !== undefined) chainStatuses.delete(oldest);
    }
    return entry.value;
  }

  const isAuthenticated = deps.isAuthenticated ?? ((req: express.Request) => hasOperatorOrReaderToken(req));

  // Owner ruling Q5 (2026-09-27): public routes address a station by its
  // public alias (server/utils/station-alias.js). Anonymous callers MUST use
  // the alias — a raw station id (which can carry a personal name) or an
  // unknown alias is 404. Operator/reader bearers may use either. The resolved
  // internal id travels in res.locals.stationId; response bodies carry none.
  const notFound = (res: express.Response) =>
    res.status(404).json({ error: { code: 'STATION_NOT_FOUND', message: 'unknown station' } });
  router.param('stationId', async (req, res, next, raw: string) => {
    // Anonymous callers get fixed error text only (#1258 review P2): an
    // upstream message may name the internal station id.
    res.locals.anonymous = !isAuthenticated(req);
    try {
      if (isStationAlias(raw)) {
        const resolved = await resolveStationAlias(
          async (sql: string, params: unknown[]) => (await db.execute(sql, params)).rows,
          raw,
        );
        if (resolved.status === 'found') {
          res.locals.stationId = resolved.stationId;
          return next();
        }
        return notFound(res);
      }
      if (isAuthenticated(req)) {
        res.locals.stationId = raw;
        return next();
      }
      return notFound(res);
    } catch {
      return res.status(503).json({ error: { code: 'STATION_LOOKUP_UNAVAILABLE', message: 'station lookup unavailable' } });
    }
  });
  const stationIdOf = (res: express.Response): string => String(res.locals.stationId);

  // #1258 review P3: Express 4 does not catch a rejected async handler and this
  // app mounts no error middleware, so a DB error inside a handler hung the
  // request (holding a connection) until the client timed out. Every detail
  // handler answers a fixed 503 instead: no error text, which could carry SQL
  // or the internal station id.
  const failSafe = (handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response) => {
      try {
        await handler(req, res);
      } catch {
        if (!res.headersSent) {
          res.status(503).json({
            error: { code: 'STATION_DATA_UNAVAILABLE', message: 'station data temporarily unavailable' },
          });
        }
      }
    };
  // Anonymous bodies get the final raw-id scrub; authenticated ones are sent as built.
  const send = (res: express.Response, body: Record<string, unknown>) =>
    res.json(res.locals.anonymous ? scrubRawId(body, stationIdOf(res)) : body);

  const rejected = (res: express.Response, status: number, payload: any) => {
    if (res.locals.anonymous) {
      // Allowlisted code + fixed message: never echo upstream text,
      // which can carry the internal station id.
      const upstreamCode = payload?.error?.code;
      const code = typeof upstreamCode === 'string' && ANONYMOUS_UPSTREAM_CODES.has(upstreamCode)
        ? upstreamCode
        : 'CORE4_REQUEST_REJECTED';
      const anonymousStatus = [400, 404, 409, 422, 429].includes(status) ? status : 502;
      return res.status(anonymousStatus).json({ error: { code, message: 'the observations request was rejected' } });
    }
    const code = payload?.error?.code ?? 'CORE4_REQUEST_REJECTED';
    const message = payload?.error?.message ?? 'core4 rejected the observations request';
    return res.status(status).json({ error: { code, message } });
  };

  router.get('/stations/:stationId/observations', failSafe(async (req, res) => {
    const limit = limitFrom(req.query.limit);
    const stationId = stationIdOf(res);
    const after = cursorFrom(req.query.after);
    const offset = cursorFrom(req.query.offset);
    if (after === INVALID_CURSOR || offset === INVALID_CURSOR) {
      return res.status(400).json({ error: { code: 'INVALID_CURSOR', message: 'after and offset must be non-negative integers' } });
    }

    // core4 is canonical. Only genuine core4 unavailability (no Reader
    // credential, unreachable, route missing on an older node, credential
    // rejected, or a 5xx) falls through to the database. A well-formed core4
    // answer -- including an empty window -- is returned as-is, and a 200 in
    // any other shape is contract drift, surfaced as 502 rather than hidden
    // behind the database (which is how backend#1198 shipped reading a
    // `payload.observations` field core4 never sends).
    let core4Unavailable: string;
    const token = readerToken();
    // backend#1280: without a cursor (the only form the public edge admits),
    // answer the chain TAIL, newest first. core4 scans ascending from height 0,
    // so passing no cursor through served the genesis window.
    if (after === null && offset === null) {
      const tail = await chainTail.latest(stationId);
      if (tail.kind === 'ok') {
        return send(res, {
          observations: tail.items
            .slice(0, limit)
            .map(res.locals.anonymous ? anonymousCore4Observation : core4Observation),
          source: 'core4',
          order: 'descending-height',
          cursor: { nextAfter: null, nextOffset: null, hasMore: null, chainHeight: tail.chainHeight },
          tail: { fromHeight: tail.fromHeight, toHeight: tail.toHeight, complete: tail.complete },
        });
      }
      if (tail.kind === 'mismatch') {
        return res.status(502).json({
          error: { code: 'CORE4_CONTRACT_MISMATCH', message: 'core4 station observations response did not match the expected shape' },
        });
      }
      if (tail.kind === 'rejected') {
        return rejected(res, tail.status, tail.payload);
      }
      core4Unavailable = tail.reason;
    } else if (!token) {
      core4Unavailable = 'CORE4_READER_CREDENTIAL_UNCONFIGURED';
    } else {
      try {
        const upstream = await fetchCore4Json(
          `/transactions/contributions/${encodeURIComponent(stationId)}/observations`,
          {
            query: { limit, after: after ?? undefined, offset: offset ?? undefined },
            headers: { authorization: `Bearer ${token}` },
          },
        );
        if (upstream.ok) {
          const window = core4Window(upstream.payload);
          if (!window) {
            return res.status(502).json({
              error: { code: 'CORE4_CONTRACT_MISMATCH', message: 'core4 station observations response did not match the expected shape' },
            });
          }
          return send(res, {
            observations: window.items
              .slice(0, limit)
              .map(res.locals.anonymous ? anonymousCore4Observation : core4Observation),
            source: 'core4',
            order: 'ascending-height',
            cursor: window.cursor,
          });
        }
        if (isCore4Unavailable(upstream.status)) {
          core4Unavailable = `CORE4_HTTP_${upstream.status}`;
        } else {
          return rejected(res, upstream.status, upstream.payload);
        }
      } catch {
        core4Unavailable = 'CORE4_UNREACHABLE';
      }
    }

    const result = await db.execute(
      `SELECT timestamp, temperature, humidity, pressure, wind_speed,
              wind_direction, precipitation,
              metadata->>'uv_index' AS uv_index,
              metadata->>'pm25_ug_m3' AS pm25_ug_m3
         FROM weather_data
        WHERE station_id = $1
        ORDER BY timestamp DESC
        LIMIT $2`,
      [stationId, limit],
    );
    if (result.rows.length === 0) {
      return send(res, { observations: [], source: 'backend-db', core4Unavailable, unavailable: ['observations'] });
    }
    return send(res, {
      observations: result.rows.map(res.locals.anonymous ? anonymousDbObservation : observation),
      source: 'backend-db',
      core4Unavailable,
    });
  }));

  router.get('/stations/:stationId/quality', failSafe(async (req, res) => {
    const result = await db.execute(
      `SELECT q.quality_score, q.confidence, q.factors, q.validation_status,
              r.tier AS advisory_tier
         FROM weather_data_quality q
         LEFT JOIN LATERAL (
           SELECT tier FROM reference_scores
            WHERE station_id = q.station_id ORDER BY scored_at DESC LIMIT 1
         ) r ON true
        WHERE q.station_id = $1
        ORDER BY q.calculated_at DESC LIMIT 1`,
      [stationIdOf(res)],
    );
    const row = result.rows[0];
    if (!row) {
      return send(res, { overall: null, dimensions: [], advisory: true, source: 'backend-db', unavailable: ['quality'] });
    }
    const factors = row.factors && typeof row.factors === 'object' ? row.factors as Row : {};
    const dimensions = res.locals.anonymous
      // Anonymous: allowlisted keys with a numeric score only; label derived
      // from the allowlisted key, never from stored text.
      ? Object.entries(factors)
        .filter(([key, value]) => QUALITY_DIMENSION_KEYS.has(key) && nullableNumber(value) !== null)
        .map(([key, value]) => ({ key, label: dimensionLabel(key), score: nullableNumber(value) }))
      : Object.entries(factors).map(([key, value]) => ({
        key,
        label: key.replace(/_/g, ' '),
        score: nullableNumber(value),
      }));
    return send(res, {
      overall: nullableNumber(row.quality_score),
      confidence: nullableNumber(row.confidence),
      dimensions,
      advisory: true,
      advisoryTier: res.locals.anonymous
        ? enumOrNull(typeof row.advisory_tier === 'string' ? row.advisory_tier.toLowerCase() : row.advisory_tier, ADVISORY_TIERS)
        : row.advisory_tier ?? null,
      source: 'backend-db',
    });
  }));

  router.get('/stations/:stationId/submissions', failSafe(async (req, res) => {
    const limit = limitFrom(req.query.limit);
    const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const result = await db.execute(
      `SELECT id, commitment_hash, status, created_at, reveal_deadline
         FROM weather_commitments WHERE station_id = $1
        ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [stationIdOf(res), limit, offset],
    );
    const submissions = await Promise.all(result.rows.map(async row => {
      const chainStatus = await chainStatusFor(String(row.commitment_hash));
      if (res.locals.anonymous) {
        // Anonymous: validated scalars/enums only (chainStatus is one of
        // core4's contribution statuses, never an upstream object).
        return {
          id: typeof row.id === 'number' && Number.isInteger(row.id) ? row.id : nullableNumber(row.id),
          commitmentHash: hashOrNull(row.commitment_hash),
          status: enumOrNull(row.status, SUBMISSION_STATUSES),
          chainStatus: enumOrNull(chainStatus, CHAIN_STATUSES),
          createdAt: isoOrNull(row.created_at),
          revealDeadline: isoOrNull(row.reveal_deadline),
        };
      }
      return {
        id: row.id,
        commitmentHash: row.commitment_hash,
        status: row.status,
        chainStatus,
        createdAt: row.created_at,
        revealDeadline: row.reveal_deadline,
      };
    }));
    return send(res, { submissions, source: 'backend-db', limit, offset });
  }));

  // backend#1232: per-station earnings. core4 has no per-station reward ledger, but it
  // has an evidence-backed read per commit (GET /transactions/contributions/{id}/reward-evidence,
  // core4#2456). The station's newest chain commits (the same tail the observations read
  // uses) are joined to that evidence. This is a RECENT-WINDOW view, never a lifetime
  // total, and `rewarded` is core4's own verdict (finalized, non-zero, credited): an
  // amount is only summed when that verdict is true. Anything else stays honestly
  // "not rewarded (blocker)". No payee address or station id is emitted.
  const EARNINGS_DEFAULT = 10;
  const EARNINGS_MAX = 25;
  const evidenceCache = new Map<string, { expiresAt: number; value: Promise<Row | null> }>();

  function rewardEvidenceFor(commitId: string, token: string): Promise<Row | null> {
    const cached = evidenceCache.get(commitId);
    if (cached && cached.expiresAt > now()) {
      evidenceCache.delete(commitId);
      evidenceCache.set(commitId, cached);
      return cached.value;
    }
    evidenceCache.delete(commitId);
    const entry = { expiresAt: Infinity, value: Promise.resolve<Row | null>(null) };
    entry.value = Promise.resolve().then(async () => {
      let evidence: Row | null = null;
      try {
        const upstream = await fetchCore4Json(
          `/transactions/contributions/${encodeURIComponent(commitId)}/reward-evidence`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (upstream.ok) {
          const body = upstream.payload?.data ?? upstream.payload;
          if (body && typeof body === 'object' && typeof (body as Row).rewarded === 'boolean') evidence = body as Row;
        }
      } catch {
        // core4 unavailable for this commit: reported as unknown, never as zero.
      }
      // A proven reward is immutable for our purposes; everything else may still advance.
      entry.expiresAt = now() + (evidence?.rewarded === true ? 600_000 : evidence ? 20_000 : 5_000);
      return evidence;
    });
    evidenceCache.set(commitId, entry);
    while (evidenceCache.size > maxEntries) {
      const oldest = evidenceCache.keys().next().value;
      if (oldest !== undefined) evidenceCache.delete(oldest);
    }
    return entry.value;
  }

  const earningsUnavailable = (res: express.Response, reason: string) => res.json({
    earnings: [],
    source: null,
    amountUnits: stationEarningsUnits(false),
    unavailable: ['earnings'],
    reason,
  });

  // backend#1232 `lifetime`: the owner address's core4 real_paid, via the leaderboard's shared
  // reader (same cache, same 30-reads-per-5-minutes budget). `scope` says what the number is:
  // 'station' only when no OTHER weather_stations row (active or not: an inactive sibling may
  // have earned to the address) shares the owner, else 'address' + the sharing count.
  // The address is never emitted. Anything unproven is null, never 0.
  const OWNER_SQL = STATION_OWNER_SHARING_SQL;
  async function lifetimeFor(stationId: string, req: express.Request, res: express.Response) {
    try {
      const rows = (await db.execute(OWNER_SQL, [stationId])).rows;
      const owner = rows[0]?.owner_address;
      const sharing = rows[0]?.stations_sharing;
      if (typeof owner !== 'string' || !CORE4_ADDRESS_RE.test(owner)) return null;
      if (typeof sharing !== 'number' || !Number.isInteger(sharing) || sharing < 1) return null;
      // Owner ruling 2026-10-05 (earnings privacy): an address-scoped total (or two stations showing
      // identical totals) would reveal a shared wallet, so it goes only to the owner wallet's own
      // login and the operator/reader bearer. Anyone else gets null (same body as "unproven", no
      // reason string) and no node read is spent on a number they cannot see.
      const privileged = !res.locals.anonymous || peekWalletSubject(req) === owner;
      if (sharing > 1 && !privileged) return null;
      const paid = await addressEarned.readOne(owner);
      if (paid === null || !/^\d{1,39}$/.test(paid)) return null;
      return {
        scope: sharing === 1 ? 'station' : 'address',
        // Only a privileged viewer reaches here with sharing > 1 (see above); the count goes with it.
        ...(sharing === 1 ? {} : { stationsSharingAddress: sharing }),
        baseUnits: paid,
        wrf: baseUnitsToWrf(BigInt(paid)),
        denomination: 'WRF',
        baseUnitDecimals: 8,
        source: 'core4',
      };
    } catch {
      return null;
    }
  }

  // backend#1232 `rate`: rewarded base units per day over the recent window, computed from the
  // evidence this route already read (zero extra node reads). Definition: take the window's
  // PROVEN rewarded commits; span = newest minus oldest blockTimestamp; amount = the sum of all
  // of them EXCEPT the oldest (it marks the start of the span, so its reward was earned before
  // it); rate = amount * 86400 / span, floored (never rounded up). Needs a COMPLETE window (no
  // unreadable commit, tail complete), >= RATE_MIN_COMMITS rewarded commits and a span of at
  // least RATE_MIN_SPAN_SECONDS; otherwise null, never 0.
  const RATE_MIN_COMMITS = 3;
  const RATE_MIN_SPAN_SECONDS = 3600;
  function rateFrom(points: Array<{ ts: number; amount: bigint }>, complete: boolean) {
    if (!complete || points.length < RATE_MIN_COMMITS) return null;
    const sorted = [...points].sort((a, b) => a.ts - b.ts);
    const spanSeconds = Math.floor((sorted[sorted.length - 1].ts - sorted[0].ts) / 1000);
    if (spanSeconds < RATE_MIN_SPAN_SECONDS) return null;
    const amount = sorted.slice(1).reduce((sum, p) => sum + p.amount, 0n);
    const perDay = (amount * 86_400n) / BigInt(spanSeconds);
    return {
      baseUnitsPerDay: perDay.toString(),
      wrfPerDay: baseUnitsToWrf(perDay),
      windowCommits: points.length,
      windowSeconds: spanSeconds,
      complete: true,
      denomination: 'WRF',
      baseUnitDecimals: 8,
      source: 'core4',
    };
  }

  router.get('/stations/:stationId/earnings', failSafe(async (req, res) => {
    const limit = Math.min(EARNINGS_MAX, limitFrom(req.query.limit ?? String(EARNINGS_DEFAULT)));
    const token = readerToken();
    if (!token) return earningsUnavailable(res, 'the core4 reader credential is not configured');
    const tail = await chainTail.latest(stationIdOf(res));
    if (tail.kind === 'mismatch') {
      return res.status(502).json({
        error: { code: 'CORE4_CONTRACT_MISMATCH', message: 'core4 station observations response did not match the expected shape' },
      });
    }
    if (tail.kind !== 'ok') return earningsUnavailable(res, 'core4 is unavailable, so no reward evidence can be read');

    const commitIds: string[] = [];
    for (const item of tail.items) {
      const id = hashOrNull(item.commit_id);
      if (id && !commitIds.includes(id)) commitIds.push(id);
      if (commitIds.length >= limit) break;
    }
    const evidence = await Promise.all(commitIds.map((id) => rewardEvidenceFor(id, token)));
    let totalRewarded = 0n;
    let rewardedCount = 0;
    let unknownCount = 0;
    let unusableRewards = 0; // rewarded:true whose amount/time core4 sent unusably: the window is not complete
    const ratePoints: Array<{ ts: number; amount: bigint }> = [];
    const earnings = commitIds.map((commitId, i) => {
      const e = evidence[i];
      if (!e) {
        unknownCount += 1;
        return { commitId, rewarded: null, amountBaseUnits: null, amountWrf: null, blocker: 'evidence_unavailable', finalized: null, height: null, blockTimestamp: null };
      }
      const reward = (e.reward && typeof e.reward === 'object' ? e.reward : null) as Row | null;
      const block = (e.block && typeof e.block === 'object' ? e.block : null) as Row | null;
      const rewarded = e.rewarded === true;
      const amountRaw = reward && typeof reward.amount === 'string' && /^\d{1,39}$/.test(reward.amount) ? BigInt(reward.amount) : null;
      if (rewarded && amountRaw !== null) {
        totalRewarded += amountRaw;
        rewardedCount += 1;
        const ts = block && typeof block.timestamp === 'number' && Number.isFinite(block.timestamp) ? block.timestamp * 1000 : null;
        if (ts !== null) ratePoints.push({ ts, amount: amountRaw }); else unusableRewards += 1;
      } else if (rewarded) {
        unusableRewards += 1;
      }
      const blocker = typeof e.rewarded_blocker === 'string' && /^[a-z_]{1,64}$/.test(e.rewarded_blocker) ? e.rewarded_blocker : null;
      return {
        commitId,
        rewarded,
        // The amount is shown only for a proven reward; a pending/zero decision carries none.
        amountBaseUnits: rewarded && amountRaw !== null ? amountRaw.toString() : null,
        amountWrf: rewarded && amountRaw !== null ? baseUnitsToWrf(amountRaw) : null,
        blocker: rewarded ? null : blocker,
        finalized: reward ? reward.finalized === true : false,
        height: block ? nullableNumber(block.height) : null,
        blockTimestamp: block ? isoOrNull(typeof block.timestamp === 'number' ? block.timestamp * 1000 : null) : null,
      };
    });
    const lifetime = await lifetimeFor(stationIdOf(res), req, res);
    const windowComplete = unknownCount === 0 && tail.complete;
    const rate = rateFrom(ratePoints, windowComplete && unusableRewards === 0);
    return send(res, {
      earnings,
      source: 'core4',
      amountUnits: stationEarningsUnits(unknownCount === 0 && tail.complete),
      window: { commits: commitIds.length, complete: tail.complete, scope: 'recent-observations' },
      totals: {
        rewardedCommits: rewardedCount,
        unknownCommits: unknownCount,
        rewardedBaseUnits: totalRewarded.toString(),
        rewardedWrf: baseUnitsToWrf(totalRewarded),
        note: 'sum over the recent window only, not a lifetime total',
      },
      lifetime,
      rate,
      // Additive (backend#1232). Kept apart from `unavailable`, which stays absent on a readable window.
      fieldsUnavailable: [...(lifetime ? [] : ['lifetime']), ...(rate ? [] : ['rate'])],
    });
  }));

  return router;
}
