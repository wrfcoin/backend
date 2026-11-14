/**
 * GET /api/public/network-status (owner decision 2026-11-01, public status page): aggregate numbers read
 * from the node; default OFF; one snapshot per 60 s; unavailable sections say so; nothing private leaks.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

type Reply = { status: number; json: unknown };
const READER = 'reader-token-for-network-status-test';
const PEER_ID = '12D3KooWSecretPeerIdShouldNeverLeak';
const GENESIS = 'ee'.repeat(32);
const PAYOUT = '0x680d51f7543ca70029866956376306d47ce60ed0';
const KEY = '1e5180e7add06bbe07cf2698ec9d4882ae1cfb54b13de67bae92a4e625ceec1a';
const NOW = Date.parse('2026-11-14T12:00:00Z');
const STEP_S = 77;

describe('GET /api/public/network-status', () => {
  const envKeys = ['CORE4_API_URL', 'WRFCOIN_READER_TOKEN', 'NETWORK_STATUS_READ_ENABLED', 'NETWORK_STATUS_TARGET_BLOCK_SECONDS', 'DISABLE_FILE_LOG_TRANSPORTS'];
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  let seen: Array<{ path: string; query: string; auth: string | undefined }> = [];
  let tip = 25_000;
  /** Block time of height h: the tip was made 40 s before NOW, one block every STEP_S before that. */
  let timeOf: (h: number) => number = (h) => NOW - 40_000 - (25_000 - h) * STEP_S * 1000;
  let failing = new Set<string>();
  let infoIds: { chain_id: unknown; network_id: unknown } = { chain_id: '888', network_id: 'testnet' };
  let producerIds = ['n5-node-a', 'mango-mini', 'producer-standby'];
  let paidEpoch = 19;
  let upstream: http.Server;
  let clock = NOW;

  const iso = (t: number) => new Date(t).toISOString().replace('.000Z', '+00:00');

  const reply = (path: string, q: URLSearchParams): Reply => {
    if ([...failing].some((f) => path.startsWith(f))) return { status: 500, json: { ok: false } };
    if (path === '/network/info') {
      return { status: 200, json: { chain_height: tip, ...infoIds, genesis_hash: GENESIS, local_peer_id: PEER_ID, peer_count: 2, sync_status: 'synced' } };
    }
    if (path === '/chain/blocks') {
      const limit = Number(q.get('limit') ?? 20);
      const blocks = [];
      for (let h = Math.max(1, tip - limit + 1); h <= tip; h += 1) blocks.push({ height: h, timestamp: iso(timeOf(h)), hash: 'ab'.repeat(32), tx_count: 1 });
      return { status: 200, json: { ok: true, data: { blocks, chain_height: tip, returned: blocks.length } } };
    }
    let m;
    if ((m = /^\/chain\/block\/(\d+)$/.exec(path))) {
      const h = Number(m[1]);
      return { status: 200, json: { ok: true, data: { height: h, timestamp: iso(timeOf(h)), producer_pubkey: [] } } };
    }
    if (path === '/network/producers') {
      const w = Number(q.get('window'));
      return { status: 200, json: { ok: true, data: {
        tip_height: tip, authorizes_height: tip + 1,
        producers: [
          { producer_id: producerIds[0], public_key: KEY, payout_address: PAYOUT, last_produced_height: tip, blocks_in_window: 40 },
          { producer_id: producerIds[1], public_key: 'cd'.repeat(32), payout_address: PAYOUT, last_produced_height: tip - 1, blocks_in_window: 24 },
          { producer_id: producerIds[2], public_key: 'ef'.repeat(32), payout_address: PAYOUT, last_produced_height: null, blocks_in_window: 0 },
        ],
        activity_window: { requested: w, from_height: tip - w + 1, to_height: tip, blocks_scanned: w },
      } } };
    }
    if (path === `/node/bonds/${'0'.repeat(64)}`) return { status: 200, json: { epoch: '21', status: 'UNKNOWN', deployment_id: '0'.repeat(64) } };
    if ((m = /^\/node\/settlement\/(\d+)$/.exec(path))) {
      const e = Number(m[1]);
      const status = e === 21 ? 'OPEN' : e === 20 ? 'PROVISIONAL' : e === paidEpoch ? 'PAID' : 'UNKNOWN';
      return { status: 200, json: { epoch: String(e), status, payouts_base_units: { ['a1'.repeat(32)]: '5' } } };
    }
    if (path === '/network/upgrade') {
      return { status: 200, json: {
        status: 'none', tip_height: tip, blocks_remaining: null, activation_height: null, notice: null,
        scheduled: { status: 'ready', entries: [
          { feature: 'passkey_p256_auth', activation_height: 3400, active_at_next: true, blocks_remaining: 0 },
          { feature: 'governance_proposals', activation_height: 27000, active_at_next: false, blocks_remaining: 27000 - tip },
          { feature: 'transfer_fee_burn', activation_height: 26000, active_at_next: false, blocks_remaining: 26000 - tip },
          { feature: 'Bad Feature<script>', activation_height: 26500, active_at_next: false, blocks_remaining: 1 },
        ] },
      } };
    }
    return { status: 404, json: { ok: false } };
  };

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ path: url.pathname, query: url.search, auth: req.headers.authorization });
      const r = reply(url.pathname, url.searchParams);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
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
    Object.assign(process.env, {
      CORE4_API_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      WRFCOIN_READER_TOKEN: READER,
      NETWORK_STATUS_READ_ENABLED: 'true',
      DISABLE_FILE_LOG_TRANSPORTS: 'true',
    });
    delete process.env.NETWORK_STATUS_TARGET_BLOCK_SECONDS;
    seen = [];
    tip = 25_000;
    timeOf = (h) => NOW - 40_000 - (25_000 - h) * STEP_S * 1000;
    failing = new Set();
    infoIds = { chain_id: '888', network_id: 'testnet' };
    producerIds = ['n5-node-a', 'mango-mini', 'producer-standby'];
    paidEpoch = 19;
    clock = NOW;
  });

  function makeApp(opts: { readerToken?: () => string | undefined; producerAliases?: Record<string, string> } = {}) {
    const { createNetworkStatusRouter } = require('../server/routes/public-network-status-routes');
    const app = express();
    app.use('/api/public/network-status', createNetworkStatusRouter({ now: () => clock, rateLimit: (_q: unknown, _s: unknown, next: () => void) => next(), ...opts }));
    return app;
  }

  it('reports block pace, producers online, peers, node pay and pending upgrades', async () => {
    const r = await request(makeApp()).get('/api/public/network-status');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=30');
    expect(r.body.network).toEqual({ status: 'ok', chainId: '888', networkId: 'testnet', syncStatus: 'synced', peerCount: 2 });
    const b = r.body.blocks;
    expect(b).toMatchObject({ status: 'ok', targetBlockSeconds: 77, tipHeight: 25_000, lastBlockAgeSeconds: 40 });
    expect(b.lastBlockAt).toBe('2026-11-14T11:59:20.000Z');
    // Hour: the tip at -40 s, then every 77 s: heights within 3600 s = floor((3600-40)/77)+1 = 47.
    expect(b.lastHour).toEqual({ produced: 47, expected: 46 });
    // Day: floor((86400-40)/77)+1 = 1122.
    expect(b.lastDay).toEqual({ produced: 1122, expected: 1122, atLeast: false });
    expect(b.longestGapSeconds).toEqual({ value: 77, overBlocks: 100 });
    expect(r.body.producers).toEqual({
      status: 'ok', windowBlocks: 64, total: 3, online: 2,
      members: [
        { label: 'producer 1', online: true, blocksInWindow: 40, lastHeight: 25_000 },
        { label: 'producer 2', online: true, blocksInWindow: 24, lastHeight: 24_999 },
        { label: 'producer 3', online: false, blocksInWindow: 0, lastHeight: null },
      ],
    });
    expect(r.body.nodePay).toEqual({ status: 'ok', currentEpoch: 21, lastPaidEpoch: 19, epochsScanned: [21, 20, 19] });
    expect(r.body.upgrades).toEqual({
      status: 'ok', activeFeatures: 1, signedNotice: null,
      pending: [
        { feature: 'transfer_fee_burn', activationHeight: 26_000, blocksRemaining: 1000 },
        { feature: 'governance_proposals', activationHeight: 27_000, blocksRemaining: 2000 },
      ],
    });
    // Every node read uses the backend's own Reader credential.
    expect(seen.every((s) => s.auth === `Bearer ${READER}`)).toBe(true);
  });

  it('never returns peer ids, genesis hash, keys, payout addresses or hosts', async () => {
    const r = await request(makeApp()).get('/api/public/network-status');
    const text = JSON.stringify(r.body);
    for (const secret of [PEER_ID, GENESIS, KEY, PAYOUT, '0x', READER, '127.0.0.1', 'deployment']) expect(text).not.toContain(secret);
  });

  it('publishes producers only by approved alias or opaque "producer N", never the configured producer_id', async () => {
    const sensitive = ['tony-macbook.local', '192.0.2.17', 'jane.doe.home', 'worker.internal.example', '2001:db8::1', 'ct101'];
    producerIds = [sensitive[0], sensitive[1], sensitive[2]];
    const r = await request(makeApp()).get('/api/public/network-status');
    expect(r.body.producers.members.map((m: { label: string }) => m.label)).toEqual(['producer 1', 'producer 2', 'producer 3']);
    const text = JSON.stringify(r.body);
    for (const v of sensitive) expect(text).not.toContain(v);

    // An approved alias is used; an alias that is malformed or mimics "producer N" falls back to opaque.
    producerIds = ['n5-node-a', 'mango-mini', 'jane.doe.home'];
    const aliased = await request(makeApp({ producerAliases: { 'n5-node-a': 'Producer A', 'mango-mini': 'producer 3', 'x': 'bad<alias>' } })).get('/api/public/network-status');
    expect(aliased.body.producers.members.map((m: { label: string }) => m.label)).toEqual(['Producer A', 'producer 2', 'producer 3']);
    expect(JSON.stringify(aliased.body)).not.toContain('jane');
  });

  it('the default alias allowlist is explicit and holds only well-formed aliases', () => {
    const { PUBLIC_PRODUCER_ALIASES, PUBLIC_ALIAS_RE } = require('../server/routes/public-network-status-routes');
    expect(Object.isFrozen(PUBLIC_PRODUCER_ALIASES)).toBe(true);
    for (const alias of Object.values(PUBLIC_PRODUCER_ALIASES) as string[]) {
      expect(alias).toMatch(PUBLIC_ALIAS_RE);
      expect(alias).not.toMatch(/^producer \d+$/i);
    }
  });

  it('publishes only chain 888 / "testnet", never a configured network or chain id', async () => {
    for (const ids of [
      { chain_id: '888-tony-laptop', network_id: 'tony-home-lab' },
      { chain_id: '10.0.0.5', network_id: '192.0.2.17' },
      { chain_id: 1337, network_id: 'staging.internal.example' },
      { chain_id: { x: 1 }, network_id: ['testnet'] },
    ]) {
      infoIds = ids;
      const r = await request(makeApp()).get('/api/public/network-status');
      expect(r.body.network).toMatchObject({ status: 'ok', chainId: null, networkId: null });
      const text = JSON.stringify(r.body);
      for (const v of ['tony', '10.0.0.5', '192.0.2.17', 'internal', '1337']) expect(text).not.toContain(v);
    }
    infoIds = { chain_id: 888, network_id: 'testnet' };
    const ok = await request(makeApp()).get('/api/public/network-status');
    expect(ok.body.network).toMatchObject({ chainId: '888', networkId: 'testnet' });
  });

  it('node pay is partial, not "none recently", when a newer epoch read fails', async () => {
    // Epoch 19 (the PAID one) fails; 21 and 20 read: the newest paid epoch cannot be known.
    failing = new Set(['/node/settlement/19']);
    const a = await request(makeApp()).get('/api/public/network-status');
    expect(a.body.nodePay).toEqual({ status: 'partial', currentEpoch: 21, lastPaidEpoch: null, epochsScanned: [21, 20, 18, 17, 16, 15, 14], epochsUnread: [19] });
    // A failed newer epoch (20) before an older PAID result (19): still partial.
    failing = new Set(['/node/settlement/20']);
    const b = await request(makeApp()).get('/api/public/network-status');
    expect(b.body.nodePay).toEqual({ status: 'partial', currentEpoch: 21, lastPaidEpoch: null, epochsScanned: [21, 19], epochsUnread: [20] });
    // A failed epoch older than the newest PAID one does not matter.
    failing = new Set(['/node/settlement/17']);
    const c = await request(makeApp()).get('/api/public/network-status');
    expect(c.body.nodePay).toEqual({ status: 'ok', currentEpoch: 21, lastPaidEpoch: 19, epochsScanned: [21, 20, 19] });
  });

  it('node pay says no paid epoch only when all eight were read', async () => {
    paidEpoch = -1;
    const r = await request(makeApp()).get('/api/public/network-status');
    expect(r.body.nodePay).toEqual({ status: 'ok', currentEpoch: 21, lastPaidEpoch: null, epochsScanned: [21, 20, 19, 18, 17, 16, 15, 14] });
    failing = new Set(['/node/settlement/15']);
    const p = await request(makeApp()).get('/api/public/network-status');
    expect(p.body.nodePay).toMatchObject({ status: 'partial', lastPaidEpoch: null, epochsUnread: [15] });
  });

  it('is 404 unless NETWORK_STATUS_READ_ENABLED=true, and makes no node reads', async () => {
    process.env.NETWORK_STATUS_READ_ENABLED = 'false';
    const r = await request(makeApp()).get('/api/public/network-status');
    expect(r.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('is 503 without a Reader credential and rejects query parameters', async () => {
    const none = await request(makeApp({ readerToken: () => undefined })).get('/api/public/network-status');
    expect(none.status).toBe(503);
    expect(none.body.error.code).toBe('CORE4_READER_CREDENTIAL_UNCONFIGURED');
    const q = await request(makeApp()).get('/api/public/network-status?window=2048');
    expect(q.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('builds one snapshot per 60 s for every caller, and the warm day search reads few blocks', async () => {
    const app = makeApp();
    await request(app).get('/api/public/network-status');
    const first = seen.length;
    expect(first).toBeLessThan(40);
    await request(app).get('/api/public/network-status');
    expect(seen.length).toBe(first);
    // One new block, 77 s later: the day search starts from the remembered floor.
    tip += 1;
    clock += 77_000;
    seen = [];
    const r = await request(app).get('/api/public/network-status');
    expect(r.body.blocks.tipHeight).toBe(25_001);
    expect(r.body.blocks.lastBlockAgeSeconds).toBe(40);
    expect(r.body.blocks.lastDay.produced).toBe(1122);
    expect(seen.filter((s) => s.path.startsWith('/chain/block/')).length).toBeLessThanOrEqual(3);
  });

  it('says unavailable for a section whose reads fail, never 0', async () => {
    failing = new Set(['/network/producers', '/node/', '/network/upgrade']);
    const r = await request(makeApp()).get('/api/public/network-status');
    expect(r.status).toBe(200);
    expect(r.body.producers).toEqual({ status: 'unavailable' });
    expect(r.body.nodePay).toEqual({ status: 'unavailable' });
    expect(r.body.upgrades).toEqual({ status: 'unavailable' });
    expect(r.body.blocks.status).toBe('ok');
  });

  it('a stalled chain shows the real block age and an empty last hour', async () => {
    timeOf = (h) => NOW - 3 * 3600_000 - (tip - h) * STEP_S * 1000;
    const r = await request(makeApp()).get('/api/public/network-status');
    expect(r.body.blocks.lastBlockAgeSeconds).toBe(3 * 3600);
    expect(r.body.blocks.lastHour.produced).toBe(0);
    expect(r.body.blocks.lastDay.produced).toBe(Math.floor((86400 - 3 * 3600) / 77) + 1);
  });

  it('an hour the 100-block list cannot cover is unknown, not a short count', async () => {
    timeOf = (h) => NOW - (tip - h) * 10_000; // 10 s blocks: 100 blocks span < 17 minutes
    const r = await request(makeApp()).get('/api/public/network-status');
    expect(r.body.blocks.lastHour.produced).toBeNull();
    // The day holds more than the 4000-block search span.
    expect(r.body.blocks.lastDay).toMatchObject({ produced: 4001, atLeast: true });
  });

  it('is 502 when the node answers nothing', async () => {
    failing = new Set(['/']);
    const r = await request(makeApp()).get('/api/public/network-status');
    expect(r.status).toBe(502);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('honours NETWORK_STATUS_TARGET_BLOCK_SECONDS for the expected counts', async () => {
    process.env.NETWORK_STATUS_TARGET_BLOCK_SECONDS = '60';
    const r = await request(makeApp()).get('/api/public/network-status');
    expect(r.body.blocks).toMatchObject({ targetBlockSeconds: 60, lastHour: { expected: 60 }, lastDay: { expected: 1440 } });
  });
});
