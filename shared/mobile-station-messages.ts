/**
 * Preimages and id derivation for per-phone station registration (backend#1288).
 * Design: docs/plans/2026-09-29-per-phone-station-registration-design.md §2, §3.2.
 *
 * Pure byte builders, no I/O, so the phone (Dart) can pin the same golden
 * vectors. The server builds these to VERIFY what the phone signed; it never
 * signs anything.
 */
import crypto from 'node:crypto';

/**
 * Preimage A v2: backend registration proof (design §3.2 + §11). The tag was
 * bumped from `..._reg_v1` when `collect_pubkey` joined the layout, so a v1
 * signature can never verify as v2 (and vice versa): the first bytes differ.
 */
export const MOBILE_STATION_REG_DOMAIN = 'wrfcoin_mobile_station_reg_v2';
/** The retired v1 tag. Kept only so tests can pin that it is refused. */
export const MOBILE_STATION_REG_DOMAIN_V1 = 'wrfcoin_mobile_station_reg_v1';

/** Preimage B domain: core4 `STATION_OWNERSHIP_DOMAIN` (transaction.rs). */
export const STATION_OWNERSHIP_DOMAIN = 'wrfcoin_station_ownership_v1';

const STATION_ID_DOMAIN = 'wrfcoin_mobile_station_v1';

/** v1 has exactly one station per wallet; the slot byte is reserved (design §2.1). */
export const MOBILE_STATION_SLOT = 0;

/** `lv(x)` = u32le(byte length) || utf8 bytes, exactly core4's `push_chain_domain` framing. */
function lv(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function i32le(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeInt32LE(value, 0);
  return out;
}

function u64le(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value), 0);
  return out;
}

/** 32 bytes as 64 hex chars (either case; callers lowercase before use). */
export function isCollectPubkeyHex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

/** `0x` + 40 lowercase hex (the chain address form the JWT subject carries). */
export function isChainAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value);
}

/** Station-id prefix reserved for ids derived by the mobile registration service. */
export const MOBILE_STATION_ID_PREFIX = 'mob-';

/**
 * True for any id the generic station paths must not create: `mob-` after trim,
 * NFKC and lower-casing, so `MOB-x`, ` mob-x` and fullwidth look-alikes are all
 * reserved. Only the mobile registration service may mint these (design §7).
 */
export function isReservedMobileStationId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.normalize('NFKC').trim().toLowerCase().startsWith(MOBILE_STATION_ID_PREFIX);
}

/**
 * station_id = "mob-" + hex(SHA-256("wrfcoin_mobile_station_v1" || 0x00 || address20 || slot_u8))[0..32]
 * `address20` is the 20 raw bytes of the wallet's chain address.
 */
export function deriveMobileStationId(ownerAddress: string, slot: number = MOBILE_STATION_SLOT): string {
  const normalized = ownerAddress.trim().toLowerCase();
  if (!isChainAddress(normalized)) {
    throw new Error('owner address must be a 0x-prefixed 20-byte hex chain address');
  }
  const digest = crypto
    .createHash('sha256')
    .update(Buffer.from(STATION_ID_DOMAIN, 'utf8'))
    .update(Buffer.from([0x00]))
    .update(Buffer.from(normalized.slice(2), 'hex'))
    .update(Buffer.from([slot & 0xff]))
    .digest('hex');
  return `mob-${digest.slice(0, 32)}`;
}

export interface MobileStationRegistrationInput {
  chainId: string;
  networkId: string;
  stationId: string;
  ownerAddress: string;
  /**
   * The phone's collect key: 32-byte ed25519 public key, 64 hex chars (case is
   * folded to lowercase before it is length-prefixed, as UTF-8 text like `owner`).
   */
  collectPubkey: string;
  /** Registered 0.1 degree cell, integer tenths of a degree. */
  latE1: number;
  lonE1: number;
  nonce: string;
  /** Unix seconds. */
  expiresAt: number;
}

/**
 * Preimage A v2:
 *   "wrfcoin_mobile_station_reg_v2" || lv(chain_id) || lv(network_id)
 *   || lv(station_id) || lv(owner_address) || lv(collect_pubkey_hex)
 *   || i32le(lat_e1) || i32le(lon_e1) || lv(nonce) || u64le(expires_at)
 */
export function buildMobileStationRegistrationMessage(input: MobileStationRegistrationInput): Buffer {
  const collectPubkey = input.collectPubkey.trim().toLowerCase();
  if (!isCollectPubkeyHex(collectPubkey)) {
    throw new Error('collect_pubkey must be a 32-byte ed25519 public key in hex');
  }
  return Buffer.concat([
    Buffer.from(MOBILE_STATION_REG_DOMAIN, 'utf8'),
    lv(input.chainId),
    lv(input.networkId),
    lv(input.stationId),
    lv(input.ownerAddress),
    lv(collectPubkey),
    i32le(input.latE1),
    i32le(input.lonE1),
    lv(input.nonce),
    u64le(input.expiresAt),
  ]);
}

/**
 * Preimage B: core4 `station_ownership_message_with_domain`
 * (shared-protocol/src/blockchain/transaction.rs):
 *   "wrfcoin_station_ownership_v1" || lv(chain_id) || lv(network_id)
 *   || lv(station_id) || lv(owner_address)
 */
export function buildStationOwnershipMessage(input: {
  chainId: string;
  networkId: string;
  stationId: string;
  ownerAddress: string;
}): Buffer {
  return Buffer.concat([
    Buffer.from(STATION_OWNERSHIP_DOMAIN, 'utf8'),
    lv(input.chainId),
    lv(input.networkId),
    lv(input.stationId),
    lv(input.ownerAddress),
  ]);
}
