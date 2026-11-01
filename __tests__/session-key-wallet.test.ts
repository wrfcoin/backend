import { attachWalletNonceIssuer } from './helpers/wallet-nonce-redis';
/**
 * Session keys with spending limits (core4 feature session_keys), backend side:
 *
 *   1. the golden vectors core4 pins in `wallet_client_golden_vectors`
 *      (contract-fixtures/session-key-golden-vectors.json) are reproduced
 *      byte-for-byte: register / transfer / revoke preimages, the deterministic
 *      ed25519 signatures, and the exact register JSON body;
 *   2. POST /api/wallet/send relays session_key_auth INSTEAD of
 *      auth_pubkey/auth_signature (the ed25519 body is unchanged);
 *   3. GET /api/wallet/:address/session-keys and POST /api/wallet/session-keys
 *      proxy to core4, owner-bound, with FEATURE_NOT_ACTIVE passed through;
 *   4. sign-in with a session key (scheme session_key): JWT sub = owner, only
 *      while core4 lists the key as active with wallet_login.
 *
 * The fake core4 below verifies transfer signatures with its own restatement of
 * the preimage (not the backend's helper), checked first against the golden
 * vector, so the backend cannot agree with itself.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';


const contract = require('../server/routes/session-key-contract');
const {
  parseSignedTransfer,
} = require('../server/routes/wallet-transfer-contract');

const GOLDEN = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      '../contract-fixtures/session-key-golden-vectors.json',
    ),
    'utf8',
  ),
);

// ---- independent ed25519 helpers ------------------------------------------------
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const addressOf = (publicKeyHex: string) =>
  `0x${crypto.createHash('sha3-256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 40)}`;

function keyFromSeed(seed: Buffer) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = crypto
    .createPublicKey(key)
    .export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = spki.subarray(spki.length - 32).toString('hex');
  return {
    publicKey,
    address: addressOf(publicKey),
    sign: (m: Buffer | string) =>
      crypto
        .sign(null, Buffer.isBuffer(m) ? m : Buffer.from(m), key)
        .toString('hex'),
  };
}
const randomKey = () => keyFromSeed(crypto.randomBytes(32));

function verifyEd25519(
  publicKeyHex: string,
  signatureHex: string,
  message: Buffer,
): boolean {
  try {
    const pub = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, message, pub, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const framed = (s: string) =>
  Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
/** core4 session_key_transfer_authorization_message_with_domain, restated independently. */
function fakeCore4TransferPreimage(
  chain: string,
  network: string,
  from: string,
  to: string,
  amount: bigint,
  nonce: bigint,
  sessionPub: string,
) {
  return Buffer.concat([
    Buffer.from('wrfcoin_session_key_transfer_auth_v1'),
    framed(chain),
    framed(network),
    framed(from),
    framed(to),
    u64(amount),
    u64(nonce),
    Buffer.from(sessionPub, 'hex'),
  ]);
}

const G = GOLDEN.inputs;
const goldenOwner = keyFromSeed(Buffer.from(G.owner_seed_hex, 'hex'));
const goldenSession = keyFromSeed(Buffer.from(G.session_seed_hex, 'hex'));
const goldenGrant = {
  publicKey: goldenSession.publicKey,
  scope: {
    allowedMethods: G.grant.allowed_methods,
    allowedTargets: G.grant.allowed_targets,
    maxValuePerUse: BigInt(G.grant.max_value_per_use),
    maxTotalValue: BigInt(G.grant.max_total_value),
    window: {
      blocks: G.grant.window.blocks,
      maxValue: BigInt(G.grant.window.max_value),
    },
  },
  validFrom: G.grant.valid_from,
  validUntil: G.grant.valid_until,
  maxUses: G.grant.max_uses,
};

/** The register body a wallet posts, from the grant (addresses as byte arrays, u128 as numbers). */
function registerBody(o: {
  owner: ReturnType<typeof keyFromSeed>;
  session: ReturnType<typeof keyFromSeed>;
  chainId: string;
  nonce: number;
  grant: typeof goldenGrant;
}) {
  const preimage = contract.sessionKeyRegisterMessage({
    chainId: o.chainId,
    owner: o.owner.address,
    registrationNonce: o.nonce,
    grant: o.grant,
  });
  const s = o.grant.scope;
  return {
    action: {
      Register: {
        owner: contract.addressToByteArray(o.owner.address),
        registration_nonce: o.nonce,
        grant: {
          public_key: o.grant.publicKey,
          scope: {
            allowed_methods: s.allowedMethods,
            allowed_targets: s.allowedTargets.map(contract.addressToByteArray),
            max_value_per_use: Number(s.maxValuePerUse),
            max_total_value: Number(s.maxTotalValue),
            window: s.window
              ? {
                blocks: s.window.blocks,
                max_value: Number(s.window.maxValue),
              }
              : null,
          },
          valid_from: o.grant.validFrom,
          valid_until: o.grant.validUntil,
          max_uses: o.grant.maxUses,
        },
        owner_public_key: o.owner.publicKey,
        owner_signature: o.owner.sign(preimage),
        session_signature: o.session.sign(preimage),
      },
    },
  };
}

describe('session-key golden vectors (core4 wallet_client_golden_vectors)', () => {
  const E = GOLDEN.expected;

  it('derives the owner and session keys and the owner address from the seeds', () => {
    expect(goldenOwner.publicKey).toBe(E.owner_public_key);
    expect(goldenSession.publicKey).toBe(E.session_public_key);
    expect(goldenOwner.address).toBe(E.owner_address);
    expect(contract.sessionKeyAddress(goldenOwner.publicKey)).toBe(
      E.owner_address,
    );
  });

  it('register preimage and both signatures match byte-for-byte', () => {
    const preimage = contract.sessionKeyRegisterMessage({
      chainId: G.chain_id,
      owner: goldenOwner.address,
      registrationNonce: G.registration_nonce,
      grant: goldenGrant,
    });
    expect(preimage.toString('hex')).toBe(E.register_preimage);
    const reg = GOLDEN.register_body.action.Register;
    expect(goldenOwner.sign(preimage)).toBe(reg.owner_signature);
    expect(goldenSession.sign(preimage)).toBe(reg.session_signature);
  });

  it('the register JSON body is exactly the one core4 accepts', () => {
    expect(
      registerBody({
        owner: goldenOwner,
        session: goldenSession,
        chainId: G.chain_id,
        nonce: 0,
        grant: goldenGrant,
      }),
    ).toEqual(GOLDEN.register_body);
    // Byte-exact: core4's REGISTER_BODY_JSON string, as serde writes it.
    expect(
      JSON.stringify(
        registerBody({
          owner: goldenOwner,
          session: goldenSession,
          chainId: G.chain_id,
          nonce: 0,
          grant: goldenGrant,
        }),
      ),
    ).toBe(E.register_body_json);
    // The relay re-serializes the parsed body; that round trip must not change a byte.
    expect(
      JSON.stringify({ action: JSON.parse(E.register_body_json).action }),
    ).toBe(E.register_body_json);
    expect(contract.parseSessionKeyAction(GOLDEN.register_body)).toEqual({
      ok: true,
      owner: E.owner_address,
      kind: 'Register',
    });
  });

  it('transfer preimage and signature match, and the fake core4 restatement agrees', () => {
    const args = {
      chainId: G.chain_id,
      networkId: G.network_id,
      from: goldenOwner.address,
      to: G.transfer.to,
      amount: G.transfer.amount,
      nonce: G.transfer.nonce,
      sessionPublicKey: goldenSession.publicKey,
    };
    const preimage = contract.sessionKeyTransferMessage(args);
    expect(preimage.toString('hex')).toBe(E.transfer_preimage);
    expect(goldenSession.sign(preimage)).toBe(E.transfer_signature);
    const fake = fakeCore4TransferPreimage(
      G.chain_id,
      G.network_id,
      goldenOwner.address,
      G.transfer.to,
      BigInt(G.transfer.amount),
      BigInt(G.transfer.nonce),
      goldenSession.publicKey,
    );
    expect(fake.toString('hex')).toBe(E.transfer_preimage);
    expect(
      verifyEd25519(goldenSession.publicKey, E.transfer_signature, fake),
    ).toBe(true);
  });

  it('revoke preimage matches', () => {
    const preimage = contract.sessionKeyRevokeMessage({
      chainId: G.chain_id,
      owner: goldenOwner.address,
      sessionKey: goldenSession.address,
      registrationNonce: G.revoke.registration_nonce,
    });
    expect(preimage.toString('hex')).toBe(E.revoke_preimage);
  });
});

describe('parseSignedTransfer: session_key_auth alternative', () => {
  const base = {
    from: `0x${'aa'.repeat(20)}`,
    to: `0x${'bb'.repeat(20)}`,
    amount: '5',
    nonce: '1',
  };
  const auth = {
    session_public_key: 'ab'.repeat(32),
    signature: 'cd'.repeat(64),
  };

  it('accepts session_key_auth without auth_pubkey', () => {
    expect(parseSignedTransfer({ ...base, session_key_auth: auth })).toEqual({
      ok: true,
      value: {
        ...base,
        amount: 5,
        sessionKeyAuth: {
          sessionPublicKey: auth.session_public_key,
          signature: auth.signature,
        },
      },
    });
  });

  it('refuses both authorizations at once, and malformed session keys', () => {
    expect(
      parseSignedTransfer({
        ...base,
        session_key_auth: auth,
        auth_pubkey: 'ab'.repeat(32),
        auth_signature: 'cd'.repeat(64),
      }).ok,
    ).toBe(false);
    expect(
      parseSignedTransfer({
        ...base,
        session_key_auth: { ...auth, session_public_key: 'zz' },
      }).code,
    ).toBe('VALIDATION_ERROR');
    expect(
      parseSignedTransfer({
        ...base,
        session_key_auth: { ...auth, signature: 'cd'.repeat(10) },
      }).code,
    ).toBe('VALIDATION_ERROR');
    expect(parseSignedTransfer({ ...base, session_key_auth: 'x' }).code).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      parseSignedTransfer({ ...base, amount: '1.5', session_key_auth: auth })
        .code,
    ).toBe('VALIDATION_ERROR');
  });

  it('leaves the ed25519 path byte-identical', () => {
    const ed = {
      ...base,
      auth_pubkey: 'ab'.repeat(32),
      auth_signature: 'cd'.repeat(64),
    };
    expect(parseSignedTransfer(ed)).toEqual({
      ok: true,
      value: {
        ...base,
        amount: 5,
        authPubkey: ed.auth_pubkey,
        authSignature: ed.auth_signature,
      },
    });
    expect(parseSignedTransfer(base)).toMatchObject({
      ok: false,
      unsigned: true,
    });
  });
});

// ---- fake core4 ------------------------------------------------------------------
const CHAIN = '777';
const NETWORK = 'testnet';
const TOKENS = {
  contributor: 'sk-contributor-token',
  reader: 'sk-reader-token',
};
interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}
interface ListRecord {
  public_key: string;
  status: string;
  allowed_methods: string[];
  max_value_per_use: string;
}
interface Core4State {
  featureActive: boolean;
  lists: Map<string, ListRecord[]>;
}

function startFakeCore4(state: Core4State) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      const u = new URL(req.url ?? '/', 'http://x');
      seen.push({
        method: req.method ?? '',
        path: u.pathname,
        headers: req.headers,
        body,
      });
      const bearer = String(req.headers.authorization ?? '').replace(
        /^Bearer /,
        '',
      );
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const err = (status: number, code: string, message: string) =>
        send(status, { ok: false, error: { code, message } });
      const needs = (role: keyof typeof TOKENS) =>
        bearer === TOKENS[role]
          ? true
          : (err(403, 'FORBIDDEN', 'Invalid API token'), false);

      const list = u.pathname.match(
        /^\/accounts\/(0x[0-9a-f]{40})\/session-keys$/,
      );
      if (req.method === 'GET' && list) {
        if (!needs('reader')) return;
        const owner = list[1];
        return send(200, {
          ok: true,
          data: {
            owner,
            feature_active: state.featureActive,
            next_height: 501,
            next_registration_nonce: 0,
            chain_id: CHAIN,
            session_keys: (state.lists.get(owner) ?? []).map((r) => ({
              session_key: addressOf(r.public_key),
              ...r,
            })),
          },
        });
      }
      if (req.method === 'POST' && u.pathname === '/session-keys/submit') {
        if (!needs('contributor')) return;
        if (!state.featureActive)
          return err(
            503,
            'FEATURE_NOT_ACTIVE',
            'session_keys is not active at the next block height 501',
          );
        return send(202, {
          ok: true,
          data: {
            accepted: true,
            tx_id: 'tx-sk-action',
            tx_type: 'SessionKeyAction',
          },
        });
      }
      if (req.method === 'POST' && u.pathname === '/transactions/submit') {
        if (!needs('contributor')) return;
        const a = body?.session_key_auth;
        if (!a)
          return err(
            400,
            'VALIDATION_ERROR',
            'this fake only settles session-key transfers',
          );
        if (body.auth_pubkey !== undefined || body.auth_signature !== undefined)
          return err(400, 'VALIDATION_ERROR', 'both authorizations');
        if (!state.featureActive)
          return err(503, 'FEATURE_NOT_ACTIVE', 'session_keys is not active');
        const preimage = fakeCore4TransferPreimage(
          CHAIN,
          NETWORK,
          body.from,
          body.to,
          BigInt(body.amount),
          BigInt(body.nonce),
          a.session_public_key,
        );
        if (!verifyEd25519(a.session_public_key, a.signature, preimage))
          return err(
            400,
            'AUTHORIZATION_INVALID',
            'session_key_auth does not verify',
          );
        const record = (state.lists.get(body.from) ?? []).find(
          (r) => r.public_key === a.session_public_key && r.status === 'active',
        );
        if (!record || BigInt(body.amount) > BigInt(record.max_value_per_use))
          return err(
            403,
            'SESSION_KEY_LIMIT',
            'session key cannot authorize this transfer',
          );
        return send(202, {
          ok: true,
          data: { accepted: true, tx_id: 'tx-sk-0001' },
        });
      }
      return err(404, 'NOT_FOUND', 'unknown route');
    });
  });
  return new Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}`,
          seen,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    },
  );
}

function fakeRedis() {
  const m = new Map<string, string>();
  return attachWalletNonceIssuer({
    set: async (k: string, v: string) => {
      m.set(k, v);
      return 'OK';
    },
    get: async (k: string) => m.get(k) ?? null,
    del: async (k: string) => (m.delete(k) ? 1 : 0),
  });
}

describe('session keys through the wallet routes and sign-in (fake core4)', () => {
  const owner = randomKey();
  const device = randomKey();
  const other = randomKey();
  const state: Core4State = { featureActive: true, lists: new Map() };
  const activeRecord = (over: Partial<ListRecord> = {}): ListRecord => ({
    public_key: device.publicKey,
    status: 'active',
    allowed_methods: ['transfer', 'wallet_login'],
    max_value_per_use: '1000000000',
    ...over,
  });
  const envKeys = [
    'CORE4_API_URL',
    'JWT_SECRET',
    'WRFCOIN_CHAIN_ID',
    'WRFCOIN_NETWORK_ID',
    'WRFCOIN_CONTRIBUTOR_TOKEN',
    'WRFCOIN_READER_TOKEN',
  ];
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  const JWT_SECRET = 'session-key-wallet-test-jwt-secret-0123456789abcdef';
  let core4: Awaited<ReturnType<typeof startFakeCore4>>;
  let app: express.Express;
  let service: any;
  let ownerJwt = '';
  const auth = () => ({ Authorization: `Bearer ${ownerJwt}` });
  const hits = (p: string) => core4.seen.filter((s) => s.path === p).length;

  async function sessionLogin(
    o: { key?: ReturnType<typeof randomKey>; ownerAddress?: string } = {},
  ) {
    const key = o.key ?? device;
    const address = o.ownerAddress ?? owner.address;
    const challenge = await service.generateNonce(
      address,
      'session_key',
      key.publicKey,
    );
    return service.walletLogin({
      scheme: 'session_key',
      address,
      pubkey: key.publicKey,
      nonce: challenge.nonce,
      signature: key.sign(challenge.message),
    });
  }

  beforeAll(async () => {
    core4 = await startFakeCore4(state);
    Object.assign(process.env, {
      CORE4_API_URL: core4.url,
      JWT_SECRET,
      WRFCOIN_CHAIN_ID: CHAIN,
      WRFCOIN_NETWORK_ID: NETWORK,
      WRFCOIN_CONTRIBUTOR_TOKEN: TOKENS.contributor,
      WRFCOIN_READER_TOKEN: TOKENS.reader,
    });
    const walletRoutes = require('../server/routes/wallet-routes');
    app = express();
    app.use(express.json());
    app.use('/api/wallet', walletRoutes.default ?? walletRoutes);
    const { createWalletAuthService } =
      await import('../server/routes/wallet-auth-service');
    // Default session-key lookup: the real core4 client against the fake, Reader token.
    service = createWalletAuthService({
      redis: fakeRedis() as any,
      db: { execute: async () => ({ rows: [] }) } as any,
      walletAuthNetwork: NETWORK,
    });
    const challenge = await service.generateNonce(owner.address, 'ed25519');
    ownerJwt = (
      await service.walletLogin({
        address: owner.address,
        scheme: 'ed25519',
        pubkey: owner.publicKey,
        nonce: challenge.nonce,
        signature: owner.sign(challenge.message),
      })
    ).jwt;
  });

  beforeEach(() => {
    state.featureActive = true;
    state.lists = new Map([[owner.address, [activeRecord()]]]);
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await core4?.close();
  });

  describe('GET /api/wallet/:address/session-keys', () => {
    it('relays the owner list with the Reader token (never the JWT)', async () => {
      const res = await request(app)
        .get(`/api/wallet/${owner.address}/session-keys`)
        .set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.feature_active).toBe(true);
      expect(res.body.data.session_keys[0].public_key).toBe(device.publicKey);
      const read = core4.seen
        .filter((s) => s.path === `/accounts/${owner.address}/session-keys`)
        .pop()!;
      expect(read.headers.authorization).toBe(`Bearer ${TOKENS.reader}`);
    });

    it('passes feature_active:false through (the app shows device keys as not yet on)', async () => {
      state.featureActive = false;
      const res = await request(app)
        .get(`/api/wallet/${owner.address}/session-keys`)
        .set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.feature_active).toBe(false);
    });

    it('is owner-bound and needs a login', async () => {
      expect(
        (
          await request(app)
            .get(`/api/wallet/${other.address}/session-keys`)
            .set(auth())
        ).status,
      ).toBe(403);
      expect(
        (await request(app).get(`/api/wallet/${owner.address}/session-keys`))
          .status,
      ).toBe(401);
    });
  });

  describe('POST /api/wallet/session-keys', () => {
    const body = () =>
      registerBody({
        owner,
        session: device,
        chainId: CHAIN,
        nonce: 0,
        grant: { ...goldenGrant, publicKey: device.publicKey },
      });

    it('relays an owner-signed register exactly, with the Contributor token', async () => {
      const b = body();
      const res = await request(app)
        .post('/api/wallet/session-keys')
        .set(auth())
        .send(b);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        hash: 'tx-sk-action',
        action: 'register',
        status: 'submitted',
        settled: false,
      });
      const relayed = core4.seen
        .filter((s) => s.path === '/session-keys/submit')
        .pop()!;
      expect(relayed.body).toEqual(b);
      expect(relayed.headers.authorization).toBe(
        `Bearer ${TOKENS.contributor}`,
      );
    });

    it('relays a revoke', async () => {
      const preimage = contract.sessionKeyRevokeMessage({
        chainId: CHAIN,
        owner: owner.address,
        sessionKey: device.address,
        registrationNonce: 0,
      });
      const revoke = {
        action: {
          Revoke: {
            owner: contract.addressToByteArray(owner.address),
            session_key: contract.addressToByteArray(device.address),
            owner_public_key: owner.publicKey,
            owner_signature: owner.sign(preimage),
          },
        },
      };
      const res = await request(app)
        .post('/api/wallet/session-keys')
        .set(auth())
        .send(revoke);
      expect(res.status).toBe(202);
      expect(res.body.action).toBe('revoke');
    });

    it('passes 503 FEATURE_NOT_ACTIVE through cleanly', async () => {
      state.featureActive = false;
      const res = await request(app)
        .post('/api/wallet/session-keys')
        .set(auth())
        .send(body());
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('FEATURE_NOT_ACTIVE');
    });

    it('refuses another owner, a key that does not derive to owner, and malformed bodies before core4', async () => {
      const n = hits('/session-keys/submit');
      const foreign = registerBody({
        owner: other,
        session: device,
        chainId: CHAIN,
        nonce: 0,
        grant: goldenGrant,
      });
      expect(
        (
          await request(app)
            .post('/api/wallet/session-keys')
            .set(auth())
            .send(foreign)
        ).status,
      ).toBe(403);
      const mismatched = body();
      mismatched.action.Register.owner_public_key = other.publicKey;
      expect(
        (
          await request(app)
            .post('/api/wallet/session-keys')
            .set(auth())
            .send(mismatched)
        ).status,
      ).toBe(400);
      const noTargets = body();
      noTargets.action.Register.grant.scope.allowed_targets = [];
      expect(
        (
          await request(app)
            .post('/api/wallet/session-keys')
            .set(auth())
            .send(noTargets)
        ).status,
      ).toBe(400);
      expect(
        (
          await request(app)
            .post('/api/wallet/session-keys')
            .set(auth())
            .send({ action: { Use: {} } })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(app)
            .post('/api/wallet/session-keys')
            .set(auth())
            .send({})
        ).status,
      ).toBe(400);
      expect(hits('/session-keys/submit')).toBe(n);
    });
  });

  describe('POST /api/wallet/send with session_key_auth', () => {
    function sessionTransfer(amount: bigint, nonce = '4', signer = device) {
      const to = other.address;
      const message = fakeCore4TransferPreimage(
        CHAIN,
        NETWORK,
        owner.address,
        to,
        amount,
        BigInt(nonce),
        signer.publicKey,
      );
      return {
        from: owner.address,
        to,
        amount: amount.toString(),
        nonce,
        session_key_auth: {
          session_public_key: signer.publicKey,
          signature: signer.sign(message),
        },
      };
    }

    it('relays session_key_auth instead of auth_pubkey/auth_signature and core4 settles it', async () => {
      const b = sessionTransfer(250_000_000n);
      const res = await request(app)
        .post('/api/wallet/send')
        .set(auth())
        .send(b);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        hash: 'tx-sk-0001',
        status: 'submitted',
        settled: false,
      });
      const relayed = core4.seen
        .filter((s) => s.path === '/transactions/submit')
        .pop()!;
      expect(relayed.body).toEqual({
        from: owner.address,
        to: other.address,
        amount: 250000000,
        nonce: '4',
        transparent_opt_out: true,
        transparent_opt_out_reason: 'first-party wallet',
        session_key_auth: b.session_key_auth,
      });
    });

    it('passes SESSION_KEY_LIMIT and FEATURE_NOT_ACTIVE through', async () => {
      const over = await request(app)
        .post('/api/wallet/send')
        .set(auth())
        .send(sessionTransfer(2_000_000_000n));
      expect(over.status).toBe(403);
      expect(over.body.error.code).toBe('SESSION_KEY_LIMIT');
      state.featureActive = false;
      const off = await request(app)
        .post('/api/wallet/send')
        .set(auth())
        .send(sessionTransfer(1n));
      expect(off.status).toBe(503);
      expect(off.body.error.code).toBe('FEATURE_NOT_ACTIVE');
    });

    it('still binds from to the logged-in owner', async () => {
      const n = hits('/transactions/submit');
      const b = { ...sessionTransfer(1n), from: other.address };
      expect(
        (await request(app).post('/api/wallet/send').set(auth()).send(b))
          .status,
      ).toBe(403);
      expect(hits('/transactions/submit')).toBe(n);
    });
  });

  describe('sign-in with a session key', () => {
    // A fresh nonce store per case: issuance is limited to 8 per owner per window.
    beforeEach(async () => {
      const { createWalletAuthService } =
        await import('../server/routes/wallet-auth-service');
      service = createWalletAuthService({
        redis: fakeRedis() as any,
        db: { execute: async () => ({ rows: [] }) } as any,
        walletAuthNetwork: NETWORK,
      });
    });

    it('good login: the device key signs the challenge and the JWT subject is the owner', async () => {
      const challenge = await service.generateNonce(
        owner.address,
        'session_key',
        device.publicKey,
      );
      const lines = challenge.message.split('\n');
      expect(lines[0]).toBe('wrfcoin_wallet_login_session_key_v1');
      expect(lines).toContain(owner.address);
      expect(lines).toContain(`Session Key: ${device.publicKey}`);
      expect(lines).toContain('Scheme: session_key');
      expect(challenge).toMatchObject({
        scheme: 'session_key',
        sessionPublicKey: device.publicKey,
      });
      const tokens = await service.walletLogin({
        scheme: 'session_key',
        address: owner.address,
        pubkey: device.publicKey,
        nonce: challenge.nonce,
        signature: device.sign(challenge.message),
      });
      const claims: any = jwt.verify(tokens.jwt, JWT_SECRET, {
        algorithms: ['HS256'],
      });
      expect(claims.sub).toBe(owner.address);
      expect(claims.wallet_scheme).toBe('session_key');
      // The minted token works on the owner's wallet routes.
      const read = await request(app)
        .get(`/api/wallet/${owner.address}/session-keys`)
        .set({ Authorization: `Bearer ${tokens.jwt}` });
      expect(read.status).toBe(200);
    });

    it.each([
      ['revoked', { status: 'revoked' }],
      ['expired', { status: 'expired' }],
      ['not yet valid', { status: 'not_yet_valid' }],
      ['without wallet_login', { allowed_methods: ['transfer'] }],
    ])('refuses a key that is %s', async (_label, over) => {
      state.lists.set(owner.address, [
        activeRecord(over as Partial<ListRecord>),
      ]);
      await expect(sessionLogin()).rejects.toThrow(
        'session key is not active for wallet login',
      );
    });

    it('refuses a key registered to a different owner', async () => {
      state.lists = new Map([[other.address, [activeRecord()]]]);
      await expect(sessionLogin()).rejects.toThrow(
        'session key is not active for wallet login',
      );
    });

    it('refuses while the feature is off', async () => {
      state.featureActive = false;
      await expect(sessionLogin()).rejects.toThrow(
        'session key is not active for wallet login',
      );
    });

    it('refuses a signature by another key, and a challenge issued for another key', async () => {
      const challenge = await service.generateNonce(
        owner.address,
        'session_key',
        device.publicKey,
      );
      await expect(
        service.walletLogin({
          scheme: 'session_key',
          address: owner.address,
          pubkey: device.publicKey,
          nonce: challenge.nonce,
          signature: other.sign(challenge.message),
        }),
      ).rejects.toThrow('invalid wallet signature');
      const c2 = await service.generateNonce(
        owner.address,
        'session_key',
        device.publicKey,
      );
      await expect(
        service.walletLogin({
          scheme: 'session_key',
          address: owner.address,
          pubkey: other.publicKey,
          nonce: c2.nonce,
          signature: other.sign(c2.message),
        }),
      ).rejects.toThrow();
    });

    it('a session-key challenge signature is not an ed25519 login for the device address', async () => {
      const challenge = await service.generateNonce(
        owner.address,
        'session_key',
        device.publicKey,
      );
      await expect(
        service.walletLogin({
          scheme: 'ed25519',
          address: device.address,
          pubkey: device.publicKey,
          nonce: challenge.nonce,
          signature: device.sign(challenge.message),
        }),
      ).rejects.toThrow();
    });

    it('needs a session public key to issue a challenge', async () => {
      await expect(
        service.generateNonce(owner.address, 'session_key'),
      ).rejects.toThrow('session public key is required');
      await expect(
        service.generateNonce(owner.address, 'session_key', 'zz'),
      ).rejects.toThrow();
    });

    it('refresh re-checks the key: a device removed after sign-in stops refreshing', async () => {
      const tokens = await sessionLogin();
      const refreshed = await service.refresh({
        refreshToken: tokens.refreshToken,
      });
      expect((jwt.decode(refreshed.jwt) as any).wallet_scheme).toBe(
        'session_key',
      );
      state.lists.set(owner.address, [activeRecord({ status: 'revoked' })]);
      await expect(
        service.refresh({ refreshToken: refreshed.refreshToken }),
      ).rejects.toThrow('session key is not active');
    });
  });
});
