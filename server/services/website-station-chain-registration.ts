/**
 * On-chain registration progress for stations connected on the website.
 *
 * A website station is a `weather_stations` row. It earns only once a
 * governance-signed StationRegistration is on chain, and that registration
 * carries the owner's own proof: `owner_pubkey` plus a signature over core4's
 * `station_ownership_message` (chain, network, station id, owner address).
 *
 * This module:
 *  - stores that proof when the owner's wallet sends it (public material only);
 *  - answers the owner's own status read (`needs_owner_signature`, `waiting`,
 *    `earning`, `blocked`), with the chain the backend verifies against so the
 *    page can refuse to sign for a different one;
 *  - lets the chain station sync flip a row to `on_chain` (the ONLY way a
 *    station becomes "earning" here) or to `blocked` (the chain already has
 *    this station id under another owner, or shows it inactive / not real).
 *    Nothing in the export path, and no request from a browser, can set either.
 *
 * It holds no governance key and never talks to the chain. OFF by default:
 * `WEBSITE_STATION_CHAIN_REGISTRATION_ENABLED=true`, after migration 0045, and
 * only with WRFCOIN_CHAIN_ID and WRFCOIN_NETWORK_ID set: this path never falls
 * back to a default chain.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  buildStationOwnershipMessage,
  isChainAddress,
  isReservedMobileStationId,
} from '../../shared/mobile-station-messages.js';
import { verifyEd25519SignatureBytes } from '../routes/wallet-auth-service.js';

export interface ChainRegistrationPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: any[]; rowCount?: number | null; count?: number }>;
}

export type ChainRegistrationState = 'needs_owner_signature' | 'waiting' | 'earning' | 'blocked';
export type BlockedReason = 'station_id_taken_on_chain' | 'chain_record_not_active';
/** Why a waiting station is not in a batch yet. `batch` = nothing is missing; it is in the queue. */
export type WaitingFor = 'batch' | 'station_report' | 'operator_review';

export interface WebsiteStationChain {
  chainId: string;
  networkId: string;
}

export interface ChainRegistrationStatus {
  state: ChainRegistrationState;
  /** The raw station id, for the owner only: it is what the ownership message signs. */
  stationId: string;
  /** The chain this backend verifies ownership signatures for. */
  chainId: string;
  networkId: string;
  waitingFor?: WaitingFor;
  blockedReason?: BlockedReason;
}

export interface ServiceResult {
  status: number;
  body: Record<string, unknown>;
}

/** The ids the website registration issues and the public edge admits. */
export const WEBSITE_STATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** An id the server issued with nothing personal in it: `pws-` + 16 hex. */
export const NEUTRAL_STATION_ID_RE = /^pws-[0-9a-f]{16}$/;
const HEX_PUBKEY = /^[0-9a-fA-F]{64}$/;
const HEX_SIGNATURE = /^[0-9a-fA-F]{128}$/;

/** How fresh a station's last reading must be for it to join a batch. */
export const RECENT_OBSERVATION_HOURS = 24;

type Env = Record<string, string | undefined>;

export function websiteStationChainRegistrationEnabled(env: Env = process.env): boolean {
  return env.WEBSITE_STATION_CHAIN_REGISTRATION_ENABLED === 'true';
}

/**
 * The chain ownership signatures are checked against, or null when it is not
 * configured. NO default: a backend that silently assumed another chain would
 * store proofs the batch tool then refuses.
 */
export function resolveWebsiteStationChain(env: Env = process.env): WebsiteStationChain | null {
  const chainId = env.WRFCOIN_CHAIN_ID?.trim() ?? '';
  const networkId = env.WRFCOIN_NETWORK_ID?.trim() ?? '';
  if (!/^[1-9][0-9]{0,18}$/.test(chainId) || !/^[A-Za-z0-9._-]{1,64}$/.test(networkId)) return null;
  return { chainId, networkId };
}

/** A fresh station id with nothing personal in it, from the system CSPRNG. */
export function newNeutralStationId(): string {
  return `pws-${randomBytes(8).toString('hex')}`;
}

/** core4 address of an ed25519 key: 0x + first 20 bytes of SHA3-256(pubkey). */
export function ownerAddressFromPubkey(pubkeyHex: string): string {
  return `0x${createHash('sha3-256').update(Buffer.from(pubkeyHex, 'hex')).digest('hex').slice(0, 40)}`;
}

function fail(status: number, code: string, message: string): ServiceResult {
  return { status, body: { success: false, error: { code, message } } };
}

function caller(walletAddress: unknown): string | null {
  if (typeof walletAddress !== 'string') return null;
  const normalized = walletAddress.trim().toLowerCase();
  return isChainAddress(normalized) ? normalized : null;
}

function affected(res: { rows?: any[]; rowCount?: number | null; count?: number }): number {
  return typeof res.rowCount === 'number' ? res.rowCount : typeof res.count === 'number' ? res.count : (res.rows ?? []).length;
}

const NOT_FOUND = () => fail(404, 'NOT_FOUND', 'Station not found');

/**
 * What makes a waiting station ready for a batch, as SQL over `w`
 * (weather_stations). Shared by the owner's status read and the export, so
 * the page and the batch can never disagree about why a station is waiting.
 */
export const ACTIVE_INGESTION_SQL = `(w.metadata->>'ingestionStatus' = 'active'
        AND EXISTS (SELECT 1 FROM station_provider_credentials c WHERE c.station_id = w.station_id))`;
export const OBSERVATIONS_24H_SQL = `(SELECT count(*)::int FROM weather_data d
          WHERE d.station_id = w.station_id
            AND d."timestamp" > now() - interval '${RECENT_OBSERVATION_HOURS} hours'
            AND d."timestamp" <= now())`;

/**
 * A station the caller owns, with ITS OWN registration row if there is one
 * (joined on the owner as well: after a station changes owner, the new owner
 * never reads the old owner's progress). Same empty answer for unknown and
 * not-yours.
 */
export const OWNED_STATION_SQL = `SELECT w.station_id, r.status, r.blocked_reason,
            ${ACTIVE_INGESTION_SQL} AS ingestion_active,
            ${OBSERVATIONS_24H_SQL} AS observations_24h
       FROM weather_stations w
       LEFT JOIN website_station_chain_registrations r
         ON r.station_id = w.station_id AND r.owner_address = lower(w.owner_address)
      WHERE w.station_id = $1 AND lower(w.owner_address) = $2
      LIMIT 1`;

function statusOf(row: Record<string, unknown>, chain: WebsiteStationChain): ChainRegistrationStatus {
  const stationId = String(row.station_id);
  const base = { stationId, chainId: chain.chainId, networkId: chain.networkId };
  if (row.status === 'on_chain') return { state: 'earning', ...base };
  if (row.status === 'blocked') {
    const reason: BlockedReason = row.blocked_reason === 'chain_record_not_active'
      ? 'chain_record_not_active'
      : 'station_id_taken_on_chain';
    return { state: 'blocked', ...base, blockedReason: reason };
  }
  if (row.status !== 'db_only') return { state: 'needs_owner_signature', ...base };
  // Waiting: say what, if anything, is still missing. The export applies the same rules.
  const reporting = row.ingestion_active === true && Number(row.observations_24h) > 0;
  const waitingFor: WaitingFor = !reporting
    ? 'station_report'
    : NEUTRAL_STATION_ID_RE.test(stationId) ? 'batch' : 'operator_review';
  return { state: 'waiting', ...base, waitingFor };
}

/**
 * The owner's own read. `null` when the station does not exist or belongs to
 * another wallet (the route answers both with the same 404).
 */
export async function getChainRegistrationStatus(
  pool: ChainRegistrationPool,
  stationId: string,
  walletAddress: unknown,
  chain: WebsiteStationChain,
): Promise<ChainRegistrationStatus | null> {
  const owner = caller(walletAddress);
  if (!owner || !WEBSITE_STATION_ID_RE.test(stationId) || isReservedMobileStationId(stationId)) return null;
  const found = await pool.query(OWNED_STATION_SQL, [stationId, owner]);
  const row = found.rows?.[0];
  if (!row) return null;
  return statusOf(row, chain);
}

/**
 * Insert the proof, or replace it. An existing row is replaced only while it is
 * still waiting under the same owner, or when it belongs to a PREVIOUS owner of
 * the station (the caller has just been checked as the current owner). A row
 * that is `on_chain` or `blocked` for this owner is never touched.
 */
export const UPSERT_OWNERSHIP_PROOF_SQL = `INSERT INTO website_station_chain_registrations
       (station_id, owner_address, owner_pubkey, ownership_signature, status)
     VALUES ($1, $2, $3, $4, 'db_only')
     ON CONFLICT (station_id) DO UPDATE
       SET owner_address = EXCLUDED.owner_address,
           owner_pubkey = EXCLUDED.owner_pubkey,
           ownership_signature = EXCLUDED.ownership_signature,
           status = 'db_only',
           blocked_reason = NULL,
           updated_at = now()
     WHERE website_station_chain_registrations.owner_address <> EXCLUDED.owner_address
        OR website_station_chain_registrations.status = 'db_only'
     RETURNING station_id`;

/**
 * Store the owner's ownership proof for one of their stations. Idempotent: the
 * same proof again answers the same way and changes nothing that matters.
 *
 * The signer must be the station's owner AND the logged-in wallet: the address
 * derived from `owner_pubkey` has to equal the JWT address. A passkey wallet's
 * address is not derived that way, so it is refused here with a clear code
 * until the chain accepts passkey owners.
 */
export async function submitOwnershipProof(
  pool: ChainRegistrationPool,
  walletAddress: unknown,
  stationId: string,
  body: unknown,
  chain: WebsiteStationChain,
): Promise<ServiceResult> {
  const owner = caller(walletAddress);
  if (!owner) return fail(401, 'UNAUTHORIZED', 'Wallet address required');
  if (!WEBSITE_STATION_ID_RE.test(stationId)) return fail(400, 'INVALID_REQUEST', 'Invalid station ID');
  if (isReservedMobileStationId(stationId)) {
    return fail(400, 'INVALID_REQUEST', 'Phone stations register through the phone app');
  }
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const pubkey = typeof input.owner_pubkey === 'string' ? input.owner_pubkey.trim() : '';
  const signature = typeof input.owner_signature === 'string' ? input.owner_signature.trim() : '';
  if (!HEX_PUBKEY.test(pubkey)) return fail(400, 'INVALID_REQUEST', 'owner_pubkey must be a 32-byte ed25519 key in hex');
  if (!HEX_SIGNATURE.test(signature)) {
    return fail(400, 'INVALID_REQUEST', 'owner_signature must be a 64-byte ed25519 signature in hex');
  }
  const pubkeyHex = pubkey.toLowerCase();
  const signatureHex = signature.toLowerCase();
  if (ownerAddressFromPubkey(pubkeyHex) !== owner) {
    return fail(
      409,
      'OWNER_KEY_NOT_THIS_WALLET',
      'The signing key is not the logged-in wallet. Only a 12-word wallet can sign for a station today.',
    );
  }

  const found = await pool.query(OWNED_STATION_SQL, [stationId, owner]);
  const row = found.rows?.[0];
  if (!row) return NOT_FOUND();
  const rawId = String(row.station_id);

  const message = buildStationOwnershipMessage({
    chainId: chain.chainId,
    networkId: chain.networkId,
    stationId: rawId,
    ownerAddress: owner,
  });
  if (!verifyEd25519SignatureBytes(pubkeyHex, signatureHex, message)) {
    return fail(
      400,
      'OWNERSHIP_SIGNATURE_INVALID',
      `The ownership signature does not verify for this station on chain ${chain.chainId} (${chain.networkId})`,
    );
  }

  // Already earning or blocked under this owner: nothing a proof can change.
  if (row.status === 'on_chain' || row.status === 'blocked') {
    return { status: 200, body: { chainRegistration: statusOf(row, chain) } };
  }
  const written = await pool.query(UPSERT_OWNERSHIP_PROOF_SQL, [rawId, owner, pubkeyHex, signatureHex]);
  const again = await getChainRegistrationStatus(pool, rawId, owner, chain);
  if (!again) return NOT_FOUND();
  if (affected(written) !== 1 && again.state === 'needs_owner_signature') {
    // The proof was not stored and nothing else explains the state: do not claim it was.
    return fail(409, 'PROOF_NOT_STORED', 'The station changed while this was being saved. Please try again.');
  }
  return { status: 200, body: { chainRegistration: again } };
}

/**
 * Reconcile, called by the chain station sync for every registry entry that is
 * not a phone station.
 *
 * A station that already has a registration row is settled from the chain:
 *  - same owner, active and real          -> on_chain
 *  - another owner                        -> blocked (station_id_taken_on_chain)
 *  - same owner, not active or not real   -> blocked (chain_record_not_active)
 * The owner comparisons are in the SQL. `on_chain` is never downgraded.
 *
 * A station with NO registration row gets an `on_chain` row (no proof) only if
 * it is a website station: its backend row has provider credentials and the
 * same owner. Stations the operator back-filled from the chain are left alone.
 */
export const MARK_REGISTERED_ON_CHAIN_SQL = `UPDATE website_station_chain_registrations
        SET status = 'on_chain', blocked_reason = NULL, updated_at = now()
      WHERE station_id = $1 AND owner_address = lower($2) AND status <> 'on_chain'
      RETURNING station_id`;

export const MARK_BLOCKED_SQL = `UPDATE website_station_chain_registrations
        SET status = 'blocked', blocked_reason = $3, updated_at = now()
      WHERE station_id = $1
        AND status = 'db_only'
        AND (($3 = 'station_id_taken_on_chain' AND owner_address <> lower($2))
          OR ($3 = 'chain_record_not_active' AND owner_address = lower($2)))
      RETURNING station_id`;

export const ADOPT_WEBSITE_STATION_ON_CHAIN_SQL = `INSERT INTO website_station_chain_registrations
       (station_id, owner_address, status)
     SELECT w.station_id, lower(w.owner_address), 'on_chain'
       FROM weather_stations w
      WHERE w.station_id = $1 AND lower(w.owner_address) = lower($2)
        AND EXISTS (SELECT 1 FROM station_provider_credentials c WHERE c.station_id = w.station_id)
     ON CONFLICT (station_id) DO NOTHING
     RETURNING station_id`;

export interface WebsiteChainEntry {
  station_id: string;
  owner_address: string;
  provenance_class: string;
  is_active: boolean;
}

export interface WebsiteReconcileResult {
  /** Stations newly marked `on_chain` (earning) this pass. */
  onChain: number;
  /** Waiting stations newly marked `blocked` this pass. */
  blocked: number;
  /** Entries whose statements failed; the rest of the pass still ran. */
  failed: number;
}

export async function reconcileWebsiteStations(
  entries: WebsiteChainEntry[],
  pool: ChainRegistrationPool,
): Promise<WebsiteReconcileResult> {
  const result: WebsiteReconcileResult = { onChain: 0, blocked: 0, failed: 0 };
  for (const entry of entries) {
    if (!WEBSITE_STATION_ID_RE.test(entry.station_id) || isReservedMobileStationId(entry.station_id)) continue;
    if (typeof entry.owner_address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(entry.owner_address)) continue;
    const id = entry.station_id;
    const owner = entry.owner_address;
    const live = entry.is_active === true && entry.provenance_class === 'real';
    // One entry's failure must not stop the others.
    try {
      const taken = await pool.query(MARK_BLOCKED_SQL, [id, owner, 'station_id_taken_on_chain']);
      result.blocked += affected(taken) === 1 ? 1 : 0;
      if (live) {
        const marked = await pool.query(MARK_REGISTERED_ON_CHAIN_SQL, [id, owner]);
        const adopted = await pool.query(ADOPT_WEBSITE_STATION_ON_CHAIN_SQL, [id, owner]);
        result.onChain += affected(marked) === 1 || affected(adopted) === 1 ? 1 : 0;
      } else {
        const inactive = await pool.query(MARK_BLOCKED_SQL, [id, owner, 'chain_record_not_active']);
        result.blocked += affected(inactive) === 1 ? 1 : 0;
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
