/**
 * Station calibration certificates (core4#388/#435, backend#931).
 *
 * A calibration certificate is a `wrf-calibration-attestation/v1` artifact signed by a trust root
 * (ed25519, the #931 signature contract in calibration-attestation-verifier.ts). The backend:
 *   - verifies a submitted certificate (signature, trust root, validity window, revocation, clone)
 *     with the existing verifier, and stores it by its content id (CIDv1, raw codec, sha2-256), so
 *     the same bytes can be pinned to IPFS later and the id never changes;
 *   - accepts a revocation only when a trust root signed it;
 *   - answers "is this station calibrated?" by re-verifying the stored certificate at read time, so
 *     expiry, a later revocation and a trust-root change all show without a background job.
 *
 * Identity is the station's public alias (`st_` + 12 hex, utils/station-alias.js) and, optionally,
 * the owner's wallet address. The raw station id is never signed, stored or returned: it can carry a
 * personal name (owner ruling 2026-09-27). No names, emails or other personal data are held (owner
 * ruling 2026-11-01): the free-text calibration fields are bounded and documented as "no personal data".
 *
 * Trust roots come only from configuration (CALIBRATION_TRUST_ROOTS_JSON, public keys). With none
 * configured every submission fails closed (CAL_TRUST_ROOT_UNCONFIGURED).
 *
 * Not on chain: core4 has `calibration_attestations` state, but no live transaction writes it, and
 * that state feeds contributor class and reward weight. Writing it is a consensus change
 * (docs/calibration-certificates.md, "Chain").
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  CALIBRATION_SIGNATURE_ALGORITHM,
  CalibrationAttestationVerifierService,
  InMemoryCalibrationAttestationArtifactResolver,
  calibrationRevocationsFromEnv,
  parseCalibrationArtifact,
  parseCalibrationTrustRoots,
  stableStringify,
  type CalibrationAttestationArtifactV1,
  type CalibrationRevocationEntry,
  type CalibrationTrustRoot,
  type CalibrationVerificationReasonCode,
} from './calibration-attestation-verifier.js';

export const CALIBRATION_REVOCATION_SCHEMA = 'wrf-calibration-revocation/v1';
export const CALIBRATION_REVOCATION_REASONS = [
  'superseded',
  'sensor_replaced',
  'sensor_moved',
  'calibration_error',
  'key_compromise',
  'other',
] as const;
export type CalibrationRevocationReason = (typeof CALIBRATION_REVOCATION_REASONS)[number];

/** Public station status. `none` = no certificate on record. */
export type CalibrationCertificateStatus = 'calibrated' | 'expired' | 'revoked' | 'not_trusted' | 'invalid' | 'none';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const STATION_ALIAS_RE = /^st_[0-9a-f]{12}$/;

export function calibrationCertificatesEnabled(): boolean {
  return process.env.CALIBRATION_CERTIFICATES_ENABLED === 'true';
}

export function calibrationTrustRoots(): CalibrationTrustRoot[] {
  return parseCalibrationTrustRoots(process.env.CALIBRATION_TRUST_ROOTS_JSON || '');
}

function base32Lower(bytes: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The exact bytes a certificate is stored, served and content-addressed as. */
export function canonicalCertificateBytes(artifact: CalibrationAttestationArtifactV1): Buffer {
  return Buffer.from(stableStringify(artifact), 'utf8');
}

/**
 * CIDv1 (multibase base32 `b`, codec raw 0x55, multihash sha2-256) of the canonical bytes: the id
 * `ipfs add --cid-version=1 --raw-leaves` gives the same file, so it can be pinned later unchanged.
 */
export function calibrationCertificateCid(artifact: CalibrationAttestationArtifactV1): string {
  const digest = createHash('sha256').update(canonicalCertificateBytes(artifact)).digest();
  return `b${base32Lower(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]))}`;
}

// ---------------------------------------------------------------------------------------------
// Revocations
// ---------------------------------------------------------------------------------------------

export interface CalibrationRevocationV1 {
  schemaVersion: typeof CALIBRATION_REVOCATION_SCHEMA;
  artifactId: string;
  reason: CalibrationRevocationReason;
  revokedAt: string;
  signature: { algorithm: string; signerPublicKey: string; value: string };
}

/** Same contract as certificates: ed25519 over sha3-256(sorted-key JSON minus signature.value). */
export function computeRevocationSignedDigest(revocation: CalibrationRevocationV1): Buffer {
  const unsigned = {
    schemaVersion: revocation.schemaVersion,
    artifactId: revocation.artifactId,
    reason: revocation.reason,
    revokedAt: revocation.revokedAt,
    signature: { algorithm: revocation.signature.algorithm, signerPublicKey: revocation.signature.signerPublicKey },
  };
  return createHash('sha3-256').update(stableStringify(unsigned)).digest();
}

export function parseCalibrationRevocation(raw: unknown): CalibrationRevocationV1 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, any>;
  const sig = r.signature;
  if (
    r.schemaVersion !== CALIBRATION_REVOCATION_SCHEMA ||
    typeof r.artifactId !== 'string' || r.artifactId.trim().length === 0 || r.artifactId.length > 128 ||
    !(CALIBRATION_REVOCATION_REASONS as readonly string[]).includes(r.reason) ||
    typeof r.revokedAt !== 'string' || Number.isNaN(new Date(r.revokedAt).getTime()) ||
    !sig || typeof sig !== 'object' ||
    typeof sig.algorithm !== 'string' ||
    typeof sig.signerPublicKey !== 'string' || !/^[0-9a-f]{64}$/.test(sig.signerPublicKey) ||
    typeof sig.value !== 'string' || !/^[0-9a-fA-F]{128}$/.test(sig.value)
  ) {
    return null;
  }
  return {
    schemaVersion: CALIBRATION_REVOCATION_SCHEMA,
    artifactId: r.artifactId,
    reason: r.reason,
    revokedAt: r.revokedAt,
    signature: { algorithm: sig.algorithm, signerPublicKey: sig.signerPublicKey, value: sig.value },
  };
}

export type RevocationCheck = { ok: true; rootId: string } | { ok: false; code: string };

/** A revocation counts only when an ACTIVE configured trust root signed it. */
export function verifyCalibrationRevocation(
  revocation: CalibrationRevocationV1,
  trustRoots: CalibrationTrustRoot[],
): RevocationCheck {
  if (revocation.signature.algorithm !== CALIBRATION_SIGNATURE_ALGORITHM) return { ok: false, code: 'CAL_UNSUPPORTED_ALG' };
  const active = trustRoots.filter(root => root.active !== false);
  if (active.length === 0) return { ok: false, code: 'CAL_TRUST_ROOT_UNCONFIGURED' };
  const keyBytes = Buffer.from(revocation.signature.signerPublicKey, 'hex');
  const fingerprint = createHash('sha256').update(keyBytes).digest('hex');
  const root = active.find(candidate => candidate.fingerprintSha256.toLowerCase() === fingerprint);
  if (!root) return { ok: false, code: 'CAL_ISSUER_UNTRUSTED_ROOT' };
  try {
    const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]), format: 'der', type: 'spki' });
    const valid = cryptoVerify(null, computeRevocationSignedDigest(revocation), publicKey, Buffer.from(revocation.signature.value, 'hex'));
    return valid ? { ok: true, rootId: root.rootId } : { ok: false, code: 'CAL_SIGNATURE_INVALID' };
  } catch {
    return { ok: false, code: 'CAL_SIGNATURE_VERIFICATION_UNAVAILABLE' };
  }
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

export interface CertificateEvaluation {
  status: Exclude<CalibrationCertificateStatus, 'none'>;
  reasonCodes: CalibrationVerificationReasonCode[];
  trustRootId: string | null;
}

/**
 * Re-verify one stored certificate now. Expired wins over the cert-expiry code it implies; a signed
 * revocation (or an env-revoked key) wins over everything; a root that is no longer configured makes
 * the certificate `not_trusted`, not `invalid`.
 */
export async function evaluateCalibrationCertificate(
  artifact: CalibrationAttestationArtifactV1,
  options: {
    trustRoots: CalibrationTrustRoot[];
    revokedCertificates?: CalibrationRevocationEntry[];
    revoked?: boolean;
    now?: () => Date;
  },
): Promise<CertificateEvaluation> {
  const cid = calibrationCertificateCid(artifact);
  const resolver = new InMemoryCalibrationAttestationArtifactResolver();
  resolver.registerFixture(`ipfs:${cid}`, JSON.parse(JSON.stringify(artifact)));
  const verifier = new CalibrationAttestationVerifierService({
    trustRoots: options.trustRoots,
    revokedCertificates: options.revokedCertificates ?? [],
    artifactResolver: resolver,
    now: options.now,
  });
  const summary = await verifier.verifyCalibrationAttestation({
    commitId: artifact.artifactId,
    stationId: artifact.subject.stationId,
    calibrationAttestationCid: `ipfs:${cid}`,
  });
  const codes = new Set<string>(summary.reasonCodes);
  let status: CertificateEvaluation['status'];
  if (summary.status === 'verified') status = 'calibrated';
  else if (options.revoked || codes.has('CAL_CERT_REVOKED')) status = 'revoked';
  else if (codes.has('CAL_TRUST_ROOT_UNCONFIGURED') || codes.has('CAL_ISSUER_UNTRUSTED_ROOT')) status = 'not_trusted';
  else if (
    codes.has('CAL_ATTESTATION_EXPIRED') &&
    [...codes].every(code => code === 'CAL_ATTESTATION_EXPIRED' || code === 'CAL_CERT_EXPIRED')
  ) status = 'expired';
  else status = 'invalid';
  if (options.revoked && status !== 'revoked') status = 'revoked';
  return { status, reasonCodes: summary.reasonCodes, trustRootId: summary.trustRootId };
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

export interface StoredCertificate {
  cid: string;
  artifactId: string;
  stationAlias: string;
  artifact: CalibrationAttestationArtifactV1;
  issuedAt: string;
  expiresAt: string;
  submittedAt: string;
}

export interface StoredRevocation {
  artifactId: string;
  reason: CalibrationRevocationReason;
  revokedAt: string;
  rootId: string;
  revocation: CalibrationRevocationV1;
}

export type InsertResult = 'inserted' | 'duplicate' | 'artifact_conflict';

export interface CalibrationCertificateStore {
  insertCertificate(row: Omit<StoredCertificate, 'submittedAt'>): Promise<InsertResult>;
  /** Newest first by issuedAt, at most `limit`. */
  certificatesForStation(stationAlias: string, limit: number): Promise<StoredCertificate[]>;
  certificateByArtifactId(artifactId: string): Promise<StoredCertificate | null>;
  revocationsFor(artifactIds: string[]): Promise<Map<string, StoredRevocation>>;
  /** false when this artifact already has a revocation (the first one stands). */
  insertRevocation(row: StoredRevocation): Promise<boolean>;
}

export class InMemoryCalibrationCertificateStore implements CalibrationCertificateStore {
  private readonly byCid = new Map<string, StoredCertificate>();
  private readonly revocations = new Map<string, StoredRevocation>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async insertCertificate(row: Omit<StoredCertificate, 'submittedAt'>): Promise<InsertResult> {
    if (this.byCid.has(row.cid)) return 'duplicate';
    for (const existing of this.byCid.values()) if (existing.artifactId === row.artifactId) return 'artifact_conflict';
    this.byCid.set(row.cid, { ...row, submittedAt: this.now().toISOString() });
    return 'inserted';
  }

  async certificatesForStation(stationAlias: string, limit: number): Promise<StoredCertificate[]> {
    return [...this.byCid.values()]
      .filter(row => row.stationAlias === stationAlias)
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt) || b.submittedAt.localeCompare(a.submittedAt))
      .slice(0, limit);
  }

  async certificateByArtifactId(artifactId: string): Promise<StoredCertificate | null> {
    for (const row of this.byCid.values()) if (row.artifactId === artifactId) return row;
    return null;
  }

  async revocationsFor(artifactIds: string[]): Promise<Map<string, StoredRevocation>> {
    const out = new Map<string, StoredRevocation>();
    for (const id of artifactIds) {
      const row = this.revocations.get(id);
      if (row) out.set(id, row);
    }
    return out;
  }

  async insertRevocation(row: StoredRevocation): Promise<boolean> {
    if (this.revocations.has(row.artifactId)) return false;
    this.revocations.set(row.artifactId, row);
    return true;
  }
}

type Query = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const isoOf = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const jsonOf = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);

function certificateFromRow(row: Record<string, unknown>): StoredCertificate {
  return {
    cid: String(row.cid),
    artifactId: String(row.artifact_id),
    stationAlias: String(row.station_alias),
    artifact: jsonOf(row.artifact),
    issuedAt: isoOf(row.issued_at),
    expiresAt: isoOf(row.expires_at),
    submittedAt: isoOf(row.submitted_at),
  };
}

/** Postgres store over migration 0038 (calibration_certificates, calibration_certificate_revocations). */
export function createPgCalibrationCertificateStore(query: Query): CalibrationCertificateStore {
  return {
    async insertCertificate(row) {
      const inserted = await query(
        `INSERT INTO calibration_certificates (cid, artifact_id, station_alias, artifact, issued_at, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz)
         ON CONFLICT DO NOTHING RETURNING cid`,
        [row.cid, row.artifactId, row.stationAlias, stableStringify(row.artifact), row.issuedAt, row.expiresAt],
      );
      if (inserted.rows.length === 1) return 'inserted';
      const same = await query('SELECT cid FROM calibration_certificates WHERE cid = $1', [row.cid]);
      return same.rows.length === 1 ? 'duplicate' : 'artifact_conflict';
    },
    async certificatesForStation(stationAlias, limit) {
      const result = await query(
        `SELECT cid, artifact_id, station_alias, artifact, issued_at, expires_at, submitted_at
           FROM calibration_certificates WHERE station_alias = $1
          ORDER BY issued_at DESC, submitted_at DESC LIMIT $2`,
        [stationAlias, limit],
      );
      return result.rows.map(certificateFromRow);
    },
    async certificateByArtifactId(artifactId) {
      const result = await query(
        `SELECT cid, artifact_id, station_alias, artifact, issued_at, expires_at, submitted_at
           FROM calibration_certificates WHERE artifact_id = $1`,
        [artifactId],
      );
      return result.rows.length ? certificateFromRow(result.rows[0]) : null;
    },
    async revocationsFor(artifactIds) {
      const out = new Map<string, StoredRevocation>();
      if (artifactIds.length === 0) return out;
      const result = await query(
        `SELECT artifact_id, reason, revoked_at, root_id, revocation
           FROM calibration_certificate_revocations WHERE artifact_id = ANY($1::text[])`,
        [artifactIds],
      );
      for (const row of result.rows) {
        out.set(String(row.artifact_id), {
          artifactId: String(row.artifact_id),
          reason: String(row.reason) as CalibrationRevocationReason,
          revokedAt: isoOf(row.revoked_at),
          rootId: String(row.root_id),
          revocation: jsonOf(row.revocation),
        });
      }
      return out;
    },
    async insertRevocation(row) {
      const result = await query(
        `INSERT INTO calibration_certificate_revocations (artifact_id, reason, revoked_at, root_id, revocation)
         VALUES ($1, $2, $3::timestamptz, $4, $5::jsonb)
         ON CONFLICT (artifact_id) DO NOTHING RETURNING artifact_id`,
        [row.artifactId, row.reason, row.revokedAt, row.rootId, stableStringify(row.revocation)],
      );
      return result.rows.length === 1;
    },
  };
}

let lazyStore: CalibrationCertificateStore | null = null;
/** Production wiring: the shared pool, resolved on first use (nothing is read while the flag is off). */
export function defaultCalibrationCertificateStore(): CalibrationCertificateStore {
  const resolve = async (): Promise<CalibrationCertificateStore> => {
    if (lazyStore) return lazyStore;
    const { pool } = await import('../../database/db.js');
    lazyStore = createPgCalibrationCertificateStore((sql, params) => pool.query(sql, params));
    return lazyStore;
  };
  return {
    insertCertificate: async row => (await resolve()).insertCertificate(row),
    certificatesForStation: async (alias, limit) => (await resolve()).certificatesForStation(alias, limit),
    certificateByArtifactId: async id => (await resolve()).certificateByArtifactId(id),
    revocationsFor: async ids => (await resolve()).revocationsFor(ids),
    insertRevocation: async row => (await resolve()).insertRevocation(row),
  };
}

// ---------------------------------------------------------------------------------------------
// Use cases (route-independent so the CLI and tests share them)
// ---------------------------------------------------------------------------------------------

export interface CalibrationCertificateContext {
  store: CalibrationCertificateStore;
  trustRoots: () => CalibrationTrustRoot[];
  revokedCertificates?: () => CalibrationRevocationEntry[];
  /** Does this alias name a known station? 'unavailable' = could not check (fail closed). */
  stationExists: (alias: string) => Promise<'found' | 'not_found' | 'unavailable'>;
  now?: () => Date;
}

export type SubmitOutcome =
  | { kind: 'stored'; created: boolean; cid: string; artifactId: string; stationAlias: string; expiresAt: string; trustRootId: string | null }
  | { kind: 'rejected'; http: number; code: string; reasonCodes?: string[] };

export async function submitCalibrationCertificate(ctx: CalibrationCertificateContext, raw: unknown): Promise<SubmitOutcome> {
  const parsed = parseCalibrationArtifact(raw);
  if (!parsed) return { kind: 'rejected', http: 400, code: 'CAL_ARTIFACT_SCHEMA_INVALID' };
  const artifact = parsed.raw;
  if (!STATION_ALIAS_RE.test(artifact.subject.stationId)) {
    // The subject must be the public alias: a raw id can carry a personal name.
    return { kind: 'rejected', http: 400, code: 'CAL_SUBJECT_MUST_BE_STATION_ALIAS' };
  }
  if (artifact.artifactId.length > 128) return { kind: 'rejected', http: 400, code: 'CAL_ARTIFACT_SCHEMA_INVALID' };
  const roots = ctx.trustRoots();
  if (!roots.some(root => root.active !== false)) {
    return { kind: 'rejected', http: 503, code: 'CAL_TRUST_ROOT_UNCONFIGURED' };
  }
  const evaluation = await evaluateCalibrationCertificate(artifact, {
    trustRoots: roots,
    revokedCertificates: ctx.revokedCertificates?.() ?? calibrationRevocationsFromEnv(),
    now: ctx.now,
  });
  if (evaluation.status !== 'calibrated') {
    return { kind: 'rejected', http: 422, code: 'CAL_CERTIFICATE_REJECTED', reasonCodes: evaluation.reasonCodes };
  }
  const exists = await ctx.stationExists(artifact.subject.stationId);
  if (exists === 'unavailable') return { kind: 'rejected', http: 503, code: 'STATION_LOOKUP_UNAVAILABLE' };
  if (exists === 'not_found') return { kind: 'rejected', http: 404, code: 'STATION_NOT_FOUND' };
  const revoked = await ctx.store.revocationsFor([artifact.artifactId]);
  if (revoked.has(artifact.artifactId)) {
    return { kind: 'rejected', http: 422, code: 'CAL_CERTIFICATE_REJECTED', reasonCodes: ['CAL_CERT_REVOKED'] };
  }
  const cid = calibrationCertificateCid(artifact);
  const result = await ctx.store.insertCertificate({
    cid,
    artifactId: artifact.artifactId,
    stationAlias: artifact.subject.stationId,
    artifact,
    issuedAt: new Date(artifact.attestation.issuedAt).toISOString(),
    expiresAt: new Date(artifact.attestation.expiresAt).toISOString(),
  });
  if (result === 'artifact_conflict') {
    return { kind: 'rejected', http: 409, code: 'CAL_ARTIFACT_CLONED' };
  }
  return {
    kind: 'stored',
    created: result === 'inserted',
    cid,
    artifactId: artifact.artifactId,
    stationAlias: artifact.subject.stationId,
    expiresAt: new Date(artifact.attestation.expiresAt).toISOString(),
    trustRootId: evaluation.trustRootId,
  };
}

export type RevokeOutcome =
  | { kind: 'stored'; created: boolean; artifactId: string; reason: CalibrationRevocationReason; revokedAt: string }
  | { kind: 'rejected'; http: number; code: string };

export async function submitCalibrationRevocation(ctx: CalibrationCertificateContext, raw: unknown): Promise<RevokeOutcome> {
  const revocation = parseCalibrationRevocation(raw);
  if (!revocation) return { kind: 'rejected', http: 400, code: 'CAL_REVOCATION_SCHEMA_INVALID' };
  const check = verifyCalibrationRevocation(revocation, ctx.trustRoots());
  if (check.ok === false) {
    const { code } = check as { ok: false; code: string };
    return { kind: 'rejected', http: code === 'CAL_TRUST_ROOT_UNCONFIGURED' ? 503 : 403, code };
  }
  const { rootId } = check as { ok: true; rootId: string };
  const certificate = await ctx.store.certificateByArtifactId(revocation.artifactId);
  if (!certificate) return { kind: 'rejected', http: 404, code: 'CAL_CERTIFICATE_NOT_FOUND' };
  const revokedAt = new Date(revocation.revokedAt).toISOString();
  const created = await ctx.store.insertRevocation({
    artifactId: revocation.artifactId,
    reason: revocation.reason,
    revokedAt,
    rootId,
    revocation,
  });
  return { kind: 'stored', created, artifactId: revocation.artifactId, reason: revocation.reason, revokedAt };
}

export interface PublicTrustRoot {
  rootId: string;
  subject: string;
  publicKeyHex: string | null;
  fingerprintSha256: string;
}

export interface PublicCertificateView {
  cid: string;
  artifactId: string;
  status: Exclude<CalibrationCertificateStatus, 'none'>;
  reasonCodes: string[];
  issuer: { issuerId: string; trustRootId: string | null };
  issuedAt: string;
  expiresAt: string;
  ownerAddress: string | null;
  calibration: CalibrationAttestationArtifactV1['calibration'] | null;
  revocation: { reason: CalibrationRevocationReason; revokedAt: string } | null;
  /** The full signed certificate, so anyone can re-verify it against the trust root key. */
  artifact: CalibrationAttestationArtifactV1;
}

export interface StationCalibrationView {
  stationAlias: string;
  status: CalibrationCertificateStatus;
  certificate: PublicCertificateView | null;
  /** Older certificates for this station (newest first), without the artifact body. */
  history: Array<Omit<PublicCertificateView, 'artifact'>>;
  trustRoots: PublicTrustRoot[];
  checkedAt: string;
}

export const STATION_HISTORY_LIMIT = 5;

export async function stationCalibrationView(ctx: CalibrationCertificateContext, stationAlias: string): Promise<StationCalibrationView> {
  const now = ctx.now ?? (() => new Date());
  const roots = ctx.trustRoots();
  const rows = await ctx.store.certificatesForStation(stationAlias, STATION_HISTORY_LIMIT + 1);
  const revocations = await ctx.store.revocationsFor(rows.map(row => row.artifactId));
  const envRevoked = ctx.revokedCertificates?.() ?? calibrationRevocationsFromEnv();
  const views: PublicCertificateView[] = [];
  for (const row of rows) {
    const revocation = revocations.get(row.artifactId) ?? null;
    const evaluation = await evaluateCalibrationCertificate(row.artifact, {
      trustRoots: roots,
      revokedCertificates: envRevoked,
      revoked: revocation !== null,
      now,
    });
    views.push({
      cid: row.cid,
      artifactId: row.artifactId,
      status: evaluation.status,
      reasonCodes: evaluation.reasonCodes,
      issuer: { issuerId: row.artifact.issuer.issuerId, trustRootId: evaluation.trustRootId },
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      ownerAddress: row.artifact.subject.ownerAddress ?? null,
      calibration: row.artifact.calibration ?? null,
      revocation: revocation ? { reason: revocation.reason, revokedAt: revocation.revokedAt } : null,
      artifact: row.artifact,
    });
  }
  // The station's status is its newest certificate's. A newer revoked or expired certificate is not
  // papered over by an older one that still verifies: the signer issued the newer one last.
  const current = views[0] ?? null;
  return {
    stationAlias,
    status: current ? current.status : 'none',
    certificate: current,
    history: views.slice(1, STATION_HISTORY_LIMIT + 1).map(({ artifact: _artifact, ...rest }) => rest),
    trustRoots: roots
      .filter(root => root.active !== false)
      .map(root => ({
        rootId: root.rootId,
        subject: root.subject,
        publicKeyHex: root.publicKeyHex ?? null,
        fingerprintSha256: root.fingerprintSha256,
      })),
    checkedAt: now().toISOString(),
  };
}
