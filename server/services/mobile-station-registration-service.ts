/**
 * Per-phone station registration (backend#1288, stories B1 + B3).
 * Design: docs/plans/2026-09-29-per-phone-station-registration-design.md
 *
 * A phone proves it holds the wallet key by signing two preimages over a
 * server-issued, single-use, wallet-bound nonce:
 *   A  - "wrfcoin_mobile_station_reg_v2" backend proof (chain, network, station,
 *        owner, COLLECT KEY, 0.1 degree cell, nonce, expiry). The wallet thereby
 *        authorises the phone's spend-less collect key (B6, design §11);
 *   B  - core4's station_ownership_message, stored so the operator can assemble
 *        the on-chain StationRegistration later without contacting the phone.
 *
 * The station id is DERIVED from the authenticated wallet and any client id is
 * ignored. Registration writes the backend's weather_stations row (so the #1284
 * owner guard in oracle-submit-routes passes) and a mobile_station_registrations
 * row with status `db_only`. It never touches the chain and holds no governance
 * key: on-chain registration is the operator's batch (design §3.5 option A), and
 * a station earns nothing until that lands.
 *
 * The collect key is backend-only: it is stored here and checked by
 * oracle-submit-routes, and is never exported to core4. Re-registering the same
 * wallet with a NEW collect key (wallet-signed, fresh nonce) replaces it.
 *
 * Logs carry the station id and the 0.1 degree cell only - never an owner
 * address, public key, signature or finer position.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  buildMobileStationRegistrationMessage,
  buildStationOwnershipMessage,
  deriveMobileStationId,
  isChainAddress,
  isCollectPubkeyHex,
} from '../../shared/mobile-station-messages.js';
import { verifyEd25519SignatureBytes } from '../routes/wallet-auth-service.js';

/** Challenge lifetime: design §3.3 "≤ 5 min". */
export const MOBILE_CHALLENGE_TTL_SECONDS = 300;
/** Live (unconsumed, unexpired) challenges one wallet may hold at once. */
export const MOBILE_MAX_LIVE_CHALLENGES = 5;
export const MOBILE_DEVICE_CLASS = 'phone-barometer';

export interface NonceRow {
  nonce: string;
  ownerAddress: string;
  stationId: string;
  expiresAt: number;
  consumed: boolean;
}

export interface RegistrationRow {
  stationId: string;
  ownerAddress: string;
  ownerPubkey: string;
  /** The wallet-authorised, spend-less key that signs commit authorizations. */
  collectPubkey: string;
  cellLatE1: number;
  cellLonE1: number;
  deviceClass: string;
  registrationNonce: string;
  registrationExpiresAt: number;
  registrationSignature: string;
  ownershipSignature: string;
  status: 'db_only' | 'submitted' | 'on_chain';
  /** Set by the store on read; absent on a row being inserted. */
  createdAt?: Date;
  updatedAt?: Date;
}

/** One transaction's worth of storage operations. */
export interface MobileStationTx {
  /** Serialize concurrent requests for one wallet for the transaction's life. */
  lockWallet(ownerAddress: string): Promise<void>;
  findRegistrationByOwner(ownerAddress: string): Promise<RegistrationRow | null>;
  /** Delete this wallet's expired nonces (consumed or not); returns nothing. */
  pruneExpiredNonces(ownerAddress: string, nowSeconds: number): Promise<void>;
  countLiveNonces(ownerAddress: string, nowSeconds: number): Promise<number>;
  insertNonce(row: Omit<NonceRow, 'consumed'>): Promise<void>;
  getNonceForUpdate(nonce: string): Promise<NonceRow | null>;
  consumeNonce(nonce: string): Promise<void>;
  /** Insert/refresh the owner-guard row; false if another owner holds the id. */
  upsertWeatherStation(stationId: string, ownerAddress: string, metadata: Record<string, unknown>): Promise<boolean>;
  insertRegistration(row: RegistrationRow): Promise<void>;
  /** Replace the collect key (rotation) and the proof that authorised it. */
  rotateCollectKey(
    ownerAddress: string,
    next: { collectPubkey: string; registrationNonce: string; registrationExpiresAt: number; registrationSignature: string }
  ): Promise<void>;
}

export interface MobileStationStore {
  withTransaction<T>(fn: (tx: MobileStationTx) => Promise<T>): Promise<T>;
}

export interface MobileStationLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface MobileStationDeps {
  chainId: string;
  networkId: string;
  now: () => number; // unix seconds
  newNonce?: () => string;
  logger?: MobileStationLogger;
}

export interface ServiceResult {
  status: number;
  body: Record<string, unknown>;
}

/** Chain identity: the node's own env, else the fixed testnet values (design §3.2). */
export function resolveMobileStationChain(): { chainId: string; networkId: string } {
  return {
    chainId: process.env.WRFCOIN_CHAIN_ID?.trim() || '777',
    networkId: process.env.WRFCOIN_NETWORK_ID?.trim() || 'testnet',
  };
}

function fail(status: number, code: string, message: string): ServiceResult {
  return { status, body: { success: false, error: { code, message } } };
}

function defaultNonce(): string {
  return randomBytes(24).toString('hex');
}

function caller(walletAddress: unknown): string | null {
  if (typeof walletAddress !== 'string') return null;
  const normalized = walletAddress.trim().toLowerCase();
  return isChainAddress(normalized) ? normalized : null;
}

const HEX_PUBKEY = /^[0-9a-fA-F]{64}$/;
const HEX_SIGNATURE = /^[0-9a-fA-F]{128}$/;
const NONCE_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

export async function issueMobileStationChallenge(
  store: MobileStationStore,
  walletAddress: unknown,
  deps: MobileStationDeps
): Promise<ServiceResult> {
  const owner = caller(walletAddress);
  if (!owner) {
    return fail(401, 'UNAUTHORIZED', 'A wallet session with a chain address is required');
  }
  const stationId = deriveMobileStationId(owner);
  const nowSeconds = deps.now();
  const nonce = (deps.newNonce ?? defaultNonce)();
  const expiresAt = nowSeconds + MOBILE_CHALLENGE_TTL_SECONDS;

  const limited = await store.withTransaction(async (tx) => {
    await tx.lockWallet(owner);
    await tx.pruneExpiredNonces(owner, nowSeconds);
    if ((await tx.countLiveNonces(owner, nowSeconds)) >= MOBILE_MAX_LIVE_CHALLENGES) {
      return true;
    }
    await tx.insertNonce({ nonce, ownerAddress: owner, stationId, expiresAt });
    return false;
  });
  if (limited) {
    return fail(429, 'CHALLENGE_LIMIT', 'Too many open registration challenges; wait for them to expire');
  }
  return {
    status: 200,
    body: {
      nonce,
      expiresAt,
      stationId,
      ownerAddress: owner,
      chainId: deps.chainId,
      networkId: deps.networkId,
    },
  };
}

/** The only registration layout accepted; v1 (no collect key) is retired. */
export const MOBILE_REGISTRATION_VERSION = 2;

interface ParsedRegistration {
  nonce: string;
  expiresAt: number;
  publicKey: string;
  collectPubkey: string;
  latE1: number;
  lonE1: number;
  registrationSignature: string;
  ownershipSignature: string;
}

type Parsed = { ok: true; value: ParsedRegistration } | { ok: false; result: ServiceResult };

function parseBody(raw: unknown): Parsed {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const invalid = (message: string): Parsed => ({
    ok: false,
    result: fail(400, 'VALIDATION_ERROR', message),
  });

  // A v1 client sends no collect key (and may say version 1). Refuse it by name
  // before anything else, so an old app gets an actionable answer, not a
  // generic validation error - and so its signature is never even considered.
  if (
    (body.version !== undefined && body.version !== MOBILE_REGISTRATION_VERSION) ||
    body.collectPubkey === undefined ||
    body.collectPubkey === null
  ) {
    return {
      ok: false,
      result: fail(
        400,
        'REGISTRATION_VERSION_UNSUPPORTED',
        'Registration v2 with a collectPubkey is required; update the app'
      ),
    };
  }
  if (typeof body.nonce !== 'string' || !NONCE_SHAPE.test(body.nonce)) {
    return invalid('nonce is required');
  }
  if (!Number.isSafeInteger(body.expiresAt) || (body.expiresAt as number) <= 0) {
    return invalid('expiresAt must be a unix-seconds integer');
  }
  if (typeof body.publicKey !== 'string' || !HEX_PUBKEY.test(body.publicKey)) {
    return invalid('publicKey must be a 32-byte ed25519 public key in hex');
  }
  if (!isCollectPubkeyHex(body.collectPubkey)) {
    return {
      ok: false,
      result: fail(400, 'COLLECT_KEY_INVALID', 'collectPubkey must be a 32-byte ed25519 public key in hex'),
    };
  }
  if (body.collectPubkey.toLowerCase() === body.publicKey.toLowerCase()) {
    return {
      ok: false,
      result: fail(400, 'COLLECT_KEY_IS_WALLET_KEY', 'collectPubkey must differ from the wallet key'),
    };
  }
  if (typeof body.registrationSignature !== 'string' || !HEX_SIGNATURE.test(body.registrationSignature)) {
    return invalid('registrationSignature must be a 64-byte ed25519 signature in hex');
  }
  if (typeof body.ownershipSignature !== 'string' || !HEX_SIGNATURE.test(body.ownershipSignature)) {
    return invalid('ownershipSignature must be a 64-byte ed25519 signature in hex');
  }
  if (body.deviceClass !== undefined && body.deviceClass !== MOBILE_DEVICE_CLASS) {
    return invalid(`deviceClass must be ${MOBILE_DEVICE_CLASS}`);
  }
  const cell = (body.cell && typeof body.cell === 'object' ? body.cell : {}) as Record<string, unknown>;
  const { latE1, lonE1 } = cell;
  if (
    !Number.isInteger(latE1) ||
    !Number.isInteger(lonE1) ||
    (latE1 as number) < -900 ||
    (latE1 as number) > 900 ||
    (lonE1 as number) < -1800 ||
    (lonE1 as number) > 1800
  ) {
    return {
      ok: false,
      result: fail(
        400,
        'CELL_NOT_ON_GRID',
        'cell must be integer tenths of a degree: latE1 in [-900, 900], lonE1 in [-1800, 1800]'
      ),
    };
  }
  return {
    ok: true,
    value: {
      nonce: body.nonce,
      expiresAt: body.expiresAt as number,
      publicKey: body.publicKey.toLowerCase(),
      collectPubkey: body.collectPubkey.toLowerCase(),
      latE1: latE1 as number,
      lonE1: lonE1 as number,
      registrationSignature: body.registrationSignature.toLowerCase(),
      ownershipSignature: body.ownershipSignature.toLowerCase(),
    },
  };
}

function existingResult(row: RegistrationRow): ServiceResult {
  return {
    status: 200,
    body: {
      stationId: row.stationId,
      status: row.status,
      created: false,
      cell: { latE1: row.cellLatE1, lonE1: row.cellLonE1 },
      deviceClass: row.deviceClass,
    },
  };
}

export async function registerMobileStation(
  store: MobileStationStore,
  walletAddress: unknown,
  rawBody: unknown,
  deps: MobileStationDeps
): Promise<ServiceResult> {
  const owner = caller(walletAddress);
  if (!owner) {
    return fail(401, 'UNAUTHORIZED', 'A wallet session with a chain address is required');
  }
  const parsed = parseBody(rawBody);
  if ('result' in parsed) return parsed.result;
  const req = parsed.value;

  // The pubkey must be the authenticated wallet's own key. Anything the client
  // says about the station id or owner is ignored: both come from the JWT.
  const derivedFromKey = deriveOwnerFromPublicKey(req.publicKey);
  if (derivedFromKey !== owner) {
    return fail(403, 'WALLET_MISMATCH', 'publicKey does not belong to the authenticated wallet');
  }
  const stationId = deriveMobileStationId(owner);

  const registrationMessage = buildMobileStationRegistrationMessage({
    chainId: deps.chainId,
    networkId: deps.networkId,
    stationId,
    ownerAddress: owner,
    collectPubkey: req.collectPubkey,
    latE1: req.latE1,
    lonE1: req.lonE1,
    nonce: req.nonce,
    expiresAt: req.expiresAt,
  });
  if (!verifyEd25519SignatureBytes(req.publicKey, req.registrationSignature, registrationMessage)) {
    return fail(403, 'INVALID_REGISTRATION_SIGNATURE', 'registrationSignature does not verify');
  }
  const ownershipMessage = buildStationOwnershipMessage({
    chainId: deps.chainId,
    networkId: deps.networkId,
    stationId,
    ownerAddress: owner,
  });
  if (!verifyEd25519SignatureBytes(req.publicKey, req.ownershipSignature, ownershipMessage)) {
    return fail(403, 'INVALID_OWNERSHIP_SIGNATURE', 'ownershipSignature does not verify');
  }

  const result = await store.withTransaction(async (tx): Promise<ServiceResult> => {
    await tx.lockWallet(owner);
    const existing = await tx.findRegistrationByOwner(owner);

    // A retry of the request that already succeeded (lost response): the stored
    // row IS this registration, so answer with it whatever the clock says.
    if (
      existing &&
      existing.registrationNonce === req.nonce &&
      existing.collectPubkey === req.collectPubkey
    ) {
      return existingResult(existing);
    }

    const nonceRow = await tx.getNonceForUpdate(req.nonce);
    if (!nonceRow || nonceRow.ownerAddress !== owner || nonceRow.expiresAt !== req.expiresAt) {
      return fail(400, 'NONCE_INVALID', 'Unknown registration challenge; request a new one');
    }
    if (nonceRow.consumed) {
      return fail(409, 'NONCE_REPLAYED', 'This registration challenge was already used');
    }
    if (deps.now() > nonceRow.expiresAt) {
      return fail(400, 'NONCE_EXPIRED', 'Registration challenge expired; request a new one');
    }

    if (existing) {
      // Same collect key: an idempotent re-register, answered with the existing
      // station unchanged. It leaves its nonce unconsumed - it expires on its own.
      if (existing.collectPubkey === req.collectPubkey) {
        return existingResult(existing);
      }
      // A different collect key, authorised by a fresh wallet signature over a
      // live nonce (verified above): rotation / lost phone. The old key stops
      // being accepted the moment this transaction commits. The registered
      // cell and status stay: one station, one registered location (Q6).
      await tx.rotateCollectKey(owner, {
        collectPubkey: req.collectPubkey,
        registrationNonce: req.nonce,
        registrationExpiresAt: req.expiresAt,
        registrationSignature: req.registrationSignature,
      });
      await tx.consumeNonce(req.nonce);
      return { status: 200, body: { ...existingResult(existing).body, rotated: true } };
    }

    const guardRowWritten = await tx.upsertWeatherStation(stationId, owner, {
      source: 'mobile-registration',
      deviceClass: MOBILE_DEVICE_CLASS,
    });
    if (!guardRowWritten) {
      return fail(409, 'STATION_ID_TAKEN', 'This station id is held by another owner');
    }
    await tx.insertRegistration({
      stationId,
      ownerAddress: owner,
      ownerPubkey: req.publicKey,
      collectPubkey: req.collectPubkey,
      cellLatE1: req.latE1,
      cellLonE1: req.lonE1,
      deviceClass: MOBILE_DEVICE_CLASS,
      registrationNonce: req.nonce,
      registrationExpiresAt: req.expiresAt,
      registrationSignature: req.registrationSignature,
      ownershipSignature: req.ownershipSignature,
      status: 'db_only',
    });
    await tx.consumeNonce(req.nonce);
    return {
      status: 201,
      body: {
        stationId,
        status: 'db_only',
        created: true,
        cell: { latE1: req.latE1, lonE1: req.lonE1 },
        deviceClass: MOBILE_DEVICE_CLASS,
      },
    };
  });

  if (result.status === 201) {
    deps.logger?.info('Mobile station registered (db_only)', {
      stationId,
      cellLatE1: req.latE1,
      cellLonE1: req.lonE1,
    });
  } else if (result.status === 200 && result.body.rotated === true) {
    deps.logger?.info('Mobile station collect key rotated', { stationId });
  }
  return result;
}

/**
 * B4: the caller's OWN registration status, or 404. The lookup key is the JWT
 * wallet, never a request parameter, and the response carries no owner address,
 * public key or signature.
 */
export async function getMobileStationStatus(
  store: MobileStationStore,
  walletAddress: unknown
): Promise<ServiceResult> {
  const owner = caller(walletAddress);
  if (!owner) {
    return fail(401, 'UNAUTHORIZED', 'A wallet session with a chain address is required');
  }
  const row = await store.withTransaction((tx) => tx.findRegistrationByOwner(owner));
  if (!row) {
    return fail(404, 'NOT_REGISTERED', 'No mobile station is registered for this wallet');
  }
  return {
    status: 200,
    body: {
      stationId: row.stationId,
      status: row.status,
      cell: { latE1: row.cellLatE1, lonE1: row.cellLonE1 },
      createdAt: row.createdAt?.toISOString() ?? null,
      updatedAt: row.updatedAt?.toISOString() ?? null,
    },
  };
}

/** 0x + SHA3-256(pubkey)[..20], the core4 chain address of an ed25519 key. */
function deriveOwnerFromPublicKey(publicKeyHex: string): string {
  const digest = createHash('sha3-256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex');
  return `0x${digest.slice(0, 40)}`;
}

// ---------------------------------------------------------------------------
// Postgres store
// ---------------------------------------------------------------------------

interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
  release(): void;
}
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}

export class PgMobileStationStore implements MobileStationStore {
  constructor(private readonly pool: PgPoolLike) {}

  async withTransaction<T>(fn: (tx: MobileStationTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(pgTx(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection already gone */
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

function toRegistration(row: any): RegistrationRow {
  return {
    stationId: row.station_id,
    ownerAddress: row.owner_address,
    ownerPubkey: row.owner_pubkey,
    collectPubkey: row.collect_pubkey,
    cellLatE1: Number(row.cell_lat_e1),
    cellLonE1: Number(row.cell_lon_e1),
    deviceClass: row.device_class,
    registrationNonce: row.registration_nonce,
    registrationExpiresAt: Number(row.registration_expires_at),
    registrationSignature: row.registration_signature,
    ownershipSignature: row.ownership_signature,
    status: row.status,
    createdAt: row.created_at ? new Date(row.created_at) : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
  };
}

function pgTx(client: PgClientLike): MobileStationTx {
  return {
    async lockWallet(ownerAddress) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mobile-station:${ownerAddress}`]);
    },
    async findRegistrationByOwner(ownerAddress) {
      const res = await client.query(
        'SELECT * FROM mobile_station_registrations WHERE owner_address = $1 LIMIT 1',
        [ownerAddress]
      );
      return res.rows[0] ? toRegistration(res.rows[0]) : null;
    },
    async pruneExpiredNonces(ownerAddress, nowSeconds) {
      await client.query(
        'DELETE FROM mobile_station_nonces WHERE owner_address = $1 AND expires_at <= $2',
        [ownerAddress, nowSeconds]
      );
    },
    async countLiveNonces(ownerAddress, nowSeconds) {
      const res = await client.query(
        `SELECT COUNT(*)::int AS n FROM mobile_station_nonces
          WHERE owner_address = $1 AND consumed_at IS NULL AND expires_at > $2`,
        [ownerAddress, nowSeconds]
      );
      return Number(res.rows[0]?.n ?? 0);
    },
    async insertNonce(row) {
      await client.query(
        `INSERT INTO mobile_station_nonces (nonce, owner_address, station_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [row.nonce, row.ownerAddress, row.stationId, row.expiresAt]
      );
    },
    async getNonceForUpdate(nonce) {
      const res = await client.query(
        `SELECT nonce, owner_address, station_id, expires_at, consumed_at
           FROM mobile_station_nonces WHERE nonce = $1 FOR UPDATE`,
        [nonce]
      );
      const row = res.rows[0];
      return row
        ? {
            nonce: row.nonce,
            ownerAddress: row.owner_address,
            stationId: row.station_id,
            expiresAt: Number(row.expires_at),
            consumed: row.consumed_at !== null,
          }
        : null;
    },
    async consumeNonce(nonce) {
      await client.query(
        'UPDATE mobile_station_nonces SET consumed_at = now() WHERE nonce = $1 AND consumed_at IS NULL',
        [nonce]
      );
    },
    async upsertWeatherStation(stationId, ownerAddress, metadata) {
      // Coordinates stay NULL on purpose: the public map lists only rows with
      // latitude, and a db_only station must not appear there. chain-station-sync
      // fills them from the chain once the operator's batch lands.
      const res = await client.query(
        `INSERT INTO weather_stations (station_id, owner_address, location, is_active, station_type, metadata)
         VALUES ($1, $2, 'mobile', true, 'mobile', $3::jsonb)
         ON CONFLICT (station_id) DO UPDATE SET updated_at = now()
           WHERE lower(weather_stations.owner_address) = lower(EXCLUDED.owner_address)
         RETURNING station_id`,
        [stationId, ownerAddress, JSON.stringify(metadata)]
      );
      return (res.rowCount ?? res.rows.length) > 0;
    },
    async insertRegistration(row) {
      await client.query(
        `INSERT INTO mobile_station_registrations
           (station_id, owner_address, owner_pubkey, collect_pubkey, cell_lat_e1, cell_lon_e1, device_class,
            registration_nonce, registration_expires_at, registration_signature, ownership_signature, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          row.stationId, row.ownerAddress, row.ownerPubkey, row.collectPubkey, row.cellLatE1, row.cellLonE1, row.deviceClass,
          row.registrationNonce, row.registrationExpiresAt, row.registrationSignature,
          row.ownershipSignature, row.status,
        ]
      );
    },
    async rotateCollectKey(ownerAddress, next) {
      await client.query(
        `UPDATE mobile_station_registrations
            SET collect_pubkey = $2, registration_nonce = $3, registration_expires_at = $4,
                registration_signature = $5, updated_at = now()
          WHERE owner_address = $1`,
        [ownerAddress, next.collectPubkey, next.registrationNonce, next.registrationExpiresAt, next.registrationSignature]
      );
    },
  };
}
