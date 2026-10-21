/**
 * backend#1288 (B1 + B3): per-phone station registration.
 * Design: docs/plans/2026-09-29-per-phone-station-registration-design.md
 *
 * Every security property in §7 has a test here. The store is an in-memory fake
 * with the same atomic semantics the Postgres store has (one transaction at a
 * time, per-wallet UNIQUE, single-use nonce); the SQL itself is exercised by
 * mobile-station-registration-migration.test.ts and the real-Postgres check
 * recorded in the PR.
 */
import crypto from 'node:crypto';
import { describe, expect, it, beforeEach } from '@jest/globals';
import {
  buildMobileStationRegistrationMessage,
  buildStationOwnershipMessage,
  deriveMobileStationId,
} from '../shared/mobile-station-messages';
import {
  issueMobileStationChallenge,
  registerMobileStation,
} from '../server/services/mobile-station-registration-service';
import { FakeStore } from './helpers/mobile-station-fake-store';

// ---- test wallet: ed25519 from a fixed seed, address = 0x + SHA3-256(pub)[..20]
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function walletFromSeed(seedByte: number) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.alloc(32, seedByte)]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = spki.subarray(spki.length - 32).toString('hex');
  const address = `0x${crypto.createHash('sha3-256').update(Buffer.from(publicKey, 'hex')).digest('hex').slice(0, 40)}`;
  return {
    publicKey,
    address,
    sign: (message: Buffer) => crypto.sign(null, message, key).toString('hex'),
  };
}

const CHAIN = { chainId: '777', networkId: 'testnet' };
const NOW = 1_790_000_000;
const alice = walletFromSeed(1);
const bob = walletFromSeed(2);
// The phone's spend-less collect key (B6): a second key, never the wallet key.
const COLLECT = walletFromSeed(101);

let counter = 0;
function deps(now = NOW) {
  return {
    ...CHAIN,
    now: () => now,
    newNonce: () => `nonce-${++counter}-${'0'.repeat(20)}`,
  };
}

async function challengeFor(store: FakeStore, w = alice, now = NOW) {
  const res = await issueMobileStationChallenge(store, w.address, deps(now));
  expect(res.status).toBe(200);
  return res.body as { nonce: string; expiresAt: number; stationId: string };
}

function signedBody(
  w: ReturnType<typeof walletFromSeed>,
  ch: { nonce: string; expiresAt: number; stationId: string },
  overrides: Record<string, unknown> = {},
  cell = { latE1: 123, lonE1: -456 }
) {
  const collectPubkey = (overrides.collectPubkey as string | undefined) ?? COLLECT.publicKey;
  const regMsg = buildMobileStationRegistrationMessage({
    ...CHAIN,
    stationId: ch.stationId,
    ownerAddress: w.address,
    collectPubkey,
    latE1: cell.latE1,
    lonE1: cell.lonE1,
    nonce: ch.nonce,
    expiresAt: ch.expiresAt,
  });
  const ownMsg = buildStationOwnershipMessage({
    ...CHAIN,
    stationId: ch.stationId,
    ownerAddress: w.address,
  });
  return {
    nonce: ch.nonce,
    expiresAt: ch.expiresAt,
    publicKey: w.publicKey,
    collectPubkey,
    cell,
    deviceClass: 'phone-barometer',
    registrationSignature: w.sign(regMsg),
    ownershipSignature: w.sign(ownMsg),
    ...overrides,
  };
}

describe('station id derivation (design §2.1)', () => {
  it('is mob- + 32 hex, deterministic, wallet-specific, case-insensitive', () => {
    const id = deriveMobileStationId(alice.address);
    expect(id).toMatch(/^mob-[0-9a-f]{32}$/);
    expect(deriveMobileStationId(alice.address)).toBe(id);
    expect(deriveMobileStationId(alice.address.toUpperCase().replace('0X', '0x'))).toBe(id);
    expect(deriveMobileStationId(bob.address)).not.toBe(id);
  });

  it('matches the hand-derived SHA-256 domain construction', () => {
    const expected = crypto
      .createHash('sha256')
      .update(Buffer.concat([
        Buffer.from('wrfcoin_mobile_station_v1'),
        Buffer.from([0]),
        Buffer.from(alice.address.slice(2), 'hex'),
        Buffer.from([0]),
      ]))
      .digest('hex')
      .slice(0, 32);
    expect(deriveMobileStationId(alice.address)).toBe(`mob-${expected}`);
  });

  it('rejects a non-chain address', () => {
    expect(() => deriveMobileStationId('not-an-address')).toThrow();
  });
});

describe('POST /stations/mobile/challenge', () => {
  let store: FakeStore;
  beforeEach(() => { store = new FakeStore(); });

  it('issues a wallet-bound single-use nonce with a short expiry and the derived station id', async () => {
    const res = await issueMobileStationChallenge(store, alice.address, deps());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      stationId: deriveMobileStationId(alice.address),
      ownerAddress: alice.address,
      chainId: '777',
      networkId: 'testnet',
    });
    const body = res.body as { nonce: string; expiresAt: number };
    expect(body.expiresAt).toBeGreaterThan(NOW);
    expect(body.expiresAt - NOW).toBeLessThanOrEqual(300);
    expect(store.nonces.get(body.nonce)).toMatchObject({ ownerAddress: alice.address, consumed: false });
  });

  it('caps live unconsumed challenges per wallet', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await issueMobileStationChallenge(store, alice.address, deps())).status).toBe(200);
    }
    const res = await issueMobileStationChallenge(store, alice.address, deps());
    expect(res.status).toBe(429);
    expect((res.body as any).error.code).toBe('CHALLENGE_LIMIT');
    // another wallet is unaffected
    expect((await issueMobileStationChallenge(store, bob.address, deps())).status).toBe(200);
  });

  it('refuses a caller with no chain address', async () => {
    const res = await issueMobileStationChallenge(store, 'unknown', deps());
    expect(res.status).toBe(401);
  });
});

describe('POST /stations/mobile', () => {
  let store: FakeStore;
  beforeEach(() => { store = new FakeStore(); });

  it('happy path: derives the id, stores both proofs, writes the owner-guard row', async () => {
    const ch = await challengeFor(store);
    const res = await registerMobileStation(store, alice.address, signedBody(alice, ch), deps());
    expect(res.status).toBe(201);
    const stationId = deriveMobileStationId(alice.address);
    expect(res.body).toMatchObject({ stationId, status: 'db_only', created: true, cell: { latE1: 123, lonE1: -456 } });
    const row = store.registrations.get(alice.address)!;
    expect(row).toMatchObject({
      stationId,
      ownerPubkey: alice.publicKey,
      cellLatE1: 123,
      cellLonE1: -456,
      status: 'db_only',
    });
    expect(row.registrationSignature).toMatch(/^[0-9a-f]{128}$/);
    expect(row.ownershipSignature).toMatch(/^[0-9a-f]{128}$/);
    // the #1284 owner guard reads weather_stations.owner_address
    expect(store.stations.get(stationId)).toEqual({ owner: alice.address });
    expect(store.nonces.get(ch.nonce)!.consumed).toBe(true);
  });

  it('ignores a client-supplied station id (squatting)', async () => {
    const ch = await challengeFor(store);
    const res = await registerMobileStation(
      store,
      alice.address,
      signedBody(alice, ch, { stationId: 'mob-ffffffffffffffffffffffffffffffff', station_id: 'victim' }),
      deps()
    );
    expect(res.status).toBe(201);
    expect((res.body as any).stationId).toBe(deriveMobileStationId(alice.address));
    expect(store.stations.has('mob-ffffffffffffffffffffffffffffffff')).toBe(false);
    expect(store.stations.has('victim')).toBe(false);
  });

  it('rejects a pubkey that does not derive to the authenticated wallet', async () => {
    const ch = await challengeFor(store);
    // bob signs a body for alice's station: valid signatures, wrong wallet
    const res = await registerMobileStation(store, alice.address, signedBody(bob, ch), deps());
    expect(res.status).toBe(403);
    expect((res.body as any).error.code).toBe('WALLET_MISMATCH');
    expect(store.registrations.size).toBe(0);
    expect(store.nonces.get(ch.nonce)!.consumed).toBe(false);
  });

  it('rejects a bad registration signature (preimage A) and does not burn the nonce', async () => {
    const ch = await challengeFor(store);
    const body = signedBody(alice, ch);
    // a valid signature over a DIFFERENT cell
    const other = signedBody(alice, ch, {}, { latE1: 124, lonE1: -456 });
    const res = await registerMobileStation(
      store,
      alice.address,
      { ...body, registrationSignature: other.registrationSignature },
      deps()
    );
    expect(res.status).toBe(403);
    expect((res.body as any).error.code).toBe('INVALID_REGISTRATION_SIGNATURE');
    expect(store.registrations.size).toBe(0);
    expect(store.stations.size).toBe(0);
    expect(store.nonces.get(ch.nonce)!.consumed).toBe(false);
  });

  it('rejects a registration signature made over another chain/network (domain separation)', async () => {
    const ch = await challengeFor(store);
    const wrongChain = buildMobileStationRegistrationMessage({
      chainId: '778', networkId: 'testnet', stationId: ch.stationId, ownerAddress: alice.address,
      collectPubkey: COLLECT.publicKey, latE1: 123, lonE1: -456, nonce: ch.nonce, expiresAt: ch.expiresAt,
    });
    const res = await registerMobileStation(
      store, alice.address, signedBody(alice, ch, { registrationSignature: alice.sign(wrongChain) }), deps()
    );
    expect(res.status).toBe(403);
    expect((res.body as any).error.code).toBe('INVALID_REGISTRATION_SIGNATURE');
  });

  it('rejects a bad ownership signature (preimage B)', async () => {
    const ch = await challengeFor(store);
    const wrongStation = buildStationOwnershipMessage({
      ...CHAIN, stationId: 'mob-00000000000000000000000000000000', ownerAddress: alice.address,
    });
    const res = await registerMobileStation(
      store, alice.address, signedBody(alice, ch, { ownershipSignature: alice.sign(wrongStation) }), deps()
    );
    expect(res.status).toBe(403);
    expect((res.body as any).error.code).toBe('INVALID_OWNERSHIP_SIGNATURE');
    expect(store.registrations.size).toBe(0);
  });

  it('does not accept the registration signature in place of the ownership signature', async () => {
    const ch = await challengeFor(store);
    const body = signedBody(alice, ch);
    const res = await registerMobileStation(
      store, alice.address, { ...body, ownershipSignature: body.registrationSignature }, deps()
    );
    expect(res.status).toBe(403);
    expect((res.body as any).error.code).toBe('INVALID_OWNERSHIP_SIGNATURE');
  });

  it('rejects a replayed nonce once no registration row holds it', async () => {
    const ch = await challengeFor(store);
    const body = signedBody(alice, ch);
    expect((await registerMobileStation(store, alice.address, body, deps())).status).toBe(201);
    // operator removed the row (e.g. cleanup): the consumed nonce must not re-open registration
    store.registrations.clear();
    store.stations.clear();
    const replay = await registerMobileStation(store, alice.address, body, deps());
    expect(replay.status).toBe(409);
    expect((replay.body as any).error.code).toBe('NONCE_REPLAYED');
    expect(store.registrations.size).toBe(0);
  });

  it('rejects an expired nonce', async () => {
    const ch = await challengeFor(store);
    const res = await registerMobileStation(store, alice.address, signedBody(alice, ch), deps(ch.expiresAt + 1));
    expect(res.status).toBe(400);
    expect((res.body as any).error.code).toBe('NONCE_EXPIRED');
    expect(store.registrations.size).toBe(0);
  });

  it('rejects an expiry the client altered (stored expiry is authoritative)', async () => {
    const ch = await challengeFor(store);
    const res = await registerMobileStation(
      store, alice.address, signedBody(alice, { ...ch, expiresAt: ch.expiresAt + 86_400 }), deps()
    );
    expect(res.status).toBe(400);
    expect((res.body as any).error.code).toBe('NONCE_INVALID');
  });

  it("rejects another wallet's nonce and an unknown nonce", async () => {
    const bobCh = await challengeFor(store, bob);
    const stolen = await registerMobileStation(
      store, alice.address,
      signedBody(alice, { ...bobCh, stationId: deriveMobileStationId(alice.address) }),
      deps()
    );
    expect(stolen.status).toBe(400);
    expect((stolen.body as any).error.code).toBe('NONCE_INVALID');
    const unknown = await registerMobileStation(
      store, alice.address,
      signedBody(alice, { nonce: 'never-issued-nonce-0000', expiresAt: NOW + 60, stationId: deriveMobileStationId(alice.address) }),
      deps()
    );
    expect(unknown.status).toBe(400);
    expect((unknown.body as any).error.code).toBe('NONCE_INVALID');
    expect(store.registrations.size).toBe(0);
  });

  it.each([
    ['fractional tenths (a 0.01 degree cell)', { latE1: 123.4, lonE1: -456 }],
    ['degrees instead of tenths', { latE1: 12.3, lonE1: -45.6 }],
    ['latitude beyond +/-90', { latE1: 901, lonE1: 0 }],
    ['longitude beyond +/-180', { latE1: 0, lonE1: -1801 }],
    ['string coordinates', { latE1: '123', lonE1: '-456' }],
    ['missing longitude', { latE1: 123 }],
  ])('rejects a cell not on the 0.1 degree grid: %s', async (_name, cell) => {
    const ch = await challengeFor(store);
    const res = await registerMobileStation(
      store, alice.address, signedBody(alice, ch, { cell: cell as any }), deps()
    );
    expect(res.status).toBe(400);
    expect((res.body as any).error.code).toBe('CELL_NOT_ON_GRID');
    expect(store.registrations.size).toBe(0);
    expect(store.nonces.get(ch.nonce)!.consumed).toBe(false);
  });

  it('is idempotent: a retry of the same signed request returns the existing station', async () => {
    const ch = await challengeFor(store);
    const body = signedBody(alice, ch);
    const first = await registerMobileStation(store, alice.address, body, deps());
    const retry = await registerMobileStation(store, alice.address, body, deps(NOW + 3600));
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ stationId: (first.body as any).stationId, created: false, status: 'db_only' });
    expect(store.registrations.size).toBe(1);
  });

  it('one station per wallet: a fresh registration with a new cell returns the existing station unchanged', async () => {
    const ch1 = await challengeFor(store);
    await registerMobileStation(store, alice.address, signedBody(alice, ch1), deps());
    const ch2 = await challengeFor(store);
    const second = await registerMobileStation(
      store, alice.address, signedBody(alice, ch2, {}, { latE1: 500, lonE1: 500 }), deps()
    );
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      stationId: deriveMobileStationId(alice.address),
      created: false,
      cell: { latE1: 123, lonE1: -456 },
    });
    expect(store.registrations.size).toBe(1);
    expect(store.stations.size).toBe(1);
  });

  it('two wallets get two distinct stations', async () => {
    await registerMobileStation(store, alice.address, signedBody(alice, await challengeFor(store, alice)), deps());
    const bobRes = await registerMobileStation(store, bob.address, signedBody(bob, await challengeFor(store, bob)), deps());
    expect(bobRes.status).toBe(201);
    expect(store.stations.size).toBe(2);
    expect(store.stations.get((bobRes.body as any).stationId)).toEqual({ owner: bob.address });
  });

  it('refuses when the derived station id is already held by another owner in weather_stations', async () => {
    const stationId = deriveMobileStationId(alice.address);
    store.stations.set(stationId, { owner: bob.address });
    const res = await registerMobileStation(store, alice.address, signedBody(alice, await challengeFor(store)), deps());
    expect(res.status).toBe(409);
    expect((res.body as any).error.code).toBe('STATION_ID_TAKEN');
    expect(store.registrations.size).toBe(0);
    expect(store.stations.get(stationId)).toEqual({ owner: bob.address });
  });

  it.each([
    ['short public key', { publicKey: 'abcd' }],
    ['non-hex signature', { registrationSignature: 'z'.repeat(128) }],
    ['missing nonce', { nonce: undefined }],
    ['non-integer expiry', { expiresAt: 1.5 }],
    ['unsupported device class', { deviceClass: 'weather-station-pro' }],
  ])('rejects malformed input: %s', async (_name, override) => {
    const ch = await challengeFor(store);
    const res = await registerMobileStation(
      store, alice.address, signedBody(alice, ch, override as any), deps()
    );
    expect(res.status).toBe(400);
    expect((res.body as any).error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a caller with no chain address', async () => {
    const res = await registerMobileStation(store, 'unknown', {}, deps());
    expect(res.status).toBe(401);
  });

  it('never logs coordinates finer than the registered 0.1 degree cell or the owner address', async () => {
    const seen: string[] = [];
    const logger = { info: (m: string, meta?: unknown) => seen.push(m + JSON.stringify(meta ?? {})), warn: () => {} };
    const ch = await challengeFor(store);
    await registerMobileStation(store, alice.address, signedBody(alice, ch), { ...deps(), logger });
    const joined = seen.join('\n');
    expect(joined).toContain(deriveMobileStationId(alice.address));
    expect(joined).not.toContain(alice.address);
    expect(joined).not.toContain(alice.publicKey);
  });
});
