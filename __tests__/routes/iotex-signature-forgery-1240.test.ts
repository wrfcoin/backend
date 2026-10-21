/**
 * backend#1235 / #1240: the IoTeX device verifiers used to be development
 * simulations (a "signature" was accepted when it started with the first 8 hex
 * chars of SHA256(data + publicKey), and the attestation check trusted a
 * caller-supplied public key). They are now real ed25519 (owner ruling
 * 2026-09-30), so this suite proves the OLD forgeries are refused and the new
 * scheme works, end to end.
 *
 * It drives the REAL router with the REAL controller and device-attestation
 * verifiers (nothing mocked on the verification path). Only persistence is
 * faked and counted, and the two processing entry points are spied. The signed
 * message is restated here independently of the implementation.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as crypto from 'crypto';
import express from 'express';
import request from 'supertest';

const OPERATOR = 'test-operator-token-1240';

const noop = () => {};
jest.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const schema = require('../../shared/schema-iotex');

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey, privateKey, hex: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex') };
}
const deviceKp = keypair();
const publisherKp = keypair();
const DEVICE_KEY = deviceKp.hex;
const PUBLISHER_KEY = publisherKp.hex;
const CHALLENGE = 'challenge-1240-abcdef';
const rows: { attestationExpired: boolean } = { attestationExpired: false };

function rowFor(table: unknown) {
  if (table === schema.devices) {
    return { id: 'dev-forge', type: 'WEATHER_STATION', geoFenceStatus: 'clear', publicKey: DEVICE_KEY };
  }
  if (table === schema.attestationRequests) {
    return {
      id: 'att-1',
      deviceId: 'dev-forge',
      challenge: CHALLENGE,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + (rows.attestationExpired ? -60_000 : 60_000)).toISOString(),
    };
  }
  if (table === schema.w3bstreamPublishers) {
    return { id: 'pub-1', publicKey: PUBLISHER_KEY };
  }
  return undefined;
}

const writes: Array<{ op: string; table: unknown; values?: any }> = [];
const storedSignatures: string[] = [];
const hooks = { slowInsertMs: 0 };
// drizzle's eq()/and() are wrapped so the fake DB can see what a query compares
// against: a stored signature only matches an EXACT value, like the real column.
jest.mock('drizzle-orm', () => ({
  ...jest.requireActual('drizzle-orm'),
  eq: (column: unknown, value: unknown) => ({ __eq: true, column, value }),
  and: (...parts: unknown[]) => ({ __and: parts }),
}));
function compared(cond: any): unknown[] {
  if (!cond) return [];
  if (cond.__and) return cond.__and.flatMap(compared);
  return cond.__eq ? [cond.value] : [];
}
function selectChain() {
  let table: unknown;
  let values: unknown[] = [];
  const chain: any = {
    from: (t: unknown) => { table = t; return chain; },
    where: (cond: unknown) => { values = compared(cond); return chain; },
    then: (resolve: any) => {
      if (table === schema.deviceData) {
        const hit = storedSignatures.find(sig => values.includes(sig));
        return resolve(hit ? [{ id: 'old-entry', deviceId: 'dev-forge', signature: hit }] : []);
      }
      return resolve(rowFor(table) ? [rowFor(table)] : []);
    },
  };
  return chain;
}
jest.mock('../../server/db', () => ({
  db: {
    select: () => selectChain(),
    insert: (table: unknown) => {
      const write: { op: string; table: unknown; values?: any } = { op: 'insert', table };
      writes.push(write);
      return {
        values: (values: any) => {
          write.values = values;
          // The row becomes visible to lookups only when the insert completes.
          const done = () => {
            if (table === schema.deviceData && values && values.signature) storedSignatures.push(values.signature);
            return Promise.resolve([{ id: 'new-1', ...values }]);
          };
          return { returning: () => (hooks.slowInsertMs ? new Promise(r => setTimeout(() => r(done()), hooks.slowInsertMs)) : done()) };
        },
      };
    },
    update: (table: unknown) => {
      writes.push({ op: 'update', table });
      return { set: () => ({ where: () => Promise.resolve() }) };
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const controller = require('../../server/integrations/iotex/controller');
const weatherSpy = jest.spyOn(controller, 'processWeatherData').mockResolvedValue({});
const eventSpy = jest.spyOn(controller, 'processW3bstreamEvent').mockResolvedValue({});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const iotexRouter = require('../../server/routes/iotex');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/iotex', iotexRouter.default || iotexRouter);
  return a;
}

// The OLD simulation's forgery: anyone who knows the public key can compute it.
function forge(data: string, key: string) {
  return crypto.createHash('sha256').update(data + key).digest('hex').substring(0, 8) + 'deadbeef';
}

// The signed message, restated independently of the implementation (see the header
// of server/integrations/iotex/device-attestation.js).
const DOMAIN = { deviceData: 'wrfcoin.iotex.device_data.v1', w3bstreamEvent: 'wrfcoin.iotex.w3bstream_event.v1', attestation: 'wrfcoin.iotex.attestation.v1' };
const lp = (t: string) => { const b = Buffer.from(t, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((a: any, k) => { Object.defineProperty(a, k, { value: sortKeys(v[k]), enumerable: true, writable: true, configurable: true }); return a; }, {});
  return v;
}
const hashOf = (payload: unknown) => crypto.createHash('sha256').update(JSON.stringify(sortKeys(payload))).digest('hex');
function message(domain: string, subject: string, ts: number | string, nonce: string, payload: unknown, chain = '777', network = 'testnet') {
  return Buffer.concat([Buffer.from(domain), lp(chain), lp(network), lp(subject), lp(String(ts)), lp(nonce), lp(hashOf(payload))]);
}
const sign = (kp: { privateKey: crypto.KeyObject }, m: Buffer) => crypto.sign(null, m, kp.privateKey).toString('hex');
const nowSec = () => Math.floor(Date.now() / 1000);
let nonceCounter = 0;
const newNonce = () => `nonce-${Date.now()}-${nonceCounter++}`;
function signedReading(over: { ts?: number; nonce?: string; chain?: string; network?: string; domain?: string; subject?: string; data?: unknown; kp?: any } = {}) {
  const ts = over.ts ?? nowSec();
  const nonce = over.nonce ?? newNonce();
  const data = over.data ?? readingData;
  const signature = sign(over.kp ?? deviceKp, message(over.domain ?? DOMAIN.deviceData, over.subject ?? 'dev-forge', ts, nonce, data, over.chain, over.network));
  return { data: readingData, timestamp: ts, nonce, signature };
}

beforeEach(() => {
  process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR;
  writes.length = 0;
  storedSignatures.length = 0;
  hooks.slowInsertMs = 0;
  delete process.env.WRFCOIN_CHAIN_ID;
  delete process.env.WRFCOIN_NETWORK_ID;
  rows.attestationExpired = false;
  weatherSpy.mockClear();
  eventSpy.mockClear();
});

const readingData = { temperature: 21.5, humidity: 40 };
const eventPayload = { reading: 7 };
const attackerKey = 'attacker-chosen-public-key';
const attackerKp = keypair();
const forgedAttestation = () => ({
  signature: forge(CHALLENGE, attackerKey),
  publicKey: attackerKey,
  timestamp: String(nowSec()),
  nonce: 'forged-nonce-1',
});
const signedAttestation = (over: { kp?: any; publicKey?: string; ts?: number } = {}) => {
  const ts = over.ts ?? nowSec();
  const nonce = newNonce();
  return {
    signature: sign(over.kp ?? deviceKp, message(DOMAIN.attestation, 'dev-forge', ts, nonce, { challenge: CHALLENGE })),
    ...(over.publicKey ? { publicKey: over.publicKey } : {}),
    timestamp: String(ts),
    nonce,
  };
};
const AUTH = { Authorization: `Bearer ${OPERATOR}` };
const DATA_URL = '/api/iotex/devices/dev-forge/data';

describe('the old forgeries are refused by the real verifiers', () => {
  it('verifySignature refuses the SHA256-prefix "signature" of the simulation', async () => {
    await expect(controller.verifySignature(JSON.stringify(readingData), forge(JSON.stringify(readingData), DEVICE_KEY), DEVICE_KEY)).resolves.toBe(false);
  });
  it('verifySignedSubmission refuses the forgery for a device and for a W3bstream publisher', async () => {
    const forged = forge(JSON.stringify(readingData), DEVICE_KEY);
    const base = { subjectId: 'dev-forge', timestamp: nowSec(), nonce: newNonce(), payload: readingData, signature: forged, publicKey: DEVICE_KEY };
    await expect(controller.verifySignedSubmission({ ...base, kind: 'deviceData' })).resolves.toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
    await expect(controller.verifySignedSubmission({ ...base, kind: 'w3bstreamEvent', publicKey: PUBLISHER_KEY })).resolves.toMatchObject({ ok: false });
  });
  it('verifyAttestation refuses a forged response that carries an attacker-chosen public key', async () => {
    const device = { deviceId: 'dev-forge', publicKey: DEVICE_KEY };
    await expect(controller.verifyAttestation(CHALLENGE, forgedAttestation(), device)).resolves.toMatchObject({ success: false });
    // the attacker signs correctly with their OWN key and supplies it: still refused, the registered key wins
    const own = signedAttestation({ kp: attackerKp, publicKey: attackerKp.hex });
    await expect(controller.verifyAttestation(CHALLENGE, own, device)).resolves.toMatchObject({ success: false });
  });
  it('verifyAttestation refuses a device with no valid registered key', async () => {
    await expect(controller.verifyAttestation(CHALLENGE, signedAttestation(), { deviceId: 'dev-forge', publicKey: 'not-a-key' })).resolves.toMatchObject({ success: false });
    await expect(controller.verifyAttestation(CHALLENGE, signedAttestation(), { deviceId: 'dev-forge' })).resolves.toMatchObject({ success: false });
  });
});

describe('real ed25519 device signatures', () => {
  it('a real keypair signs and the device write is accepted, verified, processed and stored with the signed time', async () => {
    const body = signedReading();
    const res = await request(app()).post(DATA_URL).send(body);
    expect(res.status).toBe(201);
    const insert = writes.find(w => w.op === 'insert' && w.table === schema.deviceData)!;
    expect(insert.values.verified).toBe(true);
    expect(insert.values.timestamp.getTime()).toBe(body.timestamp * 1000);
    expect(weatherSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a tampered payload', () => ({ ...signedReading(), data: { temperature: 99, humidity: 40 } })],
    ['a signature by another key', () => signedReading({ kp: attackerKp })],
    ['a signature for another device id', () => signedReading({ subject: 'dev-other' })],
    ['the wrong domain (an attestation-domain signature)', () => signedReading({ domain: DOMAIN.attestation })],
    ['the wrong domain (a W3bstream-event-domain signature)', () => signedReading({ domain: DOMAIN.w3bstreamEvent })],
    ['the wrong chain id', () => signedReading({ chain: '778' })],
    ['the wrong network id', () => signedReading({ network: 'mainnet' })],
    ['a stale timestamp (10 minutes old)', () => signedReading({ ts: nowSec() - 600 })],
    ['a future timestamp (10 minutes ahead)', () => signedReading({ ts: nowSec() + 600 })],
    ['a malformed nonce', () => ({ ...signedReading({ nonce: 'short' }) })],
    ['a missing nonce', () => { const b: any = signedReading(); delete b.nonce; return b; }],
    ['a missing timestamp', () => { const b: any = signedReading(); delete b.timestamp; return b; }],
    ['a non-hex signature', () => ({ ...signedReading(), signature: 'zz'.repeat(64) })],
    ['a truncated signature', () => ({ ...signedReading(), signature: signedReading().signature.slice(0, 100) })],
  ])('is refused (401, no write, no processing): %s', async (_label, build) => {
    const res = await request(app()).post(DATA_URL).send(build());
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('DEVICE_SIGNATURE_REQUIRED');
    expect(writes).toEqual([]);
    expect(weatherSpy).not.toHaveBeenCalled();
  });

  describe('reserved payload keys (own "__proto__" from JSON.parse) are refused before hashing and persistence', () => {
    const rawWith = (body: any, dataJson: string) =>
      JSON.stringify({ ...body, data: '@@DATA@@' }).replace('"@@DATA@@"', dataJson);
    const post = (raw: string, auth = false) => {
      const r = request(app()).post(DATA_URL).set('Content-Type', 'application/json');
      return (auth ? r.set(AUTH) : r).send(raw);
    };
    it.each([
      ['root', '{"temperature":21.5,"humidity":40,"__proto__":{"injected":1}}'],
      ['nested', '{"temperature":21.5,"humidity":40,"meta":{"__proto__":{"injected":1}}}'],
      ['in an array', '{"temperature":21.5,"humidity":40,"list":[{"__proto__":{"injected":1}}]}'],
      ['constructor', '{"temperature":21.5,"humidity":40,"constructor":{"x":1}}'],
      ['prototype', '{"temperature":21.5,"humidity":40,"prototype":{"x":1}}'],
    ])('a correctly signed payload with an appended unsigned member (%s) gets 400, no write, no processing', async (_l, dataJson) => {
      const body = signedReading(); // signed over the clean readingData only
      const res = await post(rawWith(body, dataJson));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('RESERVED_PAYLOAD_KEY');
      expect(writes).toEqual([]);
      expect(weatherSpy).not.toHaveBeenCalled();
    });
    it('the operator path refuses it too (one rule, no write)', async () => {
      const res = await post(rawWith(signedReading(), '{"temperature":1,"__proto__":{"x":1}}'), true);
      expect(res.status).toBe(400);
      expect(writes).toEqual([]);
      expect(weatherSpy).not.toHaveBeenCalled();
    });
    it('the verifier itself refuses a parsed payload carrying an own __proto__ even if the signature covers a clean copy', async () => {
      const ts = nowSec(); const nonce = newNonce();
      const signature = sign(deviceKp, message(DOMAIN.deviceData, 'dev-forge', ts, nonce, readingData));
      const parsed = JSON.parse('{"temperature":21.5,"humidity":40,"__proto__":{"x":1}}');
      const ok = await controller.verifySignedSubmission({ kind: 'deviceData', subjectId: 'dev-forge', timestamp: ts, nonce, payload: readingData, signature, publicKey: deviceKp.hex });
      expect(ok.ok).toBe(true); // control: the clean copy verifies
      const bad = await controller.verifySignedSubmission({ kind: 'deviceData', subjectId: 'dev-forge', timestamp: ts, nonce, payload: parsed, signature, publicKey: deviceKp.hex });
      expect(bad).toEqual({ ok: false, reason: 'RESERVED_KEY' });
    });
    it('control: ordinary nested payloads still verify', async () => {
      const data = { temperature: 21.5, meta: { unit: 'C', tags: ['a', 'b'] } };
      const res = await post(rawWith(signedReading({ data }), JSON.stringify(data)));
      expect(res.status).toBe(201);
    });
  });

  it('a replay of an accepted request is refused, including an upper-case copy of the signature', async () => {
    const body = signedReading();
    expect((await request(app()).post(DATA_URL).send(body)).status).toBe(201);
    weatherSpy.mockClear();
    const replay = await request(app()).post(DATA_URL).send(body);
    expect(replay.status).toBe(401);
    const upper = await request(app()).post(DATA_URL).send({ ...body, signature: body.signature.toUpperCase() });
    expect(upper.status).toBe(401);
    expect(writes.filter(w => w.op === 'insert' && w.table === schema.deviceData)).toHaveLength(1);
    expect(weatherSpy).not.toHaveBeenCalled();
  });

  it('an upper-case signature that was accepted first cannot be replayed in lower case', async () => {
    const body = signedReading();
    expect((await request(app()).post(DATA_URL).send({ ...body, signature: body.signature.toUpperCase() })).status).toBe(201);
    expect((await request(app()).post(DATA_URL).send(body)).status).toBe(401);
    expect(writes.filter(w => w.op === 'insert' && w.table === schema.deviceData)).toHaveLength(1);
  });

  it('the chain and network come from WRFCOIN_CHAIN_ID / WRFCOIN_NETWORK_ID', async () => {
    process.env.WRFCOIN_CHAIN_ID = '4242';
    process.env.WRFCOIN_NETWORK_ID = 'devnet';
    expect((await request(app()).post(DATA_URL).send(signedReading())).status).toBe(401); // signed for 777/testnet
    expect((await request(app()).post(DATA_URL).send(signedReading({ chain: '4242', network: 'devnet' }))).status).toBe(201);
  });

  it('two concurrent copies of one signed request store exactly one row', async () => {
    hooks.slowInsertMs = 60; // keeps the first insert in flight while the second copy checks for a replay
    const body = signedReading();
    const [a, b] = await Promise.all([request(app()).post(DATA_URL).send(body), request(app()).post(DATA_URL).send(body)]);
    expect([a.status, b.status].sort()).toEqual([201, 401]);
    expect(writes.filter(w => w.op === 'insert' && w.table === schema.deviceData)).toHaveLength(1);
  });

  it('operator-token writes keep working with or without a signature; a bad signature only marks the row unverified', async () => {
    expect((await request(app()).post(DATA_URL).set(AUTH).send({ data: readingData })).status).toBe(201);
    expect(writes.find(w => w.table === schema.deviceData)!.values.verified).toBe(false);
    writes.length = 0;
    const res = await request(app()).post(DATA_URL).set(AUTH).send({ data: readingData, signature: forge('x', DEVICE_KEY) });
    expect(res.status).toBe(201);
    expect(writes.find(w => w.table === schema.deviceData)!.values.verified).toBe(false);
  });
});

describe('public key format', () => {
  it('registers only a 32-byte ed25519 key (64 hex); stores it normalized', async () => {
    const upper = DEVICE_KEY.toUpperCase();
    const ok = await request(app()).post('/api/iotex/devices').set(AUTH).send({ name: 'd', type: 'WEATHER_STATION', publicKey: `0x${upper}` });
    expect(ok.status).toBe(201);
    expect(writes.find(w => w.table === schema.devices)!.values.publicKey).toBe(DEVICE_KEY);
  });
  it.each([
    ['too short', 'ab'.repeat(31)],
    ['too long', 'ab'.repeat(33)],
    ['not hex', 'zz'.repeat(32)],
    ['a free-form string (the old format)', 'device-public-key-1240'],
    ['a small-order point', '00'.repeat(32)],
    ['a non-canonical point', 'ff'.repeat(32)],
    ['a number', 12345 as unknown as string],
  ])('refuses a malformed device key: %s', async (_label, publicKey) => {
    const res = await request(app()).post('/api/iotex/devices').set(AUTH).send({ name: 'd', type: 'WEATHER_STATION', publicKey });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PUBLIC_KEY');
    expect(writes.filter(w => w.table === schema.devices)).toEqual([]);
  });
  it('the shared normalizer (also used for W3bstream publisher keys) accepts and refuses the same keys', async () => {
    await expect(controller.normalizePublicKey(`0x${PUBLISHER_KEY.toUpperCase()}`)).resolves.toBe(PUBLISHER_KEY);
    for (const bad of ['nope', '', undefined, null, 5, '00'.repeat(32), 'ff'.repeat(32)]) {
      await expect(controller.normalizePublicKey(bad)).resolves.toBeNull();
    }
  });
});

describe('anonymous forged or unsigned writes: 401, zero writes, zero processing', () => {
  const cases: Array<[string, string, () => Record<string, unknown>, string]> = [
    ['device data, forged', DATA_URL, () => ({ data: readingData, signature: forge(JSON.stringify(readingData), DEVICE_KEY) }), 'DEVICE_SIGNATURE_REQUIRED'],
    ['device data, unsigned', DATA_URL, () => ({ data: readingData }), 'DEVICE_SIGNATURE_REQUIRED'],
    ['W3bstream event, forged', '/api/iotex/w3bstream/events',
      () => ({ publisherId: 'pub-1', eventType: 'reading', payload: eventPayload, signature: forge(JSON.stringify(eventPayload), PUBLISHER_KEY) }), 'OPERATOR_AUTH_REQUIRED'],
    ['W3bstream event, unsigned', '/api/iotex/w3bstream/events', () => ({ publisherId: 'pub-1', eventType: 'reading', payload: eventPayload }), 'OPERATOR_AUTH_REQUIRED'],
    ['attestation response, forged', '/api/iotex/devices/dev-forge/attestations/att-1', () => ({ response: forgedAttestation() }), 'OPERATOR_AUTH_REQUIRED'],
    ['attestation response, empty', '/api/iotex/devices/dev-forge/attestations/att-1', () => ({}), 'OPERATOR_AUTH_REQUIRED'],
    ['W3bstream publisher registration', '/api/iotex/w3bstream/publishers', () => ({ name: 'p', type: 'sensor', publicKey: attackerKey }), 'OPERATOR_AUTH_REQUIRED'],
  ];

  it.each(cases)('%s', async (_label, path, body, code) => {
    const res = await request(app()).post(path).send(body());
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(code);
    expect(writes).toEqual([]);
    expect(weatherSpy).not.toHaveBeenCalled();
    expect(eventSpy).not.toHaveBeenCalled();
  });

  it('an EXPIRED attestation is not marked expired by an anonymous caller', async () => {
    rows.attestationExpired = true;
    const res = await request(app()).post('/api/iotex/devices/dev-forge/attestations/att-1').send({ response: forgedAttestation() });
    expect(res.status).toBe(401);
    expect(writes).toEqual([]);
  });
});

describe('the privileged paths', () => {
  it('operator attestation with a REAL signature by the registered key succeeds and writes', async () => {
    const res = await request(app()).post('/api/iotex/devices/dev-forge/attestations/att-1').set(AUTH).send({ response: signedAttestation() });
    expect(res.status).toBe(200);
    expect(writes.filter(w => w.op === 'update').length).toBe(2);
  });
  it('operator attestation with the OLD forgery (attacker-chosen key) is refused and only marks the request failed', async () => {
    const res = await request(app()).post('/api/iotex/devices/dev-forge/attestations/att-1').set(AUTH).send({ response: forgedAttestation() });
    expect(res.status).toBe(400);
    expect(res.body.result.success).toBe(false);
    expect(writes.filter(w => w.op === 'update').length).toBe(1); // FAILED only, never ATTESTED
  });
  it('a response that names a different public key is refused even when signed by the registered key', async () => {
    const res = await request(app()).post('/api/iotex/devices/dev-forge/attestations/att-1').set(AUTH).send({ response: signedAttestation({ publicKey: attackerKp.hex }) });
    expect(res.status).toBe(400);
  });
  it('operator attestation signed by another key that it also supplies is refused', async () => {
    const res = await request(app()).post('/api/iotex/devices/dev-forge/attestations/att-1').set(AUTH).send({ response: signedAttestation({ kp: attackerKp, publicKey: attackerKp.hex }) });
    expect(res.status).toBe(400);
  });
  it('operator W3bstream event passes auth and meets the not-wired 501 (backend#1171)', async () => {
    const res = await request(app()).post('/api/iotex/w3bstream/events').set(AUTH)
      .send({ publisherId: 'pub-1', eventType: 'reading', payload: eventPayload });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
    expect(writes).toEqual([]);
    expect(eventSpy).not.toHaveBeenCalled();
  });
});
