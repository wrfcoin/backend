/**
 * Station owner-action relay + ownership read (spec r23/station-owner-actions-spec.md, PROVISIONAL).
 * The node routes are faked: POST /transactions/station/owner-actions and the additive
 * owner_ledger / owner_features on GET /transactions/station/registrations/{id}.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createStationOwnerRouter, captureOwnerActionRawBody, ownerCommitment } from '../../server/routes/station-owner-routes.js';
import { stationAlias } from '../../server/utils/station-alias.js';

type Reply = { ok: boolean; status: number; payload: any };

const STATION = 'PWS-DULUTH-PRIVATENAME-01';
const ALIAS = stationAlias(STATION);
const OWNER = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const NEW_OWNER = 'wrfb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const STRANGER = '0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';
const PK = (c: string) => c.repeat(64).slice(0, 64);
const SIG = (c: string) => c.repeat(128).slice(0, 128);
const NOW = Date.parse('2026-10-06T12:00:00.000Z');

const JWT_SECRET = 'owner-actions-secret-0123456789abcdef';
const OPERATOR = 'operator-token-owner-actions-0123456789abcdef';
function walletToken(sub: string) {
  return jwt.sign({ sub, type: 'access' }, JWT_SECRET, {
    algorithm: 'HS256', issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '5m',
  });
}
let saved: Record<string, string | undefined>;
beforeAll(() => {
  saved = { J: process.env.JWT_SECRET, O: process.env.WRFCOIN_OPERATOR_TOKEN, C: process.env.WRFCOIN_CONTRIBUTOR_TOKEN, R: process.env.WRFCOIN_READER_TOKEN };
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR;
  process.env.WRFCOIN_CONTRIBUTOR_TOKEN = 'contributor-secret-token';
  process.env.WRFCOIN_READER_TOKEN = 'reader-secret-token';
});
afterAll(() => {
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('JWT_SECRET', saved.J); restore('WRFCOIN_OPERATOR_TOKEN', saved.O);
  restore('WRFCOIN_CONTRIBUTOR_TOKEN', saved.C); restore('WRFCOIN_READER_TOKEN', saved.R);
});

const PAYLOADS: Record<string, Record<string, unknown>> = {
  transfer: {
    tx_kind: 'station_owner_transfer_v1', station_id: STATION, from_owner_address: OWNER, from_owner_pubkey: PK('a'),
    to_owner_address: NEW_OWNER, to_owner_pubkey: PK('b'), transfer_nonce: 7, expires_at_height: 21000,
    from_owner_signature: SIG('c'), to_owner_signature: SIG('d'),
  },
  action: {
    tx_kind: 'station_owner_action_v1', station_id: STATION, owner_address: OWNER, owner_pubkey: PK('a'),
    action: 'report_stolen', action_nonce: 7, expires_at_height: 21000, owner_signature: SIG('c'),
  },
  recovery_file: {
    tx_kind: 'station_owner_recovery_file_v1', station_id: STATION, from_owner_address: OWNER, to_owner_address: NEW_OWNER,
    to_owner_pubkey: PK('b'), recovery_nonce: 7, to_owner_signature: SIG('d'), auth_pubkey: PK('e'), auth_signature: SIG('f'),
  },
  recovery_cancel: {
    tx_kind: 'station_owner_recovery_cancel_v1', station_id: STATION, owner_address: OWNER, owner_pubkey: PK('a'),
    recovery_nonce: 7, owner_signature: SIG('c'),
  },
  recovery_execute: { tx_kind: 'station_owner_recovery_execute_v1', station_id: STATION, recovery_nonce: 7 },
};

const KIND_OF: Record<string, string> = {
  station_owner_transfer_v1: 'transfer', station_owner_action_v1: 'owner_action', station_owner_recovery_file_v1: 'recovery_file',
  station_owner_recovery_cancel_v1: 'recovery_cancel', station_owner_recovery_execute_v1: 'recovery_execute',
};
/** The phone's body: {kind, payload}. The node builds the transaction envelope. */
function envelope(payload: Record<string, unknown>) {
  return { kind: KIND_OF[String(payload.tx_kind)] ?? 'unknown', payload: { ...payload } };
}

const NODE_OK: Reply = { ok: true, status: 201, payload: { accepted: 1, transaction_ids: ['cd'.repeat(32)], steps: [{ station_id: STATION, kind: 'station_owner_action_v1', nonce: 7 }], admission_height: 1235 } }; // exactly core4 #3482's StationOwnerTxSubmitResponse (plain JSON, no envelope)

function ledgerReply(over: Record<string, unknown> = {}, ledger: Record<string, unknown> | null = {}): Reply {
  return {
    ok: true, status: 200,
    payload: {
      station_id: STATION, owner_address: OWNER, is_active: true,
      latitude: 46.78671234, longitude: -92.10054321, elevation_meters: 12.5, state_root_hex: 'ee'.repeat(32),
      ...(ledger === null ? {} : {
        owner_ledger: { owner_nonce: 7, frozen: null, owner_deactivated: false, pending_recovery: null, ...ledger },
      }),
      rewards_suspended: false,
      features: { station_owner_consent: true, station_owner_actions: true, station_active_reward_gate: false },
      recovery_notice_blocks: 34000, observed_at_height: 500, settled_height: 480,
      ...over,
    },
  };
}

function makeApp(opts: { core4?: (path: string, options: any) => Reply | Error | Promise<Reply | Error>; limits?: any; now?: () => number } = {}) {
  const calls: Array<{ path: string; options: any }> = [];
  const fetchCore4Json = jest.fn(async (path: string, options: any) => {
    calls.push({ path, options });
    const r = await (opts.core4 ? opts.core4(path, options) : NODE_OK);
    if (r instanceof Error) throw r;
    return r;
  });
  const db = {
    execute: jest.fn(async (_sql: string, params?: unknown[]) =>
      ({ rows: params?.[0] === ALIAS ? [{ station_id: STATION }] : [] })),
  };
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb', verify: captureOwnerActionRawBody }));
  app.use('/api', createStationOwnerRouter({
    chainIdentity: () => ({ chainId: 'wrfcoin-testnet', networkId: 'testnet' }), db: db as any, fetchCore4Json: fetchCore4Json as any, now: opts.now ?? (() => NOW), limits: opts.limits,
  }));
  return { app, calls, fetchCore4Json };
}

const post = (app: express.Express, body: unknown, wallet?: string, alias = ALIAS, ip = '203.0.113.1') => {
  let r = request(app).post(`/api/stations/${alias}/owner-actions`).set('X-Forwarded-For', ip).set('Content-Type', 'application/json');
  if (wallet) r = r.set('Authorization', `Bearer ${walletToken(wallet)}`);
  return r.send(typeof body === 'string' ? body : JSON.stringify(body));
};

describe('POST /api/stations/:stationId/owner-actions: the relay', () => {
  it('forwards the EXACT payload text in the node envelope with the contributor credential and answers accepted-pending-confirmation, not applied', async () => {
    const { app, calls } = makeApp();
    // Odd spacing and key order inside the payload prove its text is forwarded byte for byte, never re-serialised.
    const payloadText = `{ "owner_signature":"${SIG('c')}" ,  "tx_kind" : "station_owner_action_v1","station_id":"${STATION}",\n"owner_address":"${OWNER}","owner_pubkey":"${PK('a')}",\t"action":"report_stolen","action_nonce":7,"expires_at_height":21000 }`;
    const raw = `{"payload": ${payloadText} ,"kind":"owner_action"}`;
    const res = await post(app, raw, OWNER);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, status: 'accepted_pending_confirmation', applied: false, stationAlias: ALIAS });
    expect(res.body.confirmWith).toBe(`/api/stations/${ALIAS}/ownership`);
    expect(res.body.transactionIds).toEqual(['cd'.repeat(32)]);
    expect(res.body.admissionHeight).toBe(1235);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/transactions/station/owner-actions');
    expect(calls[0].options.method).toBe('POST');
    expect(calls[0].options.headers.authorization).toBe('Bearer contributor-secret-token');
    const sent = JSON.parse(calls[0].options.body);
    expect(sent).toEqual({ chain_id: 'wrfcoin-testnet', network_id: 'testnet', payloads: [{ kind: 'station_owner_action_v1', payload_json: payloadText }] }); // the node requires payloads[].kind == the payload's tx_kind (core4 #3482), NOT the phone's `kind`
    expect(sent.payloads[0].payload_json).toBe(payloadText); // byte for byte
  });

  it.each([
    ['transfer', 'station_owner_transfer_v1', OWNER],
    ['action', 'station_owner_action_v1', OWNER],
    ['recovery_cancel', 'station_owner_recovery_cancel_v1', OWNER],
    ['recovery_execute', 'station_owner_recovery_execute_v1', undefined],
  ])('forwards payloads[].kind equal to the payload tx_kind for %s (the merged node answers OWNER_TX_KIND_MISMATCH otherwise)', async (payloadKey, txKind, wallet) => {
    const { app, calls } = makeApp();
    const res = await post(app, envelope(PAYLOADS[payloadKey]), wallet);
    expect(res.status).toBe(201);
    const sent = JSON.parse(calls[0].options.body);
    expect(sent.payloads).toHaveLength(1);
    expect(sent.payloads[0].kind).toBe(txKind);
    expect(JSON.parse(sent.payloads[0].payload_json).tx_kind).toBe(txKind);
    expect(Object.keys(sent).sort()).toEqual(['chain_id', 'network_id', 'payloads']); // exactly the payload form: no `transactions`
  });

  it.each([
    ['transfer', 'transfer', OWNER],
    ['owner action', 'action', OWNER.toUpperCase().replace('0X', '0x')],
    ['recovery cancel', 'recovery_cancel', OWNER],
  ])('%s needs a wallet login (the signer)', async (_name, kind, wallet) => {
    const { app, calls } = makeApp();
    expect((await post(app, envelope(PAYLOADS[kind]))).status).toBe(401);
    const wrong = await post(app, envelope(PAYLOADS[kind]), STRANGER);
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('NOT_THE_SIGNER');
    expect(calls).toHaveLength(0);
    expect((await post(app, envelope(PAYLOADS[kind]), wallet)).status).toBe(201);
  });

  it('transfer: the NEW owner (who countersigns and submits) is accepted, and so is the current owner; a third party is refused', async () => {
    const { app, calls } = makeApp();
    expect((await post(app, envelope(PAYLOADS.transfer), NEW_OWNER.replace('wrf', '0x'))).status).toBe(201); // same 20 bytes, other prefix
    expect((await post(app, envelope(PAYLOADS.transfer), OWNER)).status).toBe(201);
    const third = await post(app, envelope(PAYLOADS.transfer), STRANGER);
    expect(third.status).toBe(403);
    expect(third.body.error.code).toBe('NOT_THE_SIGNER');
    expect(calls).toHaveLength(2);
  });

  it('no operator bearer path for writes', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).post(`/api/stations/${ALIAS}/owner-actions`).set('Authorization', `Bearer ${OPERATOR}`)
      .set('Content-Type', 'application/json').send(JSON.stringify(envelope(PAYLOADS.action)));
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('recovery execute works with NO wallet login and never trusts one', async () => {
    const { app, calls } = makeApp();
    expect((await post(app, envelope(PAYLOADS.recovery_execute), undefined, ALIAS, '198.51.100.1')).status).toBe(201);
    expect((await post(app, envelope(PAYLOADS.recovery_execute), STRANGER, ALIAS, '198.51.100.2')).status).toBe(201); // a stranger login neither helps nor blocks it
    expect(calls).toHaveLength(2);
  });

  it('recovery FILE is a governance artifact: never relayed for users, with or without a login (spec 6.3)', async () => {
    const { app, calls } = makeApp();
    for (const wallet of [undefined, OWNER, NEW_OWNER, STRANGER]) {
      const res = await post(app, envelope(PAYLOADS.recovery_file), wallet, ALIAS, '198.51.100.9');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('RECOVERY_FILE_NOT_OFFERED');
    }
    const op = await request(app).post(`/api/stations/${ALIAS}/owner-actions`).set('Authorization', `Bearer ${OPERATOR}`)
      .set('Content-Type', 'application/json').send(JSON.stringify(envelope(PAYLOADS.recovery_file)));
    expect(op.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('recovery execute is rate-limited hard per IP', async () => {
    const perIp = makeApp({ limits: { signatureOnlyPerIp: 2 } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await post(perIp.app, envelope(PAYLOADS.recovery_execute), undefined, ALIAS, '192.0.2.9')).status);
    expect(statuses).toEqual([201, 201, 429, 429]);
    expect(perIp.calls).toHaveLength(2);
  });

  it('there is NO per-station budget on execute: other IPs cannot lock the real executor out (rev-1 blocker)', async () => {
    const { app, calls } = makeApp({ limits: { signatureOnlyPerIp: 5 } });
    // 25 requests from 25 different IPs against the same station (far past any plausible per-station cap)...
    for (let i = 0; i < 25; i += 1) {
      expect((await post(app, envelope(PAYLOADS.recovery_execute), undefined, ALIAS, `198.51.100.${i + 1}`)).status).toBe(201);
    }
    // ...and a fresh IP still gets through to the node, which alone decides whether the window has elapsed.
    expect((await post(app, envelope(PAYLOADS.recovery_execute), undefined, ALIAS, '203.0.113.200')).status).toBe(201);
    expect(calls).toHaveLength(26);
  });

  it('the general relay limit applies to every kind', async () => {
    const { app } = makeApp({ limits: { relayPerIp: 2 } });
    const s: number[] = [];
    for (let i = 0; i < 3; i += 1) s.push((await post(app, envelope(PAYLOADS.action), OWNER)).status);
    expect(s).toEqual([201, 201, 429]);
  });

  it('enforces the size cap on the raw body', async () => {
    const { app, calls } = makeApp();
    const big = envelope(PAYLOADS.action);
    (big.payload as any).padding = 'x'.repeat(9000);
    const res = await post(app, big, OWNER);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('BODY_TOO_LARGE');
    expect(calls).toHaveLength(0);
  });

  it('refuses a payload number above 2^53 (the parsed value would not be the signed one)', async () => {
    const { app, calls } = makeApp();
    const raw = JSON.stringify(envelope(PAYLOADS.action)).replace('"action_nonce":7', '"action_nonce":9007199254740993');
    expect(raw).toContain('9007199254740993');
    const res = await post(app, raw, OWNER);
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('refuses a duplicated "payload" member (the text forwarded would not be the text validated)', async () => {
    const { app, calls } = makeApp();
    const p = JSON.stringify(PAYLOADS.action);
    const res = await post(app, `{"kind":"owner_action","payload":${p},"payload":${p}}`, OWNER);
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a registration payload (not an owner kind)', () => envelope({ tx_kind: 'station_registration_v1', station_id: STATION })],
    ['no tx_kind', () => envelope({ station_id: STATION })],
    ['an unknown payload field', () => envelope({ ...PAYLOADS.action, extra: 1 })],
    ['a missing signature', () => { const p = { ...PAYLOADS.action } as any; delete p.owner_signature; return envelope(p); }],
    ['a short signature', () => envelope({ ...PAYLOADS.action, owner_signature: 'ab' })],
    ['a transfer without the countersignature', () => { const p = { ...PAYLOADS.transfer } as any; delete p.to_owner_signature; return envelope(p); }],
    ['an unknown action', () => envelope({ ...PAYLOADS.action, action: 'burn' })],
    ['a non-integer nonce', () => envelope({ ...PAYLOADS.action, action_nonce: 1.5 })],
    ['a negative nonce', () => envelope({ ...PAYLOADS.action, action_nonce: -1 })],
    ['a nonce beyond 2^53', () => envelope({ ...PAYLOADS.action, action_nonce: 2 ** 60 })],
    ['a station_id other than the path station', () => envelope({ ...PAYLOADS.action, station_id: 'someone-else' })],
    ['a malformed address', () => envelope({ ...PAYLOADS.action, owner_address: '0x123' })],
    ['a kind that does not match the payload', () => ({ ...envelope(PAYLOADS.action), kind: 'transfer' })],
    ['recovery_accept (no standalone tx exists)', () => ({ ...envelope(PAYLOADS.action), kind: 'recovery_accept' })],
    ['an unknown kind', () => ({ ...envelope(PAYLOADS.action), kind: 'burn' })],
    ['an extra body field', () => ({ ...envelope(PAYLOADS.action), operator: true })],
    ['no payload', () => ({ kind: 'owner_action' })],
    ['a payload that is a string', () => ({ kind: 'owner_action', payload: JSON.stringify(PAYLOADS.action) })],
    ['the old transaction form', () => ({ kind: 'owner_action', transaction: { data: JSON.stringify(PAYLOADS.action) } })],
  ])('refuses %s with 422 and forwards nothing', async (_name, build) => {
    const { app, calls } = makeApp();
    const res = await post(app, (build as () => unknown)(), OWNER);
    expect(res.status).toBe(422);
    expect(['INVALID_OWNER_ACTION', 'UNSUPPORTED_KIND']).toContain(res.body.error.code);
    expect(calls).toHaveLength(0);
  });

  it('addresses stations by alias only: a raw id or an unknown alias is 404', async () => {
    const { app, calls } = makeApp();
    expect((await post(app, envelope(PAYLOADS.action), OWNER, STATION)).status).toBe(404);
    expect((await post(app, envelope(PAYLOADS.action), OWNER, 'st_000000000000')).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it.each([
    'OWNER_TX_NONCE_MISMATCH', 'OWNER_TX_STATION_FROZEN', 'OWNER_TX_NOT_FROZEN', 'OWNER_TX_RECOVERY_ALREADY_PENDING',
    'OWNER_TX_NO_PENDING_RECOVERY', 'OWNER_TX_NOTICE_WINDOW_NOT_ELAPSED', 'OWNER_TX_NOTICE_WINDOW_ELAPSED',
    'OWNER_TX_NOT_REGISTERED_OWNER', 'OWNER_TX_UNKNOWN_STATION', 'OWNER_TX_FEATURE_NOT_ACTIVE', 'OWNER_TX_BAD_OWNER_SIGNATURE',
    'OWNER_TX_EXPIRED', 'OWNER_TX_STALE_TIMESTAMP', 'CHAIN_IDENTITY_MISMATCH', 'MEMPOOL_REJECTED', 'OWNER_TX_EXECUTE_ALREADY_PENDING', 'OWNER_TX_KIND_MISMATCH',
  ])('passes the node code %s through as error.code with 422, never echoing node text', async (nodeCode) => {
    // The message deliberately says something misleading: only the code is the contract.
    const text = `Frozen NonceMismatch for ${STATION} owner ${OWNER}`;
    const { app } = makeApp({ core4: () => ({ ok: false, status: nodeCode === 'MEMPOOL_REJECTED' ? 400 : 422, payload: { ok: false, error: { code: nodeCode, message: text } } }) });
    const res = await post(app, envelope(PAYLOADS.action), OWNER);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(nodeCode);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(STATION);
    expect(body).not.toContain(OWNER);
  });

  it('an unknown but well-formed node code is still passed through with no node text', async () => {
    const { app } = makeApp({ core4: () => ({ ok: false, status: 422, payload: { ok: false, error: { code: 'SOMETHING_NEW', message: `x ${STATION}` } } }) });
    const res = await post(app, envelope(PAYLOADS.action), OWNER);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SOMETHING_NEW'); // any stable code is passed through; its text is ours
    expect(JSON.stringify(res.body)).not.toContain(STATION);
  });

  it('node down or a node without the route is 503 retryable, never a success; a refused credential is not blamed on the client', async () => {
    for (const core4 of [
      () => new Error('connect ECONNREFUSED 10.0.0.5:8556'),
      () => ({ ok: false, status: 503, payload: null }),
      () => ({ ok: false, status: 404, payload: { error: 'no route' } }),
      () => ({ ok: false, status: 403, payload: { error: 'role' } }),
    ]) {
      const { app } = makeApp({ core4 });
      const res = await post(app, envelope(PAYLOADS.action), OWNER);
      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.error.retryable).toBe(true);
      expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
    }
  });

  it('503 without calling the node when the contributor credential is not configured', async () => {
    const was = process.env.WRFCOIN_CONTRIBUTOR_TOKEN;
    delete process.env.WRFCOIN_CONTRIBUTOR_TOKEN;
    try {
      const { app, calls } = makeApp();
      const res = await post(app, envelope(PAYLOADS.action), OWNER);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('RELAY_UNAVAILABLE');
      expect(calls).toHaveLength(0);
    } finally { process.env.WRFCOIN_CONTRIBUTOR_TOKEN = was; }
  });
});

describe('rate-limit keys through the router (the shared util is unit-tested in server/__tests__/rate-limit-key.test.ts)', () => {
  it('40 addresses in one /64 share ONE budget; another /64 has its own; IPv4 and mapped IPv4 behave as before', async () => {
    const { app } = makeApp({ limits: { relayPerIp: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) statuses.push((await post(app, envelope(PAYLOADS.action), OWNER, ALIAS, `2001:db8:abcd:12:${i.toString(16)}::${i + 1}`)).status);
    expect(statuses.filter((c) => c === 201)).toHaveLength(3);
    expect(statuses.slice(3).every((c) => c === 429)).toBe(true);
    expect((await post(app, envelope(PAYLOADS.action), OWNER, ALIAS, '2001:db8:abcd:13::1')).status).toBe(201); // other /64
    // IPv4: each full address has its own budget
    for (let i = 0; i < 3; i += 1) expect((await post(app, envelope(PAYLOADS.action), OWNER, ALIAS, '192.0.2.1')).status).toBe(201);
    expect((await post(app, envelope(PAYLOADS.action), OWNER, ALIAS, '192.0.2.1')).status).toBe(429);
    expect((await post(app, envelope(PAYLOADS.action), OWNER, ALIAS, '192.0.2.2')).status).toBe(201);
    // IPv4-mapped IPv6 is the SAME client as its IPv4 (already spent above)
    expect((await post(app, envelope(PAYLOADS.action), OWNER, ALIAS, '::ffff:192.0.2.1')).status).toBe(429);
  });

  it('the execute and read limiters use the same /64 keys', async () => {
    const { app } = makeApp({ limits: { signatureOnlyPerIp: 2, readPerIp: 2 }, core4: (path) => (path.endsWith('/owner-ledger') ? ledgerReply() : NODE_OK) });
    const exec: number[] = [];
    for (let i = 0; i < 4; i += 1) exec.push((await post(app, envelope(PAYLOADS.recovery_execute), undefined, ALIAS, `2001:db8:1:2:${i}::9`)).status);
    expect(exec).toEqual([201, 201, 429, 429]);
    const reads: number[] = [];
    for (let i = 0; i < 4; i += 1) reads.push((await request(app).get(`/api/stations/${ALIAS}/ownership`).set('X-Forwarded-For', `2001:db8:3:4:${i}::1`)).status);
    expect(reads).toEqual([200, 200, 429, 429]);
  });
});

describe('the in-memory counter is hard-bounded', () => {
  it('a flood of distinct keys cannot grow the router counters past the cap', async () => {
    const { app } = makeApp({ limits: { relayPerIp: 1000, maxKeys: 8 } });
    for (let i = 0; i < 40; i += 1) await post(app, envelope(PAYLOADS.action), OWNER, ALIAS, `198.51.100.${i + 1}`);
    // still serving, and the router exposes no unbounded state: asserted through the counter unit test above
    expect((await post(app, envelope(PAYLOADS.action), OWNER, ALIAS, '198.51.100.250')).status).toBe(201);
  });
});

describe('the express.json verify hook changes nothing for any other route', () => {
  const build = (withHook: boolean) => {
    const app = express();
    app.use(express.json({ limit: '1kb', ...(withHook ? { verify: captureOwnerActionRawBody } : {}) }));
    app.post('/api/other', (req, res) => res.json({ keys: Object.keys(req.body ?? {}), raw: (req as any).rawBody === undefined ? 'none' : 'set' }));
    app.post('/api/stations/st_0123456789ab/owner-actions', (req, res) => res.json({ raw: (req as any).rawBody === undefined ? 'none' : 'set' }));
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.status ?? 500).json({ type: err.type, status: err.status }));
    return app;
  };
  const probes: Array<[string, string, string]> = [
    ['valid json', '/api/other', '{"a":1}'],
    ['oversize (same 1kb limit)', '/api/other', JSON.stringify({ pad: 'x'.repeat(2000) })],
    ['malformed json', '/api/other', '{"a":'],
    ['empty object', '/api/other', '{}'],
  ];
  it.each(probes)('%s: identical status and body with and without the hook', async (_n, path, body) => {
    const send = (a: express.Express) => request(a).post(path).set('Content-Type', 'application/json').send(body);
    const [plain, hooked] = [await send(build(false)), await send(build(true))];
    expect(hooked.status).toBe(plain.status);
    expect(hooked.body).toEqual(plain.body);
  });
  it('only the owner-actions path keeps a raw body; the size limit and parse errors on it are unchanged too', async () => {
    const other = await request(build(true)).post('/api/other').set('Content-Type', 'application/json').send('{"a":1}');
    expect(other.body.raw).toBe('none');
    const relay = await request(build(true)).post('/api/stations/st_0123456789ab/owner-actions').set('Content-Type', 'application/json').send('{"a":1}');
    expect(relay.body.raw).toBe('set');
    const big = JSON.stringify({ pad: 'x'.repeat(2000) });
    const [p1, p2] = [
      await request(build(false)).post('/api/stations/st_0123456789ab/owner-actions').set('Content-Type', 'application/json').send(big),
      await request(build(true)).post('/api/stations/st_0123456789ab/owner-actions').set('Content-Type', 'application/json').send(big),
    ];
    expect(p2.status).toBe(p1.status);
    expect(p2.status).toBe(413);
  });
});

describe('GET /api/stations/:stationId/ownership: the read', () => {
  const get = (app: express.Express, opts: { wallet?: string; operator?: boolean; alias?: string } = {}) => {
    let r = request(app).get(`/api/stations/${opts.alias ?? ALIAS}/ownership`).set('X-Forwarded-For', '203.0.113.7');
    if (opts.wallet) r = r.set('Authorization', `Bearer ${walletToken(opts.wallet)}`);
    if (opts.operator) r = r.set('Authorization', `Bearer ${OPERATOR}`);
    return r;
  };
  const pending = {
    from_owner_address: OWNER, to_owner_address: NEW_OWNER, recovery_nonce: 7, filed_at_height: 1000, executable_at_height: 35000,
  };

  it('answers the state with the nonce for everyone, an alias, and a short owner address for non-owners', async () => {
    const { app, calls } = makeApp({ core4: () => ledgerReply({ rewards_suspended: true }, { pending_recovery: pending, frozen: { since_height: 900 } }) });
    const res = await get(app);
    expect(res.status).toBe(200);
    expect(calls[0].path).toBe(`/transactions/station/registrations/${encodeURIComponent(STATION)}/owner-ledger`);
    expect(calls[0].options.headers.authorization).toBe('Bearer reader-secret-token');
    expect(res.body).toMatchObject({
      success: true, stationAlias: ALIAS, isOwner: false, ownerNonce: 7, frozen: { sinceHeight: 900 },
      ownerDeactivated: false, rewardsSuspended: true,
      pendingRecovery: { recoveryNonce: 7, filedAtHeight: 1000, executableAtHeight: 35000, noticeBlocks: 34000 },
      features: { stationOwnerConsent: true, stationOwnerActions: true, stationActiveRewardGate: false },
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain(NEW_OWNER);
    expect(text).not.toContain(STATION);
    expect(text).not.toMatch(/latitude|longitude|elevation|46\.78|92\.10|state_root/);
  });

  it('shows full addresses only to the owner login (or the party named) and the operator', async () => {
    const { app } = makeApp({ core4: () => ledgerReply({}, { pending_recovery: pending }) });
    const owner = await get(app, { wallet: OWNER });
    expect(owner.body.isOwner).toBe(true);
    expect(owner.body.owner).toBe(OWNER);
    expect(owner.body.pendingRecovery.fromOwner).toBe(OWNER);
    expect(owner.body.pendingRecovery.toOwner).not.toBe(NEW_OWNER); // only the owner's own address is revealed
    const claimant = await get(app, { wallet: NEW_OWNER });
    expect(claimant.body.isOwner).toBe(false);
    expect(claimant.body.pendingRecovery.toOwner).toBe(NEW_OWNER);
    expect(claimant.body.pendingRecovery.fromOwner).not.toBe(OWNER);
    const stranger = await get(app, { wallet: STRANGER });
    expect(JSON.stringify(stranger.body)).not.toContain(OWNER);
    const op = await get(app, { operator: true });
    expect(op.body.owner).toBe(OWNER);
  });

  // v1: the 20 raw address bytes as lowercase hex, no prefix (so 0x and wrf spellings commit identically)
  const commit = (stationId: string, address: string) =>
    createHash('sha256').update(`wrfcoin-owner-commit-v1:${stationId}:${address.replace(/^(0x|wrf)/i, '').toLowerCase()}`).digest('hex');

  it('ownerCommitment (v1, over the 20 raw address bytes) for ALL viewers, and per pending-recovery party', async () => {
    const { app } = makeApp({ core4: () => ledgerReply({}, { pending_recovery: pending }) });
    for (const viewer of [undefined, STRANGER, OWNER]) {
      const res = await get(app, viewer ? { wallet: viewer } : {});
      expect(res.body.ownerCommitment).toBe(commit(STATION, OWNER));
      expect(res.body.pendingRecovery.fromOwnerCommitment).toBe(commit(STATION, OWNER));
      expect(res.body.pendingRecovery.toOwnerCommitment).toBe(commit(STATION, NEW_OWNER));
    }
    // salted per station: the same person has an unrelated commitment on another station
    expect(commit('another-station', OWNER)).not.toBe(commit(STATION, OWNER));
    // the full address is still not disclosed to a non-owner
    const anon = await get(app);
    expect(JSON.stringify(anon.body)).not.toContain(OWNER);
    // a pinned vector (also in the PR body) so a phone can reproduce it
    expect(commit('PWS-DULUTH-PRIVATENAME-01', '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1')).toBe('4f0803cf5968a5e36b0893b1cef89f119d4f47cfdd4b509ff684e42249d180fd');
  });

  it('the 0x and wrf spellings of the same 20 bytes give the SAME commitment; unparseable addresses give none', async () => {
    const bytes = 'a1'.repeat(20);
    expect(ownerCommitment(STATION, `0x${bytes}`)).toBe(ownerCommitment(STATION, `wrf${bytes}`));
    expect(ownerCommitment(STATION, `0x${bytes}`)).toBe(ownerCommitment(STATION, `WRF${bytes.toUpperCase()}`));
    expect(ownerCommitment(STATION, `0x${bytes}`)).toBe(ownerCommitment(STATION, `0X${bytes.toUpperCase()}`));
    expect(ownerCommitment(STATION, `0x${bytes}`)).not.toBe(ownerCommitment(STATION, `0x${'a2'.repeat(20)}`));
    for (const bad of ['', '0x123', `0x${bytes}zz`, `xyz${bytes}`, bytes, null, undefined, 42]) expect(ownerCommitment(STATION, bad)).toBeNull();
    // through the route: an owner reported in the wrf spelling commits the same as its 0x spelling
    const wrfOwner = `wrf${'a1'.repeat(20)}`;
    const { app } = makeApp({ core4: () => ledgerReply({ owner_address: wrfOwner }) });
    expect((await get(app)).body.ownerCommitment).toBe(commit(STATION, OWNER));
  });

  it.each([
    ['owner_address', (d: any) => { d.owner_address = '0x123'; }],
    ['pending from_owner_address', (d: any) => { d.owner_ledger.pending_recovery = { ...pending, from_owner_address: 'not-an-address' }; }],
    ['pending to_owner_address', (d: any) => { d.owner_ledger.pending_recovery = { ...pending, to_owner_address: '' }; }],
  ])('an unparseable %s is a 502 contract mismatch, never an empty or garbage commitment', async (_name, mutate) => {
    const reply = ledgerReply();
    mutate(reply.payload);
    const { app } = makeApp({ core4: () => reply });
    const res = await get(app);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('CORE4_CONTRACT_MISMATCH');
    expect(JSON.stringify(res.body)).not.toMatch(/ownerCommitment/);
  });

  it('a clean ledger reports no frozen and no pending recovery explicitly', async () => {
    const { app } = makeApp({ core4: () => ledgerReply() });
    const res = await get(app);
    expect(res.body).toMatchObject({ frozen: null, pendingRecovery: null, ownerNonce: 7, ownerDeactivated: false });
  });

  it('never defaults to "not frozen": node down, a node without the ledger, or garbage is not a 200', async () => {
    for (const [core4, status] of [
      [() => new Error('boom'), 503],
      [() => ({ ok: false, status: 503, payload: null }), 503],
      [() => ledgerReply({}, null), 502],
      [() => ledgerReply({}, { owner_nonce: 'seven' }), 502],
      [() => ledgerReply({}, { frozen: 'yes' }), 502],
      [() => ledgerReply({}, { pending_recovery: { recovery_nonce: 'x' } }), 502],
    ] as Array<[() => any, number]>) {
      const { app } = makeApp({ core4 });
      const res = await get(app);
      expect(res.status).toBe(status);
      expect(res.body.success).toBe(false);
      expect(res.body).not.toHaveProperty('frozen');
    }
  });

  it.each([
    ['frozen omitted', (d: any) => { delete d.owner_ledger.frozen; }],
    ['pending_recovery omitted', (d: any) => { delete d.owner_ledger.pending_recovery; }],
    ['owner_deactivated omitted', (d: any) => { delete d.owner_ledger.owner_deactivated; }],
    ['owner_nonce omitted', (d: any) => { delete d.owner_ledger.owner_nonce; }],
    ['rewards_suspended omitted', (d: any) => { delete d.rewards_suspended; }],
    ['features omitted', (d: any) => { delete d.features; }],
    ['one feature flag omitted', (d: any) => { delete d.features.station_owner_actions; }],
    ['a feature flag that is not a boolean', (d: any) => { d.features.station_owner_consent = 'yes'; }],
    ['is_active omitted', (d: any) => { delete d.is_active; }],
    ['observed_at_height omitted', (d: any) => { delete d.observed_at_height; }],
    ['settled_height omitted', (d: any) => { delete d.settled_height; }],
    ['recovery_notice_blocks omitted', (d: any) => { delete d.recovery_notice_blocks; }],
    ['frozen.since_height omitted', (d: any) => { d.owner_ledger.frozen = {}; }],
    ['pending executable_at_height omitted', (d: any) => { d.owner_ledger.pending_recovery = { ...pending }; delete d.owner_ledger.pending_recovery.executable_at_height; }],
    ['pending to_owner_address omitted', (d: any) => { d.owner_ledger.pending_recovery = { ...pending }; delete d.owner_ledger.pending_recovery.to_owner_address; }],
    ['pending recovery_nonce omitted', (d: any) => { d.owner_ledger.pending_recovery = { ...pending }; delete d.owner_ledger.pending_recovery.recovery_nonce; }],
  ])('a node reply with %s is a 502 contract mismatch, never a 200 that reads as "not frozen"', async (_name, mutate) => {
    const reply = ledgerReply();
    mutate(reply.payload);
    const { app } = makeApp({ core4: () => reply });
    const res = await get(app);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('CORE4_CONTRACT_MISMATCH');
    expect(res.body).not.toHaveProperty('frozen');
  });

  it('every key present with an explicit null (frozen, pending_recovery) is a valid 200', async () => {
    const { app } = makeApp({ core4: () => ledgerReply() });
    const res = await get(app);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ frozen: null, pendingRecovery: null });
  });

  it('an unregistered station is 404; a raw id or unknown alias is 404 for anonymous callers', async () => {
    const { app } = makeApp({ core4: () => ({ ok: false, status: 404, payload: { ok: false } }) });
    expect((await get(app)).status).toBe(404);
    expect((await get(app, { alias: STATION })).status).toBe(404);
    expect((await get(app, { alias: 'st_000000000000' })).status).toBe(404);
  });

  it('is rate-limited per IP', async () => {
    const { app } = makeApp({ core4: () => ledgerReply(), limits: { readPerIp: 2 } });
    const s: number[] = [];
    for (let i = 0; i < 3; i += 1) s.push((await get(app)).status);
    expect(s).toEqual([200, 200, 429]);
  });
});


// ---------------------------------------------------------------------------------------------------------
// Contract fixture: the REAL route output for every shape a client must handle, committed as JSON so the mobile
// tests can copy it byte for byte. A drift between the route and the file fails this test; regenerate with
// UPDATE_STATION_OWNER_CONTRACT=1 after an intentional contract change.
// ---------------------------------------------------------------------------------------------------------
describe('contract fixture: __tests__/fixtures/station-owner-contract.json', () => {
  const FIXTURE = path.join(__dirname, '../fixtures/station-owner-contract.json');
  const pendingRecovery = { from_owner_address: OWNER, to_owner_address: NEW_OWNER, recovery_nonce: 7, filed_at_height: 1000, executable_at_height: 35000 };
  type Who = 'anonymous' | 'owner' | 'new_owner' | 'stranger' | 'operator';
  const wallets: Record<string, string | undefined> = { anonymous: undefined, owner: OWNER, new_owner: NEW_OWNER, stranger: STRANGER, operator: undefined };
  type Case = {
    name: string; method: 'GET' | 'POST'; alias?: string; as: Who; body?: unknown; bodyBytes?: number;
    core4?: (path: string) => Reply | Error; limits?: any; noContributorToken?: boolean;
  };
  const cases: Case[] = [
    { name: 'ownership_owner_view', method: 'GET', as: 'owner', core4: () => ledgerReply({ rewards_suspended: true }, { pending_recovery: pendingRecovery, frozen: { since_height: 900 } }) },
    { name: 'ownership_new_owner_view', method: 'GET', as: 'new_owner', core4: () => ledgerReply({}, { pending_recovery: pendingRecovery }) },
    { name: 'ownership_non_owner_view', method: 'GET', as: 'anonymous', core4: () => ledgerReply({ rewards_suspended: true }, { pending_recovery: pendingRecovery, frozen: { since_height: 900 } }) },
    { name: 'ownership_clean', method: 'GET', as: 'anonymous', core4: () => ledgerReply() },
    { name: 'ownership_404_unknown_alias', method: 'GET', as: 'anonymous', alias: 'st_000000000000' },
    { name: 'ownership_404_not_registered', method: 'GET', as: 'anonymous', core4: () => ({ ok: false, status: 404, payload: { ok: false } }) },
    { name: 'ownership_502_contract_mismatch_frozen_omitted', method: 'GET', as: 'anonymous', core4: () => { const r = ledgerReply(); delete (r.payload.owner_ledger as any).frozen; return r; } },
    { name: 'ownership_503_node_down', method: 'GET', as: 'anonymous', core4: () => new Error('boom') },
    { name: 'submit_201_owner_action', method: 'POST', as: 'owner', body: envelope(PAYLOADS.action) },
    { name: 'submit_201_transfer_by_new_owner', method: 'POST', as: 'new_owner', body: envelope(PAYLOADS.transfer) },
    { name: 'submit_201_recovery_execute_no_login', method: 'POST', as: 'anonymous', body: envelope(PAYLOADS.recovery_execute) },
    { name: 'submit_401_login_required', method: 'POST', as: 'anonymous', body: envelope(PAYLOADS.action) },
    { name: 'submit_403_not_the_signer', method: 'POST', as: 'stranger', body: envelope(PAYLOADS.action) },
    { name: 'submit_403_recovery_file_not_offered', method: 'POST', as: 'owner', body: envelope(PAYLOADS.recovery_file) },
    { name: 'submit_404_unknown_alias', method: 'POST', as: 'owner', alias: 'st_000000000000', body: envelope(PAYLOADS.action) },
    { name: 'submit_413_body_too_large', method: 'POST', as: 'owner', bodyBytes: 9000 },
    { name: 'submit_422_invalid_owner_action', method: 'POST', as: 'owner', body: envelope({ ...PAYLOADS.action, owner_signature: 'ab' }) },
    { name: 'submit_422_unsupported_kind_recovery_accept', method: 'POST', as: 'owner', body: { ...envelope(PAYLOADS.action), kind: 'recovery_accept' } },
    { name: 'submit_422_node_code_nonce_mismatch', method: 'POST', as: 'owner', body: envelope(PAYLOADS.action), core4: () => ({ ok: false, status: 422, payload: { ok: false, error: { code: 'OWNER_TX_NONCE_MISMATCH', message: 'node text is never echoed' } } }) },
    { name: 'submit_422_node_code_chain_identity_mismatch', method: 'POST', as: 'owner', body: envelope(PAYLOADS.action), core4: () => ({ ok: false, status: 422, payload: { ok: false, error: { code: 'CHAIN_IDENTITY_MISMATCH', message: 'x' } } }) },
    { name: 'submit_429_rate_limited', method: 'POST', as: 'owner', body: envelope(PAYLOADS.action), limits: { relayPerIp: 0 } },
    { name: 'submit_503_node_unavailable', method: 'POST', as: 'owner', body: envelope(PAYLOADS.action), core4: () => new Error('ECONNREFUSED') },
    { name: 'submit_503_relay_credential_unconfigured', method: 'POST', as: 'owner', body: envelope(PAYLOADS.action), noContributorToken: true },
  ];

  async function runCase(c: Case) {
    const was = process.env.WRFCOIN_CONTRIBUTOR_TOKEN;
    if (c.noContributorToken) delete process.env.WRFCOIN_CONTRIBUTOR_TOKEN;
    try {
      const { app } = makeApp({ core4: c.core4 ? (path) => c.core4!(path) : undefined, limits: c.limits });
      const alias = c.alias ?? ALIAS;
      const url = `/api/stations/${alias}/${c.method === 'GET' ? 'ownership' : 'owner-actions'}`;
      let r = c.method === 'GET' ? request(app).get(url) : request(app).post(url).set('Content-Type', 'application/json');
      r = r.set('X-Forwarded-For', '203.0.113.5');
      const wallet = wallets[c.as];
      if (wallet) r = r.set('Authorization', `Bearer ${walletToken(wallet)}`);
      const res = c.method === 'GET'
        ? await r
        : await r.send(c.bodyBytes !== undefined ? JSON.stringify({ kind: 'owner_action', payload: { pad: 'x'.repeat(c.bodyBytes) } }) : JSON.stringify(c.body));
      return { status: res.status, body: res.body };
    } finally {
      if (c.noContributorToken && was !== undefined) process.env.WRFCOIN_CONTRIBUTOR_TOKEN = was;
    }
  }

  async function build() {
    const out: Record<string, unknown> = {
      _readme: 'Generated by __tests__/routes/station-owner-routes.test.ts from the REAL backend route output (backend#1459). Do not edit by hand: run UPDATE_STATION_OWNER_CONTRACT=1 npx jest __tests__/routes/station-owner-routes.test.ts. Mobile copies this file byte for byte.',
      constants: {
        stationId: STATION, stationAlias: ALIAS, ownerAddress: OWNER, newOwnerAddress: NEW_OWNER, strangerAddress: STRANGER,
        ownerCommitmentFormula: 'sha256("wrfcoin-owner-commit-v1:" + station_id + ":" + lowercase hex of the 20 raw address bytes, no prefix), lowercase hex; 0x and wrf spellings of the same bytes give the same value',
        ownerCommitmentVector: { stationId: STATION, address: OWNER, commitment: commit0(STATION, OWNER) },
        paths: { submit: 'POST /api/stations/:alias/owner-actions', read: 'GET /api/stations/:alias/ownership' },
        submitBody: '{kind, payload} with kind in transfer | owner_action | recovery_cancel | recovery_execute',
      },
      cases: {} as Record<string, unknown>,
    };
    for (const c of cases) {
      (out.cases as Record<string, unknown>)[c.name] = {
        request: { method: c.method, path: `/api/stations/${c.alias ?? '<alias>'}/${c.method === 'GET' ? 'ownership' : 'owner-actions'}`, loggedInAs: c.as, body: c.bodyBytes !== undefined ? { _note: `a body of more than ${c.bodyBytes} bytes` } : c.body },
        response: await runCase(c),
      };
    }
    return out;
  }
  const commit0 = (stationId: string, address: string) =>
    createHash('sha256').update(`wrfcoin-owner-commit-v1:${stationId}:${address.replace(/^(0x|wrf)/i, '').toLowerCase()}`).digest('hex');

  it('the route output equals the committed fixture byte for byte (regenerate: UPDATE_STATION_OWNER_CONTRACT=1)', async () => {
    const text = JSON.stringify(await build(), null, 2) + '\n';
    if (process.env.UPDATE_STATION_OWNER_CONTRACT === '1') fs.writeFileSync(FIXTURE, text);
    expect(fs.readFileSync(FIXTURE, 'utf8')).toBe(text);
  });

  it('covers every status the phone must handle', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cases: Record<string, { response: { status: number } }> };
    const statuses = new Set(Object.values(fixture.cases).map((c) => c.response.status));
    for (const status of [200, 201, 401, 403, 404, 413, 422, 429, 502, 503]) expect(statuses.has(status)).toBe(true);
  });
});
