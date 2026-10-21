import { normalizeOwnerAddress } from './owner-address.js';
import { createHash, randomUUID } from 'node:crypto';

export const ORACLE_WORK_AUDIENCE = 'wrfcoin.oracle-work' as const;
export const ORACLE_WORK_SCOPES = {
  read: 'wrfcoin.oracle-work.read',
  claim: 'wrfcoin.oracle-work.claim',
  result: 'wrfcoin.oracle-work.result',
} as const;

export const ORACLE_IDS = ['workstation', 'n5pro'] as const;
export type OracleId = (typeof ORACLE_IDS)[number];
export type OracleWorkScope = (typeof ORACLE_WORK_SCOPES)[keyof typeof ORACLE_WORK_SCOPES];

export interface VerifiedOraclePrincipal {
  readonly verified: true;
  readonly oracleId: OracleId;
  readonly audience: typeof ORACLE_WORK_AUDIENCE;
  readonly scopes: readonly string[];
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface OracleWorkInput {
  workId: string;
  cycleId: string;
  stationId: string;
  observationId: string;
  observationDigest?: string;
  canonicalReading: JsonObject;
  ownerAddress: string;
  chainId: string;
  networkId: string;
  genesisHash: string;
  commitId: string;
  commitHash: string;
  nonce: string;
  commitTimestamp: number;
  revealDeadline: number;
  requiredQuorum: number;
  evidenceTimestamp: string;
}

export interface OracleWorkRecord extends Omit<OracleWorkInput, 'observationDigest'> {
  schemaVersion: 1;
  observationDigest: string;
  lifecycleState: OracleWorkLifecycle;
}

export type OracleWorkLifecycle =
  | 'ATTESTATIONS_PENDING'
  | 'QUORUM_MINED'
  | 'REVEAL_CLAIMED'
  | 'REVEAL_SUBMITTED'
  | 'REWARD_ENTRY_OBSERVED'
  | 'FINALITY_RECONCILED'
  | 'ACCOUNT_RECONCILED'
  | 'MISSED_QUORUM';

export type OracleWorkClaimState =
  | 'DISPATCHABLE'
  | 'CLAIMED'
  | 'VALIDATED'
  | 'SIGNED'
  | 'SUBMITTED'
  | 'MINED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'FAILED';

export interface OracleWorkClaimResult {
  workId: string;
  genesisHash: string;
  oracleId: OracleId;
  attestationVersion: number;
  state: OracleWorkClaimState;
  leaseVersion: number;
  leaseExpiresAt: string | null;
  approved: boolean | null;
  confidence: number | null;
  signature: string | null;
  attestationTimestamp: number | null;
  resultCode: string | null;
  core4TxId: string | null;
  core4MinedAt: string | null;
  idempotencyKey: string | null;
  resultDigest: string | null;
}

export interface OracleWorkView {
  work: OracleWorkRecord;
  ownClaim: OracleWorkClaimResult | null;
}

export interface OracleWorkQueryExecutor {
  execute: (
    sql: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  transaction?: <T>(
    callback: (transaction: OracleWorkQueryExecutor) => Promise<T>,
  ) => Promise<T>;
}

export interface OracleResultInput {
  workId: string;
  attestationVersion: number;
  leaseVersion: number;
  leaseToken: string;
  idempotencyKey: string;
  approved: boolean;
  confidence?: number | null;
  signature?: string | null;
  attestationTimestamp?: number | null;
  resultCode?: string | null;
}

export interface VerifiedMinedApproval {
  readonly verified: true;
  readonly workId: string;
  readonly genesisHash: string;
  readonly oracleId: OracleId;
  readonly attestationVersion: number;
  readonly commitId: string;
  readonly commitHash: string;
  readonly core4TxId: string;
  readonly minedAt: string;
  readonly receipt: VerifiedCore4Receipt;
}

export interface VerifiedCore4Receipt {
  readonly verified: true;
  readonly status: 'MINED';
  readonly genesisHash: string;
  readonly commitId: string;
  readonly commitHash: string;
  readonly core4TxId: string;
  readonly minedAt: string;
}

export interface RevealEligibility {
  eligible: boolean;
  reason:
    | 'ELIGIBLE'
    | 'WAITING_FOR_MINED_QUORUM'
    | 'MISSED_QUORUM'
    | 'CURRENT_GENESIS_MISMATCH';
  minedApprovals: number;
  requiredQuorum: number;
}

export class OracleWorkBrokerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'OracleWorkBrokerError';
  }
}

const FORBIDDEN_FIELD = /(?:token|secret|private[_-]?key|password|credential|jwt|bearer|topology|operator[_-]?error)/i;

function requiredString(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new OracleWorkBrokerError('INVALID_WORK', `${field} is required`, 400);
  }
  return value.trim();
}

function validateId(value: string, field: string): string {
  const normalized = requiredString(value, field, 200);
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new OracleWorkBrokerError('INVALID_WORK', `${field} has invalid characters`, 400);
  }
  return normalized;
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new OracleWorkBrokerError('INVALID_WORK', 'canonical reading contains a non-finite number', 400);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function containsForbiddenField(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenField);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, child]) => FORBIDDEN_FIELD.test(key) || containsForbiddenField(child));
  }
  return false;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function leaseHash(value: string): string {
  return digest(value);
}

function dateValue(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function nowSeconds(now: Date): number {
  return now.getTime() / 1000;
}

export function assertVerifiedOraclePrincipal(
  principal: unknown,
  requiredScope: OracleWorkScope,
): VerifiedOraclePrincipal {
  const candidate = principal as Partial<VerifiedOraclePrincipal> | null | undefined;
  if (
    !candidate ||
    candidate.verified !== true ||
    !ORACLE_IDS.includes(candidate.oracleId as OracleId) ||
    candidate.audience !== ORACLE_WORK_AUDIENCE ||
    !Array.isArray(candidate.scopes) ||
    !candidate.scopes.includes(requiredScope)
  ) {
    throw new OracleWorkBrokerError('ORACLE_PRINCIPAL_REQUIRED', 'verified oracle principal and scope are required', 401);
  }
  return candidate as VerifiedOraclePrincipal;
}

export function assertOraclePrincipalOwnsOracle(
  principal: VerifiedOraclePrincipal,
  oracleId: OracleId,
): void {
  if (principal.oracleId !== oracleId) {
    throw new OracleWorkBrokerError('ORACLE_SCOPE_FORBIDDEN', 'oracle result belongs to another principal', 403);
  }
}

export function buildOracleWork(input: OracleWorkInput): OracleWorkRecord {
  const workId = validateId(input.workId, 'workId');
  const cycleId = validateId(input.cycleId, 'cycleId');
  const stationId = requiredString(input.stationId, 'stationId');
  const observationId = requiredString(input.observationId, 'observationId');
  // backend#1210: new work carries the canonical lowercase owner. Stored work
  // items are immutable (0018 trigger) and are read back verbatim.
  const ownerAddress = normalizeOwnerAddress(requiredString(input.ownerAddress, 'ownerAddress'));
  const chainId = requiredString(input.chainId, 'chainId');
  const networkId = requiredString(input.networkId, 'networkId');
  const genesisHash = requiredString(input.genesisHash, 'genesisHash');
  const commitId = requiredString(input.commitId, 'commitId');
  const commitHash = requiredString(input.commitHash, 'commitHash');
  const nonce = requiredString(input.nonce, 'nonce');
  const evidenceTimestamp = requiredString(input.evidenceTimestamp, 'evidenceTimestamp');
  if (Number.isNaN(new Date(evidenceTimestamp).getTime())) {
    throw new OracleWorkBrokerError('INVALID_WORK', 'evidenceTimestamp must be an ISO timestamp', 400);
  }
  if (!input.canonicalReading || typeof input.canonicalReading !== 'object' || Array.isArray(input.canonicalReading)) {
    throw new OracleWorkBrokerError('INVALID_WORK', 'canonicalReading must be an object', 400);
  }
  if (containsForbiddenField(input.canonicalReading)) {
    throw new OracleWorkBrokerError('SECRET_FIELD', 'canonical work contains a forbidden secret field', 400);
  }
  const canonicalReading = JSON.parse(stableJson(input.canonicalReading)) as JsonObject;
  const observationDigest = digest(stableJson(canonicalReading));
  if (input.observationDigest && input.observationDigest.toLowerCase() !== observationDigest) {
    throw new OracleWorkBrokerError('INVALID_WORK', 'observationDigest does not match canonicalReading', 400);
  }
  if (!Number.isSafeInteger(input.commitTimestamp) || input.commitTimestamp <= 0) {
    throw new OracleWorkBrokerError('INVALID_WORK', 'commitTimestamp must be a positive integer', 400);
  }
  if (!Number.isSafeInteger(input.revealDeadline) || input.revealDeadline < input.commitTimestamp) {
    throw new OracleWorkBrokerError('INVALID_WORK', 'revealDeadline must not precede commitTimestamp', 400);
  }
  if (input.requiredQuorum !== 2) {
    throw new OracleWorkBrokerError('INVALID_WORK', 'initial oracle work requires a 2-of-2 quorum', 400);
  }
  return {
    schemaVersion: 1,
    workId,
    cycleId,
    stationId,
    observationId,
    observationDigest,
    canonicalReading,
    ownerAddress,
    chainId,
    networkId,
    genesisHash,
    commitId,
    commitHash,
    nonce,
    commitTimestamp: input.commitTimestamp,
    revealDeadline: input.revealDeadline,
    requiredQuorum: input.requiredQuorum,
    evidenceTimestamp,
    lifecycleState: 'ATTESTATIONS_PENDING',
  };
}

function resultFingerprint(input: Pick<OracleResultInput, 'approved' | 'confidence' | 'signature' | 'attestationTimestamp' | 'resultCode'>): string {
  return digest(stableJson({
    approved: input.approved,
    confidence: input.confidence ?? null,
    signature: input.signature ?? null,
    attestationTimestamp: input.attestationTimestamp ?? null,
    resultCode: input.resultCode ?? null,
  }));
}

export function isIdempotentResult(
  existing: Pick<OracleWorkClaimResult, 'idempotencyKey' | 'resultDigest'>,
  input: OracleResultInput,
): boolean {
  return existing.idempotencyKey === input.idempotencyKey && existing.resultDigest === resultFingerprint(input);
}

export function canClaimLease(
  state: Pick<OracleWorkClaimResult, 'state' | 'leaseExpiresAt'>,
  now: Date,
): boolean {
  if (state.state === 'DISPATCHABLE') return true;
  if (!['CLAIMED', 'EXPIRED', 'FAILED'].includes(state.state)) return false;
  const expiry = dateValue(state.leaseExpiresAt);
  return expiry === null || expiry.getTime() <= now.getTime();
}

export function evaluateRevealEligibility(
  work: Pick<OracleWorkRecord, 'workId' | 'genesisHash' | 'requiredQuorum' | 'revealDeadline'>,
  results: Array<Pick<OracleWorkClaimResult, 'workId' | 'genesisHash' | 'oracleId' | 'state' | 'approved'>>,
  now: Date,
  currentGenesisHash = work.genesisHash,
): RevealEligibility {
  if (currentGenesisHash !== work.genesisHash) {
    return { eligible: false, reason: 'CURRENT_GENESIS_MISMATCH', minedApprovals: 0, requiredQuorum: work.requiredQuorum };
  }
  const minedOracleIds = new Set(
    results
      .filter(result => result.workId === work.workId && result.genesisHash === work.genesisHash && result.state === 'MINED' && result.approved === true)
      .map(result => result.oracleId),
  );
  const minedApprovals = minedOracleIds.size;
  if (minedApprovals >= work.requiredQuorum && nowSeconds(now) <= work.revealDeadline) {
    return { eligible: true, reason: 'ELIGIBLE', minedApprovals, requiredQuorum: work.requiredQuorum };
  }
  if (nowSeconds(now) > work.revealDeadline) {
    return { eligible: false, reason: 'MISSED_QUORUM', minedApprovals, requiredQuorum: work.requiredQuorum };
  }
  return { eligible: false, reason: 'WAITING_FOR_MINED_QUORUM', minedApprovals, requiredQuorum: work.requiredQuorum };
}

function rowToWork(row: Record<string, unknown>): OracleWorkRecord {
  const canonicalReading = typeof row.canonical_reading === 'string'
    ? JSON.parse(row.canonical_reading)
    : row.canonical_reading;
  if (Number(row.schema_version) !== 1) {
    throw new OracleWorkBrokerError('UNSUPPORTED_WORK_SCHEMA', 'oracle work schema version is unsupported', 409);
  }
  return {
    schemaVersion: 1,
    workId: String(row.work_id),
    cycleId: String(row.cycle_id),
    stationId: String(row.station_id),
    observationId: String(row.observation_id),
    observationDigest: String(row.observation_digest),
    canonicalReading: canonicalReading as JsonObject,
    ownerAddress: String(row.owner_address),
    chainId: String(row.chain_id),
    networkId: String(row.network_id),
    genesisHash: String(row.genesis_hash),
    commitId: String(row.commit_id),
    commitHash: String(row.commit_hash),
    nonce: String(row.nonce),
    commitTimestamp: Number(row.commit_timestamp),
    revealDeadline: Number(row.reveal_deadline),
    requiredQuorum: Number(row.required_quorum),
    evidenceTimestamp: new Date(String(row.evidence_timestamp)).toISOString(),
    lifecycleState: String(row.lifecycle_state) as OracleWorkLifecycle,
  };
}

function rowToClaim(row: Record<string, unknown>): OracleWorkClaimResult {
  return {
    workId: String(row.work_id),
    genesisHash: String(row.genesis_hash),
    oracleId: String(row.oracle_id) as OracleId,
    attestationVersion: Number(row.attestation_version),
    state: String(row.state) as OracleWorkClaimState,
    leaseVersion: Number(row.lease_version),
    leaseExpiresAt: row.lease_expires_at ? new Date(String(row.lease_expires_at)).toISOString() : null,
    approved: row.approved === null || row.approved === undefined ? null : Boolean(row.approved),
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    signature: row.signature ? String(row.signature) : null,
    attestationTimestamp: row.attestation_timestamp === null || row.attestation_timestamp === undefined ? null : Number(row.attestation_timestamp),
    resultCode: row.result_code ? String(row.result_code) : null,
    core4TxId: row.core4_tx_id ? String(row.core4_tx_id) : null,
    core4MinedAt: row.core4_mined_at ? new Date(String(row.core4_mined_at)).toISOString() : null,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    resultDigest: row.result_digest ? String(row.result_digest) : null,
  };
}

function revealEligibilityFromRows(
  work: OracleWorkRecord,
  rows: Array<Record<string, unknown>>,
  now: Date,
): RevealEligibility {
  return evaluateRevealEligibility(work, rows.map(row => ({
    workId: String(row.work_id),
    genesisHash: String(row.genesis_hash),
    oracleId: String(row.oracle_id) as OracleId,
    state: String(row.state) as OracleWorkClaimState,
    approved: row.approved === true,
  })), now);
}

export class OracleWorkBroker {
  constructor(
    private readonly db: OracleWorkQueryExecutor,
    private readonly clock: () => Date = () => new Date(),
    private readonly leaseMs = 5 * 60 * 1000,
  ) {}

  async createWork(input: OracleWorkInput): Promise<OracleWorkRecord> {
    const work = buildOracleWork(input);
    if (!this.db.transaction) {
      throw new OracleWorkBrokerError('TRANSACTION_REQUIRED', 'oracle work creation requires a database transaction', 503);
    }
    return this.db.transaction(async (transaction) => {
      const cycle = await transaction.execute(
        `UPDATE station_reward_cycles
            SET work_id = $1,
                work_schema_version = $2,
                commit_hash = $3,
                nonce = $4,
                commit_timestamp = $5,
                reveal_deadline = $6,
                lifecycle_state = 'VERIFYING',
                evidence_refreshed_at = $7,
                updated_at = now()
          WHERE cycle_id = $8
            AND station_id = $9
            AND observation_id = $10
            AND (work_id IS NULL OR work_id = $1)
          RETURNING cycle_id`,
        [work.workId, work.schemaVersion, work.commitHash, work.nonce, work.commitTimestamp, work.revealDeadline, work.evidenceTimestamp, work.cycleId, work.stationId, work.observationId],
      );
      if (cycle.rows.length === 0) {
        throw new OracleWorkBrokerError('CYCLE_NOT_READY', 'canonical reward cycle is missing or already bound to another work item', 409);
      }
      await transaction.execute(
        `INSERT INTO oracle_work_items (
           work_id, schema_version, cycle_id, station_id, observation_id,
           observation_digest, canonical_reading, owner_address, chain_id,
           network_id, genesis_hash, commit_id, commit_hash, nonce,
           commit_timestamp, reveal_deadline, required_quorum, evidence_timestamp
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (work_id) DO NOTHING`,
        [work.workId, work.schemaVersion, work.cycleId, work.stationId, work.observationId, work.observationDigest, stableJson(work.canonicalReading), work.ownerAddress, work.chainId, work.networkId, work.genesisHash, work.commitId, work.commitHash, work.nonce, work.commitTimestamp, work.revealDeadline, work.requiredQuorum, work.evidenceTimestamp],
      );
      for (const oracleId of ORACLE_IDS) {
        await transaction.execute(
          `INSERT INTO oracle_work_claim_results (work_id, genesis_hash, oracle_id, attestation_version)
           VALUES ($1,$2,$3,1)
           ON CONFLICT (genesis_hash, work_id, oracle_id, attestation_version) DO NOTHING`,
          [work.workId, work.genesisHash, oracleId],
        );
      }
      return work;
    });
  }

  async getWork(principal: unknown, workId: string): Promise<OracleWorkView> {
    const verified = assertVerifiedOraclePrincipal(principal, ORACLE_WORK_SCOPES.read);
    const normalizedWorkId = validateId(workId, 'workId');
    const workResult = await this.db.execute('SELECT * FROM oracle_work_items WHERE work_id = $1', [normalizedWorkId]);
    if (workResult.rows.length === 0) {
      throw new OracleWorkBrokerError('WORK_NOT_FOUND', 'oracle work item not found', 404);
    }
    const claimResult = await this.db.execute(
      `SELECT * FROM oracle_work_claim_results
        WHERE work_id = $1 AND genesis_hash = $2 AND oracle_id = $3 AND attestation_version = 1`,
      [normalizedWorkId, String(workResult.rows[0].genesis_hash), verified.oracleId],
    );
    return { work: rowToWork(workResult.rows[0]), ownClaim: claimResult.rows[0] ? rowToClaim(claimResult.rows[0]) : null };
  }

  async claimWork(principal: unknown, workId: string): Promise<{ claim: OracleWorkClaimResult; leaseToken: string }> {
    const verified = assertVerifiedOraclePrincipal(principal, ORACLE_WORK_SCOPES.claim);
    const normalizedWorkId = validateId(workId, 'workId');
    const now = this.clock();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs).toISOString();
    const leaseToken = randomUUID();
    const updated = await this.db.execute(
      `UPDATE oracle_work_claim_results
          SET state = 'CLAIMED',
              lease_version = lease_version + 1,
              lease_expires_at = $4,
              lease_token_hash = $5,
              updated_at = now()
        WHERE work_id = $1
          AND oracle_id = $2
          AND attestation_version = 1
          AND (
            state = 'DISPATCHABLE'
            OR (state IN ('CLAIMED','EXPIRED','FAILED') AND (lease_expires_at IS NULL OR lease_expires_at <= $3))
          )
        RETURNING *`,
      [normalizedWorkId, verified.oracleId, now.toISOString(), leaseExpiresAt, leaseHash(leaseToken)],
    );
    if (updated.rows.length === 0) {
      throw new OracleWorkBrokerError('LEASE_UNAVAILABLE', 'oracle work lease is unavailable', 409);
    }
    return { claim: rowToClaim(updated.rows[0]), leaseToken };
  }

  async recordResult(principal: unknown, input: OracleResultInput): Promise<{ claim: OracleWorkClaimResult; idempotent: boolean }> {
    const verified = assertVerifiedOraclePrincipal(principal, ORACLE_WORK_SCOPES.result);
    const workId = validateId(input.workId, 'workId');
    if (!Number.isSafeInteger(input.attestationVersion) || input.attestationVersion !== 1) {
      throw new OracleWorkBrokerError('INVALID_RESULT', 'attestationVersion must be 1', 400);
    }
    if (!Number.isSafeInteger(input.leaseVersion) || input.leaseVersion < 1) {
      throw new OracleWorkBrokerError('INVALID_RESULT', 'leaseVersion is invalid', 400);
    }
    const idempotencyKey = validateId(input.idempotencyKey, 'idempotencyKey');
    const leaseToken = requiredString(input.leaseToken, 'leaseToken', 200);
    if (input.confidence !== null && input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
      throw new OracleWorkBrokerError('INVALID_RESULT', 'confidence must be between 0 and 1', 400);
    }
    if (input.attestationTimestamp !== null && input.attestationTimestamp !== undefined && (!Number.isSafeInteger(input.attestationTimestamp) || input.attestationTimestamp <= 0)) {
      throw new OracleWorkBrokerError('INVALID_RESULT', 'attestationTimestamp is invalid', 400);
    }
    if (!this.db.transaction) {
      throw new OracleWorkBrokerError('TRANSACTION_REQUIRED', 'oracle work result recording requires a database transaction', 503);
    }
    return this.db.transaction(async (transaction) => {
    const current = await transaction.execute(
      `SELECT * FROM oracle_work_claim_results
        WHERE work_id = $1 AND oracle_id = $2 AND attestation_version = $3`,
      [workId, verified.oracleId, input.attestationVersion],
    );
    if (current.rows.length === 0) {
      throw new OracleWorkBrokerError('WORK_NOT_FOUND', 'oracle work claim is not available', 404);
    }
    const existing = rowToClaim(current.rows[0]);
    if (isIdempotentResult(existing, { ...input, idempotencyKey })) {
      return { claim: existing, idempotent: true };
    }
    const now = this.clock();
    if (!canClaimLease({ state: existing.state, leaseExpiresAt: existing.leaseExpiresAt }, now) || existing.state !== 'CLAIMED') {
      throw new OracleWorkBrokerError('LEASE_STALE', 'oracle work lease is stale or no longer claimable', 409);
    }
    const expiry = dateValue(existing.leaseExpiresAt);
    if (expiry && expiry.getTime() <= now.getTime()) {
      throw new OracleWorkBrokerError('LEASE_STALE', 'oracle work lease has expired', 409);
    }
    const resultDigest = resultFingerprint(input);
    const state: OracleWorkClaimState = !input.approved ? 'REJECTED' : input.signature ? 'SIGNED' : 'VALIDATED';
    const updated = await transaction.execute(
      `UPDATE oracle_work_claim_results
          SET state = $4,
              idempotency_key = $5,
              result_digest = $6,
              approved = $7,
              confidence = $8,
              signature = $9,
              attestation_timestamp = $10,
              result_code = $11,
              evidence_timestamp = now(),
              updated_at = now()
        WHERE work_id = $1 AND oracle_id = $2 AND attestation_version = $3
          AND state = 'CLAIMED' AND lease_version = $12
          AND lease_token_hash = $13
          AND lease_expires_at > $14
        RETURNING *`,
      [workId, verified.oracleId, input.attestationVersion, state, idempotencyKey, resultDigest, input.approved, input.confidence ?? null, input.signature ?? null, input.attestationTimestamp ?? null, input.resultCode ?? null, input.leaseVersion, leaseHash(leaseToken), now.toISOString()],
    );
    if (updated.rows.length === 0) {
      const raced = await transaction.execute(
        `SELECT * FROM oracle_work_claim_results
          WHERE work_id = $1 AND oracle_id = $2 AND attestation_version = $3`,
        [workId, verified.oracleId, input.attestationVersion],
      );
      if (raced.rows.length === 1) {
        const durable = rowToClaim(raced.rows[0]);
        if (isIdempotentResult(durable, { ...input, idempotencyKey })) {
          return { claim: durable, idempotent: true };
        }
      }
      throw new OracleWorkBrokerError('LEASE_STALE', 'oracle work result was not accepted for the supplied lease', 409);
    }
    return { claim: rowToClaim(updated.rows[0]), idempotent: false };
    });
  }

  async reconcileMinedApproval(readback: VerifiedMinedApproval): Promise<{ mined: boolean; quorumMined: boolean; reveal: RevealEligibility }> {
    if (readback.verified !== true || !ORACLE_IDS.includes(readback.oracleId)) {
      throw new OracleWorkBrokerError('CORE4_READBACK_REQUIRED', 'verified Core4 mined readback is required', 403);
    }
    if (!this.db.transaction) {
      throw new OracleWorkBrokerError('TRANSACTION_REQUIRED', 'mined reconciliation requires a database transaction', 503);
    }
    return this.db.transaction(async (transaction) => {
      const workResult = await transaction.execute('SELECT * FROM oracle_work_items WHERE work_id = $1', [readback.workId]);
      if (workResult.rows.length === 0) throw new OracleWorkBrokerError('WORK_NOT_FOUND', 'oracle work item not found', 404);
      const work = rowToWork(workResult.rows[0]);
      assertVerifiedMinedApprovalBinding(work, readback);
      const updated = await transaction.execute(
        `UPDATE oracle_work_claim_results
            SET state = 'MINED', core4_tx_id = $5, core4_mined_at = $6, updated_at = now()
          WHERE work_id = $1 AND genesis_hash = $2 AND oracle_id = $3
            AND attestation_version = $4 AND approved = TRUE AND state IN ('SIGNED','SUBMITTED')
          RETURNING *`,
        [readback.workId, readback.genesisHash, readback.oracleId, readback.attestationVersion, readback.core4TxId, readback.minedAt],
      );
      if (updated.rows.length === 0) {
        const existing = await transaction.execute(
          `SELECT * FROM oracle_work_claim_results
            WHERE work_id = $1 AND genesis_hash = $2 AND oracle_id = $3 AND attestation_version = $4`,
          [readback.workId, readback.genesisHash, readback.oracleId, readback.attestationVersion],
        );
        if (!existing.rows[0] || String(existing.rows[0].state) !== 'MINED' || String(existing.rows[0].core4_tx_id) !== readback.core4TxId) {
          throw new OracleWorkBrokerError('MINED_READBACK_NOT_READY', 'Core4 readback cannot advance this oracle result', 409);
        }
      }
      const now = this.clock();
      const aggregate = await transaction.execute(
        `SELECT work_id, genesis_hash, oracle_id, state, approved
           FROM oracle_work_claim_results
          WHERE work_id = $1 AND genesis_hash = $2`,
        [readback.workId, readback.genesisHash],
      );
      const reveal = revealEligibilityFromRows(work, aggregate.rows, now);
      const quorumMined = reveal.minedApprovals >= work.requiredQuorum;
      if (quorumMined && nowSeconds(now) <= work.revealDeadline) {
        await transaction.execute(`UPDATE oracle_work_items SET lifecycle_state = 'QUORUM_MINED' WHERE work_id = $1`, [work.workId]);
        await transaction.execute(`UPDATE station_reward_cycles SET lifecycle_state = 'QUORUM_REACHED', approvals = $2, quorum_mined_at = $3, evidence_refreshed_at = $3 WHERE work_id = $1`, [work.workId, reveal.minedApprovals, now.toISOString()]);
      } else if (nowSeconds(now) > work.revealDeadline) {
        await transaction.execute(`UPDATE oracle_work_items SET lifecycle_state = 'MISSED_QUORUM' WHERE work_id = $1`, [work.workId]);
        await transaction.execute(`UPDATE station_reward_cycles SET lifecycle_state = 'FAILED', failure_code = 'MISSED_QUORUM', evidence_refreshed_at = $2 WHERE work_id = $1`, [work.workId, now.toISOString()]);
      }
      return { mined: true, quorumMined, reveal };
    });
  }

  async getRevealEligibility(workId: string): Promise<RevealEligibility> {
    const normalizedWorkId = validateId(workId, 'workId');
    const workResult = await this.db.execute('SELECT * FROM oracle_work_items WHERE work_id = $1', [normalizedWorkId]);
    if (workResult.rows.length === 0) throw new OracleWorkBrokerError('WORK_NOT_FOUND', 'oracle work item not found', 404);
    const work = rowToWork(workResult.rows[0]);
    const results = await this.db.execute(`SELECT work_id, genesis_hash, oracle_id, state, approved FROM oracle_work_claim_results WHERE work_id = $1 AND genesis_hash = $2`, [work.workId, work.genesisHash]);
    return revealEligibilityFromRows(work, results.rows, this.clock());
  }
}

export function assertVerifiedMinedApprovalBinding(
  work: Pick<OracleWorkRecord, 'workId' | 'genesisHash' | 'commitId' | 'commitHash'>,
  readback: VerifiedMinedApproval,
): void {
  const receipt = readback.receipt;
  if (
    readback.workId !== work.workId ||
    readback.genesisHash !== work.genesisHash ||
    readback.commitId !== work.commitId ||
    readback.commitHash !== work.commitHash ||
    readback.attestationVersion !== 1 ||
    !receipt ||
    receipt.verified !== true ||
    receipt.status !== 'MINED' ||
    receipt.genesisHash !== work.genesisHash ||
    receipt.commitId !== work.commitId ||
    receipt.commitHash !== work.commitHash ||
    receipt.core4TxId !== readback.core4TxId ||
    receipt.minedAt !== readback.minedAt
  ) {
    throw new OracleWorkBrokerError('CORE4_READBACK_BINDING_INVALID', 'Core4 readback does not bind to the current work commit and receipt', 409);
  }
}
