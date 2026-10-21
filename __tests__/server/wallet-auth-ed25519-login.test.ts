import { attachWalletNonceIssuer, walletNonceChallengeKey } from '../helpers/wallet-nonce-redis';
/**
 * ed25519 wallet login (core4#3234: ed25519 everywhere, SLIP-0010, client
 * signs). The JWT sub an ed25519 login mints must be the core4 chain address
 * of the signing key, 0x + hex(SHA3-256(pubkey)[..20]), because that is what
 * the wallet routes compare against (GET /:address/nonce requireOwnAddress,
 * POST /send from == sub). Before this, only EVM personal_sign login existed,
 * so sub was a secp256k1 address and every first-party send was 403.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Wallet } from 'ethers';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../server/utils/logger.js', () => ({ appLogger: mockLogger, logger: mockLogger }));
jest.mock('../../server/utils/logger', () => ({ appLogger: mockLogger, logger: mockLogger }));
jest.mock('../../utils/logger', () => ({ appLogger: mockLogger, logger: mockLogger }));

const passthrough = (_req: any, _res: any, next: any) => next();
jest.mock('../../middleware/rateLimiting', () => ({
  generalLimiter: passthrough,
  transferLimiter: passthrough,
}));
jest.mock('../../config', () => ({ jwtSecret: 'unused-by-these-routes' }));
jest.mock('../../database/index.js', () => ({ executeQuery: jest.fn() }));

const mockFetchCore4Json = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../../shared/core4-route-client.js', () => ({
  fetchCore4Json: (...args: any[]) => mockFetchCore4Json(...args),
  extractCore4Data: (payload: any) => payload,
  forwardCore4Headers: (_headers: any = {}, extra: any = {}) => ({ ...extra }),
  sendCore4Unavailable: (res: any) => res.status(503).json({ success: false }),
  sendCore4Error: (res: any, response: any) =>
    res.status(response?.status || 502).json({ success: false }),
  sendNotImplemented: (res: any) => res.status(501).json({ success: false }),
}));

const {
  createWalletAuthService,
  buildEd25519WalletLoginMessage,
  ED25519_WALLET_LOGIN_DOMAIN,
} = require('../../server/routes/wallet-auth-routes');

const VECTOR = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'contract-fixtures/wallet-key-scheme-vector.json'), 'utf8'),
);
const JWT_SECRET = 'ed25519-wallet-login-test-secret-'.padEnd(64, 'x');
const ORIGIN = 'https://wrfcoin.com';
const CHAIN_ID = 777;
const NETWORK = 'testnet';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** SLIP-0010 ed25519 master key from a BIP-39 mnemonic, as the vector states. */
function deriveEd25519(mnemonic: string, passphrase = '') {
  const seed = crypto.pbkdf2Sync(
    mnemonic.normalize('NFKD'),
    `mnemonic${passphrase}`.normalize('NFKD'),
    2048,
    64,
    'sha512',
  );
  const secret = crypto.createHmac('sha512', 'ed25519 seed').update(seed).digest().subarray(0, 32);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, secret]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKeyHex = crypto
    .createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(12)
    .toString('hex');
  return {
    publicKeyHex,
    sign: (message: string) => crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex'),
  };
}

function randomEd25519() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  return {
    publicKeyHex,
    address: `0x${crypto.createHash('sha3-256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 40)}`,
    sign: (message: string) => crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex'),
  };
}

function makeRedis() {
  const store = new Map<string, string>();
  return attachWalletNonceIssuer({
    store,
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  });
}

function makeService(redis = makeRedis()) {
  return {
    redis,
    service: createWalletAuthService({
      jwtSecret: JWT_SECRET,
      redis,
      db: { execute: jest.fn(async () => ({ rows: [] })) },
      walletAuthOrigin: ORIGIN,
      walletAuthChainId: CHAIN_ID,
      walletAuthNetwork: NETWORK,
    }),
  };
}

const vectorKey = deriveEd25519(VECTOR.mnemonic, VECTOR.bip39_passphrase);

async function ed25519Login(service: any, key = vectorKey, address = VECTOR.address) {
  const challenge = await service.generateNonce(address, 'ed25519');
  return service.walletLogin({
    scheme: 'ed25519',
    address,
    pubkey: key.publicKeyHex,
    signature: key.sign(challenge.message),
    nonce: challenge.nonce,
  });
}

describe('ed25519 wallet login', () => {
  it('derives the core4 vector key and address (fixture sanity)', () => {
    expect(vectorKey.publicKeyHex).toBe(Buffer.from(VECTOR.public_key_bytes).toString('hex'));
  });

  it('happy path: vector key signs the challenge and the JWT sub is the vector chain address', async () => {
    const { service } = makeService();
    const challenge = await service.generateNonce(VECTOR.address, 'ed25519');
    // Same binding as the EVM challenge (origin, address, chain, nonce, expiry)
    // plus scheme and network, under a versioned domain tag.
    expect(challenge.message).toBe(
      buildEd25519WalletLoginMessage({
        address: VECTOR.address,
        origin: ORIGIN,
        chainId: CHAIN_ID,
        network: NETWORK,
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt,
        expirationTime: challenge.expirationTime,
      }),
    );
    expect(challenge.message.split('\n')[0]).toBe(ED25519_WALLET_LOGIN_DOMAIN);
    expect(challenge.message).toContain(`URI: ${ORIGIN}`);
    expect(challenge.message).toContain(`Chain ID: ${CHAIN_ID}`);
    expect(challenge.message).toContain(`Network: ${NETWORK}`);
    expect(challenge.message).toContain(`Nonce: ${challenge.nonce}`);
    expect(challenge).toMatchObject({ scheme: 'ed25519', network: NETWORK });

    const tokens = await service.walletLogin({
      scheme: 'ed25519',
      address: VECTOR.address,
      pubkey: vectorKey.publicKeyHex,
      signature: vectorKey.sign(challenge.message),
      nonce: challenge.nonce,
    });
    const claims: any = jwt.verify(tokens.jwt, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'wrfcoin-platform',
      audience: 'wrfcoin-api',
    });
    expect(claims.sub).toBe(VECTOR.address);
    expect(claims.address).toBe(VECTOR.address);
    expect(claims.wallet_scheme).toBe('ed25519');
    expect(claims.role).toBe('wallet');
  });

  it('accepts 0x-prefixed pubkey/signature and a checksum-cased address, binding sub to lowercase', async () => {
    const { service } = makeService();
    const upper = `0x${VECTOR.address.slice(2).toUpperCase()}`;
    const challenge = await service.generateNonce(upper, 'ed25519');
    const tokens = await service.walletLogin({
      scheme: 'ed25519',
      address: upper,
      pubkey: `0x${vectorKey.publicKeyHex}`,
      signature: `0x${vectorKey.sign(challenge.message)}`,
      nonce: challenge.nonce,
    });
    expect((jwt.decode(tokens.jwt) as any).sub).toBe(VECTOR.address);
  });

  it('wrong address: a key cannot log in as an address it does not derive, and the owner nonce survives', async () => {
    const { service, redis } = makeService();
    const attacker = randomEd25519();
    const challenge = await service.generateNonce(VECTOR.address, 'ed25519');
    await expect(
      service.walletLogin({
        scheme: 'ed25519',
        address: VECTOR.address,
        pubkey: attacker.publicKeyHex,
        signature: attacker.sign(challenge.message),
        nonce: challenge.nonce,
      }),
    ).rejects.toThrow('address does not match the ed25519 public key');
    expect(redis.store.has(walletNonceChallengeKey('ed25519', VECTOR.address, challenge.nonce))).toBe(true);
    // The owner can still log in with the same challenge.
    const tokens = await service.walletLogin({
      scheme: 'ed25519',
      address: VECTOR.address,
      pubkey: vectorKey.publicKeyHex,
      signature: vectorKey.sign(challenge.message),
      nonce: challenge.nonce,
    });
    expect((jwt.decode(tokens.jwt) as any).sub).toBe(VECTOR.address);
  });

  it.each([
    ['signed by a different key', (m: string) => randomEd25519().sign(m)],
    ['over a different message', () => vectorKey.sign('some other message')],
    ['with one flipped bit', (m: string) => {
      const sig = Buffer.from(vectorKey.sign(m), 'hex');
      sig[5] ^= 0x01;
      return sig.toString('hex');
    }],
    ['that is all zeroes', () => '0'.repeat(128)],
  ])('bad signature (%s) is rejected', async (_label, makeSig) => {
    const { service } = makeService();
    const challenge = await service.generateNonce(VECTOR.address, 'ed25519');
    await expect(
      service.walletLogin({
        scheme: 'ed25519',
        address: VECTOR.address,
        pubkey: vectorKey.publicKeyHex,
        signature: makeSig(challenge.message),
        nonce: challenge.nonce,
      }),
    ).rejects.toThrow('invalid wallet signature');
  });

  it.each([
    [{ pubkey: undefined }, 'pubkey is required for ed25519 login'],
    [{ pubkey: 'ab' }, 'pubkey must be a 32-byte ed25519 public key in hex'],
    [{ signature: 'ab' }, 'signature must be a 64-byte ed25519 signature in hex'],
    [{ scheme: 'sr25519' }, 'unsupported wallet login scheme'],
  ])('malformed ed25519 body %o is rejected', async (override, message) => {
    const { service } = makeService();
    const challenge = await service.generateNonce(VECTOR.address, 'ed25519');
    await expect(
      service.walletLogin({
        scheme: 'ed25519',
        address: VECTOR.address,
        pubkey: vectorKey.publicKeyHex,
        signature: vectorKey.sign(challenge.message),
        nonce: challenge.nonce,
        ...override,
      }),
    ).rejects.toThrow(message);
  });

  it('replayed nonce: the same signed login cannot be redeemed twice', async () => {
    const { service } = makeService();
    const challenge = await service.generateNonce(VECTOR.address, 'ed25519');
    const body = {
      scheme: 'ed25519',
      address: VECTOR.address,
      pubkey: vectorKey.publicKeyHex,
      signature: vectorKey.sign(challenge.message),
      nonce: challenge.nonce,
    };
    await expect(service.walletLogin(body)).resolves.toHaveProperty('jwt');
    await expect(service.walletLogin(body)).rejects.toThrow('nonce expired or not found');
  });

  it('concurrent replay: only the request whose DEL removes the challenge gets a token', async () => {
    const { service } = makeService();
    const challenge = await service.generateNonce(VECTOR.address, 'ed25519');
    const body = {
      scheme: 'ed25519',
      address: VECTOR.address,
      pubkey: vectorKey.publicKeyHex,
      signature: vectorKey.sign(challenge.message),
      nonce: challenge.nonce,
    };
    const results = await Promise.allSettled([service.walletLogin(body), service.walletLogin(body)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('cross-scheme: an ed25519 signature over an EVM challenge is refused (no scheme downgrade)', async () => {
    const { service } = makeService();
    const evmChallenge = await service.generateNonce(VECTOR.address);
    await expect(
      service.walletLogin({
        scheme: 'ed25519',
        address: VECTOR.address,
        pubkey: vectorKey.publicKeyHex,
        signature: vectorKey.sign(evmChallenge.message),
        nonce: evmChallenge.nonce,
      }),
    ).rejects.toThrow('nonce expired or not found');
  });

  it('refresh keeps the ed25519 sub and wallet_scheme claim', async () => {
    const { service } = makeService();
    const first = await ed25519Login(service);
    const refreshed = await service.refresh({ refreshToken: first.refreshToken });
    const claims: any = jwt.decode(refreshed.jwt);
    expect(claims.sub).toBe(VECTOR.address);
    expect(claims.wallet_scheme).toBe('ed25519');
  });

  it('EVM login still works unchanged: checksum sub, no wallet_scheme claim, nonce-scoped storage', async () => {
    const { service, redis } = makeService();
    const wallet = Wallet.createRandom();
    const challenge = await service.generateNonce(wallet.address);
    expect(challenge.message).toContain('wants you to sign in with your Ethereum account:');
    expect(challenge.message).not.toContain(ED25519_WALLET_LOGIN_DOMAIN);
    expect(redis.store.has(walletNonceChallengeKey('evm', wallet.address, challenge.nonce))).toBe(true);
    const tokens = await service.walletLogin({
      address: wallet.address,
      signature: await wallet.signMessage(challenge.message),
      nonce: challenge.nonce,
    });
    const claims: any = jwt.decode(tokens.jwt);
    expect(claims.sub).toBe(wallet.address);
    expect(claims).not.toHaveProperty('wallet_scheme');
    const refreshed: any = jwt.decode((await service.refresh({ refreshToken: tokens.refreshToken })).jwt);
    expect(refreshed).not.toHaveProperty('wallet_scheme');
  });

  it('pre-fix bug: the web wallet body today (ed25519 signature, no scheme/pubkey) is refused on the EVM path', async () => {
    const { service } = makeService();
    const challenge = await service.generateNonce(VECTOR.address);
    await expect(
      service.walletLogin({
        address: VECTOR.address,
        signature: vectorKey.sign(challenge.message),
        nonce: challenge.nonce,
      }),
    ).rejects.toThrow('invalid wallet signature');
  });
});

// The 8 small-order (8-torsion) points in canonical encoding, as listed by
// curve25519-dalek EIGHT_TORSION, plus non-canonical encodings of torsion
// points (y >= p, or x = 0 with the sign bit set).
const SMALL_ORDER_POINTS = [
  '0100000000000000000000000000000000000000000000000000000000000000', // identity
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // order 2
  '0000000000000000000000000000000000000000000000000000000000000000', // order 4
  '0000000000000000000000000000000000000000000000000000000000000080', // order 4
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', // order 8
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa', // order 8
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', // order 8
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85', // order 8
];
const NON_CANONICAL_POINTS = [
  '0100000000000000000000000000000000000000000000000000000000000080', // identity, x=0 sign bit set
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // y = p + 1 (identity)
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // y = p (order 4)
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', // y = p, sign bit set
];
const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;
const addressOf = (pubkeyHex: string) =>
  `0x${crypto.createHash('sha3-256').update(Buffer.from(pubkeyHex, 'hex')).digest('hex').slice(0, 40)}`;

describe('verify_strict parity: small-order and non-canonical keys cannot mint a JWT', () => {
  // backend#1208 security review, finding 1: pubkey 01||00*31 with
  // signature identity-R || zero-S verifies under node:crypto for ANY message.
  const PROBE_PUBKEY = SMALL_ORDER_POINTS[0];
  const PROBE_SIGNATURE = PROBE_PUBKEY + '00'.repeat(32);

  // Whether node:crypto alone accepts this probe depends on the Node/OpenSSL
  // build: node 24.15.0 (OpenSSL 3.5.5) returns true for ANY message, while the
  // CT102 runner's node 24.20.0 rejects it. The backend must not depend on
  // that, so these tests assert only the backend's decision. The RED control
  // (isStrictEd25519Point forced true) mints a JWT on node 24.15.0.
  it('the reviewer probe (identity pubkey, identity R, zero S) mints no JWT and leaves the challenge intact', async () => {
    const { service, redis } = makeService();
    const address = addressOf(PROBE_PUBKEY);
    expect(address).toBe('0x17cd8acc6c4e438664ef675e23dd274fed89954b');
    const challenge = await service.generateNonce(address, 'ed25519');
    await expect(
      service.walletLogin({
        scheme: 'ed25519',
        address,
        pubkey: PROBE_PUBKEY,
        signature: PROBE_SIGNATURE,
        nonce: challenge.nonce,
      }),
    ).rejects.toThrow('pubkey must be a canonical ed25519 point that is not of small order');
    expect(redis.store.has(walletNonceChallengeKey('ed25519', address, challenge.nonce))).toBe(true);
  });

  it.each([...SMALL_ORDER_POINTS, ...NON_CANONICAL_POINTS])(
    'pubkey %s is refused before the challenge is touched',
    async (pubkey) => {
      const { service, redis } = makeService();
      const address = addressOf(pubkey);
      const challenge = await service.generateNonce(address, 'ed25519');
      for (const signature of [pubkey + '00'.repeat(32), SMALL_ORDER_POINTS[0] + '00'.repeat(32)]) {
        await expect(
          service.walletLogin({ scheme: 'ed25519', address, pubkey, signature, nonce: challenge.nonce }),
        ).rejects.toThrow('pubkey must be a canonical ed25519 point that is not of small order');
      }
      expect(redis.store.has(walletNonceChallengeKey('ed25519', address, challenge.nonce))).toBe(true);
    },
  );

  it.each(SMALL_ORDER_POINTS)('small-order R %s with the real vector key is refused', async (r) => {
    const { service } = makeService();
    const challenge = await service.generateNonce(VECTOR.address, 'ed25519');
    const realSignature = vectorKey.sign(challenge.message);
    await expect(
      service.walletLogin({
        scheme: 'ed25519',
        address: VECTOR.address,
        pubkey: vectorKey.publicKeyHex,
        signature: r + realSignature.slice(64),
        nonce: challenge.nonce,
      }),
    ).rejects.toThrow('invalid wallet signature');
  });

  it('non-canonical S (S + L) of a valid signature is refused', async () => {
    const { service } = makeService();
    const challenge = await service.generateNonce(VECTOR.address, 'ed25519');
    const sig = vectorKey.sign(challenge.message);
    const s = BigInt(`0x${Buffer.from(sig.slice(64), 'hex').reverse().toString('hex')}`) + ED25519_L;
    const sPlusL = Buffer.from(s.toString(16).padStart(64, '0'), 'hex').reverse().toString('hex');
    await expect(
      service.walletLogin({
        scheme: 'ed25519',
        address: VECTOR.address,
        pubkey: vectorKey.publicKeyHex,
        signature: sig.slice(0, 64) + sPlusL,
        nonce: challenge.nonce,
      }),
    ).rejects.toThrow('invalid wallet signature');
  });
});

describe('verify_strict parity holds even under a permissive platform verifier', () => {
  // OpenSSL's verdict on these inputs varies by Node/OpenSSL build and returns
  // the same generic failure, so the backend's own R and S checks are proven
  // here with crypto.verify forced to accept everything.
  let verifySpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    verifySpy = jest.spyOn(crypto, 'verify').mockImplementation((() => true) as any);
  });
  afterEach(() => verifySpy.mockRestore());

  const sLE = (n: bigint) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex').reverse().toString('hex');

  async function attempt(signatureFor: (realSig: string) => string) {
    const { service } = makeService();
    const challenge = await service.generateNonce(VECTOR.address, 'ed25519');
    verifySpy.mockClear();
    const realSig = vectorKey.sign(challenge.message);
    return service.walletLogin({
      scheme: 'ed25519',
      address: VECTOR.address,
      pubkey: vectorKey.publicKeyHex,
      signature: signatureFor(realSig),
      nonce: challenge.nonce,
    });
  }

  it('sanity: the spy is live (a well-formed forged signature is accepted when only OpenSSL decides)', async () => {
    // Canonical, non-small-order R (from a real signature) and S = 1 < L.
    const tokens = await attempt((real) => real.slice(0, 64) + sLE(1n));
    expect((jwt.decode(tokens.jwt) as any).sub).toBe(VECTOR.address);
    expect(verifySpy).toHaveBeenCalled();
  });

  it.each(SMALL_ORDER_POINTS)('small-order R %s is refused by the backend check', async (r) => {
    await expect(attempt((real) => r + real.slice(64))).rejects.toThrow('invalid wallet signature');
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it.each(NON_CANONICAL_POINTS)('non-canonical R %s is refused by the backend check', async (r) => {
    await expect(attempt((real) => r + real.slice(64))).rejects.toThrow('invalid wallet signature');
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it.each([
    ['S = L', () => ED25519_L],
    ['S = L + 1', () => ED25519_L + 1n],
    ['S = 2^256 - 1', () => (1n << 256n) - 1n],
  ])('%s is refused by the backend check', async (_label, s) => {
    await expect(attempt((real) => real.slice(0, 64) + sLE(s()))).rejects.toThrow('invalid wallet signature');
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('S + L of the real signature is refused by the backend check', async () => {
    await expect(
      attempt((real) => {
        const s = BigInt(`0x${Buffer.from(real.slice(64), 'hex').reverse().toString('hex')}`) + ED25519_L;
        return real.slice(0, 64) + sLE(s);
      }),
    ).rejects.toThrow('invalid wallet signature');
    expect(verifySpy).not.toHaveBeenCalled();
  });
});

describe('ed25519 login JWT → wallet routes (real requireAuth, mocked core4)', () => {
  const originalEnv = { ...process.env };
  let app: express.Express;
  const RECIPIENT = '0x0000000000000000000000000000000000000b22';

  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.WRFCOIN_READER_TOKEN = 'reader-token';
    process.env.WRFCOIN_CONTRIBUTOR_TOKEN = 'test-only-ed25519-contributor';
    mockFetchCore4Json.mockReset();
    app = express();
    app.use(express.json());
    app.use('/api/wallet', require('../../server/routes/wallet-routes'));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('GET /api/wallet/:addr/nonce passes the owner check and POST /send passes from == sub', async () => {
    const { service } = makeService();
    const { jwt: token } = await ed25519Login(service);

    mockFetchCore4Json.mockResolvedValueOnce({ ok: true, status: 200, payload: { nonce: 3 } });
    const nonceRes = await request(app)
      .get(`/api/wallet/${VECTOR.address}/nonce`)
      .set('Authorization', `Bearer ${token}`);
    expect(nonceRes.status).toBe(200);
    expect(nonceRes.body).toEqual({ address: VECTOR.address, nonce: '3' });
    expect(mockFetchCore4Json.mock.calls[0][0]).toBe(`/addresses/${VECTOR.address}`);

    mockFetchCore4Json.mockResolvedValueOnce({ ok: true, status: 202, payload: { tx_id: 'tx-1' } });
    const body = {
      from: VECTOR.address,
      to: RECIPIENT,
      amount: '1000',
      nonce: '3',
      auth_pubkey: vectorKey.publicKeyHex,
      auth_signature: 'c'.repeat(128),
    };
    const sendRes = await request(app)
      .post('/api/wallet/send')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    expect(sendRes.status).toBe(202);
    expect(sendRes.body).toEqual({ hash: 'tx-1', status: 'submitted', settled: false });
    const [route, init] = mockFetchCore4Json.mock.calls[1];
    expect(route).toBe('/transactions/submit');
    expect(init.headers).toEqual({ authorization: 'Bearer test-only-ed25519-contributor' });
    expect(init.body).toMatchObject({ from: VECTOR.address, auth_pubkey: vectorKey.publicKeyHex });
  });

  it('the pre-fix state: an EVM-login JWT cannot read the ed25519 address nonce or send from it (403)', async () => {
    const { service } = makeService();
    const wallet = Wallet.createRandom();
    const challenge = await service.generateNonce(wallet.address);
    const { jwt: evmToken } = await service.walletLogin({
      address: wallet.address,
      signature: await wallet.signMessage(challenge.message),
      nonce: challenge.nonce,
    });

    const nonceRes = await request(app)
      .get(`/api/wallet/${VECTOR.address}/nonce`)
      .set('Authorization', `Bearer ${evmToken}`);
    expect(nonceRes.status).toBe(403);

    const sendRes = await request(app)
      .post('/api/wallet/send')
      .set('Authorization', `Bearer ${evmToken}`)
      .send({
        from: VECTOR.address,
        to: RECIPIENT,
        amount: '1000',
        nonce: '3',
        auth_pubkey: vectorKey.publicKeyHex,
        auth_signature: 'c'.repeat(128),
      });
    expect(sendRes.status).toBe(403);
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });
});
