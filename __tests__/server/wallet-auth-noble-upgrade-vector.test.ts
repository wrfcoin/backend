import { attachWalletNonceIssuer, walletNonceChallengeKey } from '../helpers/wallet-nonce-redis';
/**
 * Compatibility known answer generated once with @noble/curves 1.2.0.
 * Tests use the literal signature, never sign it with the upgraded dependency.
 * Only external storage/logging and challenge randomness are substituted;
 * generateNonce -> walletLogin -> strict noble point checks -> crypto.verify
 * execute their production implementations.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../server/utils/logger.js', () => ({ appLogger: mockLogger, logger: mockLogger }));

const { createWalletAuthService, isStrictEd25519Point } = require('../../server/routes/wallet-auth-service');
const vector = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../contract-fixtures/wallet-auth-noble-1.2.0-vector.json'), 'utf8',
));
const JWT_SECRET = 'synthetic-known-answer-wallet-auth-secret'.padEnd(64, 'x');

async function issuePinnedChallenge() {
  const store = new Map<string, string>();
  const redis = attachWalletNonceIssuer({
    set: async (key: string, value: string) => { store.set(key, value); return 'OK'; },
    get: async (key: string) => store.get(key) ?? null,
    del: async (key: string) => store.delete(key) ? 1 : 0,
  });
  const db = { execute: jest.fn(async () => ({ rows: [] })) };
  const service = createWalletAuthService({
    redis, db, jwtSecret: JWT_SECRET, walletAuthOrigin: vector.origin,
    walletAuthChainId: vector.chain_id, walletAuthNetwork: vector.network,
    now: () => new Date(vector.issued_at),
  });
  const nonceSpy = jest.spyOn(crypto, 'randomBytes').mockImplementationOnce(
    (() => Buffer.from(vector.nonce, 'hex')) as any,
  );
  let challenge;
  try { challenge = await service.generateNonce(vector.address, 'ed25519'); }
  finally { nonceSpy.mockRestore(); }
  expect(vector.generator).toBe('@noble/curves@1.2.0');
  expect(challenge.message).toBe(vector.message);
  expect(Buffer.from(challenge.message, 'utf8').toString('hex')).toBe(vector.message_hex);
  expect(challenge.issuedAt).toBe(vector.issued_at);
  expect(challenge.expirationTime).toBe(vector.expiration_time);
  return { service, db, store, challenge };
}

describe('wallet-auth accepts old noble ed25519 signature bytes after the dependency upgrade', () => {
  afterEach(() => jest.restoreAllMocks());

  it('authenticates the literal signature generated with 1.2.0 through actual walletLogin', async () => {
    const { service, db, store, challenge } = await issuePinnedChallenge();
    const verifySpy = jest.spyOn(crypto, 'verify'); // observation only; actual OpenSSL runs
    const tokens = await service.walletLogin({
      scheme: 'ed25519', address: vector.address, pubkey: vector.public_key_hex,
      nonce: challenge.nonce, signature: vector.signature_hex,
    });
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy.mock.calls[0][1]).toEqual(Buffer.from(vector.message_hex, 'hex'));
    expect(verifySpy.mock.calls[0][3]).toEqual(Buffer.from(vector.signature_hex, 'hex'));
    const claims = jwt.verify(tokens.jwt, JWT_SECRET, {
      algorithms: ['HS256'], issuer: 'wrfcoin-platform', audience: 'wrfcoin-api',
    }) as jwt.JwtPayload;
    expect(claims.sub).toBe(vector.address);
    expect(claims.wallet_scheme).toBe('ed25519');
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(store.has(walletNonceChallengeKey('ed25519', vector.address, challenge.nonce))).toBe(false);
  });

  it('rejects one tampered signature bit after the strict-point checks reach real verification', async () => {
    const { service, db, challenge } = await issuePinnedChallenge();
    const tampered = Buffer.from(vector.signature_hex, 'hex');
    tampered[32] ^= 1; // alter S only; preserve the canonical public key and R
    expect(isStrictEd25519Point(vector.public_key_hex)).toBe(true);
    expect(isStrictEd25519Point(tampered.subarray(0, 32).toString('hex'))).toBe(true);
    const verifySpy = jest.spyOn(crypto, 'verify');
    await expect(service.walletLogin({
      scheme: 'ed25519', address: vector.address, pubkey: vector.public_key_hex,
      nonce: challenge.nonce, signature: tampered.toString('hex'),
    })).rejects.toThrow('invalid wallet signature');
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(db.execute).not.toHaveBeenCalled();
  });
});
