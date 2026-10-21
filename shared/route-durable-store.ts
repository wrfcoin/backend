/**
 * RouteDurableStore V2
 * 
 * Manages durable state for critical backend routes (Bridges, Governance, Weather).
 * 
 * V2 Architecture:
 * - Backed by normalized Postgres tables (when backend='db').
 * - Supports Optimistic Concurrency Control (OCC) via 'version' column.
 * - Granular read/write methods (e.g. putBridgeTransaction, updateBridgeSafety) to reduce contention.
 * - Legacy JSON-blob support maintained for 'file' backend and unmigrated modules.
 * 
 * Key Tables:
 * - bridge_transactions: Stores individual bridge transfers.
 * - bridge_safety_state: Stores global bridge safety configuration (halt status, exposure caps).
 * - governance_proposals / governance_votes: Normalized governance state.
 * - weather_records: Normalized weather station submissions.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// FILE BACKEND NOTE (non-production only):
// When WRFCOIN_ROUTE_STORE_BACKEND=file (default), state is persisted to a
// local JSON file at WRFCOIN_ROUTE_STORE_PATH.  This backend is intended for
// local development and integration testing ONLY.  The JSON file is NOT served
// via any HTTP route — access is always mediated through TypeScript methods
// in this module.  In production set WRFCOIN_ROUTE_STORE_BACKEND=db to use
// PostgreSQL with OCC (Optimistic Concurrency Control).
const DEFAULT_STORE_PATH =
  process.env.WRFCOIN_ROUTE_STORE_PATH ||
  path.join(process.cwd(), 'backend', 'data', 'route-durable-store.json');
const DEFAULT_BACKEND: RouteStoreBackend =
  process.env.WRFCOIN_ROUTE_STORE_BACKEND?.toLowerCase() === 'db'
    ? 'db'
    : 'file';
const DB_STORE_KEY = 'wrfcoin-route-state-v1';

const SAFE_BASE_DIR = path.resolve(process.cwd(), 'backend', 'data');

function safePath(candidate: string): string {
  if (candidate.includes('\0')) {
    throw new Error(`[route-durable-store] Null byte in path: ${candidate}`);
  }
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(SAFE_BASE_DIR + path.sep) && resolved !== SAFE_BASE_DIR) {
    throw new Error(
      `[route-durable-store] Path escapes safe base directory. ` +
      `Resolved: ${resolved}, Base: ${SAFE_BASE_DIR}`
    );
  }
  return resolved;
}

const MAX_IDEMPOTENCY_ENTRIES = 10_000;
const CONCURRENCY_MAX_RETRIES = 6;
const CONCURRENCY_BACKOFF_BASE_MS = 25;
const CONCURRENCY_BACKOFF_MAX_MS = 800;

/** Current schema version for normalized tables. Bump when table shapes change. */
const CURRENT_SCHEMA_VERSION = 1;
/** Tracks whether the normalized-table migration has been applied. */
const CURRENT_MIGRATION_VERSION = 1;

// ──────────────────────────────────────────────────────────────────────────
// HA-safe consistency state types (Issue #239)
// ──────────────────────────────────────────────────────────────────────────
export type StoreConsistencyHealth = 'healthy' | 'degraded' | 'failed';
export type StoreReadMode = 'normalized' | 'dual-read' | 'legacy-only';

export interface StoreConsistencyState {
  health: StoreConsistencyHealth;
  /** Active read strategy for this store instance. */
  readMode: StoreReadMode;
  backend: 'db' | 'file';
  schemaVersion: number | null;
  migrationVersion: number | null;
  migrationComplete: boolean;
  lastIntegrityCheckAt: string | null;
  /** Human-readable issue descriptions for operator visibility. */
  issues: string[];
  degradedAt: string | null;
}

type RouteStoreBackend = 'file' | 'db';
type ExecuteQueryFn = (query: string, params?: any[]) => Promise<any>;

export class ConcurrencyConflictError extends Error {
  public readonly expectedVersion: number;
  public readonly actualVersion?: number;
  public readonly storeKey: string;

  constructor(key: string, expectedVersion: number, actualVersion?: number) {
    const detail =
      actualVersion !== undefined
        ? ` (expected ${expectedVersion}, actual ${actualVersion})`
        : ` (expected ${expectedVersion})`;
    super(`Concurrency conflict on key "${key}"${detail}`);
    this.name = 'ConcurrencyConflictError';
    this.storeKey = key;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

async function retryOnConflict<T>(
  fn: () => Promise<T>,
  maxRetries = CONCURRENCY_MAX_RETRIES
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ConcurrencyConflictError) || attempt === maxRetries) {
        throw err;
      }
      lastError = err;
      const retryAttempt = attempt + 1;
      const rawDelay = Math.min(
        CONCURRENCY_BACKOFF_MAX_MS,
        CONCURRENCY_BACKOFF_BASE_MS * 2 ** (retryAttempt - 1)
      );
      const delayMs = Math.random() * rawDelay;
      storeLog('retrying after concurrency conflict', {
        storeKey: err.storeKey,
        retryAttempt,
        maxRetries,
        expectedVersion: err.expectedVersion,
        actualVersion: err.actualVersion ?? null,
        delayMs,
      });
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export interface IdempotencyEntry {
  scope: string;
  key: string;
  status: number;
  responseBody: unknown;
  createdAt: string;
}

export interface GovernanceProposalRecord {
  id: string;
  title: string;
  description: string;
  proposalType: 'TEXT' | 'PARAMETER_CHANGE' | 'UPGRADE';
  parametersToChange?: Record<string, unknown>;
  status: 'PENDING' | 'ACTIVE' | 'PASSED' | 'REJECTED';
  createdAt: string;
  updatedAt: string;
  voteSummary: {
    support: number;
    oppose: number;
  };
}

export interface GovernanceVoteRecord {
  id: string;
  proposalId: string;
  voterId: string;
  support: boolean;
  reason?: string;
  createdAt: string;
}

export interface WeatherDataRecord {
  id: string;
  stationId: string;
  timestamp: string;
  temperature?: number;
  humidity?: number;
  pressure?: number;
  windSpeed?: number;
  windDirection?: number;
  precipitation?: number;
  visibility?: number;
  uvIndex?: number;
  airQuality?: number;
  submittedAt: string;
  persistence?: {
    submissionId: number | null;
    submittedAt: string;
  };
}

export interface BridgeTransactionRecord {
  transactionId: string;
  fromChain: string;
  toChain: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  token: string;
  routeId: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'COMPLETED' | 'HALTED';
  createdAt: string;
  updatedAt: string;
  challengeWindowEndsAt: string;
  verificationFailureCount: number;
}

export interface BridgeSafetyState {
  halted: boolean;
  haltedAt: string | null;
  haltReason: string | null;
  globalExposure: string;
  routeExposure: Record<string, string>;
  globalExposureCap: string;
  routeExposureCap: string;
  anomalyWindowStartedAt: string;
  anomalyFailuresInWindow: number;
  anomalyFailureThreshold: number;
  challengeWindowSeconds: number;
}

export interface BridgeValidatorQuorumSummary {
  requiredSignatures: number;
  collectedSignatures: number;
  registeredValidators: number;
  activeValidators: number;
  quorumReached: boolean;
  /** Percentage of required signatures collected (0-100+). */
  quorumPercentage: number;
  /** Percentage of active validators that signed (0-100). */
  participationRate: number;
}

export type BridgeMisbehaviorReasonCode =
  | 'DUPLICATE_ATTESTATION'
  | 'CONFLICTING_SIGNATURE'
  | 'CONFLICTING_PUBLIC_KEY';

export interface BridgeValidatorMisbehaviorEvidence {
  detected: boolean;
  reasonCodes: BridgeMisbehaviorReasonCode[];
  implicatedValidators: string[];
  evidenceFingerprint: string;
  duplicateEntries: number;
  conflictingEntries: number;
}

export interface EvidenceAvailability {
  merkleProof: boolean;
  signatures: boolean;
  oracleAttestation: boolean;
  relayerAttestation: boolean;
}

export interface BridgeValidatorAttestationEvidence {
  evidenceIds: string[];
  quorum: BridgeValidatorQuorumSummary;
  evidenceAvailable: EvidenceAvailability;
  misbehavior?: BridgeValidatorMisbehaviorEvidence;
}

export interface BridgeSlashingTriggerRecord {
  triggered: boolean;
  triggerId: string;
  governanceProposalId: string;
  dispatchPath: 'verify' | 'finalize';
  status: 'pending' | 'failed';
  payloadHash: string;
  dispatchedAt: string;
  implicatedValidators: string[];
  reasonCodes: BridgeMisbehaviorReasonCode[];
  failureReason?: string;
}

export interface BridgeVerificationResultRecord {
  verified: boolean;
  confidence: number;
  errors: string[];
  timestamp: string;
  validatorAttestation?: BridgeValidatorAttestationEvidence;
  slashingTrigger?: BridgeSlashingTriggerRecord;
}

export interface RouteDurableState {
  governance: {
    proposals: Record<string, GovernanceProposalRecord>;
    votes: Record<string, GovernanceVoteRecord>;
  };
  weather: {
    records: Record<string, WeatherDataRecord>;
  };
  bridges: {
    transactions: Record<string, BridgeTransactionRecord>;
    verificationResults: Record<string, BridgeVerificationResultRecord>;
    safety: BridgeSafetyState;
  };
  idempotency: {
    entries: Record<string, IdempotencyEntry>;
    order: string[];
  };
}

const DEFAULT_STATE: RouteDurableState = {
  governance: {
    proposals: {},
    votes: {},
  },
  weather: {
    records: {},
  },
  bridges: {
    transactions: {},
    verificationResults: {},
    safety: {
      halted: false,
      haltedAt: null,
      haltReason: null,
      globalExposure: '0',
      routeExposure: {},
      globalExposureCap:
        process.env.BRIDGE_GLOBAL_EXPOSURE_CAP || '1000000000000',
      routeExposureCap: process.env.BRIDGE_ROUTE_EXPOSURE_CAP || '250000000000',
      anomalyWindowStartedAt: new Date(0).toISOString(),
      anomalyFailuresInWindow: 0,
      anomalyFailureThreshold: Number.parseInt(
        process.env.BRIDGE_ANOMALY_FAILURE_THRESHOLD || '5',
        10
      ),
      challengeWindowSeconds: Number.parseInt(
        process.env.BRIDGE_CHALLENGE_WINDOW_SECONDS || '1800',
        10
      ),
    },
  },
  idempotency: {
    entries: {},
    order: [],
  },
};

function parseStore(input: unknown): RouteDurableState {
  if (!input || typeof input !== 'object') {
    return structuredClone(DEFAULT_STATE);
  }
  const candidate = input as Partial<RouteDurableState>;
  const defaults = structuredClone(DEFAULT_STATE);
  return {
    governance: {
      proposals:
        candidate.governance?.proposals || defaults.governance.proposals,
      votes: candidate.governance?.votes || defaults.governance.votes,
    },
    weather: {
      records: candidate.weather?.records || defaults.weather.records,
    },
    bridges: {
      transactions:
        candidate.bridges?.transactions || defaults.bridges.transactions,
      verificationResults:
        candidate.bridges?.verificationResults ||
        defaults.bridges.verificationResults,
      safety: {
        ...defaults.bridges.safety,
        ...(candidate.bridges?.safety || {}),
      },
    },
    idempotency: {
      entries: candidate.idempotency?.entries || defaults.idempotency.entries,
      order: candidate.idempotency?.order || defaults.idempotency.order,
    },
  };
}

function normalizeKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > 128) {
    return null;
  }
  if (!/^[a-zA-Z0-9:_-]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Normalized table row types (domain-specific tables alongside the JSON blob)
// ---------------------------------------------------------------------------

export interface BridgeStateRow {
  id: string;
  bridge_name: string;
  active_transfers: BridgeTransactionRecord[];
  validator_attestations: Record<string, BridgeVerificationResultRecord>;
  finality_cache: Record<string, string>;
  schema_version: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface GovernanceStateRow {
  id: string;
  proposal_id: string;
  vote_tallies: { support: number; oppose: number };
  treasury_balance: string;
  status: string;
  schema_version: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface WeatherStateRow {
  id: string;
  station_id: string;
  quality_score: number;
  payout_queue: unknown[];
  last_submission: string | null;
  schema_version: number;
  version: number;
  created_at: string;
  updated_at: string;
}

function storeLog(message: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const suffix = data ? ` ${JSON.stringify(data)}` : '';
  // Use console.log for migration progress; consumers can redirect via logger later
  console.log(`[route-durable-store ${ts}] ${message}${suffix}`);
}

export class RouteDurableStore {
  private readonly filePath: string;
  private backend: RouteStoreBackend;
  private readonly _maxIdempotencyEntries: number;

  private state: RouteDurableState | null = null;
  private dbVersion = 0;

  private queue: Promise<unknown> = Promise.resolve();

  private executeQuery: ExecuteQueryFn | null = null;
  private dbInitialized = false;
  private normalizedTablesReady = false;
  private migrationRan = false;

  private _consistencyState!: StoreConsistencyState;

  constructor(
    filePath = DEFAULT_STORE_PATH,
    backend = DEFAULT_BACKEND,
    maxIdempotencyEntries = MAX_IDEMPOTENCY_ENTRIES
  ) {
    this.filePath = safePath(filePath);
    this.backend = backend;
    this._maxIdempotencyEntries = maxIdempotencyEntries;
    this._consistencyState = {
      health: 'healthy',
      readMode: backend === 'file' ? 'legacy-only' : 'dual-read',
      backend,
      schemaVersion: null,
      migrationVersion: null,
      migrationComplete: false,
      lastIntegrityCheckAt: null,
      issues: [],
      degradedAt: null,
    };
  }

  public getMaxIdempotencyEntries(): number {
    return this._maxIdempotencyEntries;
  }

  // ── Consistency state helpers ──────────────────────────────────────────

  private _setDegraded(reason: string): void {
    if (this._consistencyState.health === 'failed') return;
    this._consistencyState.health = 'degraded';
    if (!this._consistencyState.degradedAt) {
      this._consistencyState.degradedAt = new Date().toISOString();
    }
    if (!this._consistencyState.issues.includes(reason)) {
      this._consistencyState.issues.push(reason);
    }
    storeLog('store degraded', { reason });
  }

  /**
   * Returns a defensive copy of the current consistency state.
   * Safe to call at any time; does not modify store state.
   */
  public getConsistencyState(): StoreConsistencyState {
    return { ...this._consistencyState };
  }

  /**
   * Run on service startup to validate DB connectivity, run migration, and
   * set a deterministic readMode. Safe to call repeatedly (idempotent).
   *
   * - file backend  → readMode='legacy-only', health='healthy'
   * - db backend, probe succeeds → readMode='normalized', migrationComplete=true
   * - db backend, probe fails    → readMode='legacy-only', health='degraded'
   */
  public async runStartupIntegrityCheck(): Promise<void> {
    if (this.backend === 'file') {
      this._consistencyState.readMode = 'legacy-only';
      this._consistencyState.health = 'healthy';
      this._consistencyState.lastIntegrityCheckAt = new Date().toISOString();
      storeLog('startup integrity check passed (file backend)', { readMode: 'legacy-only' });
      return;
    }
    try {
      const executeQuery = await this.loadExecuteQuery();
      await executeQuery('SELECT 1'); // connectivity probe
      await this.ensureDbInitialized();
      await this.ensureNormalizedTables();
      await this.migrateToNormalizedTables();
      this._consistencyState = {
        ...this._consistencyState,
        health: 'healthy',
        readMode: 'normalized',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        migrationVersion: CURRENT_MIGRATION_VERSION,
        migrationComplete: true,
        lastIntegrityCheckAt: new Date().toISOString(),
        issues: [],
        degradedAt: null,
      };
      storeLog('startup integrity check passed', { readMode: 'normalized' });
    } catch (err) {
      const reason = `Startup check: ${err instanceof Error ? err.message : String(err)}`;
      this._setDegraded(reason);
      this._consistencyState.readMode = 'legacy-only';
      this._consistencyState.lastIntegrityCheckAt = new Date().toISOString();
    }
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(
      () => fn(),
      () => fn()
    );
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async loadExecuteQuery(): Promise<ExecuteQueryFn> {
    if (this.executeQuery) {
      return this.executeQuery;
    }
    const dbModule = await import('../database/db.js');
    this.executeQuery = dbModule.executeQuery as ExecuteQueryFn;
    return this.executeQuery;
  }

  // ------------------------------------------------------------------
  // Schema initialization: original table + schema_version column
  // ------------------------------------------------------------------

  private async ensureDbInitialized(): Promise<void> {
    if (this.backend !== 'db' || this.dbInitialized) {
      return;
    }
    const executeQuery = await this.loadExecuteQuery();

    // Create the original blob table if missing
    await executeQuery(
      `
      CREATE TABLE IF NOT EXISTS route_durable_state (
        store_key TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      `
    );
    // Add schema_version column (safe to run repeatedly)
    await executeQuery(
      `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'route_durable_state' AND column_name = 'schema_version'
        ) THEN
          ALTER TABLE route_durable_state
            ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
        END IF;
      END
      $$;
      `
    );

    // Add version column for optimistic concurrency control
    await executeQuery(
      `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'route_durable_state' AND column_name = 'version'
        ) THEN
          ALTER TABLE route_durable_state
            ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        END IF;
      END
      $$;
      `
    );

    await executeQuery(
      `
      CREATE TABLE IF NOT EXISTS route_idempotency_entries (
        composite_key TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        status INTEGER NOT NULL,
        response_body JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      `
    );
    await executeQuery(
      `
      CREATE INDEX IF NOT EXISTS route_idempotency_entries_created_at_idx
      ON route_idempotency_entries (created_at DESC)
      `
    );
    this.dbInitialized = true;
  }

  // ------------------------------------------------------------------
  // Normalized domain tables
  // ------------------------------------------------------------------

  private async ensureNormalizedTables(): Promise<void> {
    if (this.backend !== 'db' || this.normalizedTablesReady) {
      return;
    }
    const executeQuery = await this.loadExecuteQuery();

    await executeQuery(`
      CREATE TABLE IF NOT EXISTS bridge_transactions (
        transaction_id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        from_chain TEXT NOT NULL,
        to_chain TEXT NOT NULL,
        from_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        amount TEXT NOT NULL,
        token TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        challenge_window_ends_at TIMESTAMPTZ,
        verification_failure_count INTEGER NOT NULL DEFAULT 0,
        verification_result JSONB,
        schema_version INTEGER NOT NULL DEFAULT ${CURRENT_SCHEMA_VERSION},
        version INTEGER NOT NULL DEFAULT 1
      )
    `);
    
    await executeQuery(`
      CREATE INDEX IF NOT EXISTS bridge_transactions_route_id_idx ON bridge_transactions (route_id);
    `);

    await executeQuery(`
      CREATE TABLE IF NOT EXISTS bridge_safety_state (
        id TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT ${CURRENT_SCHEMA_VERSION},
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await executeQuery(`
      CREATE TABLE IF NOT EXISTS governance_proposals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        proposal_type TEXT NOT NULL,
        parameters_to_change JSONB,
        status TEXT NOT NULL,
        vote_summary JSONB NOT NULL DEFAULT '{"support":0,"oppose":0}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT ${CURRENT_SCHEMA_VERSION},
        version INTEGER NOT NULL DEFAULT 1
      )
    `);

    await executeQuery(`
      CREATE TABLE IF NOT EXISTS governance_votes (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        voter_id TEXT NOT NULL,
        support BOOLEAN NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT ${CURRENT_SCHEMA_VERSION},
        version INTEGER NOT NULL DEFAULT 1
      )
    `);

    await executeQuery(`
      CREATE TABLE IF NOT EXISTS weather_records (
        id TEXT PRIMARY KEY,
        station_id TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        data JSONB NOT NULL,
        submitted_at TIMESTAMPTZ NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT ${CURRENT_SCHEMA_VERSION},
        version INTEGER NOT NULL DEFAULT 1
      )
    `);

    this.normalizedTablesReady = true;
  }

  // ------------------------------------------------------------------
  // Idempotent migration: JSON blob -> normalized tables
  // ------------------------------------------------------------------

  /**
   * Migrate existing JSON-blob data into domain-specific normalized tables.
   * Safe to call multiple times -- uses INSERT ... ON CONFLICT DO NOTHING so
   * rows that already exist are silently skipped.
   */
  async migrateToNormalizedTables(): Promise<void> {
    if (this.backend !== 'db') {
      storeLog('Skipping migration -- backend is not db');
      return;
    }

    await this.ensureDbInitialized();
    await this.ensureNormalizedTables();

    if (this.migrationRan) {
      return;
    }

    const executeQuery = await this.loadExecuteQuery();

    storeLog('Starting migration from JSON blobs to normalized tables');

    // Load current blob state
    const blobResult = await executeQuery(
      `SELECT state FROM route_durable_state WHERE store_key = $1`,
      [DB_STORE_KEY]
    );
    const blobRow = blobResult?.rows?.[0];
    if (!blobRow) {
      storeLog('No existing blob state found, nothing to migrate');
      this.migrationRan = true;
      return;
    }
    const blobState: RouteDurableState = parseStore(
      typeof blobRow.state === 'string' ? JSON.parse(blobRow.state) : blobRow.state
    );

    // --- Bridge state migration ---
    const bridgeTxs = Object.values(blobState.bridges.transactions);
    const verificationResults = blobState.bridges.verificationResults;
    
    if (bridgeTxs.length > 0) {
      storeLog('Migrating bridge state', {
        transactions: bridgeTxs.length,
      });

      for (const tx of bridgeTxs) {
        const vr = verificationResults[tx.transactionId];
        await executeQuery(
          `
          INSERT INTO bridge_transactions (
            transaction_id, route_id, from_chain, to_chain, from_address, to_address,
            amount, token, status, created_at, updated_at, challenge_window_ends_at,
            verification_failure_count, verification_result, schema_version, version
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, 1)
          ON CONFLICT (transaction_id) DO NOTHING
          `,
          [
            tx.transactionId,
            tx.routeId || 'default',
            tx.fromChain,
            tx.toChain,
            tx.fromAddress,
            tx.toAddress,
            tx.amount,
            tx.token,
            tx.status,
            tx.createdAt,
            tx.updatedAt,
            tx.challengeWindowEndsAt,
            tx.verificationFailureCount,
            vr ? JSON.stringify(vr) : null,
            CURRENT_SCHEMA_VERSION,
          ]
        );
      }
    }

    // --- Bridge safety migration ---
    const safety = blobState.bridges.safety;
    if (safety) {
      storeLog('Migrating bridge safety state');
      await executeQuery(
        `
        INSERT INTO bridge_safety_state (id, state, schema_version, version, created_at, updated_at)
        VALUES ($1, $2::jsonb, $3, 1, NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
        `,
        [
          'global_safety',
          JSON.stringify(safety),
          CURRENT_SCHEMA_VERSION,
        ]
      );
    }

    // --- Governance state migration ---
    const proposals = Object.values(blobState.governance.proposals);
    if (proposals.length > 0) {
      storeLog('Migrating governance state', { proposals: proposals.length });
      for (const proposal of proposals) {
        await executeQuery(
          `
          INSERT INTO governance_proposals (
            id, title, description, proposal_type, parameters_to_change, status,
            vote_summary, created_at, updated_at, schema_version, version
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, 1)
          ON CONFLICT (id) DO NOTHING
          `,
          [
            proposal.id,
            proposal.title,
            proposal.description,
            proposal.proposalType,
            proposal.parametersToChange ? JSON.stringify(proposal.parametersToChange) : null,
            proposal.status,
            JSON.stringify(proposal.voteSummary),
            proposal.createdAt,
            proposal.updatedAt,
            CURRENT_SCHEMA_VERSION,
          ]
        );
      }
    }
    
    // --- Governance votes migration ---
    const votes = Object.values(blobState.governance.votes);
    if (votes.length > 0) {
      storeLog('Migrating governance votes', { votes: votes.length });
      for (const vote of votes) {
        await executeQuery(
          `
          INSERT INTO governance_votes (
            id, proposal_id, voter_id, support, reason, created_at, schema_version, version
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
          ON CONFLICT (id) DO NOTHING
          `,
          [
            vote.id,
            vote.proposalId,
            vote.voterId,
            vote.support,
            vote.reason || null,
            vote.createdAt,
            CURRENT_SCHEMA_VERSION,
          ]
        );
      }
    }

    // --- Weather state migration ---
    const weatherRecords = Object.values(blobState.weather.records);
    if (weatherRecords.length > 0) {
      storeLog('Migrating weather state', { records: weatherRecords.length });
      for (const rec of weatherRecords) {
        const data = { ...rec };
        // @ts-ignore
        delete data.id;
        // @ts-ignore
        delete data.stationId;
        // @ts-ignore
        delete data.timestamp;
        // @ts-ignore
        delete data.submittedAt;

        await executeQuery(
          `
          INSERT INTO weather_records (
            id, station_id, timestamp, data, submitted_at, schema_version, version
          )
          VALUES ($1, $2, $3, $4::jsonb, $5, $6, 1)
          ON CONFLICT (id) DO NOTHING
          `,
          [
            rec.id,
            rec.stationId,
            rec.timestamp,
            JSON.stringify(data),
            rec.submittedAt || rec.timestamp,
            CURRENT_SCHEMA_VERSION,
          ]
        );
      }
    }

    // Update schema_version on the blob row to indicate migration ran
    await executeQuery(
      `UPDATE route_durable_state SET schema_version = $1 WHERE store_key = $2`,
      [CURRENT_SCHEMA_VERSION, DB_STORE_KEY]
    );

    storeLog('Migration to normalized tables complete');
    this.migrationRan = true;
  }

  // ------------------------------------------------------------------
  // Dual-read helpers: normalized table first, JSON blob fallback
  // ------------------------------------------------------------------

  /**
   * Read bridge state rows from the normalized table.
   * Falls back to building the result from the JSON blob when the
   * normalized table is empty or unavailable.
   */
  async readBridgeStates(): Promise<BridgeStateRow[]> {
    if (this.backend === 'db') {
      try {
        await this.ensureDbInitialized();
        await this.ensureNormalizedTables();
        const executeQuery = await this.loadExecuteQuery();
        const result = await executeQuery(`SELECT * FROM bridge_state ORDER BY updated_at DESC LIMIT 500`);
        if (result?.rows?.length) {
          return result.rows.map((row: any) => ({
            id: row.id,
            bridge_name: row.bridge_name,
            active_transfers: typeof row.active_transfers === 'string' ? JSON.parse(row.active_transfers) : row.active_transfers,
            validator_attestations: typeof row.validator_attestations === 'string' ? JSON.parse(row.validator_attestations) : row.validator_attestations,
            finality_cache: typeof row.finality_cache === 'string' ? JSON.parse(row.finality_cache) : row.finality_cache,
            schema_version: row.schema_version,
            created_at: row.created_at,
            updated_at: row.updated_at,
          }));
        }
      } catch (err) {
        this._setDegraded(
          `bridge_state read failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Fallback: synthesize from JSON blob
    return this.read(state => {
      const txs = Object.values(state.bridges.transactions);
      const verifications = state.bridges.verificationResults;
      const routeMap = new Map<string, BridgeTransactionRecord[]>();
      for (const tx of txs) {
        const key = tx.routeId || 'default';
        if (!routeMap.has(key)) {
          routeMap.set(key, []);
        }
        routeMap.get(key)!.push(tx);
      }
      const rows: BridgeStateRow[] = [];
      for (const [bridgeName, transfers] of routeMap) {
        const routeVerifications: Record<string, BridgeVerificationResultRecord> = {};
        for (const tx of transfers) {
          const vr = verifications[tx.transactionId];
          if (vr) {
            routeVerifications[tx.transactionId] = vr;
          }
        }
        rows.push({
          id: `bridge_${bridgeName}`,
          bridge_name: bridgeName,
          active_transfers: transfers,
          validator_attestations: routeVerifications,
          finality_cache: {},
          schema_version: CURRENT_SCHEMA_VERSION,
          version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      return rows;
    });
  }

  /**
   * Read governance state rows from the normalized table.
   * Falls back to building the result from the JSON blob when the
   * normalized table is empty or unavailable.
   */
  async readGovernanceStates(): Promise<GovernanceStateRow[]> {
    if (this.backend === 'db') {
      try {
        await this.ensureDbInitialized();
        await this.ensureNormalizedTables();
        const executeQuery = await this.loadExecuteQuery();
        const result = await executeQuery(`SELECT * FROM governance_state ORDER BY updated_at DESC LIMIT 500`);
        if (result?.rows?.length) {
          return result.rows.map((row: any) => ({
            id: row.id,
            proposal_id: row.proposal_id,
            vote_tallies: typeof row.vote_tallies === 'string' ? JSON.parse(row.vote_tallies) : row.vote_tallies,
            treasury_balance: row.treasury_balance,
            status: row.status,
            schema_version: row.schema_version,
            created_at: row.created_at,
            updated_at: row.updated_at,
          }));
        }
      } catch (err) {
        this._setDegraded(
          `governance_state read failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Fallback: synthesize from JSON blob
    return this.read(state => {
      return Object.values(state.governance.proposals).map(proposal => ({
        id: `gov_${proposal.id}`,
        proposal_id: proposal.id,
        vote_tallies: proposal.voteSummary,
        treasury_balance: '0',
        status: proposal.status,
        schema_version: CURRENT_SCHEMA_VERSION,
        version: 1,
        created_at: proposal.createdAt,
        updated_at: proposal.updatedAt,
      }));
    });
  }

  /**
   * Read weather state rows from the normalized table.
   * Falls back to building the result from the JSON blob when the
   * normalized table is empty or unavailable.
   */
  async readWeatherStates(): Promise<WeatherStateRow[]> {
    if (this.backend === 'db') {
      try {
        await this.ensureDbInitialized();
        await this.ensureNormalizedTables();
        const executeQuery = await this.loadExecuteQuery();
        const result = await executeQuery(`SELECT * FROM weather_state ORDER BY updated_at DESC LIMIT 500`);
        if (result?.rows?.length) {
          return result.rows.map((row: any) => ({
            id: row.id,
            station_id: row.station_id,
            quality_score: Number(row.quality_score),
            payout_queue: typeof row.payout_queue === 'string' ? JSON.parse(row.payout_queue) : row.payout_queue,
            last_submission: row.last_submission,
            schema_version: row.schema_version,
            created_at: row.created_at,
            updated_at: row.updated_at,
          }));
        }
      } catch (err) {
        this._setDegraded(
          `weather_state read failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Fallback: synthesize from JSON blob
    return this.read(state => {
      const records = Object.values(state.weather.records);
      const stationAgg = new Map<string, { latestTimestamp: string; count: number }>();
      for (const rec of records) {
        const existing = stationAgg.get(rec.stationId);
        if (!existing) {
          stationAgg.set(rec.stationId, { latestTimestamp: rec.submittedAt || rec.timestamp, count: 1 });
        } else {
          existing.count += 1;
          if ((rec.submittedAt || rec.timestamp) > existing.latestTimestamp) {
            existing.latestTimestamp = rec.submittedAt || rec.timestamp;
          }
        }
      }
      const rows: WeatherStateRow[] = [];
      for (const [stationId, agg] of stationAgg) {
        rows.push({
          id: `weather_${stationId}`,
          station_id: stationId,
          quality_score: 0,
          payout_queue: [],
          last_submission: agg.latestTimestamp,
          schema_version: CURRENT_SCHEMA_VERSION,
          version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      return rows;
    });
  }

  // ------------------------------------------------------------------
  // Original blob persistence (unchanged logic, preserved interface)
  // ------------------------------------------------------------------

  private async loadStateFromDb(): Promise<RouteDurableState> {
    await this.ensureDbInitialized();
    const executeQuery = await this.loadExecuteQuery();
    const queryResult = await executeQuery(
      `SELECT state, version FROM route_durable_state WHERE store_key = $1`,
      [DB_STORE_KEY]
    );
    const row = queryResult?.rows?.[0];
    if (!row) {
      const seed = structuredClone(DEFAULT_STATE);
      await executeQuery(
        `
        INSERT INTO route_durable_state (store_key, state, updated_at, schema_version, version)
        VALUES ($1, $2::jsonb, NOW(), $3, 1)
        ON CONFLICT (store_key) DO NOTHING
        `,
        [DB_STORE_KEY, JSON.stringify(seed), CURRENT_SCHEMA_VERSION]
      );
      this.dbVersion = 1;
      return seed;
    }
    this.dbVersion = typeof row.version === 'number' ? row.version : 1;
    if (typeof row.state === 'string') {
      return parseStore(JSON.parse(row.state));
    }
    return parseStore(row.state);
  }

  private async persistStateToDb(state: RouteDurableState): Promise<void> {
    await this.ensureDbInitialized();
    const executeQuery = await this.loadExecuteQuery();
    const expectedVersion = this.dbVersion;
    const result = await executeQuery(
      `
      UPDATE route_durable_state
      SET state = $2::jsonb,
          version = version + 1,
          updated_at = NOW(),
          schema_version = $3
      WHERE store_key = $1 AND version = $4
      RETURNING version
      `,
      [DB_STORE_KEY, JSON.stringify(state), CURRENT_SCHEMA_VERSION, expectedVersion]
    );

    if (!result?.rows?.length) {
      // Version mismatch -- another instance updated the row
      // Try to read the current version for a better error message
      const current = await executeQuery(
        `SELECT version FROM route_durable_state WHERE store_key = $1`,
        [DB_STORE_KEY]
      );
      const actualVersion = current?.rows?.[0]?.version;
      throw new ConcurrencyConflictError(DB_STORE_KEY, expectedVersion, actualVersion);
    }

    this.dbVersion = result.rows[0].version;
  }

  private async persistStateToFile(state: RouteDurableState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmpPath, this.filePath);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.backend === 'db') {
      this.state = await this.loadStateFromDb();
      return;
    }
    if (this.state) {
      return;
    }
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.state = parseStore(JSON.parse(raw));
    } catch (error) {
      this.state = structuredClone(DEFAULT_STATE);
      await this.persistStateToFile(this.state);
    }
  }

  private async persist(): Promise<void> {
    if (!this.state) {
      return;
    }
    if (this.backend === 'db') {
      await this.persistStateToDb(this.state);
      return;
    }
    await this.persistStateToFile(this.state);
  }

  async read<T>(
    reader: (state: RouteDurableState) => T | Promise<T>
  ): Promise<T> {
    return this.runExclusive(async () => {
      await this.ensureLoaded();
      return reader(structuredClone(this.state as RouteDurableState));
    });
  }

  async write<T>(
    writer: (state: RouteDurableState) => T | Promise<T>
  ): Promise<T> {
    if (this.backend === 'db') {
      return this.runExclusive(() =>
        retryOnConflict(async () => {
          await this.ensureLoaded();
          const result = await writer(this.state as RouteDurableState);
          await this.persist();
          return result;
        })
      );
    }
    return this.runExclusive(async () => {
      await this.ensureLoaded();
      const result = await writer(this.state as RouteDurableState);
      await this.persist();
      return result;
    });
  }

  async updateBridgeSafety(
    updater: (safety: BridgeSafetyState) => BridgeSafetyState
  ): Promise<BridgeSafetyState> {
    if (this.backend === 'db') {
      return this.runExclusive(() =>
        retryOnConflict(async () => {
          await this.ensureDbInitialized();
          await this.ensureNormalizedTables();
          const executeQuery = await this.loadExecuteQuery();

          const res = await executeQuery(
            `SELECT state, version FROM bridge_safety_state WHERE id = 'global_safety'`
          );
          let current: BridgeSafetyState;
          let version = 0;

          if (res?.rows?.[0]) {
            current = typeof res.rows[0].state === 'string' ? JSON.parse(res.rows[0].state) : res.rows[0].state;
            version = res.rows[0].version;
          } else {
             current = structuredClone(DEFAULT_STATE.bridges.safety);
          }

          const updated = updater(structuredClone(current));

          if (version === 0) {
             await executeQuery(
               `INSERT INTO bridge_safety_state (id, state, schema_version, version, created_at, updated_at)
                VALUES ('global_safety', $1::jsonb, $2, 1, NOW(), NOW())`,
               [JSON.stringify(updated), CURRENT_SCHEMA_VERSION]
             );
          } else {
             const updateRes = await executeQuery(
               `UPDATE bridge_safety_state
                SET state = $1::jsonb, version = version + 1, updated_at = NOW()
                WHERE id = 'global_safety' AND version = $2
                RETURNING version`,
               [JSON.stringify(updated), version]
             );
             if (!updateRes?.rows?.length) {
               throw new ConcurrencyConflictError('bridge_safety_state:global_safety', version);
             }
          }
          return updated;
        })
      );
    }
    
    // File/Blob fallback
    await this.write(state => {
      state.bridges.safety = updater(state.bridges.safety);
    });
    return this.read(s => s.bridges.safety);
  }

  async getBridgeSafety(): Promise<BridgeSafetyState> {
    if (this.backend === 'db') {
      try {
        await this.ensureDbInitialized();
        await this.ensureNormalizedTables();
        const executeQuery = await this.loadExecuteQuery();
        const res = await executeQuery(
          `SELECT state FROM bridge_safety_state WHERE id = 'global_safety'`
        );
        if (res?.rows?.[0]) {
           return typeof res.rows[0].state === 'string' ? JSON.parse(res.rows[0].state) : res.rows[0].state;
        }
        // If not found, return defaults (safe fallback)
        return structuredClone(DEFAULT_STATE.bridges.safety);
      } catch (err) {
        console.error('Error reading bridge safety from DB', err);
        // Fallback?
      }
    }
    return this.read(state => state.bridges.safety);
  }

  async getBridgeTransaction(txId: string): Promise<BridgeTransactionRecord | null> {
    if (this.backend === 'db') {
      try {
        await this.ensureDbInitialized();
        await this.ensureNormalizedTables();
        const executeQuery = await this.loadExecuteQuery();
        const res = await executeQuery(
          `SELECT * FROM bridge_transactions WHERE transaction_id = $1`,
          [txId]
        );
        if (res?.rows?.[0]) {
          const row = res.rows[0];
          return {
            transactionId: row.transaction_id,
            fromChain: row.from_chain,
            toChain: row.to_chain,
            fromAddress: row.from_address,
            toAddress: row.to_address,
            amount: row.amount,
            token: row.token,
            routeId: row.route_id,
            status: row.status as any,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            challengeWindowEndsAt: row.challenge_window_ends_at,
            verificationFailureCount: row.verification_failure_count,
          };
        }
        return null;
      } catch (err) {
        console.error('Error reading bridge transaction from DB', err);
        // Fallback to blob if needed, or just return null?
        // Given we want to migrate away, let's stick to DB or File.
      }
    }
    return this.read(state => state.bridges.transactions[txId] || null);
  }

  async getBridgeVerificationResult(
    txId: string
  ): Promise<BridgeVerificationResultRecord | null> {
    if (this.backend === 'db') {
      try {
        await this.ensureDbInitialized();
        await this.ensureNormalizedTables();
        const executeQuery = await this.loadExecuteQuery();
        const res = await executeQuery(
          `SELECT verification_result FROM bridge_transactions WHERE transaction_id = $1`,
          [txId]
        );
        if (res?.rows?.[0]?.verification_result) {
          const vr = res.rows[0].verification_result;
          return typeof vr === 'string' ? JSON.parse(vr) : vr;
        }
        return null;
      } catch (err) {
        console.error('Error reading bridge verification result from DB', err);
      }
    }
    return this.read(state => state.bridges.verificationResults[txId] || null);
  }

  async getAllBridgeTransactions(): Promise<BridgeTransactionRecord[]> {
    if (this.backend === 'db') {
      try {
        await this.ensureDbInitialized();
        await this.ensureNormalizedTables();
        const executeQuery = await this.loadExecuteQuery();
        const res = await executeQuery(
          `SELECT transaction_id, from_chain, to_chain, from_address, to_address, amount, token, route_id, status, created_at, updated_at, challenge_window_ends_at FROM bridge_transactions ORDER BY created_at DESC LIMIT 200`
        );
        if (res?.rows) {
          return res.rows.map((row: any) => ({
            transactionId: row.transaction_id,
            fromChain: row.from_chain,
            toChain: row.to_chain,
            fromAddress: row.from_address,
            toAddress: row.to_address,
            amount: row.amount,
            token: row.token,
            routeId: row.route_id,
            status: row.status as any,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            challengeWindowEndsAt: row.challenge_window_ends_at,
            verificationFailureCount: row.verification_failure_count,
          }));
        }
        return [];
      } catch (err) {
        console.error('Error reading all bridge transactions from DB', err);
        return [];
      }
    }
    return this.read(state => Object.values(state.bridges.transactions));
  }

  async putBridgeTransaction(
    tx: BridgeTransactionRecord,
    verificationResult?: BridgeVerificationResultRecord
  ): Promise<void> {
    if (this.backend === 'db') {
      return this.runExclusive(() =>
        retryOnConflict(async () => {
          await this.ensureDbInitialized();
          await this.ensureNormalizedTables();
          const executeQuery = await this.loadExecuteQuery();

          // Check if exists for version
          const res = await executeQuery(
            `SELECT version FROM bridge_transactions WHERE transaction_id = $1`,
            [tx.transactionId]
          );
          
          let version = 0;
          if (res?.rows?.[0]) {
            version = res.rows[0].version;
          }

          if (version === 0) {
             await executeQuery(
               `INSERT INTO bridge_transactions (
                  transaction_id, route_id, from_chain, to_chain, from_address, to_address,
                  amount, token, status, created_at, updated_at, challenge_window_ends_at,
                  verification_failure_count, verification_result, schema_version, version
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, 1)`,
               [
                 tx.transactionId,
                 tx.routeId || 'default',
                 tx.fromChain,
                 tx.toChain,
                 tx.fromAddress,
                 tx.toAddress,
                 tx.amount,
                 tx.token,
                 tx.status,
                 tx.createdAt,
                 tx.updatedAt,
                 tx.challengeWindowEndsAt,
                 tx.verificationFailureCount,
                 verificationResult ? JSON.stringify(verificationResult) : null,
                 CURRENT_SCHEMA_VERSION
               ]
             );
          } else {
             // If verificationResult is NOT provided, we should probably preserve existing?
             // Or assumes caller provides it if they want to update it. 
             // In current usage, verify() provides it. transfer() does not.
             // If not provided, we should fetch existing? 
             // Ideally we only update columns that changed. But that's hard with this API.
             // Let's assume if not provided, we explicitly set null? No, that would wipe it.
             // We should only update verification_result if provided.
             
             const updateCols = [
               `status = $2`,
               `updated_at = NOW()`,
               `challenge_window_ends_at = $3`,
               `verification_failure_count = $4`,
               `version = version + 1`
             ];
             const params = [
               tx.transactionId,
               tx.status,
               tx.challengeWindowEndsAt,
               tx.verificationFailureCount,
               version
             ];
             
             let paramIdx = 6;
             if (verificationResult) {
               updateCols.push(`verification_result = $${paramIdx}::jsonb`);
               params.splice(paramIdx - 1, 0, JSON.stringify(verificationResult));
               paramIdx++;
             }

             // We also update fields that might change? Usually only status/counts change after creation.
             
             const updateRes = await executeQuery(
               `UPDATE bridge_transactions
                SET ${updateCols.join(', ')}
                WHERE transaction_id = $1 AND version = $5
                RETURNING version`,
               params
             );
             
             if (!updateRes?.rows?.length) {
               throw new ConcurrencyConflictError(`bridge_transactions:${tx.transactionId}`, version);
             }
          }
        })
      );
    }

    // File/Blob fallback
    await this.write(state => {
      state.bridges.transactions[tx.transactionId] = tx;
      if (verificationResult) {
        state.bridges.verificationResults[tx.transactionId] = verificationResult;
      }
    });
  }

  async getIdempotency(
    scope: string,
    key: string,
    options?: { forUpdate?: boolean }
  ): Promise<IdempotencyEntry | null> {
    const normalized = normalizeKey(key);
    if (!normalized) {
      return null;
    }
    const composite = `${scope}:${normalized}`;
    if (this.backend === 'db') {
      await this.ensureDbInitialized();
      const executeQuery = await this.loadExecuteQuery();
      const lockClause = options?.forUpdate ? 'FOR UPDATE' : '';
      const queryResult = await executeQuery(
        `
        SELECT scope, key, status, response_body, created_at
        FROM route_idempotency_entries
        WHERE composite_key = $1
        LIMIT 1 ${lockClause}
        `,
        [composite]
      );
      const row = queryResult?.rows?.[0];
      if (!row) {
        return null;
      }
      return {
        scope: row.scope,
        key: row.key,
        status: Number(row.status),
        responseBody: row.response_body,
        createdAt: new Date(row.created_at).toISOString(),
      };
    }
    return this.read(state => state.idempotency.entries[composite] || null);
  }

  async putIdempotency(
    scope: string,
    key: string,
    status: number,
    responseBody: unknown
  ): Promise<void> {
    const normalized = normalizeKey(key);
    if (!normalized) {
      return;
    }
    const composite = `${scope}:${normalized}`;
    if (this.backend === 'db') {
      await this.ensureDbInitialized();
      const executeQuery = await this.loadExecuteQuery();
      await executeQuery(
        `
        INSERT INTO route_idempotency_entries
          (composite_key, scope, key, status, response_body, created_at)
        VALUES
          ($1, $2, $3, $4, $5::jsonb, NOW())
        ON CONFLICT (composite_key) DO NOTHING
        `,
        [composite, scope, normalized, status, JSON.stringify(responseBody)]
      );
      await executeQuery(
        `
        DELETE FROM route_idempotency_entries
        WHERE composite_key IN (
          SELECT composite_key
          FROM route_idempotency_entries
          ORDER BY created_at DESC
          OFFSET $1
        )
        `,
        [this._maxIdempotencyEntries]
      );
      return;
    }
    await this.write(state => {
      state.idempotency.entries[composite] = {
        scope,
        key: normalized,
        status,
        responseBody,
        createdAt: new Date().toISOString(),
      };
      state.idempotency.order.push(composite);

      while (state.idempotency.order.length > this._maxIdempotencyEntries) {
        const evicted = state.idempotency.order.shift();
        if (evicted) {
          delete state.idempotency.entries[evicted];
        }
      }
    });
  }
}

export const routeDurableStore = new RouteDurableStore();

export function getRouteDurableStoreBackend(): 'file' | 'db' {
  return DEFAULT_BACKEND;
}

export function resolveIdempotencyKey(candidate: unknown): string | null {
  if (typeof candidate !== 'string') {
    return null;
  }
  return normalizeKey(candidate);
}

export function newDurableId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
