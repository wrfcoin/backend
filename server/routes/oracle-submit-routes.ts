import crypto from 'node:crypto';
import express, { Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
// authMiddleware.js is CJS; import the .cjs shim for ESM compatibility.
import _authMiddlewareMod from '../middleware/authMiddleware.js';
// requireAuth is a single handler; the role guards are handler CHAINS (arrays)
// in authMiddleware.js, so they must be typed as RequestHandler[].
const authMiddleware = _authMiddlewareMod as {
  requireAuth: import('express').RequestHandler;
  requireAdmin: import('express').RequestHandler[];
  requireValidator: import('express').RequestHandler[];
  requireFoundationMember: import('express').RequestHandler[];
};
import {
  buildCanonicalReading,
  canonicalizeJson,
  CommitRevealValidationError,
  computeCommitId,
} from '../../shared/commit-reveal-hash.js';
import { buildCommitAuthorizationMessage, COMMIT_AUTH_DOMAIN } from '../../shared/commit-authorization.js';
import { core4ReaderHeaders } from '../utils/core4-reader-credential.js';
import { core4ContributorHeaders } from '../utils/core4-contributor-credential.js';
import { extractCore4Data, fetchCore4Json } from '../../shared/core4-route-client.js';
import { executeQuery } from '../../database/connection.js';
import { normalizeCommitRevealReading } from '../../shared/types/weather-types.js';
import { blockchainLogger } from '../utils/logger.js';
import { isReservedMobileStationId } from '../../shared/mobile-station-messages.js';

const router = express.Router();

// One phone reading needs prepare + signed submit. Give each phase its own
// bounded budget after requireAuth, keyed by the same verified reward owner
// used below. Refreshing a JWT or selecting another station cannot mint quota.
// The live entrypoint's global IP limiter remains an aggregate abuse bound.
function walletStepLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      const user = (req as Request & { user?: Record<string, unknown> }).user;
      const owner = user?.walletAddress || user?.address || user?.sub;
      return typeof owner === 'string' && owner.trim()
        ? `wallet:${owner.trim().toLowerCase()}`
        : `ip:${ipKeyGenerator(req.ip || 'unknown')}`;
    },
  });
}
const oraclePrepareLimiter = walletStepLimiter();
const oracleSubmitLimiter = walletStepLimiter();

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

function normalizeStationId(body: Record<string, unknown>, location: unknown): string {
  if (body.stationId || body.station_id) {
    return String(body.stationId || body.station_id).slice(0, 128);
  }
  if (location && typeof location === 'object') {
    const record = location as Record<string, unknown>;
    return String(
      record.stationId ||
        record.station_id ||
        record.id ||
        record.name ||
        'mobile-oracle'
    ).slice(0, 128);
  }
  return String(location || 'mobile-oracle')
    .replace(/[^a-zA-Z0-9_.:-]+/g, '-')
    .slice(0, 128);
}

function timestampToSeconds(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed)
    ? Math.floor(parsed / 1000)
    : Math.floor(Date.now() / 1000);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function applyLegacyFieldAliases(reading: Record<string, unknown>): Record<string, unknown> {
  const result = { ...reading };
  const assignIfMissing = (target: string, ...sources: string[]) => {
    if (result[target] !== undefined) return;
    for (const source of sources) {
      if (result[source] !== undefined) {
        result[target] = result[source];
        return;
      }
    }
  };

  assignIfMissing('temperature_c', 'temperature', 'temp_c');
  assignIfMissing('humidity_percent', 'humidity', 'humidity_pct');
  assignIfMissing('pressure_hpa', 'pressure');
  assignIfMissing('wind_speed_ms', 'wind_mps', 'windSpeed', 'wind_speed');
  assignIfMissing('precipitation_mm', 'rainfall_mm', 'rainfall', 'precipitation');
  return result;
}

/**
 * Thrown when a `dataType`/`value` single-measurement payload (the mobile
 * collector shape) cannot be mapped: an unrecognized `dataType`, or a
 * non-scalar `value`. Previously such input was silently dropped, so the
 * measurement fell through to 0 and still earned a reward (mobile#217). The
 * route maps this to a 400 instead of fail-open.
 */
export class OracleSubmitValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OracleSubmitValidationError';
  }
}

/** A weather measurement must be a finite numeric scalar (number or numeric string). */
function isScalarMeasurement(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'string') {
    return value.trim() !== '' && Number.isFinite(Number(value));
  }
  return false;
}

function applyDataTypeValue(
  reading: Record<string, unknown>,
  dataType: unknown,
  value: unknown
): Record<string, unknown> {
  // Only the mobile single-measurement shape carries top-level dataType+value.
  // Other payload shapes (readings[]/reading/data) don't; leave them untouched.
  if (value === undefined && (dataType === undefined || dataType === null)) {
    return reading;
  }
  if (typeof dataType !== 'string' || dataType.trim() === '') {
    throw new OracleSubmitValidationError(
      'dataType must be a non-empty string when submitting a single measurement value'
    );
  }

  const result = { ...reading };
  const normalizedType = dataType.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  // Field-name aliases include the mobile collector's `barometric_pressure`.
  const targetField = (() => {
    if (['temperature', 'temperature_c', 'temp', 'temp_c'].includes(normalizedType)) {
      return 'temperature_c';
    }
    if (['humidity', 'humidity_percent', 'humidity_pct'].includes(normalizedType)) {
      return 'humidity_percent';
    }
    if (['pressure', 'pressure_hpa', 'barometric_pressure', 'barometricpressure'].includes(normalizedType)) {
      return 'pressure_hpa';
    }
    if (['wind', 'wind_speed', 'wind_speed_ms', 'wind_mps'].includes(normalizedType)) {
      return 'wind_speed_ms';
    }
    if (['rainfall', 'rainfall_mm', 'precipitation', 'precipitation_mm'].includes(normalizedType)) {
      return 'precipitation_mm';
    }
    return null;
  })();

  if (targetField === null) {
    // #217: reject rather than silently zeroing an unrecognized measurement.
    throw new OracleSubmitValidationError(`Unrecognized dataType '${dataType}'`);
  }
  if (!isScalarMeasurement(value)) {
    // #217: the mobile bug shipped `value` as an object; reject non-scalars.
    throw new OracleSubmitValidationError(
      `value for dataType '${dataType}' must be a numeric scalar, got ${
        Array.isArray(value) ? 'array' : typeof value
      }`
    );
  }
  result[targetField] = value;
  return result;
}

function buildSubmitReading(body: Record<string, unknown>) {
  const baseReading =
    (Array.isArray(body.readings) && asRecord(body.readings[0])) ||
    asRecord(body.reading) ||
    asRecord(body.data) ||
    body;
  const withAliases = applyLegacyFieldAliases(baseReading);
  const withDataTypeValue = applyDataTypeValue(withAliases, body.dataType, body.value);
  return buildCanonicalReading(normalizeCommitRevealReading(withDataTypeValue));
}

const CONTRIBUTION_TYPE = 'contribution';

type Core4Credential = 'contributor' | 'reader';

const CORE4_CREDENTIALS: Record<
  Core4Credential,
  { env: 'WRFCOIN_CONTRIBUTOR_TOKEN' | 'WRFCOIN_READER_TOKEN'; code: string; message: string }
> = {
  contributor: {
    env: 'WRFCOIN_CONTRIBUTOR_TOKEN',
    code: 'CORE4_CONTRIBUTOR_CREDENTIAL_UNCONFIGURED',
    message:
      'Station submission is unavailable: the backend core4 Contributor credential is not configured',
  },
  reader: {
    env: 'WRFCOIN_READER_TOKEN',
    code: 'CORE4_READER_CREDENTIAL_UNCONFIGURED',
    message:
      'Station submission is unavailable: the backend core4 Reader credential is not configured',
  },
};

/**
 * A short, log-safe description of core4's rejection body so a 400/422 is
 * attributable. Keeps only a string code and message, strips hex addresses and
 * decimal numbers (coordinates, readings) and caps the length.
 */
export function core4ErrorDetail(payload: unknown): { code?: string; message?: string } {
  const scrub = (v: unknown): string | undefined => {
    if (typeof v !== 'string' || v === '') return undefined;
    return v
      .replace(/\b(?:0x)?[0-9a-fA-F]{16,}\b/g, '[hex]')
      // Any decimal (incl. leading-dot), exponent form, or long digit run: coordinates and readings.
      .replace(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g, (m) =>
        /[.eE]/.test(m) || m.replace(/\D/g, '').length >= 4 ? '[n]' : m)
      .slice(0, 200);
  };
  if (typeof payload === 'string') return { message: scrub(payload) };
  if (!payload || typeof payload !== 'object') return {};
  const o = payload as Record<string, unknown>;
  const err = o.error;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    return { code: scrub(e.code), message: scrub(e.message) };
  }
  return { code: scrub(o.code) ?? (typeof err === 'string' && o.message ? scrub(err) : undefined), message: scrub(o.message) ?? scrub(err) };
}

/** core4's answer to a commit id it has already accepted. */
function isReplayRejection(payload: unknown): boolean {
  const d = core4ErrorDetail(payload);
  return /launch protocol replay detected/i.test(`${d.message ?? ''} ${d.code ?? ''}`);
}

function sendErrorEnvelope(res: Response, status: number, code: string, message: string) {
  res.status(status).json({
    success: false,
    error: { code, message },
    timestamp: new Date().toISOString(),
  });
}

/**
 * #1284: the core4 bearer for this call is a SERVER credential, never the
 * caller's backend JWT (core4's require_role answers 403 "Invalid API token"
 * for any bearer outside its own token store). Returns null after sending a
 * 503 when the credential is unset — without it core4 would answer 401, which
 * the app would misread as its own session expiring.
 */
function requireCore4Token(res: Response, credential: Core4Credential): string | null {
  const spec = CORE4_CREDENTIALS[credential];
  const token = process.env[spec.env]?.trim();
  if (token) return token;
  blockchainLogger.warn(`${spec.env} is not set; POST /api/oracle/submit-data returns 503`);
  sendErrorEnvelope(res, 503, spec.code, spec.message);
  return null;
}

interface PreparedSubmission {
  contributor: string;
  stationId: string;
  payload: ReturnType<typeof buildSubmitReading>;
  nonce: string;
  timestampSeconds: number;
  commitHash: string;
}

/**
 * Validation, caller binding and the station-owner guard shared by prepare and
 * submit. Sends the error response and returns null on any refusal; runs no
 * core4 call and reads no core4 credential.
 */
async function prepareSubmission(
  req: Request,
  res: Response,
  { requireAuthPubkey }: { requireAuthPubkey: boolean }
): Promise<PreparedSubmission | null> {
  const body = (req.body || {}) as Record<string, unknown>;
  const { dataType, location, value, timestamp } = body;

  if (!dataType || !location || value === undefined || !timestamp) {
    res.status(400).json({ error: 'Missing required fields' });
    return null;
  }

  let payload;
  try {
    payload = buildSubmitReading(body);
  } catch (validationError) {
    // #217: reject unmappable / non-scalar measurements and physically-
    // impossible (present-but-unparseable) pressure with a 400 instead of
    // silently recording a zeroed, still-rewarded contribution.
    if (
      validationError instanceof OracleSubmitValidationError ||
      validationError instanceof CommitRevealValidationError
    ) {
      res.status(400).json({ error: validationError.message });
      return null;
    }
    throw validationError;
  }
  const stationId = normalizeStationId(body, location);
  const user = (req as Request & { user?: Record<string, unknown> }).user;
  // SECURITY (#886): the reward-attribution identity MUST come from the
  // authenticated caller's own JWT, never from the client-supplied request
  // body — otherwise one authenticated session can attribute unlimited
  // submissions to arbitrary wallet addresses (Sybil reward farming).
  const ownWallet = (user?.walletAddress || user?.address || user?.sub) as
    | string
    | undefined;
  if (!ownWallet) {
    res.status(400).json({ error: 'Authenticated wallet address is required' });
    return null;
  }
  const bodyContributor = body.contributor;
  if (
    bodyContributor !== undefined &&
    bodyContributor !== null &&
    bodyContributor !== '' &&
    String(bodyContributor).toLowerCase() !== ownWallet.toLowerCase()
  ) {
    res.status(403).json({
      error: 'Forbidden: contributor must match your authenticated wallet address',
    });
    return null;
  }

  // SECURITY (#1284, confused deputy): the backend lends its own core4
  // Contributor credential to this call, so it must only ever submit for a
  // station the caller owns. An unregistered station (including the shared
  // 'mobile-oracle' fallback) is refused the same way, before any core4 call.
  let ownerAddress: unknown;
  try {
    const lookup = await executeQuery(
      'SELECT owner_address FROM weather_stations WHERE station_id = $1 LIMIT 1',
      [stationId]
    );
    ownerAddress = lookup.rows?.[0]?.owner_address;
  } catch (lookupError) {
    blockchainLogger.error('Station ownership lookup failed for oracle submit', {
      stationId,
      error: lookupError instanceof Error ? lookupError.message : String(lookupError),
    });
    sendErrorEnvelope(
      res,
      503,
      'STATION_OWNERSHIP_UNAVAILABLE',
      'Station ownership could not be verified; try again later'
    );
    return null;
  }
  if (
    typeof ownerAddress !== 'string' ||
    ownerAddress.toLowerCase() !== ownWallet.toLowerCase()
  ) {
    sendErrorEnvelope(
      res,
      403,
      'STATION_NOT_OWNED',
      'Forbidden: this station is not registered to your wallet'
    );
    return null;
  }

  // SECURITY (#1288 B6): core4 checks only that the commit-authorization
  // signature verifies under the SUPPLIED auth_pubkey, not that the key belongs
  // to the station's owner. For a per-phone (`mob-`) station this is the binding:
  // the key must be the collect key the wallet authorised at registration. A
  // replaced (rotated-out) key, the wallet key, or any other key is refused
  // here, before any core4 call. Non-mobile stations are not touched.
  if (isReservedMobileStationId(stationId)) {
    const refusal = await checkCollectKey(stationId, ownWallet, body.auth_pubkey, requireAuthPubkey);
    if (refusal) {
      sendErrorEnvelope(res, refusal.status, refusal.code, refusal.message);
      return null;
    }
  }

  const timestampSeconds = timestampToSeconds(String(timestamp));
  const nonce = String(
    body.nonce ||
      crypto
        .createHash('sha256')
        .update(`${canonicalJson(payload)}:${timestampSeconds}`)
        .digest('hex')
        .slice(0, 32)
  );
  const commitHash = computeCommitId({
    data: payload,
    nonce,
    stationId,
    timestamp: timestampSeconds,
  });
  return { contributor: ownWallet, stationId, payload, nonce, timestampSeconds, commitHash };
}

/**
 * Null when the commit auth key is the station's registered collect key.
 * `prepare` runs before the phone has signed, so it checks a key only if one is
 * supplied; `submit` (requireAuthPubkey) refuses a missing key as well.
 * A `mob-` station without a registration row fails closed.
 */
async function checkCollectKey(
  stationId: string,
  ownWallet: string,
  authPubkey: unknown,
  requireAuthPubkey: boolean
): Promise<{ status: number; code: string; message: string } | null> {
  const mismatch = {
    status: 403,
    code: 'COLLECT_KEY_MISMATCH',
    message: 'Forbidden: auth_pubkey is not the collect key registered for this station',
  };
  let registered: unknown;
  let registrationStatus: unknown;
  try {
    const lookup = await executeQuery(
      'SELECT collect_pubkey, status FROM mobile_station_registrations WHERE station_id = $1 AND owner_address = $2 LIMIT 1',
      [stationId, ownWallet.toLowerCase()]
    );
    registered = lookup.rows?.[0]?.collect_pubkey;
    registrationStatus = lookup.rows?.[0]?.status;
  } catch (lookupError) {
    blockchainLogger.error('Collect key lookup failed for oracle submit', {
      stationId,
      error: lookupError instanceof Error ? lookupError.message : String(lookupError),
    });
    return {
      status: 503,
      code: 'STATION_OWNERSHIP_UNAVAILABLE',
      message: 'Station ownership could not be verified; try again later',
    };
  }
  if (typeof registered !== 'string' || registered === '') return mismatch;
  if (authPubkey === undefined || authPubkey === null) {
    if (requireAuthPubkey) return mismatch;
  } else if (
    typeof authPubkey !== 'string' ||
    authPubkey.trim().toLowerCase() !== registered.toLowerCase()
  ) {
    return mismatch;
  }
  // Owner ruling 2026-09-30: a station that is not yet `on_chain` (db_only /
  // submitted) is unknown to core4, which would reject the commit (400) and
  // reveal (422). Refuse here, after the ownership + key checks (so a non-owner
  // learns nothing about status), and never forward. Fails closed on a
  // missing/unknown status.
  if (registrationStatus !== 'on_chain') {
    blockchainLogger.info('Oracle submit refused: mobile station not active', { stationId });
    return {
      status: 409,
      code: 'STATION_NOT_ACTIVE',
      message: 'Station awaiting activation',
    };
  }
  return null;
}

/** The declared chain identity, or null unless BOTH ids are set (never a guessed default). */
function declaredChainIdentity(): { chainId: string; networkId: string } | null {
  const chainId = process.env.WRFCOIN_CHAIN_ID?.trim();
  const networkId = process.env.WRFCOIN_NETWORK_ID?.trim();
  return chainId && networkId ? { chainId, networkId } : null;
}

router.use(authMiddleware.requireAuth);

/**
 * Step 1 of the phone-signed submit (#1284). Returns the commit id and the
 * exact commit-authorization inputs the client signs with its wallet key.
 * It is a pure function of the body (the nonce is derived deterministically
 * when the client sends none), so step 2 — POST /submit-data with the same
 * body plus the returned nonce and `auth_pubkey`/`auth_signature` — commits
 * the same commit id. No core4 call is made here.
 */
router.post('/submit-data/prepare', oraclePrepareLimiter, async (req: Request, res: Response) => {
  try {
    const prepared = await prepareSubmission(req, res, { requireAuthPubkey: false });
    if (!prepared) return;
    const identity = declaredChainIdentity();
    res.json({
      success: true,
      contributor: prepared.contributor,
      stationId: prepared.stationId,
      commitId: prepared.commitHash,
      nonce: prepared.nonce,
      timestamp: prepared.timestampSeconds,
      authorization: {
        scheme: COMMIT_AUTH_DOMAIN,
        stationId: prepared.stationId,
        commitId: prepared.commitHash,
        contributionType: CONTRIBUTION_TYPE,
        chainId: identity?.chainId ?? null,
        networkId: identity?.networkId ?? null,
        messageHex: identity
          ? buildCommitAuthorizationMessage({
              ...identity,
              stationId: prepared.stationId,
              commitId: prepared.commitHash,
              contributionType: CONTRIBUTION_TYPE,
            }).toString('hex')
          : null,
      },
    });
  } catch (error) {
    blockchainLogger.error('Error preparing oracle submission', {
      error: { message: error instanceof Error ? error.message : String(error) },
    });
    res.status(500).json({ error: 'Failed to prepare submission' });
  }
});

router.post('/submit-data', oracleSubmitLimiter, async (req: Request, res: Response) => {
  try {
    const prepared = await prepareSubmission(req, res, { requireAuthPubkey: true });
    if (!prepared) return;
    const contributorToken = requireCore4Token(res, 'contributor');
    if (!contributorToken) return;
    const readerToken = requireCore4Token(res, 'reader');
    if (!readerToken) return;

    const { contributor, stationId, payload, nonce, timestampSeconds, commitHash } = prepared;
    const contributorHeaders = core4ContributorHeaders(req.headers);
    const readerHeaders = core4ReaderHeaders(req.headers);

    // Forward the normalized key used by the collect-key binding above (#1313).
    // The signature bytes are unchanged; core4 verifies the authorization.
    const body = req.body as Record<string, unknown>;
    const authPubkey = typeof body.auth_pubkey === 'string'
      ? body.auth_pubkey.trim().toLowerCase()
      : body.auth_pubkey;
    const authSignature = body.auth_signature;

    const commitResponse = await fetchCore4Json('/transactions/contribution/commit', {
      method: 'POST',
      headers: contributorHeaders,
      body: {
        contributor,
        station_id: stationId,
        commit_hash: commitHash,
        ...(authPubkey !== undefined && authPubkey !== null && { auth_pubkey: authPubkey }),
        ...(authSignature !== undefined &&
          authSignature !== null && { auth_signature: authSignature }),
      },
    });
    if (!commitResponse.ok) {
      const detail = core4ErrorDetail(commitResponse.payload);
      blockchainLogger.warn('core4 contribution commit rejected', {
        stationId,
        status: commitResponse.status,
        ...detail,
      });
      if (commitResponse.status === 400 && isReplayRejection(commitResponse.payload)) {
        // Terminal: this commit id is already on chain; retrying can never succeed.
        sendErrorEnvelope(res, 409, 'COMMIT_ALREADY_SUBMITTED', 'This reading was already submitted');
        return;
      }
      throw new Error(`core4 contribution commit failed (${commitResponse.status})`);
    }

    const revealResponse = await fetchCore4Json('/transactions/contribution/reveal', {
      method: 'POST',
      headers: contributorHeaders,
      body: {
        contributor,
        station_id: stationId,
        payload,
        nonce,
        commit_hash: commitHash,
        timestamp: timestampSeconds,
      },
    });
    if (!revealResponse.ok) {
      blockchainLogger.warn('core4 contribution reveal rejected', {
        stationId,
        status: revealResponse.status,
        ...core4ErrorDetail(revealResponse.payload),
      });
      throw new Error(`core4 contribution reveal failed (${revealResponse.status})`);
    }

    const statusResponse = await fetchCore4Json(
      `/transactions/commit/${encodeURIComponent(commitHash)}/status`,
      { headers: readerHeaders }
    );
    const accountResponse = await fetchCore4Json(
      `/addresses/${encodeURIComponent(String(contributor))}`,
      { headers: readerHeaders }
    );

    const contributionStatus = statusResponse.ok
      ? extractCore4Data(statusResponse.payload) || {}
      : {};
    const account = accountResponse.ok
      ? extractCore4Data(accountResponse.payload) || {}
      : {};
    const commitData = extractCore4Data(commitResponse.payload) || {};
    const revealData = extractCore4Data(revealResponse.payload) || {};

    res.json({
      success: true,
      submissionId: commitHash,
      commitHash,
      status: contributionStatus.status || 'revealed_pending_attestation',
      stationId,
      attestation: {
        approvals: contributionStatus.approvals ?? 0,
        rejections: contributionStatus.rejections ?? 0,
        hasQuorum: Boolean(contributionStatus.has_quorum),
        oracleQuorum: contributionStatus.oracle_quorum ?? null,
      },
      blockInclusion: {
        commitAccepted: true,
        revealAccepted: true,
        txId: revealData.tx_id || commitData.tx_id || null,
      },
      rewardAmount:
        account.earned_balance_total ??
        account.reward_amount ??
        account.rewardAmount ??
        null,
      core4: {
        commit: commitData,
        reveal: revealData,
        contributionStatus,
      },
      message: 'Data submitted successfully through core4 contribution pipeline',
    });
  } catch (error) {
    blockchainLogger.error('Error submitting data to oracle network', {
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
    res.status(502).json({ error: 'Failed to submit data through core4 contribution pipeline' });
  }
});

export default router;
