/**
 * Public proof card (backend#229): GET /api/proofs/:commitId[?h=<height>] reads one station reading
 * and the block it landed in from the node, default OFF, 30/min per IP, process-wide node budget,
 * never a guessed height, never the raw station id.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

function redisFake() {
  const sets = new Map<string, Array<{ score: number; member: string }>>();
  return {
    status: 'ready', on: jest.fn(), connect: jest.fn(async () => undefined), quit: jest.fn(async () => 'OK'), disconnect: jest.fn(),
    ttl: jest.fn(async () => -2), exists: jest.fn(async () => 0), incr: jest.fn(async () => 1), expire: jest.fn(async () => 1),
    setex: jest.fn(async () => 'OK'), del: jest.fn(async () => 1),
    pipeline: () => {
      const ops: Array<() => unknown> = [];
      const p: any = {
        zremrangebyscore: (k: string, min: number, max: number) => { ops.push(() => { sets.set(k, (sets.get(k) || []).filter((e) => e.score < min || e.score > max)); return 0; }); return p; },
        zadd: (k: string, score: number, member: string) => { ops.push(() => { sets.set(k, [...(sets.get(k) || []), { score, member }]); return 1; }); return p; },
        zcard: (k: string) => { ops.push(() => (sets.get(k) || []).length); return p; },
        expire: () => { ops.push(() => 1); return p; },
        exec: async () => ops.map((op) => [null, op()]),
      };
      return p;
    },
  };
}
jest.mock('ioredis', () => jest.fn().mockImplementation(() => (global as any).__proofRedis));

type Reply = { status: number; json: unknown };
const READER = 'reader-token-for-proof-card-test';
// A raw id that carries a personal name: it must never reach the response.
const STATION = 'PWS-DULUTH-JANEDOE-01';
const COMMIT = 'c0'.repeat(32);
const OTHER_COMMIT = 'd1'.repeat(32);
const BLOCK_HASH = 'ab'.repeat(32);
const GENESIS = 'ee'.repeat(32);
const PUBKEY_BYTES = Array.from({ length: 32 }, (_, i) => i + 1);
const PUBKEY_HEX = PUBKEY_BYTES.map((b) => b.toString(16).padStart(2, '0')).join('');

const evidence = (over: Record<string, unknown> = {}, contributionOver: Record<string, unknown> = {}): Reply => ({
  status: 200,
  json: {
    commit_id: COMMIT,
    chain: { network_id: 'testnet', chain_id: '888', genesis_hash: GENESIS, height: 5000, finalized_height: 4990 },
    contribution: {
      commit_id: COMMIT, station_id: STATION, contribution_type: 'contribution', committed_at: null, commit_expires_at: null,
      reveal_expires_at: null, revealed_at: null, provenance_class: 'real', reward_amount: '250000000', reward_finalized: true,
      reward_status: 'paid', approvals: 0, rejections: 0, has_quorum: false, oracle_quorum: 2, status: 'reward_finalized',
      ...contributionOver,
    },
    reward: { address: '0x' + '9'.repeat(40), amount: '250000000', reason: `contribution:${COMMIT}`, station_id: STATION,
      provenance_class: 'real', reward_eligible: true, finalized: true },
    block: { height: 4900, hash: 'cd'.repeat(32), timestamp: 1_790_000_000, finalized: true },
    block_search: { scanned_from: 904, scanned_to: 5000, archive_consulted: false, complete: true },
    account: { address: '0x' + '9'.repeat(40), balance: '1', earned_balance_total: '250000000', credit_covers_reward: true },
    rewarded: true,
    rewarded_blocker: null,
    ...over,
  },
});

const observationItem = (height: number, commit = COMMIT) => ({
  commit_id: commit, station_id: STATION, height, observed_at: 1_789_999_000,
  values: { temperature_c: 4.5, humidity_percent: 81, pressure_hpa: 1012.3, wind_speed_ms: 3.1, precipitation_mm: 0, dewpoint_c: 1.4 },
  provenance_class: 'real', attestation: { approvals: 2, has_quorum: true },
});

describe('GET /api/proofs/:commitId', () => {
  const envKeys = ['CORE4_API_URL', 'WRFCOIN_READER_TOKEN', 'PROOF_CARDS_ENABLED', 'TRUSTED_PROXIES', 'DISABLE_FILE_LOG_TRANSPORTS', 'PROOF_CARDS_UPSTREAM_MAX_PER_MIN'];
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  let seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  let evidenceReply: Reply;
  let blockReply: Reply;
  /** Observations: items by height; `after` cursor semantics follow core4 (64 heights per call). */
  let chainItems: Array<ReturnType<typeof observationItem>> = [];
  let observationsStatus = 200;
  let upstream: http.Server;
  let clock = 1_000_000;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ url: req.url ?? '', headers: req.headers });
      let reply: Reply;
      if (url.pathname.endsWith('/reward-evidence')) reply = evidenceReply;
      else if (url.pathname.startsWith('/chain/block/')) reply = blockReply;
      else if (url.pathname.endsWith('/observations')) {
        const after = Number(url.searchParams.get('after') ?? 0);
        const upTo = Math.min(after + 64, 5000);
        const items = chainItems.filter((i) => i.height > after && i.height <= upTo);
        reply = observationsStatus === 200
          ? { status: 200, json: { ok: true, data: { items, limit: 100, next_after: upTo, next_offset: 0, has_more: upTo < 5000, chain_height: 5000 } } }
          : { status: observationsStatus, json: { ok: false, error: { code: 'INTERNAL', message: 'boom' } } };
      } else reply = { status: 404, json: { ok: false } };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.json));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  });
  afterAll(async () => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await new Promise<void>((r) => upstream.close(() => r()));
  });
  beforeEach(() => {
    jest.resetModules();
    (global as any).__proofRedis = redisFake();
    Object.assign(process.env, {
      CORE4_API_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      WRFCOIN_READER_TOKEN: READER,
      PROOF_CARDS_ENABLED: 'true',
      TRUSTED_PROXIES: '127.0.0.1,::1',
      DISABLE_FILE_LOG_TRANSPORTS: 'true',
    });
    delete process.env.PROOF_CARDS_UPSTREAM_MAX_PER_MIN;
    seen = [];
    evidenceReply = evidence();
    blockReply = { status: 200, json: { ok: true, data: { height: 4890, hash: BLOCK_HASH, timestamp: '2026-10-31T12:00:00+00:00',
      producer_pubkey: PUBKEY_BYTES, producer_sig: [1, 2], transactions: [] } } };
    chainItems = [observationItem(4890)];
    observationsStatus = 200;
    clock = 1_000_000;
  });
  afterEach(() => { delete (global as any).__proofRedis; });

  function makeApp(deps: Record<string, unknown> = {}) {
    const { createProofCardRouter } = require('../server/routes/proof-card-routes');
    const app = express();
    app.use('/api/proofs', createProofCardRouter({ now: () => clock, ...deps }));
    return app;
  }
  const paths = () => seen.map((s) => new URL(s.url, 'http://x').pathname);

  it('builds the card from chain reads only: reading, block it landed in, reward, chain identity', async () => {
    const r = await request(makeApp()).get(`/api/proofs/${COMMIT}?h=4890`).set('Authorization', 'Bearer caller-token-must-not-travel');
    expect(r.status).toBe(200);
    const { stationAlias } = require('../server/utils/station-alias');
    expect(r.body).toEqual({
      commitId: COMMIT,
      stationAlias: stationAlias(STATION),
      status: 'reward_finalized',
      reading: { observedAt: new Date(1_789_999_000 * 1000).toISOString(), temperatureC: 4.5, humidityPct: 81, pressureHpa: 1012.3,
        windSpeedMs: 3.1, precipitationMm: 0, dewpointC: 1.4, provenanceClass: 'real' },
      inclusion: { status: 'included', block: { height: 4890, hash: BLOCK_HASH, timestamp: '2026-10-31T12:00:00.000Z',
        producerPubkey: PUBKEY_HEX, finalized: true } },
      attestation: { approvals: 2, hasQuorum: true, quorum: 2 },
      reward: { status: 'paid', amountBaseUnits: '250000000', finalized: true, rewarded: true, blocker: null,
        block: { height: 4900, hash: 'cd'.repeat(32), finalized: true } },
      chain: { networkId: 'testnet', chainId: '888', genesisHash: GENESIS, height: 5000, finalizedHeight: 4990 },
    });
    // The hint is one exact window; the server Reader bearer only.
    expect(paths()).toEqual([
      `/transactions/contributions/${COMMIT}/reward-evidence`,
      `/transactions/contributions/${STATION}/observations`,
      '/chain/block/4890',
    ]);
    expect(new URL(seen[1].url, 'http://x').searchParams.get('after')).toBe('4889');
    for (const s of seen) expect(s.headers.authorization).toBe(`Bearer ${READER}`);
    const text = JSON.stringify(r.body).toLowerCase();
    expect(text).not.toContain(STATION.toLowerCase());
    expect(text).not.toContain('9'.repeat(40)); // no payout address on a reading card
    expect(text).not.toContain(READER);
  });

  it('finds the reveal without a hint by walking back from the reward block', async () => {
    chainItems = [observationItem(4800), observationItem(4801, OTHER_COMMIT)];
    blockReply = { status: 200, json: { ok: true, data: { height: 4800, hash: BLOCK_HASH, timestamp: '2026-10-31T11:00:00Z', producer_pubkey: PUBKEY_BYTES } } };
    const r = await request(makeApp()).get(`/api/proofs/${COMMIT}`);
    expect(r.status).toBe(200);
    expect(r.body.inclusion.block.height).toBe(4800);
    const afters = seen.filter((s) => s.url.includes('/observations')).map((s) => new URL(s.url, 'http://x').searchParams.get('after'));
    expect(afters).toEqual(['4836', '4772']);
  });

  it('uses the reveal height core4 still holds when there is no hint', async () => {
    evidenceReply = evidence({ reward: null, block: null, rewarded: false, rewarded_blocker: 'no_reward_record' },
      { status: 'revealed_attested', revealed_at: 4890, reward_status: 'not_evaluated', reward_finalized: false, reward_amount: null });
    const r = await request(makeApp()).get(`/api/proofs/${COMMIT}`);
    expect(r.status).toBe(200);
    expect(r.body.inclusion.status).toBe('included');
    expect(r.body.reward).toEqual({ status: 'not_evaluated', amountBaseUnits: null, finalized: false, rewarded: false,
      blocker: 'no_reward_record', block: null });
  });

  it('says not_located (never a guessed height) when the bounded scan does not find the reveal', async () => {
    chainItems = [observationItem(10)];
    const r = await request(makeApp()).get(`/api/proofs/${COMMIT}`);
    expect(r.status).toBe(200);
    expect(r.body.inclusion).toEqual({ status: 'not_located', block: null });
    expect(r.body.reading).toBeNull();
    expect(paths().filter((p) => p.endsWith('/observations')).length).toBeLessThanOrEqual(4);
    expect(paths()).not.toContain('/chain/block/10');
  });

  it('says not_revealed for a commit with no reveal yet and does not scan', async () => {
    evidenceReply = evidence({ reward: null, block: null, rewarded: false, rewarded_blocker: 'no_reward_record' },
      { status: 'committed_pending_reveal', reward_status: 'not_evaluated', reward_finalized: false });
    const r = await request(makeApp()).get(`/api/proofs/${COMMIT}?h=4890`);
    expect(r.status).toBe(200);
    expect(r.body.inclusion).toEqual({ status: 'not_revealed', block: null });
    expect(paths()).toEqual([`/transactions/contributions/${COMMIT}/reward-evidence`]);
  });

  it('keeps the chain-proven height but leaves the block fields null when the block read fails', async () => {
    blockReply = { status: 500, json: { ok: false } };
    const r = await request(makeApp()).get(`/api/proofs/${COMMIT}?h=4890`);
    expect(r.status).toBe(200);
    expect(r.body.inclusion.block).toEqual({ height: 4890, hash: null, timestamp: null, producerPubkey: null, finalized: true });
  });

  it('reports an all-zero (unsigned) producer key as unknown', async () => {
    blockReply = { status: 200, json: { ok: true, data: { height: 4890, hash: BLOCK_HASH, timestamp: '2026-10-31T12:00:00Z', producer_pubkey: new Array(32).fill(0) } } };
    const r = await request(makeApp()).get(`/api/proofs/${COMMIT}?h=4890`);
    expect(r.body.inclusion.block.producerPubkey).toBeNull();
  });

  it('answers 404 for a commit the chain does not know, and for a forecast commit', async () => {
    evidenceReply = { status: 404, json: { ok: false, data: null, error: { code: 'NOT_FOUND', message: 'no commit' } } };
    let r = await request(makeApp()).get(`/api/proofs/${COMMIT}`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('PROOF_NOT_FOUND');
    evidenceReply = evidence({}, { contribution_type: 'forecast' });
    r = await request(makeApp()).get(`/api/proofs/${COMMIT}`);
    expect(r.status).toBe(404);
    expect(paths().filter((p) => p.endsWith('/observations'))).toEqual([]);
  });

  it('answers 502 (never a 200 with made-up data) when the node fails or drifts', async () => {
    evidenceReply = { status: 500, json: { ok: false } };
    expect((await request(makeApp()).get(`/api/proofs/${COMMIT}`)).status).toBe(502);
    evidenceReply = evidence({ commit_id: OTHER_COMMIT });
    expect((await request(makeApp()).get(`/api/proofs/${COMMIT}`)).status).toBe(502);
    evidenceReply = evidence();
    observationsStatus = 500;
    expect((await request(makeApp()).get(`/api/proofs/${COMMIT}?h=4890`)).status).toBe(502);
  });

  it('validates the commit id and the only query parameter before asking the node', async () => {
    const app = makeApp();
    for (const bad of [COMMIT.toUpperCase(), COMMIT.slice(1), `0x${COMMIT}`, 'x'.repeat(64)]) {
      expect((await request(app).get(`/api/proofs/${bad}`)).status).toBe(400);
    }
    for (const q of ['h=0', 'h=-1', 'h=abc', 'h=1&x=1', 'x=1', 'h=1&h=2']) {
      expect((await request(app).get(`/api/proofs/${COMMIT}?${q}`)).status).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it('is 404 while PROOF_CARDS_ENABLED is not exactly true, and 503 without a Reader credential', async () => {
    process.env.PROOF_CARDS_ENABLED = 'TRUE';
    expect((await request(makeApp()).get(`/api/proofs/${COMMIT}`)).status).toBe(404);
    process.env.PROOF_CARDS_ENABLED = 'true';
    const r = await request(makeApp({ readerToken: () => undefined })).get(`/api/proofs/${COMMIT}`);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('CORE4_READER_CREDENTIAL_UNCONFIGURED');
    expect(seen).toEqual([]);
  });

  it('caches a settled card and coalesces concurrent reads into one load', async () => {
    const app = makeApp();
    await Promise.all([1, 2, 3].map(() => request(app).get(`/api/proofs/${COMMIT}?h=4890`)));
    expect(paths().filter((p) => p.endsWith('/reward-evidence')).length).toBe(1);
    clock += 200_000;
    await request(app).get(`/api/proofs/${COMMIT}?h=4890`);
    expect(paths().filter((p) => p.endsWith('/reward-evidence')).length).toBe(1);
    clock += 200_000;
    await request(app).get(`/api/proofs/${COMMIT}?h=4890`);
    expect(paths().filter((p) => p.endsWith('/reward-evidence')).length).toBe(2);
  });

  it('caps card loads process-wide and answers 503 with Retry-After without asking the node', async () => {
    process.env.PROOF_CARDS_UPSTREAM_MAX_PER_MIN = '2';
    const app = makeApp({ rateLimit: (_req: unknown, _res: unknown, next: () => void) => next() });
    expect((await request(app).get(`/api/proofs/${COMMIT}?h=1`)).status).toBe(200);
    expect((await request(app).get(`/api/proofs/${COMMIT}?h=2`)).status).toBe(200);
    const before = seen.length;
    const r = await request(app).get(`/api/proofs/${COMMIT}?h=3`);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('UPSTREAM_BUDGET_EXHAUSTED');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(seen.length).toBe(before);
  });

  it('limits each client to 30 reads per minute with the shared limiter', async () => {
    const app = makeApp();
    for (let i = 0; i < 30; i += 1) expect((await request(app).get(`/api/proofs/${COMMIT}?h=4890`)).status).toBe(200);
    const r = await request(app).get(`/api/proofs/${COMMIT}?h=4890`);
    expect(r.status).toBe(429);
  });
});

describe('capabilities: proofCards', () => {
  const saved = process.env.PROOF_CARDS_ENABLED;
  afterAll(() => { if (saved === undefined) delete process.env.PROOF_CARDS_ENABLED; else process.env.PROOF_CARDS_ENABLED = saved; });

  it('is unavailable (not_wired) while the route is off and configured (unverified, never operational) when on', async () => {
    const { createCapabilitiesRouter } = require('../server/routes/capabilities-routes');
    const app = express();
    app.use('/api', createCapabilitiesRouter());
    process.env.PROOF_CARDS_ENABLED = 'false';
    expect((await request(app).get('/api/capabilities')).body.features.proofCards).toEqual({ status: 'unavailable', reasonCode: 'not_wired' });
    process.env.PROOF_CARDS_ENABLED = 'true';
    expect((await request(app).get('/api/capabilities')).body.features.proofCards).toEqual({ status: 'configured', reasonCode: 'unverified' });
  });
});
