/**
 * backend#1288 story B6: the per-phone COLLECT key (design addendum §11).
 *
 * A second, spend-less ed25519 key lives on the phone so background runs can
 * sign commit authorizations without the biometric-gated wallet key. The wallet
 * authorises it once, inside preimage A v2. core4 does not bind `auth_pubkey`
 * to the station owner, so oracle-submit-routes is the binding: for a `mob-`
 * station the commit `auth_pubkey` must equal the registered collect key.
 *
 * Service level: FakeStore. Route level: the real weather + oracle routers with
 * core4 mocked (a spy that proves "before any core4 call").
 */
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { FakeStore } from './helpers/mobile-station-fake-store';

const mockStore = new FakeStore();
const stationOwners = new Map<string, string>(); // non-mobile weather_stations rows
let collectLookupFails = false;

function fakeAuth(req: any, res: any, next: any) {
  const wallet = req.headers['x-test-wallet'];
  if (!wallet) return res.status(401).json({ error: 'Bearer Token Required' });
  req.user = { address: wallet, walletAddress: wallet, id: 'u' };
  return next();
}
jest.mock('../server/middleware/auth-middleware.js', () => ({ authenticateToken: fakeAuth }));
jest.mock('../server/middleware/authMiddleware', () => ({ requireAuth: fakeAuth }));
jest.mock('../server/db', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../server/services/mobile-station-registration-service', () => {
  const actual = jest.requireActual('../server/services/mobile-station-registration-service');
  return { ...actual, PgMobileStationStore: class { constructor() { return mockStore; } } };
});
// One executeQuery double for both lookups the submit path makes.
jest.mock('../database/connection.js', () => ({
  executeQuery: jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM mobile_station_registrations')) {
      if (collectLookupFails) throw new Error('db down');
      const [stationId, owner] = params as string[];
      const row = [...mockStore.registrations.values()].find(
        (r) => r.stationId === stationId && r.ownerAddress === owner
      );
      return { rows: row ? [{ collect_pubkey: row.collectPubkey, status: row.status }] : [] };
    }
    const id = String(params[0]);
    const mobile = mockStore.stations.get(id);
    const owner = mobile?.owner ?? stationOwners.get(id);
    return { rows: owner ? [{ owner_address: owner }] : [] };
  }),
}));
const mockFetchCore4Json = jest.fn();
jest.mock('../shared/core4-route-client.js', () => ({
  fetchCore4Json: (...args: unknown[]) => mockFetchCore4Json(...args),
  extractCore4Data: (p: any) => p?.data ?? p,
  forwardCore4Headers: jest.fn(() => ({})),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const weatherRoutes = require('../server/routes/weather-routes');
import oracleSubmitRoutes from '../server/routes/oracle-submit-routes';
import {
  buildMobileStationRegistrationMessage,
  buildStationOwnershipMessage,
  deriveMobileStationId,
} from '../shared/mobile-station-messages';
import {
  issueMobileStationChallenge,
  registerMobileStation,
} from '../server/services/mobile-station-registration-service';
import { buildExportArtifact } from '../server/services/mobile-station-export';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function keypair(seed: number) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = spki.subarray(spki.length - 32).toString('hex');
  const address = `0x${crypto.createHash('sha3-256').update(Buffer.from(publicKey, 'hex')).digest('hex').slice(0, 40)}`;
  return { publicKey, address, sign: (m: Buffer) => crypto.sign(null, m, key).toString('hex') };
}

const CHAIN = { chainId: '777', networkId: 'testnet' };
const NOW = 1_790_000_000;
const dana = keypair(41); // wallet
const danaPhone1 = keypair(141); // collect keys
const danaPhone2 = keypair(142);
const eve = keypair(43); // another wallet
const evePhone = keypair(143);
let counter = 0;
const deps = (now = NOW) => ({ ...CHAIN, now: () => now, newNonce: () => `b6-${++counter}-${'0'.repeat(20)}` });

type Ch = { nonce: string; expiresAt: number; stationId: string };
async function challenge(store: FakeStore, w = dana): Promise<Ch> {
  const res = await issueMobileStationChallenge(store, w.address, deps());
  expect(res.status).toBe(200);
  return res.body as unknown as Ch;
}

function v2Body(w: ReturnType<typeof keypair>, ch: Ch, collectPubkey: string, over: Record<string, unknown> = {}) {
  const cell = { latE1: 100, lonE1: -200 };
  return {
    nonce: ch.nonce, expiresAt: ch.expiresAt, publicKey: w.publicKey, collectPubkey, cell,
    deviceClass: 'phone-barometer',
    registrationSignature: w.sign(buildMobileStationRegistrationMessage({
      ...CHAIN, stationId: ch.stationId, ownerAddress: w.address, collectPubkey,
      latE1: cell.latE1, lonE1: cell.lonE1, nonce: ch.nonce, expiresAt: ch.expiresAt,
    })),
    ownershipSignature: w.sign(buildStationOwnershipMessage({ ...CHAIN, stationId: ch.stationId, ownerAddress: w.address })),
    ...over,
  };
}

function code(res: { body: any }) {
  return (res.body as any).error?.code;
}

beforeEach(() => {
  mockStore.nonces.clear();
  mockStore.registrations.clear();
  mockStore.stations.clear();
  stationOwners.clear();
  collectLookupFails = false;
  mockFetchCore4Json.mockReset();
  delete process.env.WRFCOIN_CHAIN_ID;
  delete process.env.WRFCOIN_NETWORK_ID;
  process.env.WRFCOIN_CONTRIBUTOR_TOKEN = 'test-contributor';
  process.env.WRFCOIN_READER_TOKEN = 'test-reader';
});

describe('B6 registration v2 (service)', () => {
  it('v2 happy path: registers, stores the collect key lowercase, and consumes the nonce', async () => {
    const store = new FakeStore();
    const ch = await challenge(store);
    const res = await registerMobileStation(store, dana.address, v2Body(dana, ch, danaPhone1.publicKey.toUpperCase()), deps());
    // an upper-case key is signed lower-cased by the builder, so the SAME signature must verify
    expect(res.status).toBe(201);
    expect(store.registrations.get(dana.address)!.collectPubkey).toBe(danaPhone1.publicKey);
    expect(store.registrations.get(dana.address)!.ownerPubkey).toBe(dana.publicKey);
    expect(store.nonces.get(ch.nonce)!.consumed).toBe(true);
    // the response never echoes keys
    expect(JSON.stringify(res.body)).not.toContain(danaPhone1.publicKey);
  });

  it('v1 is rejected by name: no collectPubkey -> 400 REGISTRATION_VERSION_UNSUPPORTED, nothing written', async () => {
    const store = new FakeStore();
    const ch = await challenge(store);
    const { collectPubkey: _drop, ...v1Shape } = v2Body(dana, ch, danaPhone1.publicKey);
    const res = await registerMobileStation(store, dana.address, v1Shape, deps());
    expect(res.status).toBe(400);
    expect(code(res)).toBe('REGISTRATION_VERSION_UNSUPPORTED');
    expect(store.registrations.size).toBe(0);
    expect(store.stations.size).toBe(0);
    expect(store.nonces.get(ch.nonce)!.consumed).toBe(false);
  });

  it('an explicit version other than 2 is rejected the same way, even with a collect key', async () => {
    const store = new FakeStore();
    const ch = await challenge(store);
    for (const version of [1, 3, '2', null]) {
      const res = await registerMobileStation(store, dana.address, v2Body(dana, ch, danaPhone1.publicKey, { version }), deps());
      expect(code(res)).toBe('REGISTRATION_VERSION_UNSUPPORTED');
    }
    const ok = await registerMobileStation(store, dana.address, v2Body(dana, ch, danaPhone1.publicKey, { version: 2 }), deps());
    expect(ok.status).toBe(201);
  });

  it('a signature made over the retired v1 layout never verifies as v2 (collect key present or not)', async () => {
    const store = new FakeStore();
    const ch = await challenge(store);
    // hand-build the v1 bytes: v2 minus the collect lv, with the v1 tag
    const v2 = buildMobileStationRegistrationMessage({
      ...CHAIN, stationId: ch.stationId, ownerAddress: dana.address, collectPubkey: danaPhone1.publicKey,
      latE1: 100, lonE1: -200, nonce: ch.nonce, expiresAt: ch.expiresAt,
    });
    const tag2 = Buffer.from('wrfcoin_mobile_station_reg_v2');
    const collectLv = Buffer.concat([Buffer.from([64, 0, 0, 0]), Buffer.from(danaPhone1.publicKey)]);
    const at = v2.indexOf(collectLv);
    const v1 = Buffer.concat([Buffer.from('wrfcoin_mobile_station_reg_v1'), v2.subarray(tag2.length, at), v2.subarray(at + collectLv.length)]);
    const res = await registerMobileStation(
      store, dana.address, v2Body(dana, ch, danaPhone1.publicKey, { registrationSignature: dana.sign(v1) }), deps()
    );
    expect(res.status).toBe(403);
    expect(code(res)).toBe('INVALID_REGISTRATION_SIGNATURE');
    expect(store.registrations.size).toBe(0);
  });

  it('the wallet authorises the collect key: swapping in another key under an old signature is refused', async () => {
    const store = new FakeStore();
    const ch = await challenge(store);
    const signedForPhone1 = v2Body(dana, ch, danaPhone1.publicKey);
    const res = await registerMobileStation(
      store, dana.address, { ...signedForPhone1, collectPubkey: evePhone.publicKey }, deps()
    );
    expect(res.status).toBe(403);
    expect(code(res)).toBe('INVALID_REGISTRATION_SIGNATURE');
    expect(store.registrations.size).toBe(0);
  });

  it('collect key == wallet key is refused (400 COLLECT_KEY_IS_WALLET_KEY), case-insensitively', async () => {
    const store = new FakeStore();
    const ch = await challenge(store);
    for (const key of [dana.publicKey, dana.publicKey.toUpperCase()]) {
      const res = await registerMobileStation(store, dana.address, v2Body(dana, ch, dana.publicKey, { collectPubkey: key }), deps());
      expect(res.status).toBe(400);
      expect(code(res)).toBe('COLLECT_KEY_IS_WALLET_KEY');
    }
    expect(store.registrations.size).toBe(0);
    expect(store.nonces.get(ch.nonce)!.consumed).toBe(false);
  });

  it.each([
    ['too short', 'ab'.repeat(31)],
    ['too long', 'ab'.repeat(33)],
    ['non-hex', 'zz'.repeat(32)],
    ['0x-prefixed', `0x${'ab'.repeat(31)}`],
    ['a number', 12345],
    ['an object', { hex: 'ab'.repeat(32) }],
    ['empty string', ''],
  ])('malformed collect key (%s) -> 400 COLLECT_KEY_INVALID', async (_label, bad) => {
    const store = new FakeStore();
    const ch = await challenge(store);
    const res = await registerMobileStation(
      store, dana.address, { ...v2Body(dana, ch, danaPhone1.publicKey), collectPubkey: bad }, deps()
    );
    expect(res.status).toBe(400);
    expect(code(res)).toBe('COLLECT_KEY_INVALID');
    expect(store.registrations.size).toBe(0);
  });

  it('idempotent re-register with the SAME collect key returns the existing station, unchanged, nonce unspent', async () => {
    const store = new FakeStore();
    const first = await registerMobileStation(store, dana.address, v2Body(dana, await challenge(store), danaPhone1.publicKey), deps());
    expect(first.status).toBe(201);
    const before = { ...store.registrations.get(dana.address)! };
    const ch2 = await challenge(store);
    const again = await registerMobileStation(store, dana.address, v2Body(dana, ch2, danaPhone1.publicKey), deps());
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ stationId: before.stationId, created: false });
    expect((again.body as any).rotated).toBeUndefined();
    expect(store.registrations.get(dana.address)).toEqual(before);
    expect(store.nonces.get(ch2.nonce)!.consumed).toBe(false);
  });

  it('rotation: a NEW collect key under a fresh wallet signature replaces the stored key (200, rotated)', async () => {
    const store = new FakeStore();
    await registerMobileStation(store, dana.address, v2Body(dana, await challenge(store), danaPhone1.publicKey), deps());
    const before = store.registrations.get(dana.address)!;
    const ch2 = await challenge(store);
    const res = await registerMobileStation(store, dana.address, v2Body(dana, ch2, danaPhone2.publicKey), deps());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stationId: before.stationId, created: false, rotated: true });
    const after = store.registrations.get(dana.address)!;
    expect(after.collectPubkey).toBe(danaPhone2.publicKey);
    expect(after.registrationNonce).toBe(ch2.nonce);
    // one station, one registered cell, status and ownership proof untouched
    expect(after).toMatchObject({
      stationId: before.stationId, cellLatE1: before.cellLatE1, cellLonE1: before.cellLonE1,
      status: before.status, ownerPubkey: before.ownerPubkey, ownershipSignature: before.ownershipSignature,
    });
    expect(store.registrations.size).toBe(1);
    expect(store.nonces.get(ch2.nonce)!.consumed).toBe(true);
  });

  it('rotation is not repeatable with the same nonce for a different key, and a retry of the same request is idempotent', async () => {
    const store = new FakeStore();
    await registerMobileStation(store, dana.address, v2Body(dana, await challenge(store), danaPhone1.publicKey), deps());
    const ch2 = await challenge(store);
    const rotate = v2Body(dana, ch2, danaPhone2.publicKey);
    expect((await registerMobileStation(store, dana.address, rotate, deps())).status).toBe(200);
    // lost response: same request again -> existing station, not an error, not a second rotation
    const retry = await registerMobileStation(store, dana.address, rotate, deps());
    expect(retry.status).toBe(200);
    expect(store.registrations.get(dana.address)!.collectPubkey).toBe(danaPhone2.publicKey);
    // the spent nonce cannot rotate back to phone 1
    const back = await registerMobileStation(store, dana.address, v2Body(dana, ch2, danaPhone1.publicKey), deps());
    expect(back.status).toBe(409);
    expect(code(back)).toBe('NONCE_REPLAYED');
    expect(store.registrations.get(dana.address)!.collectPubkey).toBe(danaPhone2.publicKey);
  });

  it("another wallet cannot rotate this wallet's collect key (wallet/JWT binding)", async () => {
    const store = new FakeStore();
    await registerMobileStation(store, dana.address, v2Body(dana, await challenge(store), danaPhone1.publicKey), deps());
    // eve signs with her own key for HER station; she never touches dana's row
    const chEve = await challenge(store, eve);
    const res = await registerMobileStation(store, eve.address, v2Body(eve, chEve, evePhone.publicKey), deps());
    expect(res.status).toBe(201);
    expect(store.registrations.get(dana.address)!.collectPubkey).toBe(danaPhone1.publicKey);
    // and dana's session with eve's signed body is a wallet mismatch
    const chDana = await challenge(store);
    const forged = await registerMobileStation(store, dana.address, v2Body(eve, chDana, evePhone.publicKey), deps());
    expect(forged.status).toBe(403);
    expect(code(forged)).toBe('WALLET_MISMATCH');
    expect(store.registrations.get(dana.address)!.collectPubkey).toBe(danaPhone1.publicKey);
  });

  it('concurrency unchanged: parallel identical registrations yield exactly one row and one 201', async () => {
    const store = new FakeStore();
    const body = v2Body(dana, await challenge(store), danaPhone1.publicKey);
    const results = await Promise.all([1, 2, 3, 4].map(() => registerMobileStation(store, dana.address, body, deps())));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(store.registrations.size).toBe(1);
  });

  it('the operator export carries nothing new: the collect key is backend-only and never reaches core4', () => {
    const row = {
      stationId: deriveMobileStationId(dana.address), ownerAddress: dana.address, ownerPubkey: dana.publicKey,
      ownershipSignature: dana.sign(buildStationOwnershipMessage({ ...CHAIN, stationId: deriveMobileStationId(dana.address), ownerAddress: dana.address })),
      cellLatE1: 123, cellLonE1: -456, deviceClass: 'phone-barometer',
      collectPubkey: danaPhone1.publicKey,
    };
    const { artifact } = buildExportArtifact([row as any], { ...CHAIN, batchId: 'b6' });
    expect(artifact.stations).toHaveLength(1);
    expect(JSON.stringify(artifact)).not.toContain(danaPhone1.publicKey);
    expect(Object.keys(artifact.stations[0]).sort()).toEqual([
      'cell', 'chain_id', 'data_quality_tier', 'hardware_model', 'latitude', 'longitude', 'network_id',
      'owner_address', 'owner_pubkey', 'owner_signature', 'provenance_class', 'station_id',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Route level: the collect-key binding in oracle-submit-routes.
// ---------------------------------------------------------------------------
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/weather', weatherRoutes.default ?? weatherRoutes);
  app.use('/api/oracle', oracleSubmitRoutes);
  return app;
}

async function registerViaHttp(app: express.Express, w: ReturnType<typeof keypair>, collectPubkey: string) {
  const ch = await request(app).post('/api/weather/stations/mobile/challenge').set('x-test-wallet', w.address);
  expect(ch.status).toBe(200);
  const res = await request(app)
    .post('/api/weather/stations/mobile').set('x-test-wallet', w.address)
    .send(v2Body(w, ch.body as Ch, collectPubkey));
  return res;
}

const reading = (stationId: string, extra: Record<string, unknown> = {}) => ({
  dataType: 'temperature',
  location: { stationId, lat: 41.9, lon: -87.6 },
  value: 72.5,
  timestamp: '2026-05-29T12:00:00.000Z',
  source: 'mobile',
  nonce: 'mobile-nonce',
  ...extra,
});
const SIG = '11'.repeat(64);
// Registration leaves a station db_only; core4 only knows it once it is on_chain.
// (The STATION_NOT_ACTIVE cases live in mobile-station-not-active.test.ts.)
const activate = (w: { address: string }) => {
  mockStore.registrations.get(w.address)!.status = 'on_chain';
};
const submit = (app: express.Express, w: { address: string }, body: object) =>
  request(app).post('/api/oracle/submit-data').set('x-test-wallet', w.address).send(body);
const prepare = (app: express.Express, w: { address: string }, body: object) =>
  request(app).post('/api/oracle/submit-data/prepare').set('x-test-wallet', w.address).send(body);

function core4Ok() {
  mockFetchCore4Json.mockImplementation(async (path: string) => ({
    ok: true,
    status: 200,
    payload: { data: path.includes('/status') ? { status: 'revealed_pending_attestation' } : { tx_id: 'tx-1' } },
  }));
}

describe('B6 collect-key binding on submit-data (route level)', () => {
  // The per-wallet challenge limiter (5/hour) is module state, so every test gets its own wallets.
  let dana: ReturnType<typeof keypair>;
  let eve: ReturnType<typeof keypair>;
  let danaPhone1: ReturnType<typeof keypair>;
  let danaPhone2: ReturnType<typeof keypair>;
  let evePhone: ReturnType<typeof keypair>;
  let stationId: string;
  let seed = 60;
  beforeEach(() => {
    [dana, eve, danaPhone1, danaPhone2, evePhone] = [1, 2, 3, 4, 5].map((n) => keypair(seed + n)) as any;
    seed += 10;
    stationId = deriveMobileStationId(dana.address);
  });

  it('submit with the WALLET key as auth_pubkey -> 403 COLLECT_KEY_MISMATCH, no core4 call', async () => {
    const app = buildApp();
    expect((await registerViaHttp(app, dana, danaPhone1.publicKey)).status).toBe(201);
    const res = await submit(app, dana, reading(stationId, { auth_pubkey: dana.publicKey, auth_signature: SIG }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COLLECT_KEY_MISMATCH');
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });

  it('submit with NO auth_pubkey for a mob- station -> 403 (no silent fallback to the wallet), no core4 call', async () => {
    const app = buildApp();
    await registerViaHttp(app, dana, danaPhone1.publicKey);
    for (const extra of [{}, { auth_pubkey: null }, { auth_pubkey: 42 }, { auth_pubkey: '' }, { auth_pubkey: { a: 1 } }]) {
      const res = await submit(app, dana, reading(stationId, { auth_signature: SIG, ...extra }));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('COLLECT_KEY_MISMATCH');
    }
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });

  it('submit with the registered collect key proceeds to core4 and forwards the pair untouched', async () => {
    const app = buildApp();
    await registerViaHttp(app, dana, danaPhone1.publicKey);
    activate(dana);
    core4Ok();
    const res = await submit(app, dana, reading(stationId, { auth_pubkey: danaPhone1.publicKey, auth_signature: SIG }));
    expect(res.status).toBe(200);
    const commit = mockFetchCore4Json.mock.calls.find((c) => c[0] === '/transactions/contribution/commit')!;
    expect(commit[1].body).toMatchObject({ station_id: stationId, auth_pubkey: danaPhone1.publicKey, auth_signature: SIG });
  });

  it('forwards the same normalized collect key that passed the binding check (#1313)', async () => {
    const app = buildApp();
    await registerViaHttp(app, dana, danaPhone1.publicKey);
    activate(dana);
    core4Ok();
    const res = await submit(app, dana, reading(stationId, {
      auth_pubkey: `  ${danaPhone1.publicKey.toUpperCase()}  `,
      auth_signature: SIG,
    }));
    expect(res.status).toBe(200);
    const commit = mockFetchCore4Json.mock.calls.find((c) => c[0] === '/transactions/contribution/commit')!;
    expect(commit[1].body.auth_pubkey).toBe(danaPhone1.publicKey);
    expect(commit[1].body.auth_signature).toBe(SIG);
  });

  it('the comparison is case- and whitespace-normalised', async () => {
    const app = buildApp();
    await registerViaHttp(app, dana, danaPhone1.publicKey);
    activate(dana);
    core4Ok();
    const res = await submit(app, dana, reading(stationId, { auth_pubkey: ` ${danaPhone1.publicKey.toUpperCase()} `, auth_signature: SIG }));
    expect(res.status).toBe(200);
  });

  it("rotation: after re-registration the OLD key is refused and the NEW key is accepted", async () => {
    const app = buildApp();
    await registerViaHttp(app, dana, danaPhone1.publicKey);
    activate(dana);
    core4Ok();
    expect((await submit(app, dana, reading(stationId, { auth_pubkey: danaPhone1.publicKey, auth_signature: SIG }))).status).toBe(200);

    const rotated = await registerViaHttp(app, dana, danaPhone2.publicKey);
    expect(rotated.status).toBe(200);
    expect(rotated.body.rotated).toBe(true);

    mockFetchCore4Json.mockClear();
    const old = await submit(app, dana, reading(stationId, { auth_pubkey: danaPhone1.publicKey, auth_signature: SIG }));
    expect(old.status).toBe(403);
    expect(old.body.error.code).toBe('COLLECT_KEY_MISMATCH');
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
    expect((await submit(app, dana, reading(stationId, { auth_pubkey: danaPhone2.publicKey, auth_signature: SIG }))).status).toBe(200);
  });

  it("another wallet's own collect key cannot be used on this station (owner guard still runs first)", async () => {
    const app = buildApp();
    await registerViaHttp(app, dana, danaPhone1.publicKey);
    await registerViaHttp(app, eve, evePhone.publicKey);
    const res = await submit(app, eve, reading(stationId, { auth_pubkey: evePhone.publicKey, auth_signature: SIG }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('STATION_NOT_OWNED');
    // and the owner presenting eve's collect key is a collect mismatch
    const cross = await submit(app, dana, reading(stationId, { auth_pubkey: evePhone.publicKey, auth_signature: SIG }));
    expect(cross.body.error.code).toBe('COLLECT_KEY_MISMATCH');
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });

  it('a mob- station row with no registration row fails closed (403), and a lookup outage is 503', async () => {
    const app = buildApp();
    mockStore.stations.set(stationId, { owner: dana.address }); // guard row only, e.g. hand-inserted
    const res = await submit(app, dana, reading(stationId, { auth_pubkey: danaPhone1.publicKey, auth_signature: SIG }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COLLECT_KEY_MISMATCH');

    await registerViaHttp(app, dana, danaPhone1.publicKey);
    collectLookupFails = true;
    const down = await submit(app, dana, reading(stationId, { auth_pubkey: danaPhone1.publicKey, auth_signature: SIG }));
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('STATION_OWNERSHIP_UNAVAILABLE');
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });

  it('prepare: a wrong key is refused, the registered key (or none yet) passes, and no core4 call is made', async () => {
    const app = buildApp();
    await registerViaHttp(app, dana, danaPhone1.publicKey);
    activate(dana);
    const wrong = await prepare(app, dana, reading(stationId, { auth_pubkey: dana.publicKey }));
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('COLLECT_KEY_MISMATCH');
    expect((await prepare(app, dana, reading(stationId, { auth_pubkey: danaPhone1.publicKey }))).status).toBe(200);
    // prepare runs before the phone has signed, so it may be called without a key
    expect((await prepare(app, dana, reading(stationId))).status).toBe(200);
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });

  it('non-mob stations are unaffected: no collect lookup, any/absent auth_pubkey behaves as before', async () => {
    const app = buildApp();
    stationOwners.set('pws-legacy-1', dana.address);
    core4Ok();
    const { executeQuery } = require('../database/connection.js');
    executeQuery.mockClear();

    const noKey = await submit(app, dana, reading('pws-legacy-1'));
    expect(noKey.status).toBe(200);
    const anyKey = await submit(app, dana, reading('pws-legacy-1', { auth_pubkey: dana.publicKey, auth_signature: SIG }));
    expect(anyKey.status).toBe(200);
    const commits = mockFetchCore4Json.mock.calls.filter((c) => c[0] === '/transactions/contribution/commit');
    expect(commits[0][1].body).not.toHaveProperty('auth_pubkey');
    expect(commits[1][1].body).toMatchObject({ auth_pubkey: dana.publicKey });
    const collectLookups = executeQuery.mock.calls.filter((c: any[]) => String(c[0]).includes('mobile_station_registrations'));
    expect(collectLookups).toHaveLength(0);
    expect((await prepare(app, dana, reading('pws-legacy-1'))).status).toBe(200);
  });

  it('a look-alike id (MOB- / fullwidth) gets no legacy bypass: it is NOT owned, so it is refused', async () => {
    const app = buildApp();
    await registerViaHttp(app, dana, danaPhone1.publicKey);
    const res = await submit(app, dana, reading(stationId.toUpperCase(), { auth_pubkey: danaPhone1.publicKey, auth_signature: SIG }));
    expect(res.status).toBe(403);
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });
});
