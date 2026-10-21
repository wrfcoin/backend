/**
 * backend#1288 / PR #1309 security-review findings:
 *   P2-1  the `mob-` station-id prefix is reserved for the mobile service
 *   P3-2  the per-wallet lock: concurrent registrations for one wallet
 *   P3-3  expired nonces are pruned when a challenge is issued
 */
import crypto from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import {
  buildMobileStationRegistrationMessage,
  buildStationOwnershipMessage,
  deriveMobileStationId,
  isReservedMobileStationId,
} from '../shared/mobile-station-messages';
import {
  issueMobileStationChallenge,
  registerMobileStation,
} from '../server/services/mobile-station-registration-service';
import { registerStation, type QueryablePool } from '../server/services/station-registration-service.js';
import { validateInput } from '../server/services/chain-station-backfill';
import { FakeStore } from './helpers/mobile-station-fake-store';

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
  return { publicKey, address, sign: (m: Buffer) => crypto.sign(null, m, key).toString('hex') };
}

const CHAIN = { chainId: '777', networkId: 'testnet' };
const NOW = 1_790_000_000;
const victim = walletFromSeed(7);
const COLLECT_PUBKEY = walletFromSeed(107).publicKey;
let counter = 0;
const deps = (now = NOW) => ({ ...CHAIN, now: () => now, newNonce: () => `rev1309-${++counter}-${'0'.repeat(20)}` });

async function signedRequest(w: ReturnType<typeof walletFromSeed>, store: FakeStore, now = NOW) {
  const ch = (await issueMobileStationChallenge(store, w.address, deps(now))).body as any;
  const cell = { latE1: 10, lonE1: 20 };
  return {
    nonce: ch.nonce,
    expiresAt: ch.expiresAt,
    publicKey: w.publicKey,
    collectPubkey: COLLECT_PUBKEY,
    cell,
    deviceClass: 'phone-barometer',
    registrationSignature: w.sign(buildMobileStationRegistrationMessage({
      ...CHAIN, stationId: ch.stationId, ownerAddress: w.address, collectPubkey: COLLECT_PUBKEY,
      latE1: cell.latE1, lonE1: cell.lonE1, nonce: ch.nonce, expiresAt: ch.expiresAt,
    })),
    ownershipSignature: w.sign(buildStationOwnershipMessage({
      ...CHAIN, stationId: ch.stationId, ownerAddress: w.address,
    })),
  };
}

// ---------------------------------------------------------------- P2-1
const TRICKS = [
  'mob-abc',
  'MOB-abc',
  'Mob-abc',
  '  mob-abc  ',
  '\tmob-abc\n',
  ' mob-abc',
  'ｍｏｂ-abc', // fullwidth "mob" (NFKC folds to ascii)
  'ＭＯＢ－abc', // fullwidth "MOB-"
];

describe('P2-1 isReservedMobileStationId', () => {
  it.each(TRICKS)('reserves %j', (id) => {
    expect(isReservedMobileStationId(id)).toBe(true);
  });
  it('reserves the real derived id and leaves other ids alone', () => {
    expect(isReservedMobileStationId(deriveMobileStationId(victim.address))).toBe(true);
    for (const ok of ['pws-jon-abc123', 'mobile-1', 'mob_x', 'xmob-1', '', 'mo']) {
      expect(isReservedMobileStationId(ok)).toBe(false);
    }
    expect(isReservedMobileStationId(undefined as any)).toBe(false);
  });
});

function recordingPool() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool: QueryablePool = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)')) return { rows: [{ n: 0 }] };
      return { rows: [] };
    }),
  };
  return { pool, calls };
}

describe('P2-1 generic POST /api/weather/stations service cannot mint mob- ids', () => {
  it.each(TRICKS)('registerStation rejects stationId %j with STATION_ID_RESERVED', async (stationId) => {
    const { pool, calls } = recordingPool();
    const result = await registerStation(
      { name: 'Squat', latitude: 46.8, longitude: -92.0, provider: 'acurite', stationId },
      '0x' + 'a'.repeat(40),
      { pool, fetchFn: jest.fn() as any, encryptionKey: 'a'.repeat(64) },
      () => 'abc123'
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('STATION_ID_RESERVED');
    expect(calls.filter((c) => /INSERT|UPDATE/i.test(c.sql))).toEqual([]);
  });

  it('a non-reserved stationId is still accepted', async () => {
    const { pool } = recordingPool();
    const result = await registerStation(
      { name: 'Fine', latitude: 46.8, longitude: -92.0, provider: 'acurite', stationId: 'pws-fine-1' },
      '0x' + 'a'.repeat(40),
      { pool, fetchFn: jest.fn() as any, encryptionKey: 'a'.repeat(64) },
      () => 'abc123'
    );
    expect(result.status).toBe(201);
  });

  it('an attacker cannot pre-register the victim derived id, so the victim still registers', async () => {
    const store = new FakeStore();
    const derived = deriveMobileStationId(victim.address);
    const { pool } = recordingPool();
    const attack = await registerStation(
      { name: 'Squat', latitude: 46.8, longitude: -92.0, provider: 'acurite', stationId: derived },
      '0x' + 'b'.repeat(40),
      { pool, fetchFn: jest.fn() as any, encryptionKey: 'a'.repeat(64) },
      () => 'abc123'
    );
    expect(attack.status).toBe(400);
    // (the generic path wrote nothing, so the fake's guard table is empty)
    const res = await registerMobileStation(store, victim.address, await signedRequest(victim, store), deps());
    expect(res.status).toBe(201);
    expect((res.body as any).stationId).toBe(derived);
  });
});

describe('P2-1 chain backfill cannot import a mob- id', () => {
  it.each(['mob-abc', 'MOB-abc', 'Mob-abc'])('validateInput refuses %j as reserved', (stationId) => {
    expect(validateInput({ stationId, name: 'x' })).toMatch(/reserved/);
  });
  it.each(TRICKS)('validateInput refuses %j (reserved or bad charset)', (stationId) => {
    expect(validateInput({ stationId, name: 'x' })).not.toBeNull();
  });
});

// ---------------------------------------------------------------- P3-2
describe('P3-2 per-wallet lock serializes concurrent registrations', () => {
  it('two concurrent registrations, different nonces, one wallet: one 201 + one idempotent 200, same station, no throw', async () => {
    const store = new FakeStore();
    const a = await signedRequest(victim, store);
    const b = await signedRequest(victim, store);
    expect(a.nonce).not.toBe(b.nonce);
    const settled = await Promise.allSettled([
      registerMobileStation(store, victim.address, a, deps()),
      registerMobileStation(store, victim.address, b, deps()),
    ]);
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
    const results = settled.map((s) => (s as PromiseFulfilledResult<any>).value);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(results[0].body.stationId).toBe(results[1].body.stationId);
    expect(store.registrations.size).toBe(1);
  });
});

// ---------------------------------------------------------------- P3-3
describe('P3-3 expired nonces are pruned at challenge time', () => {
  it('deletes the wallet expired rows, keeps live/consumed-unexpired and other wallets', async () => {
    const store = new FakeStore();
    const other = walletFromSeed(9);
    await issueMobileStationChallenge(store, victim.address, deps(NOW)); // expires NOW+300
    await issueMobileStationChallenge(store, other.address, deps(NOW));
    expect(store.nonces.size).toBe(2);
    const later = NOW + 10_000;
    await issueMobileStationChallenge(store, victim.address, deps(later));
    const mine = [...store.nonces.values()].filter((n) => n.ownerAddress === victim.address);
    expect(mine).toHaveLength(1);
    expect(mine[0].expiresAt).toBeGreaterThan(later);
    // the other wallet row is untouched even though it is also expired
    expect([...store.nonces.values()].filter((n) => n.ownerAddress === other.address)).toHaveLength(1);
  });
});
