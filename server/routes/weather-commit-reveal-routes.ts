import { Counter } from 'prom-client';
import { metricsRegistry } from '../utils/metrics.js';
import { appLogger } from '../utils/logger.js';
import { WRF_UNITS_PER_COIN, baseUnitsToWrf } from '../../shared/currency.js';
import { type CommitRevealReading, normalizeCommitRevealReading } from '../../shared/types/weather-types.js';
import {
  type CanonicalReading,
  buildCanonicalReading,
  computeCommitId,
} from '../../shared/commit-reveal-hash.js';
import { getCore4ApiUrl } from '../../src/config/core4.js';
import { isReservedMobileStationId } from '../../shared/mobile-station-messages.js';
import { grossGuardActiveAt, type ReferenceTieringContext } from '../../shared/reference-tier.js';
import {
  ReferenceShadowScorer,
  type ReferenceShadowResult,
  type ReferenceShadowScorerLike,
} from '../services/reference-shadow-scorer.js';

type QueryResult = { rows: Record<string, unknown>[] };

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<QueryResult>;
};

export interface WeatherCommitRequest {
  stationId: string;
  readings: CommitRevealReading[];
  nonce: string;
  contributor?: string;
}

export interface WeatherRevealRequest {
  commitmentId: number;
  readings: CommitRevealReading[];
  nonce: string;
  contributor?: string;
  data_cid?: string;
  data_hash?: string;
  storage_provider?: string;
}

export interface WeatherCommitResult {
  commitmentId: number;
  revealDeadline: number;
  commitmentHash: string;
  core4: unknown;
}

export interface WeatherRevealResult {
  receiptId: string;
  stationId: string;
  accuracyScore: number;
  rewardEstimate: string;
  core4: unknown;
  referenceScore?: ReferenceShadowResult;
}

interface Core4Client {
  getCurrentHeight: () => Promise<number>;
  postCommit: (payload: {
    contributor: string;
    stationId: string;
    commitHash: string;
  }) => Promise<unknown>;
  postReveal: (payload: {
    contributor: string;
    stationId: string;
    data: CanonicalReading;
    timestamp: number;
    nonce: string;
    commitHash: string;
    data_cid?: string;
    data_hash?: string;
    storage_provider?: string;
  }) => Promise<unknown>;
}

interface CreateWeatherServiceOptions {
  db?: DbExecutor;
  core4BaseUrl?: string;
  core4Token?: string;
  defaultContributor?: string;
  referenceShadow?: boolean;
  referenceScorer?: ReferenceShadowScorerLike;
}

function defaultDb(): DbExecutor {
  // Lazy dynamic import — returns a promise-based executor
  let cachedExecuteQuery: ((...args: unknown[]) => Promise<QueryResult>) | null = null;
  return {
    execute: async (sql: string, params?: unknown[]) => {
      if (!cachedExecuteQuery) {
        const mod = await import('../../database/index.js');
        cachedExecuteQuery = mod.executeQuery;
      }
      return cachedExecuteQuery!(sql, params);
    },
  };
}

function getCore4BaseUrl(input?: string): string {
  return input ?? getCore4ApiUrl();
}

function getCounter(name: string, help: string): Counter<string> {
  const existing = metricsRegistry.getSingleMetric(name);
  if (existing) {
    return existing as Counter<string>;
  }

  return new Counter({
    name,
    help,
    registers: [metricsRegistry],
  });
}

const commitmentsExpiredCounter = getCounter(
  'wrfcoin_commitments_expired_total',
  'Total number of weather commitments marked as expired'
);

const CORE4_REQUEST_TIMEOUT_MS = parseInt(
  process.env.CORE4_REQUEST_TIMEOUT_MS || '10000',
  10
);
const FETCH_MAX_RETRIES = 3;
const FETCH_INITIAL_DELAY_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT']);

class Core4RequestError extends Error {
  readonly path: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { path: string; status?: number; retryable: boolean }) {
    super(message);
    this.name = 'Core4RequestError';
    this.path = options.path;
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof Core4RequestError) {
    return err.retryable;
  }
  if (err && typeof err === 'object') {
    const code = (err as any).code || (err as any).cause?.code;
    if (typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code)) {
      return true;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return true;
    }
  }
  return false;
}

function isTransientCore4RevealError(err: unknown): boolean {
  if (err instanceof Core4RequestError) {
    if (err.retryable) return true;
    return typeof err.status === 'number' && err.status >= 500;
  }

  return isRetryableError(err);
}

async function fetchJson(
  baseUrl: string,
  path: string,
  init?: RequestInit,
  authToken?: string
): Promise<unknown> {
  const headers = new Headers(init?.headers || {});
  headers.set('Content-Type', 'application/json');
  if (authToken) {
    headers.set('Authorization', `Bearer ${authToken}`);
  }

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= FETCH_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CORE4_REQUEST_TIMEOUT_MS);

      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      let body: unknown;
      const raw = await response.text();
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }

      if (!response.ok) {
        // Only retry on retryable status codes; client errors are not retryable
        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < FETCH_MAX_RETRIES) {
          const delayMs = FETCH_INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
          appLogger.warn('Core4 request failed with retryable status, retrying', {
            path,
            status: response.status,
            attempt,
            maxRetries: FETCH_MAX_RETRIES,
            nextDelayMs: delayMs,
          });
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        throw new Core4RequestError(
          `Core4 ${path} failed (${response.status}): ${JSON.stringify(body)}`,
          {
            path,
            status: response.status,
            retryable: RETRYABLE_STATUS_CODES.has(response.status),
          }
        );
      }

      return body;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < FETCH_MAX_RETRIES && isRetryableError(err)) {
        const delayMs = FETCH_INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
        appLogger.warn('Core4 request failed with network error, retrying', {
          path,
          error: lastError.message,
          code: (err as any).code || (err as any).cause?.code || lastError.name,
          attempt,
          maxRetries: FETCH_MAX_RETRIES,
          nextDelayMs: delayMs,
        });
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      throw lastError;
    }
  }

  // Should not reach here, but satisfy the compiler
  throw lastError ?? new Error(`Core4 ${path} failed after ${FETCH_MAX_RETRIES} retries`);
}

// Operators mirror the chain's configured feature schedule. Unset/empty means
// explicitly unscheduled; never infer activation from wall-clock time.
function referenceTieringContext(height: number): ReferenceTieringContext {
  const raw = process.env.REFERENCE_GROSS_GUARD_ACTIVATION_HEIGHT?.trim();
  if (raw && !/^\d+$/.test(raw)) throw new Error('Invalid REFERENCE_GROSS_GUARD_ACTIVATION_HEIGHT');
  const context = { height, grossGuardActivationHeight: raw ? Number(raw) : null };
  grossGuardActiveAt(context); // rejects unsafe/negative heights and schedule values
  return context;
}

function extractHeight(data: unknown): number | null {
  if (typeof data === 'number' && Number.isFinite(data)) {
    return data;
  }

  if (!data || typeof data !== 'object') {
    return null;
  }

  const record = data as Record<string, unknown>;
  const candidates = [
    record.height,
    record.blockHeight,
    record.currentHeight,
    (record.data as Record<string, unknown> | undefined)?.height,
    (record.data as Record<string, unknown> | undefined)?.blockHeight,
    (record.data as Record<string, unknown> | undefined)?.currentHeight,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function createCore4Client(
  baseUrl: string,
  token: string | undefined,
  defaultContributor: string
): Core4Client {
  if (!token || token.trim() === '') {
    throw new Error(
      'WRFCOIN_OPERATOR_TOKEN is not set — cannot make authenticated calls to core4'
    );
  }
  return {
    async getCurrentHeight() {
      const paths = [
        '/blockchain',
        '/api/blockchain/height',
        '/api/blockchain/status',
        '/status',
      ];

      for (const path of paths) {
        try {
          const data = await fetchJson(baseUrl, path, { method: 'GET' }, token);
          const height = extractHeight(data);
          if (height !== null) {
            return height;
          }
        } catch {
          // Continue to fallback endpoint
        }
      }

      throw new Error('Failed to resolve current chain height from core4');
    },

    async postCommit(payload) {
      return fetchJson(
        baseUrl,
        '/transactions/contribution/commit',
        {
          method: 'POST',
          body: JSON.stringify({
            contributor: payload.contributor || defaultContributor,
            station_id: payload.stationId,
            commit_hash: payload.commitHash,
          }),
        },
        token
      );
    },

    async postReveal(payload) {
      return fetchJson(
        baseUrl,
        '/transactions/contribution/reveal',
        {
          method: 'POST',
          body: JSON.stringify({
            contributor: payload.contributor || defaultContributor,
            station_id: payload.stationId,
            // core4 requires `payload` to be a JSON object (not the readings array)
            // and re-derives the commit hash from it — see shared/commit-reveal-hash.ts.
            payload: payload.data,
            nonce: payload.nonce,
            commit_hash: payload.commitHash,
            // Must be the timestamp fixed at commit time (replayed here), not Date.now() —
            // core4 hashes the timestamp, so a fresh value would break commit/reveal parity.
            timestamp: payload.timestamp,
            ...(payload.data_cid && { data_cid: payload.data_cid }),
            ...(payload.data_hash && { data_hash: payload.data_hash }),
            ...(payload.storage_provider && { storage_provider: payload.storage_provider }),
          }),
        },
        token
      );
    },
  };
}

async function ensureWeatherTables(db: DbExecutor): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS weather_commitments (
      id serial PRIMARY KEY,
      station_id text NOT NULL,
      commitment_hash text NOT NULL,
      reveal_deadline integer NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      nonce text,
      readings_json text,
      contributor text,
      commit_timestamp integer,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_weather_commitments_station_status
      ON weather_commitments (station_id, status)
  `);

  // Backfill columns if table already existed without them
  for (const col of ['nonce text', 'readings_json text', 'contributor text', 'commit_timestamp integer']) {
    const [name] = col.split(' ');
    await db.execute(`
      DO $$ BEGIN
        ALTER TABLE weather_commitments ADD COLUMN IF NOT EXISTS ${col};
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `);
  }

  await db.execute(`
    DO $$ BEGIN
      ALTER TABLE weather_submissions ADD COLUMN IF NOT EXISTS commitment_id integer;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$
  `);

  await db.execute(`
    DO $$ BEGIN
      CREATE UNIQUE INDEX IF NOT EXISTS idx_weather_submissions_commitment_id
        ON weather_submissions (commitment_id)
        WHERE commitment_id IS NOT NULL;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS reference_scores (
      id serial PRIMARY KEY,
      commitment_id integer NOT NULL UNIQUE,
      station_id text NOT NULL,
      tier text NOT NULL CHECK (tier IN ('good', 'degraded', 'outlier')),
      bands_version integer NOT NULL,
      worst_source text,
      worst_variable text,
      worst_residual double precision,
      worst_ratio double precision,
      residuals jsonb NOT NULL,
      analysis_residual double precision,
      forecast_error double precision,
      scored_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_reference_scores_station_scored
      ON reference_scores (station_id, scored_at)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_reference_scores_tier
      ON reference_scores (tier)
  `);
}

function computeAccuracy(readings: CommitRevealReading[]): number {
  if (readings.length === 0) {
    return 0;
  }

  let complete = 0;
  for (const reading of readings) {
    const hasTemp = typeof reading.temperature_c === 'number';
    const hasPressure = typeof reading.pressure_hpa === 'number';
    const hasHumidity = typeof reading.humidity_percent === 'number';
    const hasTimestamp = typeof reading.timestamp === 'string' && reading.timestamp.length > 0;

    if (hasTemp && hasPressure && hasHumidity && hasTimestamp) {
      complete += 1;
    }
  }

  return Number(((complete / readings.length) * 100).toFixed(2));
}

function estimateReward(accuracy: number, readingCount: number): string {
  // 0.05 WRF base reward expressed in integer base units (avoids float arithmetic)
  const baseUnits = 5_000_000n; // 0.05 WRF × 10^8
  const qualityFactor = Math.max(0.25, Math.min(1.5, accuracy / 100));
  const countFactor = Math.max(1, Math.min(3, readingCount / 4));
  // Scale each factor by 10^6 for integer multiplication, divide by 10^12 to restore scale
  const SCALE = 1_000_000n;
  const qualityScaled = BigInt(Math.round(qualityFactor * 1_000_000));
  const countScaled = BigInt(Math.round(countFactor * 1_000_000));
  const rewardUnits = (baseUnits * qualityScaled * countScaled) / (SCALE * SCALE);
  return baseUnitsToWrf(rewardUnits);
}

/**
 * Compute the commit hash core4 will accept. `data` is the canonical flat reading
 * object (see shared/commit-reveal-hash.ts); `timestamp` must be the value fixed at
 * commit time and replayed at reveal time. Mirrors core4's `compute_commit_id`.
 */
function computeCommitmentHash(
  data: CanonicalReading,
  nonce: string,
  stationId: string,
  timestamp: number
): string {
  return computeCommitId({ data, nonce, stationId, timestamp });
}

export function createWeatherCommitRevealService(
  options: CreateWeatherServiceOptions = {}
) {
  const db = options.db ?? defaultDb();
  const defaultContributor =
    options.defaultContributor ||
    process.env.WRFCOIN_CONTRIBUTOR_ADDRESS ||
    '0x0000000000000000000000000000000000000b02';
  const core4 = createCore4Client(
    getCore4BaseUrl(options.core4BaseUrl),
    options.core4Token || process.env.WRFCOIN_OPERATOR_TOKEN,
    defaultContributor
  );
  const referenceShadowEnabled =
    options.referenceShadow ?? process.env.REFERENCE_SHADOW === '1';
  const referenceScorer = referenceShadowEnabled
    ? options.referenceScorer ?? new ReferenceShadowScorer(db)
    : null;

  let initialized = false;

  async function ensureInitialized() {
    if (initialized) return;
    await ensureWeatherTables(db);
    initialized = true;
  }

  async function commit(input: WeatherCommitRequest): Promise<WeatherCommitResult> {
    // Reject hidden format characters before normalization or any I/O (#1315).
    // Such IDs cannot be registered and can disguise the reserved mob- prefix.
    if (typeof input.stationId !== 'string' || /\p{Cf}/u.test(input.stationId)) {
      throw new Error('stationId must be a string without Unicode format characters');
    }
    // Mobile commits must use the oracle path's registered collect-key binding.
    if (isReservedMobileStationId(input.stationId)) {
      throw new Error('Mobile stations must commit through /api/oracle/submit-data');
    }
    await ensureInitialized();

    if (!input.stationId || !Array.isArray(input.readings) || input.readings.length === 0) {
      throw new Error('stationId and at least one reading are required');
    }
    if (!input.nonce || typeof input.nonce !== 'string') {
      throw new Error('nonce is required');
    }

    // Normalize legacy field names (e.g. humidity_pct → humidity_percent)
    input.readings = input.readings.map(r => normalizeCommitRevealReading(r as Record<string, unknown>));

    // Collapse to a single canonical reading and fix the timestamp once — both are
    // hashed and must be replayed verbatim at reveal time (core4 re-derives the hash).
    const canonicalData = buildCanonicalReading(input.readings[0]);
    const commitTimestamp = Math.floor(Date.now() / 1000);
    const commitmentHash = computeCommitmentHash(
      canonicalData,
      input.nonce,
      input.stationId,
      commitTimestamp
    );
    const currentHeight = await core4.getCurrentHeight();
    const revealDeadline = currentHeight + 3;

    const insertResult = await db.execute(
      `INSERT INTO weather_commitments (station_id, commitment_hash, reveal_deadline, status, nonce, readings_json, contributor, commit_timestamp)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)
       RETURNING id`,
      [input.stationId, commitmentHash, revealDeadline, input.nonce, JSON.stringify(input.readings), input.contributor || defaultContributor, commitTimestamp]
    );

    const commitmentId = Number(insertResult.rows[0]?.id);

    let core4Receipt: unknown;
    try {
      core4Receipt = await core4.postCommit({
        contributor: input.contributor || defaultContributor,
        stationId: input.stationId,
        commitHash: commitmentHash,
      });
    } catch (error) {
      await db.execute(`DELETE FROM weather_commitments WHERE id = $1`, [commitmentId]);
      throw error;
    }

    return {
      commitmentId,
      revealDeadline,
      commitmentHash,
      core4: core4Receipt,
    };
  }

  async function reveal(input: WeatherRevealRequest): Promise<WeatherRevealResult> {
    await ensureInitialized();

    if (!input.commitmentId || !Array.isArray(input.readings) || input.readings.length === 0) {
      throw new Error('commitmentId and at least one reading are required');
    }
    if (!input.nonce || typeof input.nonce !== 'string') {
      throw new Error('nonce is required');
    }

    // Normalize legacy field names (e.g. humidity_pct → humidity_percent)
    input.readings = input.readings.map(r => normalizeCommitRevealReading(r as Record<string, unknown>));

    const commitmentResult = await db.execute(
      `SELECT id, station_id, commitment_hash, reveal_deadline, status, commit_timestamp
       FROM weather_commitments
       WHERE id = $1
       LIMIT 1`,
      [input.commitmentId]
    );

    const commitment = commitmentResult.rows[0];
    if (!commitment) {
      throw new Error('commitment not found');
    }

    const status = String(commitment.status || '');
    if (status !== 'pending') {
      throw new Error(`commitment status must be pending, got ${status}`);
    }

    const stationId = String(commitment.station_id);
    const storedHash = String(commitment.commitment_hash || '');

    // Legacy commitments (pre-#767) have no persisted timestamp and used the old
    // BLAKE3 hash; they can never produce a core4-valid reveal.
    if (commitment.commit_timestamp === null || commitment.commit_timestamp === undefined) {
      throw new Error('commitment predates core4-compatible hashing (no commit_timestamp)');
    }
    const commitTimestamp = Number(commitment.commit_timestamp);

    // Rebuild the exact canonical reading + timestamp used at commit time and
    // re-derive the hash; this must match the stored hash (and what core4 recomputes).
    const canonicalData = buildCanonicalReading(input.readings[0]);
    const computedHash = computeCommitmentHash(
      canonicalData,
      input.nonce,
      stationId,
      commitTimestamp
    );

    if (computedHash !== storedHash) {
      throw new Error('commitment hash mismatch');
    }

    const currentHeight = await core4.getCurrentHeight();
    const revealDeadline = Number(commitment.reveal_deadline || 0);

    if (currentHeight < revealDeadline) {
      throw new Error(
        `reveal is too early (current height ${currentHeight}, deadline ${revealDeadline})`
      );
    }

    const claimResult = await db.execute(
      `UPDATE weather_commitments
       SET status = 'revealing'
       WHERE id = $1
         AND status = 'pending'
       RETURNING id, station_id, commitment_hash, reveal_deadline, status, commit_timestamp`,
      [input.commitmentId]
    );

    if (claimResult.rows.length === 0) {
      throw new Error('commitment status must be pending, got claimed');
    }

    let core4Receipt: unknown;
    try {
      core4Receipt = await core4.postReveal({
        contributor: input.contributor || defaultContributor,
        stationId,
        data: canonicalData,
        timestamp: commitTimestamp,
        nonce: input.nonce,
        commitHash: storedHash,
        data_cid: input.data_cid,
        data_hash: input.data_hash,
        storage_provider: input.storage_provider,
      });
    } catch (error) {
      const nextStatus = isTransientCore4RevealError(error) ? 'pending' : 'reveal_failed';
      await db.execute(
        `UPDATE weather_commitments
         SET status = $2
         WHERE id = $1
           AND status = 'revealing'`,
        [input.commitmentId, nextStatus]
      ).catch(() => {});
      throw error;
    }

    const accuracyScore = computeAccuracy(input.readings);
    const rewardEstimate = estimateReward(accuracyScore, input.readings.length);
    const firstReading = input.readings[0] || {};

    const finalizationResult = await db.execute(
      `WITH finalized AS (
         UPDATE weather_commitments
         SET status = 'revealed'
         WHERE id = $1
           AND status = 'revealing'
         RETURNING id
       ), inserted AS (
         INSERT INTO weather_submissions (
           station_id,
           temperature,
           pressure,
           humidity,
           quality_score,
           reward_amount,
           source,
           submitted_at,
           commitment_id
         )
         SELECT $2, $3, $4, $5, $6, $7, 'commit_reveal', now(), finalized.id
         FROM finalized
         ON CONFLICT (commitment_id) WHERE commitment_id IS NOT NULL DO NOTHING
         RETURNING id
       )
       SELECT
         (SELECT COUNT(*) FROM finalized)::integer AS finalized_count,
         (SELECT COUNT(*) FROM inserted)::integer AS inserted_count`,
      [
        input.commitmentId,
        stationId,
        firstReading.temperature_c ?? null,
        firstReading.pressure_hpa ?? null,
        firstReading.humidity_percent ?? null,
        Math.round(accuracyScore),
        rewardEstimate,
      ]
    );

    if (Number(finalizationResult.rows[0]?.finalized_count || 0) !== 1) {
      throw new Error('commitment reveal finalization failed');
    }

    let referenceScore: ReferenceShadowResult | undefined;
    if (referenceScorer) {
      try {
        referenceScore = await referenceScorer.scoreReveal({
          commitmentId: input.commitmentId,
          stationId,
          observedAtUnix: commitTimestamp,
          reading: canonicalData,
          tieringContext: referenceTieringContext(currentHeight),
        });
      } catch (error) {
        // Shadow scoring is deliberately fail-open and runs only after core4
        // reveal plus local submission finalization. It cannot change reward.
        appLogger.warn('Oracle-reference shadow score unavailable', {
          commitmentId: input.commitmentId,
          stationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      receiptId: `wrf-${input.commitmentId}-${Date.now()}`,
      stationId,
      accuracyScore,
      rewardEstimate,
      core4: core4Receipt,
      ...(referenceScore ? { referenceScore } : {}),
    };
  }

  async function listCommitments(stationId: string) {
    await ensureInitialized();

    const result = await db.execute(
      `SELECT id, station_id, commitment_hash, reveal_deadline, status, created_at
       FROM weather_commitments
       WHERE station_id = $1
       ORDER BY created_at DESC`,
      [stationId]
    );

    return result.rows;
  }

  async function expireStaleCommitments(): Promise<number> {
    await ensureInitialized();

    let currentHeight: number;
    try {
      currentHeight = await core4.getCurrentHeight();
    } catch (error) {
      appLogger.warn('Skipping commitment expiry tick; core4 height unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }

    const expiredResult = await db.execute(
      `UPDATE weather_commitments
       SET status = 'expired'
       WHERE status = 'pending'
         AND reveal_deadline + 100 < $1
       RETURNING id`,
      [currentHeight]
    );

    const expiredCount = expiredResult.rows.length;
    if (expiredCount > 0) {
      commitmentsExpiredCounter.inc(expiredCount);
      appLogger.info('Expired stale weather commitments', {
        expiredCount,
        currentHeight,
      });
    }

    return expiredCount;
  }

  async function revealPendingCommitments(): Promise<number> {
    await ensureInitialized();

    let currentHeight: number;
    try {
      currentHeight = await core4.getCurrentHeight();
    } catch (error) {
      appLogger.warn('Skipping reveal tick; core4 height unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }

    const pendingResult = await db.execute(
      `SELECT id, station_id, commitment_hash, reveal_deadline, nonce, readings_json, contributor
       FROM weather_commitments
       WHERE status = 'pending'
         AND reveal_deadline <= $1
         AND nonce IS NOT NULL
         AND readings_json IS NOT NULL
         AND commit_timestamp IS NOT NULL
       ORDER BY reveal_deadline ASC
       LIMIT 50`,
      [currentHeight]
    );

    let revealedCount = 0;
    for (const row of pendingResult.rows) {
      try {
        const readings: CommitRevealReading[] = JSON.parse(String(row.readings_json));
        await reveal({
          commitmentId: Number(row.id),
          readings,
          nonce: String(row.nonce),
          contributor: String(row.contributor || defaultContributor),
        });
        revealedCount++;
      } catch (error) {
        appLogger.warn('Auto-reveal failed for commitment', {
          commitmentId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
        if (isTransientCore4RevealError(error)) {
          continue;
        }

        // Mark permanent failures so we don't retry indefinitely.
        await db.execute(
          `UPDATE weather_commitments SET status = 'reveal_failed' WHERE id = $1 AND status = 'pending'`,
          [row.id]
        ).catch(() => {});
      }
    }

    if (revealedCount > 0) {
      appLogger.info('Auto-revealed pending commitments', {
        revealedCount,
        currentHeight,
      });
    }

    return revealedCount;
  }

  return {
    commit,
    reveal,
    listCommitments,
    expireStaleCommitments,
    revealPendingCommitments,
  };
}

export function startCommitmentExpiryJob(
  service: ReturnType<typeof createWeatherCommitRevealService>,
  intervalMs: number = 60_000
): () => void {
  const timer = setInterval(() => {
    service.expireStaleCommitments().catch(error => {
      appLogger.warn('Commitment expiry job failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, intervalMs);

  return () => {
    clearInterval(timer);
  };
}

export function startRevealSchedulerJob(
  service: ReturnType<typeof createWeatherCommitRevealService>,
  intervalMs: number = 30_000
): () => void {
  const timer = setInterval(() => {
    service.revealPendingCommitments().catch(error => {
      appLogger.warn('Reveal scheduler job failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, intervalMs);

  return () => {
    clearInterval(timer);
  };
}
