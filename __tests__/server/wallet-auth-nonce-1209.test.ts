import crypto from 'node:crypto';
import Redis from 'ioredis';
import { Wallet } from 'ethers';
import { attachWalletNonceIssuer, walletNonceChallengeKey } from '../helpers/wallet-nonce-redis';

jest.mock('../../server/utils/logger.js', () => ({ appLogger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));
const { createWalletAuthService } = require('../../server/routes/wallet-auth-service');

function memoryRedis() {
  const values = new Map<string, { value: string; expires: number }>();
  return attachWalletNonceIssuer({
    get: jest.fn(async (key: string) => {
      const row = values.get(key);
      if (row && row.expires <= Date.now()) { values.delete(key); return null; }
      return row?.value ?? null;
    }),
    set: jest.fn(async (key: string, value: string, _ex: string, ttl: number) => {
      values.set(key, { value, expires: Date.now() + Number(ttl) * 1000 }); return 'OK';
    }),
    del: jest.fn(async (key: string) => values.delete(key) ? 1 : 0),
    keys: async () => [...values.keys()],
  });
}

let redis: any;
beforeEach(async () => {
  // Test-only opt-in: never connect to the application's Redis or a remote host.
  const socket = process.env.WRFCOIN_TEST_NONCE_REDIS_SOCKET;
  if (socket) {
    if (!socket.startsWith('/tmp/sol-2-r162-')) throw new Error('owned local fixture socket required');
    redis = new Redis(socket);
    await redis.flushdb();
  } else redis = memoryRedis();
});
afterEach(async () => { if (redis.quit) await redis.quit(); });

function fixture(scheme: 'evm' | 'ed25519', ttl = 300) {
  const evm = Wallet.createRandom();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pubkey = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('hex');
  const address = scheme === 'evm' ? evm.address
    : `0x${crypto.createHash('sha3-256').update(Buffer.from(pubkey, 'hex')).digest('hex').slice(0, 40)}`;
  const service = createWalletAuthService({ redis, db: { execute: async () => ({ rows: [] }) },
    jwtSecret: 'synthetic-nonce-regression-secret'.padEnd(64, 'x'),
    walletAuthOrigin: 'https://example.test', nonceTtlSec: ttl });
  const login = async (challenge: any) => service.walletLogin({ address, scheme, nonce: challenge.nonce,
    pubkey, signature: scheme === 'evm' ? await evm.signMessage(challenge.message)
      : crypto.sign(null, Buffer.from(challenge.message), privateKey).toString('hex') });
  const refresh = (refreshToken: string) => service.refresh({ refreshToken });
  return { service, address, login, refresh };
}

describe.each(['evm', 'ed25519'] as const)('%s pending wallet challenges', scheme => {
  it('issuance B cannot invalidate A; both are independently single-use', async () => {
    const { service, address, login } = fixture(scheme);
    const a = await service.generateNonce(address, scheme);
    const b = await service.generateNonce(address.toLowerCase(), scheme);
    expect(a.nonce).not.toBe(b.nonce);
    await expect(login(a)).resolves.toHaveProperty('jwt');
    await expect(login(a)).rejects.toThrow(/nonce/);
    await expect(login(b)).resolves.toHaveProperty('jwt');
  });
  it('concurrent replay mints exactly one token', async () => {
    const { service, address, login } = fixture(scheme);
    const a = await service.generateNonce(address, scheme);
    const results = await Promise.allSettled([login(a), login(a)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('an atomic per-target budget bounds concurrent issuance without evicting A', async () => {
    const { service, address, login } = fixture(scheme);
    const a = await service.generateNonce(address, scheme);
    const results = await Promise.allSettled(Array.from({ length: 32 }, () => service.generateNonce(address, scheme)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(7);
    for (const result of results) if (result.status === 'rejected') expect(result.reason.code).toBe('WALLET_NONCE_RATE_LIMIT');
    await expect(login(a)).resolves.toHaveProperty('jwt');
    const keys = await redis.keys(`wallet:nonce:*${address.toLowerCase()}*`);
    expect(keys.length).toBeLessThanOrEqual(18); // two 8-issuance windows plus this client's counter and the address backstop
  });
  it('clamps a zero-second quota TTL to one second instead of a full nonce lifetime', async () => {
    const { service, address } = fixture(scheme);
    const realRedis = typeof redis.pexpire === 'function';
    if (realRedis) {
      for (let i = 0; i < 8; i++) await service.generateNonce(address, scheme);
      const quota = `wallet:nonce:v2:{${scheme}:${address.toLowerCase()}}:issuance:client:unknown`;
      // Redis TTL rounds down: this is the last fractional second of a window.
      await redis.pexpire(quota, 400);
      expect(await redis.ttl(quota)).toBe(0);
    } else {
      // Exercise the exact Redis response even when the default suite uses a model.
      redis.eval.mockResolvedValueOnce([0, 0]);
    }
    let failure: any;
    try { await service.generateNonce(address, scheme); } catch (error) { failure = error; }
    if (realRedis) await new Promise(resolve => setTimeout(resolve, 500));
    await expect(service.generateNonce(address, scheme)).resolves.toHaveProperty('nonce');
    expect(failure).toMatchObject({ code: 'WALLET_NONCE_RATE_LIMIT', retryAfterSec: 1 });
    if (!realRedis) {
      for (const unavailableTtl of [-1, -2]) {
        redis.eval.mockResolvedValueOnce([0, unavailableTtl]);
        await expect(service.generateNonce(address, scheme)).rejects.toMatchObject({
          code: 'WALLET_NONCE_RATE_LIMIT', retryAfterSec: 300,
        });
      }
    }
  });

  it('expired challenges refuse and the issuance window expires', async () => {
    const { service, address, login } = fixture(scheme, 1);
    const a = await service.generateNonce(address, scheme);
    for (let i = 1; i < 8; i++) await service.generateNonce(address, scheme);
    await new Promise(resolve => setTimeout(resolve, 1200));
    await expect(login(a)).rejects.toThrow(/nonce/);
    const fresh = await service.generateNonce(address, scheme);
    await expect(login(fresh)).resolves.toHaveProperty('jwt');
  });
  it('a pre-upgrade challenge remains redeemable once after new issuance', async () => {
    const { service, address, login } = fixture(scheme);
    const a = await service.generateNonce(address, scheme);
    const key = walletNonceChallengeKey(scheme, address, a.nonce);
    const raw = await redis.get(key);
    await redis.del(key);
    const legacy = scheme === 'evm' ? `wallet:nonce:${address.toLowerCase()}`
      : `wallet:nonce:ed25519:${address.toLowerCase()}`;
    await redis.set(legacy, raw, 'EX', 300);
    const b = await service.generateNonce(address, scheme);
    await expect(login(a)).resolves.toHaveProperty('jwt');
    await expect(login(a)).rejects.toThrow(/nonce/);
    await expect(login(b)).resolves.toHaveProperty('jwt');
  });
  it('an unknown nonce cannot erase a challenge or its issuance counter', async () => {
    const { service, address, login } = fixture(scheme);
    const a = await service.generateNonce(address, scheme);
    await expect(login({ ...a, nonce: 'issuance' })).rejects.toThrow(/nonce/);
    await expect(login(a)).resolves.toHaveProperty('jwt');
    for (let i = 1; i < 8; i++) await service.generateNonce(address, scheme);
    await expect(service.generateNonce(address, scheme)).rejects.toMatchObject({ code: 'WALLET_NONCE_RATE_LIMIT' });
  });
});

it('scheme namespaces have independent target budgets', async () => {
  const { service, address } = fixture('ed25519');
  for (let i = 0; i < 8; i++) await service.generateNonce(address, 'evm');
  await expect(service.generateNonce(address, 'evm')).rejects.toMatchObject({ code: 'WALLET_NONCE_RATE_LIMIT' });
  await expect(service.generateNonce(address, 'ed25519')).resolves.toHaveProperty('nonce');
});

describe.each(['evm', 'ed25519'] as const)('%s per-client issuance budget', scheme => {
  it('other clients cannot use up an address allowance', async () => {
    const { service, address, login } = fixture(scheme);
    for (let i = 0; i < 8; i++) await service.generateNonce(address, scheme, undefined, '198.51.100.7');
    await expect(service.generateNonce(address, scheme, undefined, '198.51.100.7'))
      .rejects.toMatchObject({ code: 'WALLET_NONCE_RATE_LIMIT' });
    const owner = await service.generateNonce(address, scheme, undefined, '203.0.113.9');
    await expect(login(owner)).resolves.toHaveProperty('jwt');
  });
  it('a per-address backstop bounds issuance across clients and never evicts outstanding challenges', async () => {
    const { service, address, login } = fixture(scheme);
    const first = await service.generateNonce(address, scheme, undefined, '203.0.113.1');
    for (let i = 1; i < 64; i++) await service.generateNonce(address, scheme, undefined, `198.51.100.${i % 16}:${i}`);
    await expect(service.generateNonce(address, scheme, undefined, '203.0.113.200'))
      .rejects.toMatchObject({ code: 'WALLET_NONCE_RATE_LIMIT' });
    await expect(login(first)).resolves.toHaveProperty('jwt');
    const prefix = `wallet:nonce:v2:{${scheme}:${address.toLowerCase()}}:challenge:`;
    const keys = (await redis.keys(`${prefix}*`)).filter((k: string) => k.startsWith(prefix));
    expect(keys.length).toBe(63); // 64 issued, the redeemed one is gone, none evicted
  });
  it('a request with no client key uses its own shared bucket', async () => {
    const { service, address } = fixture(scheme);
    for (let i = 0; i < 8; i++) await service.generateNonce(address, scheme);
    await expect(service.generateNonce(address, scheme)).rejects.toMatchObject({ code: 'WALLET_NONCE_RATE_LIMIT' });
    await expect(service.generateNonce(address, scheme, undefined, '203.0.113.9')).resolves.toHaveProperty('nonce');
  });
});

describe.each(['evm', 'ed25519'] as const)('%s refresh token rotation', scheme => {
  it('two concurrent refreshes of one token: exactly one succeeds', async () => {
    const { service, address, login, refresh } = fixture(scheme);
    const session = await login(await service.generateNonce(address, scheme));
    const results = await Promise.allSettled([refresh(session.refreshToken), refresh(session.refreshToken)]);
    const ok = results.filter(r => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.message).toBe('invalid refresh token');
    // The token that was used is gone; the new one works once.
    await expect(refresh(session.refreshToken)).rejects.toThrow('invalid refresh token');
    const next = (ok[0] as PromiseFulfilledResult<any>).value.refreshToken;
    await expect(refresh(next)).resolves.toHaveProperty('refreshToken');
  });
});
