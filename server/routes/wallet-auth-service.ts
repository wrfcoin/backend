import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { JWT_ISSUER, JWT_AUDIENCE } from '../auth/jwt-constants.js';
import { appLogger } from '../utils/logger.js';
import Redis from 'ioredis';

type QueryResult = { rows: Record<string, unknown>[] };

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<QueryResult>;
};

/**
 * Login key schemes. 'evm' is the original secp256k1 personal_sign flow and
 * stays the default so existing clients are unchanged. 'ed25519' is the
 * first-party wallet scheme decided in core4#3234 (SLIP-0010 ed25519, the
 * client signs); its JWT sub is the core4 chain address of the signing key,
 * which is what the wallet routes compare against a signed transfer's from.
 */
export type WalletLoginScheme = 'evm' | 'ed25519';

interface WalletLoginRequest {
  address: string;
  signature: string;
  nonce: string;
  scheme?: string;
  pubkey?: string;
}

interface RefreshRequest {
  refreshToken: string;
}

interface AuthTokenResponse {
  jwt: string;
  refreshToken: string;
  expiresIn: number;
}

interface RefreshTokenRecord {
  address: string;
  expiresAtMs: number;
  walletScheme?: WalletLoginScheme;
}

export interface WalletLoginChallenge {
  nonce: string;
  message: string;
  issuedAt: string;
  expirationTime: string;
}

interface StoredWalletLoginChallenge extends WalletLoginChallenge {
  origin: string;
  chainId: number;
  // Absent on challenges stored before ed25519 login existed: those are EVM.
  scheme?: WalletLoginScheme;
  network?: string;
}

interface WalletLoginMessageInput {
  address: string;
  origin: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

interface Ed25519WalletLoginMessageInput extends WalletLoginMessageInput {
  network: string;
}

interface CreateWalletAuthServiceOptions {
  db?: DbExecutor;
  jwtSecret?: string;
  accessTokenTtlSec?: number;
  refreshTokenTtlSec?: number;
  redis?: Redis;
  nonceTtlSec?: number;
  walletAuthOrigin?: string;
  walletAuthChainId?: number | string;
  walletAuthNetwork?: string;
  now?: () => Date;
}

export class WalletNonceRateLimitError extends Error {
  readonly code = 'WALLET_NONCE_RATE_LIMIT';
  readonly retryAfterSec: number;

  constructor(retryAfterSec: number) {
    super('Too many wallet nonce requests, please try again later.');
    this.name = 'WalletNonceRateLimitError';
    this.retryAfterSec = Math.max(1, retryAfterSec);
  }
}

// Eight issuances per scheme/address per nonce-TTL window, across all clients.
// Refuse new requests rather than evict an unexpired challenge. Because each
// challenge also expires after one window, at most two windows (16 challenges)
// can overlap, plus one expiring counter. Both keys share a Redis hash tag.
const NONCE_ISSUANCE_LIMIT = 8;
const ISSUE_NONCE = `-- wallet_nonce_issuance_v2
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then
  return {0, redis.call('TTL', KEYS[1])}
end
if redis.call('EXISTS', KEYS[2]) == 1 then return {-1, 0} end
if used == 0 then
  redis.call('SET', KEYS[1], 1, 'EX', ARGV[2])
else
  redis.call('INCR', KEYS[1])
end
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[2])
return {1, tonumber(ARGV[2])}`;

function defaultDb(): DbExecutor {
  // Lazy dynamic import — avoids "require is not defined" in ESM bundles (#268)
  let cachedExecuteQuery: ((sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | null = null;
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

function isEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// Same derivation the signed-transfer contract uses (SHA3-256, not Keccak),
// so the JWT sub an ed25519 login mints is the address core4 authorize_debit
// binds to that key.
const { ed25519PublicKeyToLaunchAddress } = require('./wallet-transfer-contract.js') as {
  ed25519PublicKeyToLaunchAddress: (publicKeyHex: string) => string | null;
};

// Strict point decoding for the verify_strict pre-checks below. Pinned exact:
// ExtendedPoint.fromHex(hex, false) enforces canonical encodings and
// isSmallOrder() detects the 8-torsion.
const { ed25519: nobleEd25519 } = require('@noble/curves/ed25519') as {
  ed25519: {
    ExtendedPoint: {
      fromHex: (hex: string, zip215?: boolean) => { isSmallOrder: () => boolean };
    };
  };
};

// Ed25519 group order L = 2^252 + 27742317777372353535851937790883648493.
const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;

/**
 * True when `hex` is a canonically encoded Ed25519 point that is NOT of small
 * order. core4 verifies with ed25519-dalek verify_strict
 * (shared-protocol/src/crypto/signature.rs), which rejects small-order public
 * keys and R. OpenSSL (node:crypto) does not: with A = identity, R = identity
 * and S = 0, crypto.verify returns true for ANY message. Without this check a
 * JWT could be minted for a keyless address with no private key.
 */
export function isStrictEd25519Point(hex: string): boolean {
  try {
    return !nobleEd25519.ExtendedPoint.fromHex(hex, false).isSmallOrder();
  } catch {
    return false;
  }
}

function isCanonicalEd25519Scalar(littleEndianHex: string): boolean {
  const s = BigInt(`0x${Buffer.from(littleEndianHex, 'hex').reverse().toString('hex')}`);
  return s < ED25519_L;
}

// RFC 8410 SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Versioned domain tag on the first line of the ed25519 challenge. It keeps a
 * login signature from being valid as any other signature the same key makes
 * (e.g. a transparent-transfer authorization, whose preimage starts with
 * wrfcoin_transparent_transfer_auth_v2) and lets the format evolve.
 */
export const ED25519_WALLET_LOGIN_DOMAIN = 'wrfcoin_wallet_login_ed25519_v1';

export function parseWalletLoginScheme(raw: unknown): WalletLoginScheme {
  if (raw === undefined || raw === null || raw === '') return 'evm';
  if (typeof raw !== 'string') throw new Error('unsupported wallet login scheme');
  const scheme = raw.trim().toLowerCase();
  if (scheme === 'evm' || scheme === 'secp256k1') return 'evm';
  if (scheme === 'ed25519') return 'ed25519';
  throw new Error('unsupported wallet login scheme');
}

function stripHexPrefix(value: string): string {
  return value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
}

function resolveWalletAuthNetwork(explicitNetwork?: string): string {
  const network = (
    explicitNetwork ??
    process.env.WRFCOIN_WALLET_AUTH_NETWORK ??
    process.env.WRFCOIN_NETWORK_ID ??
    process.env.NETWORK_ID ??
    'testnet'
  ).trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(network)) {
    throw new Error('wallet auth network must be 1-64 characters of [A-Za-z0-9._-]');
  }
  return network;
}

function resolveWalletAuthOrigin(explicitOrigin?: string): string {
  const rawOrigin = (
    explicitOrigin ??
    process.env.WRFCOIN_WALLET_AUTH_ORIGIN ??
    process.env.CORS_ORIGIN ??
    ''
  ).trim();

  if (!rawOrigin) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('WRFCOIN_WALLET_AUTH_ORIGIN is required in production');
    }
    return 'http://localhost:5000';
  }
  if (rawOrigin.includes(',')) {
    throw new Error('wallet auth origin must be one exact origin');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new Error('wallet auth origin must be a valid absolute URL');
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('wallet auth origin must be an origin without credentials, path, query, or fragment');
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('wallet auth origin must use HTTPS in production');
  }

  return parsed.origin;
}

function resolveWalletAuthChainId(explicitChainId?: number | string): number {
  const rawChainId =
    explicitChainId ??
    process.env.WRFCOIN_WALLET_AUTH_CHAIN_ID ??
    process.env.WRFCOIN_CHAIN_ID ??
    process.env.PAYMASTER_CHAIN_ID ??
    777;
  const chainId = Number(rawChainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('wallet auth chain ID must be a positive integer');
  }
  return chainId;
}

export function buildWalletLoginMessage(input: WalletLoginMessageInput): string {
  const { getAddress } = require('ethers');
  const domain = new URL(input.origin).host;
  return `${domain} wants you to sign in with your Ethereum account:\n${getAddress(input.address)}\n\nSign in to WRFCoin Testnet.\n\nURI: ${input.origin}\nVersion: 1\nChain ID: ${input.chainId}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}\nExpiration Time: ${input.expirationTime}`;
}

/**
 * Challenge the ed25519 wallet signs. The same fields as the EVM challenge
 * (relying-party origin/host, address, chain ID, nonce, issue and expiry
 * times) plus the key scheme and network, under a versioned domain tag. The
 * address is the lowercase core4 chain address (it carries no EIP-55
 * checksum). The client signs the UTF-8 bytes of this exact server-issued
 * string with plain ed25519 (no prefix, no pre-hash).
 */
export function buildEd25519WalletLoginMessage(input: Ed25519WalletLoginMessageInput): string {
  const domain = new URL(input.origin).host;
  return `${ED25519_WALLET_LOGIN_DOMAIN}\n${domain} wants you to sign in with your WRFCoin ed25519 account:\n${input.address.toLowerCase()}\n\nSign in to WRFCoin Testnet.\n\nURI: ${input.origin}\nVersion: 1\nScheme: ed25519\nChain ID: ${input.chainId}\nNetwork: ${input.network}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}\nExpiration Time: ${input.expirationTime}`;
}

function verifyEd25519Signature(publicKeyHex: string, signatureHex: string, message: string): boolean {
  return verifyEd25519SignatureBytes(publicKeyHex, signatureHex, Buffer.from(message, 'utf8'));
}

/**
 * Strict (dalek verify_strict parity) ed25519 verification over raw bytes.
 * Shared with binary-preimage callers such as mobile station registration
 * (backend#1288); the string form above signs UTF-8 text.
 */
export function verifyEd25519SignatureBytes(
  publicKeyHex: string,
  signatureHex: string,
  message: Uint8Array
): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex) || !/^[0-9a-fA-F]{128}$/.test(signatureHex)) {
    return false;
  }
  // verify_strict parity: reject small-order or non-canonical A and R, and a
  // non-canonical S, before OpenSSL's (non-strict) cofactorless check.
  if (
    !isStrictEd25519Point(publicKeyHex) ||
    !isStrictEd25519Point(signatureHex.slice(0, 64)) ||
    !isCanonicalEd25519Scalar(signatureHex.slice(64))
  ) {
    return false;
  }
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signatureHex, 'hex'));
  } catch (error) {
    appLogger.warn('ed25519 signature verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function verifyWalletSignature(
  address: string,
  signature: string,
  message: string
): Promise<boolean> {
  if (!isEvmAddress(address)) {
    throw new Error('unsupported wallet address format for login');
  }

  try {
    const { getAddress, verifyMessage } = require('ethers');
    const recoveredAddress = getAddress(verifyMessage(message, signature));
    return recoveredAddress.toLowerCase() === getAddress(address).toLowerCase();
  } catch (error) {
    appLogger.warn('EVM signature verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function createWalletAuthService(options: CreateWalletAuthServiceOptions = {}) {
  const db = options.db ?? defaultDb();
  const jwtSecret = options.jwtSecret || process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required');
  }
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  const accessTokenTtlSec = options.accessTokenTtlSec || 15 * 60;
  const refreshTokenTtlSec = options.refreshTokenTtlSec || 7 * 24 * 60 * 60;
  const nonceTtlSec = options.nonceTtlSec || 300;
  const walletAuthOrigin = resolveWalletAuthOrigin(options.walletAuthOrigin);
  const walletAuthChainId = resolveWalletAuthChainId(options.walletAuthChainId);
  const walletAuthNetwork = resolveWalletAuthNetwork(options.walletAuthNetwork);
  const now = options.now ?? (() => new Date());
  let _redis: Redis | null = options.redis ?? null;

  function getRedis(): Redis {
    if (!_redis) {
      _redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
        lazyConnect: true,
        maxRetriesPerRequest: 3,
      });
    }
    return _redis;
  }

  // Read-only compatibility for challenges issued before the v2 storage change.
  // They expire naturally and can still be redeemed once; issuance never writes
  // this shared legacy slot again.
  function legacyNonceKey(scheme: WalletLoginScheme, address: string): string {
    return scheme === 'ed25519'
      ? `wallet:nonce:ed25519:${address.toLowerCase()}`
      : `wallet:nonce:${address.toLowerCase()}`;
  }

  function nonceBucketKey(scheme: WalletLoginScheme, address: string): string {
    return `wallet:nonce:v2:{${scheme}:${address.toLowerCase()}}`;
  }

  function nonceKey(scheme: WalletLoginScheme, address: string, nonce: string): string {
    return `${nonceBucketKey(scheme, address)}:challenge:${encodeURIComponent(nonce)}`;
  }

  function buildChallengeMessage(
    scheme: WalletLoginScheme,
    input: WalletLoginMessageInput,
  ): string {
    return scheme === 'ed25519'
      ? buildEd25519WalletLoginMessage({ ...input, network: walletAuthNetwork })
      : buildWalletLoginMessage(input);
  }

  async function generateNonce(
    address: string,
    rawScheme?: unknown,
  ): Promise<WalletLoginChallenge & { scheme?: WalletLoginScheme; network?: string }> {
    const scheme = parseWalletLoginScheme(rawScheme);
    if (!isEvmAddress(address)) {
      throw new Error('invalid address format');
    }
    const nonce = crypto.randomBytes(32).toString('hex');
    const issuedAtMs = now().getTime();
    const issuedAt = new Date(issuedAtMs).toISOString();
    const expirationTime = new Date(issuedAtMs + nonceTtlSec * 1000).toISOString();
    const message = buildChallengeMessage(scheme, {
      address,
      origin: walletAuthOrigin,
      chainId: walletAuthChainId,
      nonce,
      issuedAt,
      expirationTime,
    });
    const challenge: StoredWalletLoginChallenge = {
      nonce,
      message,
      issuedAt,
      expirationTime,
      origin: walletAuthOrigin,
      chainId: walletAuthChainId,
      ...(scheme === 'ed25519' ? { scheme, network: walletAuthNetwork } : {}),
    };
    const result = await getRedis().eval(ISSUE_NONCE, 2,
      `${nonceBucketKey(scheme, address)}:issuance`, nonceKey(scheme, address, nonce),
      NONCE_ISSUANCE_LIMIT, nonceTtlSec, JSON.stringify(challenge));
    if (!Array.isArray(result) || !Number.isInteger(result[0])) {
      throw new Error('wallet nonce store unavailable');
    }
    if (result[0] === 0) {
      throw new WalletNonceRateLimitError(
        typeof result[1] === 'number' && result[1] >= 0 ? result[1] : nonceTtlSec);
    }
    if (result[0] !== 1) throw new Error('nonce issuance collision — request a new nonce');
    if (scheme === 'ed25519') {
      return { nonce, message, issuedAt, expirationTime, scheme, network: walletAuthNetwork };
    }
    return { nonce, message, issuedAt, expirationTime };
  }

  async function issueTokens(
    address: string,
    secret: string,
    aTtlSec: number,
    rTtlSec: number,
    walletScheme: WalletLoginScheme = 'evm',
  ): Promise<AuthTokenResponse> {
    const expiresIn = aTtlSec;

    const accessToken = jwt.sign(
      {
        sub: address,
        address,
        role: 'wallet',
        type: 'access',
        // EVM tokens keep their original claim set.
        ...(walletScheme === 'ed25519' ? { wallet_scheme: 'ed25519' } : {}),
      },
      secret,
      {
        algorithm: 'HS256',
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        expiresIn,
        notBefore: 0,
      }
    );

    const refreshToken = crypto.randomBytes(32).toString('hex');
    const redisKey = `wallet:refresh:${refreshToken}`;
    await getRedis().set(
      redisKey,
      JSON.stringify({
        address,
        expiresAtMs: (Math.floor(Date.now() / 1000) + rTtlSec) * 1000,
        ...(walletScheme === 'ed25519' ? { walletScheme } : {}),
      }),
      'EX',
      rTtlSec
    );

    return {
      jwt: accessToken,
      refreshToken,
      expiresIn,
    };
  }

  async function walletLogin(payload: WalletLoginRequest): Promise<AuthTokenResponse> {
    const scheme = parseWalletLoginScheme(payload.scheme);
    if (!payload.address || !payload.signature || !payload.nonce) {
      throw new Error('address, signature, and nonce are required');
    }

    let address = payload.address.trim();
    const signature = payload.signature.trim();
    const nonce = payload.nonce.trim();
    if (!nonce || nonce.length > 128) throw new Error('invalid nonce');
    if (!isEvmAddress(address)) {
      throw new Error('unsupported wallet address format for login');
    }

    let ed25519PublicKey = '';
    if (scheme === 'ed25519') {
      if (typeof payload.pubkey !== 'string' || !payload.pubkey.trim()) {
        throw new Error('pubkey is required for ed25519 login');
      }
      ed25519PublicKey = stripHexPrefix(payload.pubkey.trim());
      if (!/^[0-9a-fA-F]{64}$/.test(ed25519PublicKey)) {
        throw new Error('pubkey must be a 32-byte ed25519 public key in hex');
      }
      if (!/^[0-9a-fA-F]{128}$/.test(stripHexPrefix(signature))) {
        throw new Error('signature must be a 64-byte ed25519 signature in hex');
      }
      // Rejected before the challenge is touched: a small-order or
      // non-canonical key proves no possession of anything (see
      // isStrictEd25519Point).
      if (!isStrictEd25519Point(ed25519PublicKey)) {
        throw new Error('pubkey must be a canonical ed25519 point that is not of small order');
      }
      // Bind the claimed address to the key before touching the challenge,
      // so a mismatched attempt never consumes the owner's nonce.
      const derivedAddress = ed25519PublicKeyToLaunchAddress(ed25519PublicKey);
      if (!derivedAddress || derivedAddress !== address.toLowerCase()) {
        throw new Error('address does not match the ed25519 public key');
      }
      address = derivedAddress;
    }

    // Validate nonce against Redis (single-use)
    let redisKey = nonceKey(scheme, address, nonce);
    let storedRaw = await getRedis().get(redisKey);
    if (!storedRaw) {
      const legacyKey = legacyNonceKey(scheme, address);
      const legacyRaw = await getRedis().get(legacyKey);
      if (legacyRaw) {
        try {
          if (JSON.parse(legacyRaw)?.nonce === nonce) {
            redisKey = legacyKey;
            storedRaw = legacyRaw;
          }
        } catch { /* An invalid legacy record cannot authorize a login. */ }
      }
    }
    if (!storedRaw) {
      throw new Error('nonce expired or not found — request a new nonce');
    }
    let challenge: StoredWalletLoginChallenge;
    try {
      challenge = JSON.parse(storedRaw) as StoredWalletLoginChallenge;
    } catch {
      await getRedis().del(redisKey);
      throw new Error('wallet login challenge is invalid — request a new nonce');
    }
    const issuedAtMs = Date.parse(challenge.issuedAt);
    const expirationTimeMs = Date.parse(challenge.expirationTime);
    const expectedMessage =
      Number.isFinite(issuedAtMs) && Number.isFinite(expirationTimeMs)
        ? buildChallengeMessage(scheme, {
            address,
            origin: walletAuthOrigin,
            chainId: walletAuthChainId,
            nonce: challenge.nonce,
            issuedAt: challenge.issuedAt,
            expirationTime: challenge.expirationTime,
          })
        : '';
    if (
      typeof challenge.nonce !== 'string' ||
      typeof challenge.message !== 'string' ||
      (challenge.scheme ?? 'evm') !== scheme ||
      (scheme === 'ed25519' && challenge.network !== walletAuthNetwork) ||
      challenge.origin !== walletAuthOrigin ||
      challenge.chainId !== walletAuthChainId ||
      !Number.isFinite(issuedAtMs) ||
      !Number.isFinite(expirationTimeMs) ||
      expirationTimeMs <= issuedAtMs ||
      expirationTimeMs - issuedAtMs > nonceTtlSec * 1000 ||
      challenge.message !== expectedMessage
    ) {
      await getRedis().del(redisKey);
      throw new Error('wallet login challenge is invalid — request a new nonce');
    }
    if (challenge.nonce !== nonce) {
      throw new Error('invalid nonce');
    }
    if (expirationTimeMs <= now().getTime()) {
      await getRedis().del(redisKey);
      throw new Error('nonce expired or not found — request a new nonce');
    }
    // Atomic single-use consume. DEL returns the number of keys it removed.
    // Under concurrent replay two requests can both pass every check above
    // (they read the same stored challenge), but only the one whose DEL
    // actually removes the key (returns 1) may proceed; the loser sees 0 and
    // is rejected. This closes the GET/DEL time-of-check/time-of-use window,
    // so a captured signature cannot be redeemed twice. Placed after the
    // nonce-match and expiry checks so a wrong-nonce attempt never consumes a
    // victim's in-flight challenge.
    const consumed = await getRedis().del(redisKey);
    if (consumed !== 1) {
      throw new Error('nonce already used — request a new nonce');
    }

    const isValid =
      scheme === 'ed25519'
        ? verifyEd25519Signature(ed25519PublicKey, stripHexPrefix(signature), challenge.message)
        : await verifyWalletSignature(address, signature, challenge.message);
    if (!isValid) {
      throw new Error('invalid wallet signature');
    }

    // Best-effort wallet upsert keeps auth available when local DB auth
    // connectivity is temporarily unavailable during launch-path verification.
    try {
      await db.execute(
        `INSERT INTO wallets (address, network, balance, is_active, created_at, last_updated)
         VALUES ($1, 'testnet', '0', true, now(), now())
         ON CONFLICT (address)
         DO UPDATE SET last_updated = now()`,
        [address]
      );
    } catch (error) {
      appLogger.warn('Wallet auth login proceeding without wallet upsert', {
        address,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return await issueTokens(address, jwtSecret, accessTokenTtlSec, refreshTokenTtlSec, scheme);
  }

  async function refresh(payload: RefreshRequest): Promise<AuthTokenResponse> {
    if (!payload.refreshToken) {
      throw new Error('refreshToken is required');
    }

    const redisKey = `wallet:refresh:${payload.refreshToken}`;
    const raw = await getRedis().get(redisKey);
    if (!raw) {
      throw new Error('invalid refresh token');
    }

    const existing: RefreshTokenRecord = JSON.parse(raw);
    if (existing.expiresAtMs <= Date.now()) {
      await getRedis().del(redisKey);
      throw new Error('refresh token expired');
    }

    // Rotate: delete old token before issuing new one
    await getRedis().del(redisKey);

    return await issueTokens(
      existing.address,
      jwtSecret,
      accessTokenTtlSec,
      refreshTokenTtlSec,
      existing.walletScheme === 'ed25519' ? 'ed25519' : 'evm'
    );
  }

  return {
    walletLogin,
    refresh,
    generateNonce,
  };
}
