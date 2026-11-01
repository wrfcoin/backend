import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';

export const CalibrationVerificationReasonCodes = Object.freeze({
  OK: 'CAL_OK',
  CID_INVALID: 'CAL_CID_INVALID',
  ARTIFACT_FETCH_ERROR: 'CAL_ARTIFACT_FETCH_ERROR',
  ARTIFACT_NOT_FOUND: 'CAL_ARTIFACT_NOT_FOUND',
  ARTIFACT_SCHEMA_INVALID: 'CAL_ARTIFACT_SCHEMA_INVALID',
  SUBJECT_STATION_MISMATCH: 'CAL_SUBJECT_STATION_MISMATCH',
  ATTESTATION_TIME_WINDOW_INVALID: 'CAL_ATTESTATION_TIME_WINDOW_INVALID',
  ATTESTATION_NOT_YET_VALID: 'CAL_ATTESTATION_NOT_YET_VALID',
  ATTESTATION_EXPIRED: 'CAL_ATTESTATION_EXPIRED',
  CERT_CHAIN_MISSING: 'CAL_CERT_CHAIN_MISSING',
  CERT_CHAIN_BROKEN: 'CAL_CERT_CHAIN_BROKEN',
  CERT_NOT_YET_VALID: 'CAL_CERT_NOT_YET_VALID',
  CERT_EXPIRED: 'CAL_CERT_EXPIRED',
  CERT_REVOKED: 'CAL_CERT_REVOKED',
  TRUST_ROOT_UNCONFIGURED: 'CAL_TRUST_ROOT_UNCONFIGURED',
  ISSUER_UNTRUSTED_ROOT: 'CAL_ISSUER_UNTRUSTED_ROOT',
  SIGNATURE_VERIFICATION_UNAVAILABLE: 'CAL_SIGNATURE_VERIFICATION_UNAVAILABLE',
  ARTIFACT_CLONED: 'CAL_ARTIFACT_CLONED',
  // #931 — real signature verification. Each failure mode is specific: a blunt
  // reject-everything guard cannot pass an asymmetric control.
  UNSUPPORTED_ALG: 'CAL_UNSUPPORTED_ALG',
  SIGNER_KEY_INVALID: 'CAL_SIGNER_KEY_INVALID',
  SIGNATURE_INVALID: 'CAL_SIGNATURE_INVALID',
  SIGNER_NOT_BOUND_TO_CHAIN: 'CAL_SIGNER_NOT_BOUND_TO_CHAIN',
  CHAIN_DEPTH_UNSUPPORTED: 'CAL_CHAIN_DEPTH_UNSUPPORTED',
});

export type CalibrationVerificationReasonCode =
  (typeof CalibrationVerificationReasonCodes)[keyof typeof CalibrationVerificationReasonCodes];

export type CalibrationVerificationStatus = 'verified' | 'rejected' | 'error';

export interface CalibrationTrustRoot {
  rootId: string;
  subject: string;
  fingerprintSha256: string;
  /**
   * The root's raw ed25519 public key (64 hex). Optional for older configs that pin only the
   * fingerprint; when present, the fingerprint is sha256(public key bytes) and must agree.
   */
  publicKeyHex?: string;
  active?: boolean;
}

export interface CalibrationRevocationEntry {
  fingerprintSha256: string;
  reason?: string;
  revokedAt?: string;
}

export interface CalibrationAttestationVerifierRequest {
  commitId: string;
  stationId: string;
  calibrationAttestationCid: string;
  canonicalCalibrationAttestationCid?: string;
}

export interface CalibrationAttestationVerificationSummary {
  schemaVersion: 'calibration_attestation_verifier_summary/v1';
  verificationId: string;
  status: CalibrationVerificationStatus;
  reasonCodes: CalibrationVerificationReasonCode[];
  commitId: string;
  stationId: string;
  canonicalCalibrationAttestationCid: string;
  artifactId: string | null;
  artifactDigestSha256: string | null;
  issuerId: string | null;
  trustRootId: string | null;
  verifiedAt: string;
}

interface CalibrationCertificateRecord {
  certId: string;
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  fingerprintSha256: string;
}

/**
 * Optional description of what was calibrated. Every field is signed. Free text is bounded and must
 * never carry personal data (no names, emails or phone numbers): identity is the station alias and
 * the owner's wallet address.
 */
export interface CalibrationDetailsV1 {
  sensor?: string;
  method?: string;
  reference?: string;
  notes?: string;
}

export const CALIBRATION_DETAIL_FIELDS = ['sensor', 'method', 'reference', 'notes'] as const;
export const CALIBRATION_DETAIL_MAX_LEN = 200;

export interface CalibrationAttestationArtifactV1 {
  schemaVersion: 'wrf-calibration-attestation/v1';
  artifactId: string;
  subject: {
    stationId: string;
    /** The station owner's wallet (0x + 40 lowercase hex) the signer issued this to. Optional. */
    ownerAddress?: string;
  };
  calibration?: CalibrationDetailsV1;
  issuer: {
    issuerId: string;
    certificateChain: CalibrationCertificateRecord[];
  };
  attestation: {
    issuedAt: string;
    expiresAt: string;
  };
  signature: {
    algorithm: string;
    value: string;
    /** 64-hex raw ed25519 public key — required for the pinned algorithm. */
    signerPublicKey?: string;
  };
}

export interface ParsedArtifact {
  raw: CalibrationAttestationArtifactV1;
  artifactDigestSha256: string;
}

export interface CalibrationAttestationArtifactResolver {
  fetchByCanonicalCid(canonicalCid: string): Promise<unknown | null>;
}

function parseCanonicalCid(
  canonicalCid: string,
): { provider: 'ipfs' | 'filecoin' | 'arweave'; id: string } | null {
  const index = canonicalCid.indexOf(':');
  if (index <= 0) {
    return null;
  }
  const provider = canonicalCid.slice(0, index) as 'ipfs' | 'filecoin' | 'arweave';
  const id = canonicalCid.slice(index + 1);
  if (!id || !['ipfs', 'filecoin', 'arweave'].includes(provider)) {
    return null;
  }
  return {
    provider,
    id,
  };
}

export class InMemoryCalibrationAttestationArtifactResolver
implements CalibrationAttestationArtifactResolver
{
  private readonly fixtures = new Map<string, unknown>();

  registerFixture(canonicalCid: string, artifact: unknown): void {
    this.fixtures.set(canonicalCid, artifact);
  }

  async fetchByCanonicalCid(canonicalCid: string): Promise<unknown | null> {
    return this.fixtures.get(canonicalCid) ?? null;
  }
}

interface GatewayCalibrationAttestationArtifactResolverOptions {
  ipfsGateways?: string[];
  arweaveGateways?: string[];
  fetchTimeoutMs?: number;
}

function parseGatewayEnv(raw: string | undefined): string[] {
  const value = (raw || '').trim();
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

export class GatewayCalibrationAttestationArtifactResolver
implements CalibrationAttestationArtifactResolver
{
  private readonly fixtures = new Map<string, unknown>();

  private readonly ipfsGateways: string[];

  private readonly arweaveGateways: string[];

  private readonly fetchTimeoutMs: number;

  constructor(options: GatewayCalibrationAttestationArtifactResolverOptions = {}) {
    const ipfsFromEnv = parseGatewayEnv(process.env.CALIBRATION_IPFS_GATEWAYS);
    const arweaveFromEnv = parseGatewayEnv(process.env.CALIBRATION_ARWEAVE_GATEWAYS);
    this.ipfsGateways =
      options.ipfsGateways ??
      (ipfsFromEnv.length > 0 ? ipfsFromEnv : ['https://ipfs.io/ipfs', 'https://w3s.link/ipfs']);
    this.arweaveGateways =
      options.arweaveGateways ??
      (arweaveFromEnv.length > 0 ? arweaveFromEnv : ['https://arweave.net']);
    this.fetchTimeoutMs = Math.max(250, options.fetchTimeoutMs ?? 7_500);
  }

  registerFixture(canonicalCid: string, artifact: unknown): void {
    this.fixtures.set(canonicalCid, artifact);
  }

  async fetchByCanonicalCid(canonicalCid: string): Promise<unknown | null> {
    const fixture = this.fixtures.get(canonicalCid);
    if (fixture !== undefined) {
      return fixture;
    }

    const parsed = parseCanonicalCid(canonicalCid);
    if (!parsed) {
      return null;
    }

    const urls = this.buildCandidateUrls(parsed.provider, parsed.id);
    for (const url of urls) {
      const result = await this.tryFetchJson(url);
      if (result !== null) {
        return result;
      }
    }

    return null;
  }

  private buildCandidateUrls(
    provider: 'ipfs' | 'filecoin' | 'arweave',
    id: string,
  ): string[] {
    if (provider === 'arweave') {
      return this.arweaveGateways.map(base => `${base.replace(/\/+$/, '')}/${id}`);
    }
    return this.ipfsGateways.map(base => `${base.replace(/\/+$/, '')}/${id}`);
  }

  private async tryFetchJson(url: string): Promise<unknown | null> {
    const AbortControllerCtor = globalThis.AbortController;
    if (!AbortControllerCtor) {
      return null;
    }

    const controller = new AbortControllerCtor();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }

      const text = await response.text();
      if (!text.trim()) {
        return null;
      }
      return JSON.parse(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface CalibrationAttestationVerifierServiceOptions {
  trustRoots?: CalibrationTrustRoot[];
  revokedCertificates?: CalibrationRevocationEntry[];
  artifactResolver?: CalibrationAttestationArtifactResolver;
  now?: () => Date;
}

const MAX_CALIBRATION_CID_LEN = 256;
const ARWEAVE_ID_LEN = 43;

const PROVIDER_PREFIXES: Array<{ prefix: string; provider: 'ipfs' | 'filecoin' | 'arweave' }> = [
  { prefix: 'ipfs://', provider: 'ipfs' },
  { prefix: 'ipfs:', provider: 'ipfs' },
  { prefix: '/ipfs/', provider: 'ipfs' },
  { prefix: 'filecoin://', provider: 'filecoin' },
  { prefix: 'filecoin:', provider: 'filecoin' },
  { prefix: 'arweave://', provider: 'arweave' },
  { prefix: 'arweave:', provider: 'arweave' },
  { prefix: 'ar://', provider: 'arweave' },
];

/**
 * Parse a trust-root list (CALIBRATION_TRUST_ROOTS_JSON). Each entry names a root by `rootId` and
 * `subject` and pins its key with `publicKeyHex` (raw ed25519, preferred) and/or `fingerprintSha256`
 * (sha256 of the raw key). An entry whose two pins disagree, or that pins nothing valid, is dropped:
 * a malformed root never widens trust. Invalid JSON yields no roots (verification fails closed).
 */
export function parseCalibrationTrustRoots(raw: string): CalibrationTrustRoot[] {
  const text = (raw || '').trim();
  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const roots: CalibrationTrustRoot[] = [];
    for (const entry of parsed as any[]) {
      const rootId = typeof entry?.rootId === 'string' ? entry.rootId : '';
      const subject = typeof entry?.subject === 'string' ? entry.subject : '';
      const publicKeyHex =
        typeof entry?.publicKeyHex === 'string' && isHex64(entry.publicKeyHex)
          ? entry.publicKeyHex.toLowerCase()
          : undefined;
      if (entry?.publicKeyHex !== undefined && publicKeyHex === undefined) {
        continue;
      }
      const derived = publicKeyHex
        ? createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex')
        : undefined;
      const pinned =
        typeof entry?.fingerprintSha256 === 'string' ? entry.fingerprintSha256.toLowerCase() : undefined;
      if (pinned !== undefined && derived !== undefined && pinned !== derived) {
        continue;
      }
      const fingerprintSha256 = derived ?? pinned ?? '';
      if (!rootId || !subject || !isHexSha256(fingerprintSha256)) {
        continue;
      }
      roots.push({
        rootId,
        subject,
        fingerprintSha256,
        ...(publicKeyHex ? { publicKeyHex } : {}),
        active: entry?.active !== false,
      });
    }
    return roots;
  } catch {
    return [];
  }
}

function parseTrustRootsFromEnv(): CalibrationTrustRoot[] {
  return parseCalibrationTrustRoots(process.env.CALIBRATION_TRUST_ROOTS_JSON || '');
}

/** Revocations configured by env (CALIBRATION_REVOKED_CERTIFICATES_JSON / _FINGERPRINTS). */
export function calibrationRevocationsFromEnv(): CalibrationRevocationEntry[] {
  return parseRevocationsFromEnv();
}

function parseRevocationsFromEnv(): CalibrationRevocationEntry[] {
  const rawJson = (process.env.CALIBRATION_REVOKED_CERTIFICATES_JSON || '').trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry: any) => ({
            fingerprintSha256:
              typeof entry?.fingerprintSha256 === 'string' ? entry.fingerprintSha256 : '',
            reason: typeof entry?.reason === 'string' ? entry.reason : undefined,
            revokedAt: typeof entry?.revokedAt === 'string' ? entry.revokedAt : undefined,
          }))
          .filter(entry => isHexSha256(entry.fingerprintSha256));
      }
    } catch {
      return [];
    }
  }

  const rawCsv = (process.env.CALIBRATION_REVOKED_CERT_FINGERPRINTS || '').trim();
  if (!rawCsv) {
    return [];
  }

  return rawCsv
    .split(',')
    .map(value => value.trim())
    .filter(value => isHexSha256(value))
    .map(value => ({
      fingerprintSha256: value,
    }));
}

function isHexSha256(value: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(value);
}

function isBase58BtcChar(char: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]$/.test(char);
}

function isLowerBase32Char(char: string): boolean {
  return /^[a-z2-7]$/.test(char);
}

function isValidIpfsLikeCid(value: string): boolean {
  const isV0 =
    value.startsWith('Qm') && value.length === 46 && value.split('').every(isBase58BtcChar);
  const isV1 =
    value.startsWith('b') && value.length >= 10 && value.split('').every(isLowerBase32Char);
  return isV0 || isV1;
}

function isValidArweaveId(value: string): boolean {
  return value.length === ARWEAVE_ID_LEN && /^[a-zA-Z0-9_-]+$/.test(value);
}

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

export function canonicalizeCalibrationAttestationCid(rawCid: string): string | null {
  if (
    rawCid.trim() !== rawCid ||
    rawCid.length === 0 ||
    rawCid.length > MAX_CALIBRATION_CID_LEN ||
    hasControlCharacters(rawCid)
  ) {
    return null;
  }

  for (const entry of PROVIDER_PREFIXES) {
    if (rawCid.startsWith(entry.prefix)) {
      const stripped = rawCid.slice(entry.prefix.length);
      if (!stripped) {
        return null;
      }
      if (
        (entry.provider === 'ipfs' || entry.provider === 'filecoin') &&
        !isValidIpfsLikeCid(stripped)
      ) {
        return null;
      }
      if (entry.provider === 'arweave' && !isValidArweaveId(stripped)) {
        return null;
      }
      return `${entry.provider}:${stripped}`;
    }
  }

  if (isValidIpfsLikeCid(rawCid)) {
    return `ipfs:${rawCid}`;
  }
  if (isValidArweaveId(rawCid)) {
    return `arweave:${rawCid}`;
  }
  return null;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

function computeSha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * #931 signature contract, pinned. The signer produces:
 *   sig = ed25519_sign( sha3_256( stableStringify(artifact minus signature.value) ) )
 * i.e. the signed message is the 32-byte SHA3-256 digest of the sorted-key JSON
 * of the artifact with `signature.value` removed (algorithm and signerPublicKey
 * stay inside the signed payload so neither can be swapped post-signature).
 * Same canonicalization family as the commit-reveal hash contract — we do not
 * mint a second canonicalization dialect.
 */
export const CALIBRATION_SIGNATURE_ALGORITHM = 'ed25519-sha3-256-json-v1';

/** SPKI DER prefix for a raw ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function isHex64(value: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(value);
}

function isHex128(value: string): boolean {
  return /^[a-fA-F0-9]{128}$/.test(value);
}

/** The exact bytes the #931 contract signs, exported so issuers and tests share it. */
export function computeCalibrationSignedDigest(
  artifact: CalibrationAttestationArtifactV1,
): Buffer {
  const unsigned = {
    schemaVersion: artifact.schemaVersion,
    artifactId: artifact.artifactId,
    subject: artifact.subject,
    ...(artifact.calibration !== undefined ? { calibration: artifact.calibration } : {}),
    issuer: artifact.issuer,
    attestation: artifact.attestation,
    signature: {
      algorithm: artifact.signature.algorithm,
      ...(artifact.signature.signerPublicKey !== undefined
        ? { signerPublicKey: artifact.signature.signerPublicKey }
        : {}),
    },
  };
  return createHash('sha3-256').update(stableStringify(unsigned)).digest();
}

function parseIsoTimestamp(value: string): Date | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Schema-check and normalize an artifact; null when it is not a valid v1 artifact. */
export function parseCalibrationArtifact(rawArtifact: unknown): ParsedArtifact | null {
  if (!isObject(rawArtifact)) {
    return null;
  }

  if (rawArtifact.schemaVersion !== 'wrf-calibration-attestation/v1') {
    return null;
  }
  if (typeof rawArtifact.artifactId !== 'string' || rawArtifact.artifactId.trim().length === 0) {
    return null;
  }
  if (!isObject(rawArtifact.subject) || typeof rawArtifact.subject.stationId !== 'string') {
    return null;
  }
  const ownerAddress = rawArtifact.subject.ownerAddress;
  if (ownerAddress !== undefined && (typeof ownerAddress !== 'string' || !/^0x[0-9a-f]{40}$/.test(ownerAddress))) {
    return null;
  }
  let calibration: CalibrationDetailsV1 | undefined;
  if (rawArtifact.calibration !== undefined) {
    if (!isObject(rawArtifact.calibration)) {
      return null;
    }
    const details = rawArtifact.calibration;
    if (Object.keys(details).some(key => !(CALIBRATION_DETAIL_FIELDS as readonly string[]).includes(key))) {
      return null;
    }
    calibration = {};
    for (const field of CALIBRATION_DETAIL_FIELDS) {
      const value = details[field];
      if (value === undefined) continue;
      if (
        typeof value !== 'string' ||
        value.trim().length === 0 ||
        value.length > CALIBRATION_DETAIL_MAX_LEN ||
        hasControlCharacters(value)
      ) {
        return null;
      }
      calibration[field] = value;
    }
  }
  if (
    !isObject(rawArtifact.issuer) ||
    typeof rawArtifact.issuer.issuerId !== 'string' ||
    !Array.isArray(rawArtifact.issuer.certificateChain)
  ) {
    return null;
  }
  if (
    !isObject(rawArtifact.attestation) ||
    typeof rawArtifact.attestation.issuedAt !== 'string' ||
    typeof rawArtifact.attestation.expiresAt !== 'string'
  ) {
    return null;
  }
  if (
    !isObject(rawArtifact.signature) ||
    typeof rawArtifact.signature.algorithm !== 'string' ||
    rawArtifact.signature.algorithm.trim().length === 0 ||
    typeof rawArtifact.signature.value !== 'string' ||
    rawArtifact.signature.value.trim().length === 0
  ) {
    return null;
  }

  const certificateChain: CalibrationCertificateRecord[] = [];
  for (const cert of rawArtifact.issuer.certificateChain) {
    if (!isObject(cert)) {
      return null;
    }
    if (
      typeof cert.certId !== 'string' ||
      typeof cert.subject !== 'string' ||
      typeof cert.issuer !== 'string' ||
      typeof cert.notBefore !== 'string' ||
      typeof cert.notAfter !== 'string' ||
      typeof cert.fingerprintSha256 !== 'string'
    ) {
      return null;
    }
    certificateChain.push({
      certId: cert.certId,
      subject: cert.subject,
      issuer: cert.issuer,
      notBefore: cert.notBefore,
      notAfter: cert.notAfter,
      fingerprintSha256: cert.fingerprintSha256,
    });
  }

  const normalizedArtifact: CalibrationAttestationArtifactV1 = {
    schemaVersion: 'wrf-calibration-attestation/v1',
    artifactId: rawArtifact.artifactId,
    subject: {
      stationId: rawArtifact.subject.stationId,
      ...(typeof ownerAddress === 'string' ? { ownerAddress } : {}),
    },
    ...(calibration !== undefined ? { calibration } : {}),
    issuer: {
      issuerId: rawArtifact.issuer.issuerId,
      certificateChain,
    },
    attestation: {
      issuedAt: rawArtifact.attestation.issuedAt,
      expiresAt: rawArtifact.attestation.expiresAt,
    },
    signature: {
      algorithm: rawArtifact.signature.algorithm,
      value: rawArtifact.signature.value,
      ...(typeof rawArtifact.signature.signerPublicKey === 'string'
        ? { signerPublicKey: rawArtifact.signature.signerPublicKey }
        : {}),
    },
  };

  const artifactDigestSha256 = computeSha256Hex(stableStringify(normalizedArtifact));
  return {
    raw: normalizedArtifact,
    artifactDigestSha256,
  };
}

export class CalibrationAttestationVerifierService {
  private readonly trustRoots: CalibrationTrustRoot[];

  private readonly revokedCertificates = new Map<string, CalibrationRevocationEntry>();

  private readonly artifactResolver: CalibrationAttestationArtifactResolver;

  private readonly now: () => Date;

  private readonly summaries = new Map<string, CalibrationAttestationVerificationSummary>();

  private readonly summariesByCommitId = new Map<string, string>();

  private readonly artifactIdBindings = new Map<string, string>();

  constructor(options: CalibrationAttestationVerifierServiceOptions = {}) {
    this.trustRoots =
      options.trustRoots ?? parseTrustRootsFromEnv();
    const revocations = options.revokedCertificates ?? parseRevocationsFromEnv();
    for (const revocation of revocations) {
      this.revokedCertificates.set(
        revocation.fingerprintSha256.toLowerCase(),
        revocation,
      );
    }
    this.artifactResolver =
      options.artifactResolver ?? new GatewayCalibrationAttestationArtifactResolver();
    this.now = options.now ?? (() => new Date());
  }

  getSummaryByVerificationId(
    verificationId: string,
  ): CalibrationAttestationVerificationSummary | null {
    return this.summaries.get(verificationId) ?? null;
  }

  getSummaryByCommitId(commitId: string): CalibrationAttestationVerificationSummary | null {
    const verificationId = this.summariesByCommitId.get(commitId);
    if (!verificationId) {
      return null;
    }
    return this.summaries.get(verificationId) ?? null;
  }

  querySummaries(filters: {
    commitId?: string;
    stationId?: string;
    canonicalCalibrationAttestationCid?: string;
    status?: CalibrationVerificationStatus;
    limit?: number;
  }): CalibrationAttestationVerificationSummary[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 1000);
    let values = Array.from(this.summaries.values());

    values.sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt));

    if (filters.commitId) {
      values = values.filter(item => item.commitId === filters.commitId);
    }
    if (filters.stationId) {
      values = values.filter(item => item.stationId === filters.stationId);
    }
    if (filters.canonicalCalibrationAttestationCid) {
      values = values.filter(
        item =>
          item.canonicalCalibrationAttestationCid ===
          filters.canonicalCalibrationAttestationCid,
      );
    }
    if (filters.status) {
      values = values.filter(item => item.status === filters.status);
    }

    return values.slice(0, limit);
  }

  async verifyCalibrationAttestation(
    request: CalibrationAttestationVerifierRequest,
  ): Promise<CalibrationAttestationVerificationSummary> {
    const nowIso = this.now().toISOString();
    const reasonCodes = new Set<CalibrationVerificationReasonCode>();

    const canonicalCid = request.canonicalCalibrationAttestationCid
      ? canonicalizeCalibrationAttestationCid(request.canonicalCalibrationAttestationCid)
      : canonicalizeCalibrationAttestationCid(request.calibrationAttestationCid);

    if (!canonicalCid) {
      reasonCodes.add(CalibrationVerificationReasonCodes.CID_INVALID);
      return this.persistSummary({
        request,
        status: 'rejected',
        reasonCodes,
        canonicalCid: request.canonicalCalibrationAttestationCid || request.calibrationAttestationCid,
        nowIso,
        artifactId: null,
        artifactDigestSha256: null,
        issuerId: null,
        trustRootId: null,
      });
    }

    let resolvedArtifact: unknown | null = null;
    try {
      resolvedArtifact = await this.artifactResolver.fetchByCanonicalCid(canonicalCid);
    } catch {
      reasonCodes.add(CalibrationVerificationReasonCodes.ARTIFACT_FETCH_ERROR);
      return this.persistSummary({
        request,
        status: 'error',
        reasonCodes,
        canonicalCid,
        nowIso,
        artifactId: null,
        artifactDigestSha256: null,
        issuerId: null,
        trustRootId: null,
      });
    }

    if (!resolvedArtifact) {
      reasonCodes.add(CalibrationVerificationReasonCodes.ARTIFACT_NOT_FOUND);
      return this.persistSummary({
        request,
        status: 'rejected',
        reasonCodes,
        canonicalCid,
        nowIso,
        artifactId: null,
        artifactDigestSha256: null,
        issuerId: null,
        trustRootId: null,
      });
    }

    const parsed = this.parseArtifact(resolvedArtifact);
    if (!parsed) {
      reasonCodes.add(CalibrationVerificationReasonCodes.ARTIFACT_SCHEMA_INVALID);
      return this.persistSummary({
        request,
        status: 'rejected',
        reasonCodes,
        canonicalCid,
        nowIso,
        artifactId: null,
        artifactDigestSha256: null,
        issuerId: null,
        trustRootId: null,
      });
    }

    const now = this.now();
    const issuedAt = parseIsoTimestamp(parsed.raw.attestation.issuedAt);
    const expiresAt = parseIsoTimestamp(parsed.raw.attestation.expiresAt);
    if (!issuedAt || !expiresAt || issuedAt.getTime() >= expiresAt.getTime()) {
      reasonCodes.add(CalibrationVerificationReasonCodes.ATTESTATION_TIME_WINDOW_INVALID);
    } else {
      if (now.getTime() < issuedAt.getTime()) {
        reasonCodes.add(CalibrationVerificationReasonCodes.ATTESTATION_NOT_YET_VALID);
      }
      if (now.getTime() > expiresAt.getTime()) {
        reasonCodes.add(CalibrationVerificationReasonCodes.ATTESTATION_EXPIRED);
      }
    }

    if (parsed.raw.subject.stationId !== request.stationId) {
      reasonCodes.add(CalibrationVerificationReasonCodes.SUBJECT_STATION_MISMATCH);
    }

    const trustRootValidation = this.validateCertificateChain(parsed.raw, now);
    for (const reasonCode of trustRootValidation.reasonCodes) {
      reasonCodes.add(reasonCode);
    }

    // #931 — cryptographic signature verification (replaces the interim
    // reject-everything guard from #947). Every failure is a specific reason
    // code; SIGNATURE_VERIFICATION_UNAVAILABLE now means what it says — the
    // crypto layer itself failed — and nothing else.
    for (const reasonCode of this.verifyArtifactSignature(parsed.raw)) {
      reasonCodes.add(reasonCode);
    }

    const existingStationBinding = this.artifactIdBindings.get(parsed.raw.artifactId);
    if (existingStationBinding && existingStationBinding !== request.stationId) {
      reasonCodes.add(CalibrationVerificationReasonCodes.ARTIFACT_CLONED);
    }

    const status: CalibrationVerificationStatus =
      reasonCodes.size === 0 ? 'verified' : 'rejected';

    if (status === 'verified') {
      this.artifactIdBindings.set(parsed.raw.artifactId, request.stationId);
      reasonCodes.add(CalibrationVerificationReasonCodes.OK);
    }

    return this.persistSummary({
      request,
      status,
      reasonCodes,
      canonicalCid,
      nowIso,
      artifactId: parsed.raw.artifactId,
      artifactDigestSha256: parsed.artifactDigestSha256,
      issuerId: parsed.raw.issuer.issuerId,
      trustRootId: trustRootValidation.trustRootId,
    });
  }

  private parseArtifact(rawArtifact: unknown): ParsedArtifact | null {
    return parseCalibrationArtifact(rawArtifact);
  }

  /**
   * #931 v1 signature verification. Trust shape, stated plainly:
   * - Only `ed25519-sha3-256-json-v1` verifies; any other algorithm is a
   *   SPECIFIC unsupported-algorithm rejection, not a blanket one.
   * - The signer key must be BOUND to the certificate chain: the leaf cert's
   *   fingerprintSha256 must equal sha256(raw signer pubkey bytes). Root trust
   *   is the existing fingerprint match in validateCertificateChain, so for the
   *   supported depth-1 chain the signer key IS the trust-root key.
   * - Chain depth > 1 is rejected as unsupported: intermediate certs carry no
   *   signature material in this format, so deeper chains cannot be
   *   cryptographically verified — pretending otherwise would be #947's blunt
   *   guard wearing a chain costume. Deeper chains are a v2 with real certs.
   */
  private verifyArtifactSignature(
    artifact: CalibrationAttestationArtifactV1,
  ): Set<CalibrationVerificationReasonCode> {
    const reasonCodes = new Set<CalibrationVerificationReasonCode>();

    if (artifact.signature.algorithm !== CALIBRATION_SIGNATURE_ALGORITHM) {
      reasonCodes.add(CalibrationVerificationReasonCodes.UNSUPPORTED_ALG);
      return reasonCodes;
    }

    const signerPublicKey = artifact.signature.signerPublicKey;
    if (typeof signerPublicKey !== 'string' || !isHex64(signerPublicKey)) {
      reasonCodes.add(CalibrationVerificationReasonCodes.SIGNER_KEY_INVALID);
      return reasonCodes;
    }
    if (!isHex128(artifact.signature.value)) {
      reasonCodes.add(CalibrationVerificationReasonCodes.SIGNATURE_INVALID);
      return reasonCodes;
    }

    const chain = artifact.issuer.certificateChain;
    if (chain.length !== 1) {
      reasonCodes.add(CalibrationVerificationReasonCodes.CHAIN_DEPTH_UNSUPPORTED);
      return reasonCodes;
    }
    const signerKeyBytes = Buffer.from(signerPublicKey, 'hex');
    const signerFingerprint = createHash('sha256').update(signerKeyBytes).digest('hex');
    if (signerFingerprint !== chain[0].fingerprintSha256.toLowerCase()) {
      reasonCodes.add(CalibrationVerificationReasonCodes.SIGNER_NOT_BOUND_TO_CHAIN);
      return reasonCodes;
    }

    try {
      const publicKey = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, signerKeyBytes]),
        format: 'der',
        type: 'spki',
      });
      const digest = computeCalibrationSignedDigest(artifact);
      const valid = cryptoVerify(
        null,
        digest,
        publicKey,
        Buffer.from(artifact.signature.value, 'hex'),
      );
      if (!valid) {
        reasonCodes.add(CalibrationVerificationReasonCodes.SIGNATURE_INVALID);
      }
    } catch {
      // The crypto layer itself failed — the one case this code is for now.
      reasonCodes.add(
        CalibrationVerificationReasonCodes.SIGNATURE_VERIFICATION_UNAVAILABLE,
      );
    }

    return reasonCodes;
  }

  private validateCertificateChain(
    artifact: CalibrationAttestationArtifactV1,
    now: Date,
  ): {
    reasonCodes: Set<CalibrationVerificationReasonCode>;
    trustRootId: string | null;
  } {
    const reasonCodes = new Set<CalibrationVerificationReasonCode>();
    const chain = artifact.issuer.certificateChain;

    if (chain.length === 0) {
      reasonCodes.add(CalibrationVerificationReasonCodes.CERT_CHAIN_MISSING);
      return { reasonCodes, trustRootId: null };
    }

    if (chain[0].subject !== artifact.issuer.issuerId) {
      reasonCodes.add(CalibrationVerificationReasonCodes.CERT_CHAIN_BROKEN);
    }

    for (let index = 0; index < chain.length; index += 1) {
      const cert = chain[index];
      if (!isHexSha256(cert.fingerprintSha256)) {
        reasonCodes.add(CalibrationVerificationReasonCodes.CERT_CHAIN_BROKEN);
        continue;
      }

      const notBefore = parseIsoTimestamp(cert.notBefore);
      const notAfter = parseIsoTimestamp(cert.notAfter);
      if (!notBefore || !notAfter || notBefore.getTime() >= notAfter.getTime()) {
        reasonCodes.add(CalibrationVerificationReasonCodes.CERT_CHAIN_BROKEN);
        continue;
      }

      if (now.getTime() < notBefore.getTime()) {
        reasonCodes.add(CalibrationVerificationReasonCodes.CERT_NOT_YET_VALID);
      }
      if (now.getTime() > notAfter.getTime()) {
        reasonCodes.add(CalibrationVerificationReasonCodes.CERT_EXPIRED);
      }

      const revoked = this.revokedCertificates.get(cert.fingerprintSha256.toLowerCase());
      if (revoked) {
        reasonCodes.add(CalibrationVerificationReasonCodes.CERT_REVOKED);
      }

      if (index < chain.length - 1) {
        const parent = chain[index + 1];
        if (cert.issuer !== parent.subject) {
          reasonCodes.add(CalibrationVerificationReasonCodes.CERT_CHAIN_BROKEN);
        }
      }
    }

    const activeRoots = this.trustRoots.filter(root => root.active !== false);
    if (activeRoots.length === 0) {
      reasonCodes.add(CalibrationVerificationReasonCodes.TRUST_ROOT_UNCONFIGURED);
      return {
        reasonCodes,
        trustRootId: null,
      };
    }

    const rootCert = chain[chain.length - 1];
    const matchedRoot = activeRoots.find(
      root =>
        root.fingerprintSha256.toLowerCase() === rootCert.fingerprintSha256.toLowerCase() &&
        root.subject === rootCert.subject,
    );

    if (!matchedRoot) {
      reasonCodes.add(CalibrationVerificationReasonCodes.ISSUER_UNTRUSTED_ROOT);
      return {
        reasonCodes,
        trustRootId: null,
      };
    }

    return {
      reasonCodes,
      trustRootId: matchedRoot.rootId,
    };
  }

  private persistSummary(args: {
    request: CalibrationAttestationVerifierRequest;
    status: CalibrationVerificationStatus;
    reasonCodes: Set<CalibrationVerificationReasonCode>;
    canonicalCid: string;
    nowIso: string;
    artifactId: string | null;
    artifactDigestSha256: string | null;
    issuerId: string | null;
    trustRootId: string | null;
  }): CalibrationAttestationVerificationSummary {
    const sortedReasonCodes = Array.from(args.reasonCodes).sort();
    const verificationId = computeSha256Hex(
      [
        args.request.commitId,
        args.request.stationId,
        args.canonicalCid,
        args.status,
        args.artifactDigestSha256 ?? 'null',
        sortedReasonCodes.join(','),
      ].join('|'),
    );

    const summary: CalibrationAttestationVerificationSummary = {
      schemaVersion: 'calibration_attestation_verifier_summary/v1',
      verificationId,
      status: args.status,
      reasonCodes: sortedReasonCodes,
      commitId: args.request.commitId,
      stationId: args.request.stationId,
      canonicalCalibrationAttestationCid: args.canonicalCid,
      artifactId: args.artifactId,
      artifactDigestSha256: args.artifactDigestSha256,
      issuerId: args.issuerId,
      trustRootId: args.trustRootId,
      verifiedAt: args.nowIso,
    };

    this.summaries.set(verificationId, summary);
    this.summariesByCommitId.set(args.request.commitId, verificationId);
    return summary;
  }
}

export const calibrationAttestationVerifier = new CalibrationAttestationVerifierService();
