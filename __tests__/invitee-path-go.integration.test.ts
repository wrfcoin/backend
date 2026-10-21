import { attachWalletNonceIssuer } from './helpers/wallet-nonce-redis';
/**
 * GO invitee-path regression net (lane be-gov G10, "r17").
 *
 * Walks, in order, what an invited tester does, through the REAL routers, the REAL
 * services and a REAL throwaway PostgreSQL, against an in-process FAKE core4 that
 * speaks HTTP on loopback and checks everything it receives INDEPENDENTLY of the
 * backend's own helpers (its own JavaScript sha3 commit-id formula, its own V1 vote preimage,
 * its own address derivation, its own credential checks):
 *
 *   1. wallet challenge + ed25519 login (real wallet-auth service, in-memory redis)
 *   2. per-phone station challenge + register (db_only)
 *   3. submit-data -> 409 STATION_NOT_ACTIVE, and core4 saw NO contribution call
 *   4. simulated chain sync (real fetchChainStationList + runStationSyncOnce) -> on_chain
 *   5. prepare + submit-data forward a commit then a reveal; core4 recomputes the
 *      commit id from the reveal and it matches; core4's own auth-signature check passes
 *   6. a governance proposal is listed (paginated core4 object unwrapped)
 *   7. a V1-signed vote is forwarded with the server Contributor token and
 *      x-voter-address = the wallet address
 *
 * The fake uses JavaScript JSON parsing/serialization; it does not model Rust
 * serde_json float parsing. The independent 21.46 assertion below proves 2-dp
 * quantization; actual Rust float fidelity is covered by the serde golden suite.
 *
 * Every link is asserted, so a break anywhere fails this file. Needs a disposable
 * PostgreSQL: MOBILE_STATION_PG_URL (CI sets it; MOBILE_STATION_REQUIRE_PG=1 turns a
 * missing URL into a failure). Never point it at the live backend database.
 * Fake coordinates only (10.0 / 20.0).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

const url = process.env.MOBILE_STATION_PG_URL;
const d = url ? describe : describe.skip;

if (!url && process.env.MOBILE_STATION_REQUIRE_PG === '1') {
  it('MOBILE_STATION_PG_URL is required when MOBILE_STATION_REQUIRE_PG=1', () => {
    throw new Error('the invitee-path integration suite would have been skipped');
  });
}

// ---- independent crypto helpers (deliberately NOT the backend's) -------------
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const sha3 = (b: Buffer | string) => crypto.createHash('sha3-256').update(b).digest('hex');

function keypair(seed: string) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, crypto.createHash('sha256').update(`g10:${seed}`).digest()]), format: 'der', type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = spki.subarray(spki.length - 32).toString('hex');
  return {
    publicKey,
    address: `0x${sha3(Buffer.from(publicKey, 'hex')).slice(0, 40)}`,
    sign: (m: Buffer | string) => crypto.sign(null, Buffer.isBuffer(m) ? m : Buffer.from(m), key).toString('hex'),
  };
}
function verifyEd25519(publicKeyHex: string, signatureHex: string, message: Buffer): boolean {
  try {
    const pub = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return crypto.verify(null, message, pub, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
/** Commit-id structure restated with JavaScript JSON; Rust float spelling is not reproduced. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}
const core4CommitId = (data: unknown, nonce: string, station: string, ts: number) =>
  sha3(`${JSON.stringify(sortKeys(data))}||${nonce}||${station}||${ts}||contribution`);
const u32le = (s: string) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
const core4CommitAuthMessage = (chain: string, net: string, station: string, commitId: string) =>
  Buffer.concat([Buffer.from('wrfcoin_commit_auth_v2'), u32le(chain), u32le(net), u32le(station), u32le(commitId), u32le('contribution')]);

// ---- fake core4 ---------------------------------------------------------------
const TOKENS = { contributor: 'g10-contributor-token', reader: 'g10-reader-token', operator: 'g10-operator-token' };
const CHAIN = '777';
const NETWORK = 'testnet';

interface Seen { method: string; path: string; headers: http.IncomingHttpHeaders; body: any }

function startFakeCore4() {
  const seen: Seen[] = [];
  const onChainStations = new Map<string, { station_id: string; owner_address: string; provenance_class: string; is_active: boolean; latitude: number; longitude: number }>();
  const commits = new Map<string, { station: string; contributor: string; revealed: boolean }>();
  const votes: Array<{ proposal: string; approve: boolean; voter: string }> = [];
  const proposals = [{ id: 'prop-g10', title: 'Raise nothing', status: 'Active', proposer: `0x${'c'.repeat(40)}` }];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any = undefined;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
      const u = new URL(req.url ?? '/', 'http://x');
      seen.push({ method: req.method ?? '', path: u.pathname, headers: req.headers, body });
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const send = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const err = (status: number, code: string, message: string) => send(status, { ok: false, error: { code, message } });
      const needs = (role: keyof typeof TOKENS) => {
        if (bearer !== TOKENS[role]) { err(403, 'FORBIDDEN', 'Invalid API token'); return false; }
        return true;
      };

      if (req.method === 'GET' && u.pathname === '/transactions/station/registrations') {
        if (!needs('operator')) return;
        return send(200, { ok: true, data: { stations: [...onChainStations.values()], has_more: false } });
      }
      if (req.method === 'POST' && u.pathname === '/transactions/contribution/commit') {
        if (!needs('contributor')) return;
        const st = onChainStations.get(body?.station_id);
        if (!st) return err(400, 'UNKNOWN_STATION', 'station not registered'); // what live core4 does for a non-activated mob- station
        if (st.owner_address !== body.contributor) return err(400, 'NOT_OWNER', 'contributor is not the station owner');
        const msg = core4CommitAuthMessage(CHAIN, NETWORK, body.station_id, body.commit_hash);
        if (!verifyEd25519(String(body.auth_pubkey), String(body.auth_signature), msg)) return err(400, 'BAD_AUTH', 'commit authorization does not verify');
        commits.set(body.commit_hash, { station: body.station_id, contributor: body.contributor, revealed: false });
        return send(200, { ok: true, data: { tx_id: `tx-commit-${body.commit_hash.slice(0, 8)}` } });
      }
      if (req.method === 'POST' && u.pathname === '/transactions/contribution/reveal') {
        if (!needs('contributor')) return;
        const c = commits.get(body?.commit_hash);
        if (!c) return err(422, 'NO_COMMIT', 'no such commit');
        if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) return err(422, 'BAD_PAYLOAD', 'payload must be a JSON object');
        const expected = core4CommitId(body.payload, String(body.nonce), String(body.station_id), Number(body.timestamp));
        if (expected !== body.commit_hash || c.station !== body.station_id) return err(422, 'HASH_MISMATCH', 'Reveal payload does not match commit_hash');
        c.revealed = true;
        return send(200, { ok: true, data: { tx_id: `tx-reveal-${body.commit_hash.slice(0, 8)}` } });
      }
      if (req.method === 'GET' && u.pathname.startsWith('/transactions/commit/') && u.pathname.endsWith('/status')) {
        if (!needs('reader')) return;
        return send(200, { ok: true, data: { status: 'revealed_pending_attestation', approvals: 0, rejections: 0, has_quorum: false } });
      }
      if (req.method === 'GET' && u.pathname.startsWith('/addresses/')) {
        if (!needs('reader')) return;
        return send(200, { ok: true, data: { balance: '0', earned_balance_total: '0' } });
      }
      if (req.method === 'GET' && u.pathname === '/governance/proposals') {
        return send(200, { total: proposals.length, offset: 0, limit: 100, proposals });
      }
      if (req.method === 'POST' && u.pathname === '/governance/vote') {
        if (!needs('contributor')) return;
        const voter = String(req.headers['x-voter-address'] ?? '');
        // core4 65134a64 state.rs:7163-7210: V1 message, signer key must derive the sender.
        const v1 = Buffer.from(`governance-vote-v1|${body?.proposal_id}|${body?.approve ? 'approve' : 'reject'}`);
        if (!verifyEd25519(String(body?.signer_public_key), String(body?.signature), v1)) return err(400, 'BAD_VOTE_SIG', 'Invalid governance vote signature');
        if (`0x${sha3(Buffer.from(String(body.signer_public_key), 'hex')).slice(0, 40)}` !== voter) return err(400, 'VOTER_MISMATCH', 'Signer public key does not match voter address');
        votes.push({ proposal: body.proposal_id, approve: body.approve, voter });
        return send(200, { ok: true, data: { tx_id: 'tx-vote' } });
      }
      return err(404, 'NOT_FOUND', 'unknown route');
    });
  });
  return new Promise<{ url: string; seen: Seen[]; onChainStations: typeof onChainStations; commits: typeof commits; votes: typeof votes; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, seen, onChainStations, commits, votes, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// ---- in-memory redis for the wallet-auth service -----------------------------
function fakeRedis() {
  const m = new Map<string, string>();
  return attachWalletNonceIssuer({
    set: async (k: string, v: string) => { m.set(k, v); return 'OK'; },
    get: async (k: string) => m.get(k) ?? null,
    del: async (k: string) => (m.delete(k) ? 1 : 0),
  });
}

function withDatabase(base: string, database: string): string {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

d('GO invitee path against a fake core4 and real PostgreSQL', () => {
  const RUN = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  const dbName = `g10_${process.pid}_${RUN}`;
  const wallet = keypair(`wallet-${RUN}`);
  const collect = keypair(`collect-${RUN}`);
  const envKeys = [
    'DATABASE_URL', 'DB_POOL_SIZE', 'CORE4_API_URL', 'JWT_SECRET', 'WRFCOIN_CHAIN_ID', 'WRFCOIN_NETWORK_ID',
    'WRFCOIN_CONTRIBUTOR_TOKEN', 'WRFCOIN_READER_TOKEN', 'WRFCOIN_OPERATOR_TOKEN',
    'WRFCOIN_GOVERNANCE_SIGNING_VERSION', 'WRFCOIN_GOVERNANCE_CHAIN_ID', 'WRFCOIN_GOVERNANCE_NETWORK_ID',
  ];
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  let admin: Pool;
  let shim: any;
  let core4: Awaited<ReturnType<typeof startFakeCore4>>;
  let app: express.Express;
  let jwt = '';
  let stationId = '';
  let prepared: any;
  let readingBody: Record<string, unknown>;
  const auth = () => ({ Authorization: `Bearer ${jwt}` });
  const contributionCalls = () => core4.seen.filter((s) => s.path.startsWith('/transactions/contribution/'));

  beforeAll(async () => {
    core4 = await startFakeCore4();
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const dbUrl = withDatabase(url as string, dbName);
    const ddl = new Pool({ connectionString: dbUrl, max: 1 });
    await ddl.query(`CREATE TABLE weather_stations (
      id serial PRIMARY KEY, station_id text NOT NULL UNIQUE, owner_address text NOT NULL, location text NOT NULL,
      is_active boolean DEFAULT true NOT NULL, created_at timestamp DEFAULT now() NOT NULL, updated_at timestamp DEFAULT now() NOT NULL,
      metadata jsonb, latitude double precision, longitude double precision, station_type text)`);
    for (const file of ['0025_mobile_station_registrations.sql', '0026_mobile_station_collect_pubkey.sql']) {
      await ddl.query(fs.readFileSync(path.join(__dirname, '../drizzle/migrations', file), 'utf8'));
    }
    await ddl.end();

    Object.assign(process.env, {
      DATABASE_URL: dbUrl, DB_POOL_SIZE: '3', CORE4_API_URL: core4.url,
      JWT_SECRET: 'g10-invitee-path-jwt-secret-0123456789abcdef',
      WRFCOIN_CHAIN_ID: CHAIN, WRFCOIN_NETWORK_ID: NETWORK,
      WRFCOIN_CONTRIBUTOR_TOKEN: TOKENS.contributor, WRFCOIN_READER_TOKEN: TOKENS.reader, WRFCOIN_OPERATOR_TOKEN: TOKENS.operator,
      WRFCOIN_GOVERNANCE_SIGNING_VERSION: '1', WRFCOIN_GOVERNANCE_CHAIN_ID: CHAIN, WRFCOIN_GOVERNANCE_NETWORK_ID: NETWORK,
    });
    /* eslint-disable @typescript-eslint/no-var-requires */
    shim = (await import('../database/db')).pool;
    const weatherRoutes = require('../server/routes/weather-routes');
    const oracleRoutes = require('../server/routes/oracle-submit-routes');
    const governanceRoutes = require('../server/routes/governance-routes');
    app = express();
    app.use(express.json());
    app.use('/api/weather', weatherRoutes.default ?? weatherRoutes);
    app.use('/api/oracle', oracleRoutes.default ?? oracleRoutes);
    app.use('/api/governance', governanceRoutes.default ?? governanceRoutes);
  });

  afterAll(async () => {
    try { await shim?.end(); } finally {
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin?.end();
      await core4?.close();
    }
  });

  // Fake coordinates only. The value is a LONG float (a phone float32 widened to f64), so the
  // independent 21.46 assertion must catch removal of 2-dp quantization (backend#1343).
  // Fake prepare/reveal hashing could still agree on the same raw JavaScript float.
  const LONG_FLOAT = 21.456789012345678;
  const reading = (id: string) => ({
    dataType: 'temperature', location: { stationId: id, lat: 10.0, lon: 20.0 }, value: LONG_FLOAT,
    timestamp: '2026-05-29T12:00:00.000Z', source: 'mobile',
  });

  it('1. wallet challenge + ed25519 login issues a wallet JWT', async () => {
    const { createWalletAuthService } = await import('../server/routes/wallet-auth-service');
    const service = createWalletAuthService({ redis: fakeRedis() as any, db: { execute: async () => ({ rows: [] }) } as any });
    const challenge = await service.generateNonce(wallet.address, 'ed25519');
    expect(challenge.scheme).toBe('ed25519');
    const tokens = await service.walletLogin({
      address: wallet.address, scheme: 'ed25519', pubkey: wallet.publicKey, nonce: challenge.nonce, signature: wallet.sign(challenge.message),
    } as any);
    jwt = tokens.jwt;
    expect(jwt.split('.')).toHaveLength(3);
    // a bad signature is refused (the login check is real)
    const c2 = await service.generateNonce(wallet.address, 'ed25519');
    await expect(service.walletLogin({
      address: wallet.address, scheme: 'ed25519', pubkey: wallet.publicKey, nonce: c2.nonce, signature: collect.sign(c2.message),
    } as any)).rejects.toThrow(/invalid wallet signature/);
  });

  it('2. per-phone station challenge + register creates a db_only station', async () => {
    const { buildMobileStationRegistrationMessage, buildStationOwnershipMessage } = await import('../shared/mobile-station-messages');
    const ch = await request(app).post('/api/weather/stations/mobile/challenge').set(auth()).send({});
    expect(ch.status).toBe(200);
    stationId = ch.body.stationId;
    expect(stationId).toMatch(/^mob-/);
    const cell = { latE1: 100, lonE1: 200 }; // the 0.1 degree cell of the fake chain coordinates
    const reg = await request(app).post('/api/weather/stations/mobile').set(auth()).send({
      nonce: ch.body.nonce, expiresAt: ch.body.expiresAt, publicKey: wallet.publicKey, collectPubkey: collect.publicKey, cell, deviceClass: 'phone-barometer',
      registrationSignature: wallet.sign(buildMobileStationRegistrationMessage({
        chainId: CHAIN, networkId: NETWORK, stationId, ownerAddress: wallet.address, collectPubkey: collect.publicKey,
        latE1: cell.latE1, lonE1: cell.lonE1, nonce: ch.body.nonce, expiresAt: ch.body.expiresAt,
      })),
      ownershipSignature: wallet.sign(buildStationOwnershipMessage({ chainId: CHAIN, networkId: NETWORK, stationId, ownerAddress: wallet.address })),
    });
    expect([200, 201]).toContain(reg.status);
    const status = await request(app).get('/api/weather/stations/mobile').set(auth());
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.body)).toContain('db_only');
  });

  it('3. submit-data before activation is 409 STATION_NOT_ACTIVE and core4 sees no contribution call', async () => {
    readingBody = reading(stationId);
    const res = await request(app).post('/api/oracle/submit-data').set(auth()).send({ ...readingBody, nonce: 'n0', auth_pubkey: collect.publicKey, auth_signature: '11'.repeat(64) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STATION_NOT_ACTIVE');
    expect(contributionCalls()).toHaveLength(0);
    const prep = await request(app).post('/api/oracle/submit-data/prepare').set(auth()).send(readingBody);
    expect(prep.status).toBe(409);
    expect(contributionCalls()).toHaveLength(0);
  });

  it('4. simulated chain sync (real list fetch + sync pass) marks the station on_chain', async () => {
    core4.onChainStations.set(stationId, {
      station_id: stationId, owner_address: wallet.address, provenance_class: 'real', is_active: true, latitude: 10.0, longitude: 20.0,
    });
    const { fetchChainStationList, runStationSyncOnce } = await import('../server/services/chain-station-sync');
    const summary = await runStationSyncOnce({
      listStations: () => fetchChainStationList(core4.url, TOKENS.operator),
      labels: {},
      pool: shim,
    });
    expect(summary.mobileOnChain).toBe(1);
    expect(summary.mobileRefused).toBe(0);
    const status = await request(app).get('/api/weather/stations/mobile').set(auth());
    expect(JSON.stringify(status.body)).toContain('on_chain');
  });

  it('5. prepare + submit-data forward a commit then a reveal that core4 accepts (commit id matches core4\'s formula)', async () => {
    const prep = await request(app).post('/api/oracle/submit-data/prepare').set(auth()).send(readingBody);
    expect(prep.status).toBe(200);
    prepared = prep.body;
    expect(contributionCalls()).toHaveLength(0); // prepare makes no core4 call
    const messageHex = prepared.authorization.messageHex as string;
    // the phone signs exactly the bytes prepare returned; they equal core4's own restatement
    expect(messageHex).toBe(core4CommitAuthMessage(CHAIN, NETWORK, stationId, prepared.commitId).toString('hex'));
    const res = await request(app).post('/api/oracle/submit-data').set(auth()).send({
      ...readingBody, nonce: prepared.nonce, auth_pubkey: collect.publicKey, auth_signature: collect.sign(Buffer.from(messageHex, 'hex')),
    });
    expect(res.status).toBe(200);
    expect(res.body.commitHash).toBe(prepared.commitId);
    const calls = contributionCalls();
    expect(calls.map((c) => c.path)).toEqual(['/transactions/contribution/commit', '/transactions/contribution/reveal']);
    expect(calls[1].body.commit_hash).toBe(calls[0].body.commit_hash);
    // the server credential is lent, never the caller's wallet JWT
    for (const c of calls) {
      expect(c.headers.authorization).toBe(`Bearer ${TOKENS.contributor}`);
      expect(c.headers.authorization).not.toContain(jwt);
    }
    expect(calls[0].body.contributor).toBe(wallet.address);
    expect(core4.commits.get(prepared.commitId)?.revealed).toBe(true);
    // #1343/#1372: this independent numeric assertion is the quantization control.
    // Fake HASH_MISMATCH covers request consistency, using JavaScript on both sides;
    // it cannot prove serde_json float fidelity. That evidence lives in the Rust golden suite.
    const revealed = calls[1].body.payload;
    expect(revealed.temperature_c).toBe(Math.round(LONG_FLOAT * 100) / 100); // 21.46, restated independently
    expect(revealed.temperature_c).not.toBe(LONG_FLOAT);
    expect(JSON.stringify(revealed)).not.toContain('21.4567');
  });

  it('6. a governance proposal is listed (core4 paginated object unwrapped)', async () => {
    const res = await request(app).get('/api/governance/proposals');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.proposals).toHaveLength(1);
    expect(res.body.proposals[0].id).toBe('prop-g10');
  });

  it('7. a V1-signed vote is forwarded with the Contributor token and x-voter-address = the wallet', async () => {
    const message = Buffer.from('governance-vote-v1|prop-g10|approve');
    const res = await request(app).post('/api/governance/proposals/prop-g10/vote').set(auth()).send({
      support: true, signer_public_key: wallet.publicKey, signature: wallet.sign(message),
    });
    expect(res.status).toBe(200);
    const vote = core4.seen.find((s) => s.path === '/governance/vote');
    expect(vote?.headers['x-voter-address']).toBe(wallet.address);
    expect(vote?.headers.authorization).toBe(`Bearer ${TOKENS.contributor}`);
    expect(vote?.body).toEqual({ proposal_id: 'prop-g10', approve: true, signer_public_key: wallet.publicKey, signature: wallet.sign(message) });
    expect(core4.votes).toEqual([{ proposal: 'prop-g10', approve: true, voter: wallet.address }]);
  });
});
