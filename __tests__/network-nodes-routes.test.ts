/**
 * GET /api/network/nodes (owner demo queue 2026-11-01 item 3): producers, bonded nodes and attesters, all
 * read from the node; default OFF; one snapshot per 60 s; unavailable sections say so, never a guessed 0.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

type Reply = { status: number; json: unknown };
const READER = 'reader-token-for-network-nodes-test';
const N5 = '1e5180e7add06bbe07cf2698ec9d4882ae1cfb54b13de67bae92a4e625ceec1a';
const MANGO = '1f7a4ec7699e361390cb89297a2b4441e676b17c95b122063eda25b1f64e0f1e';
const STRANGER = 'ab'.repeat(32);
const bytes = (hex: string) => hex.match(/../g)!.map((b) => parseInt(b, 16));
const BOND_A = 'a1'.repeat(32);
const BOND_B = 'b2'.repeat(32);
const BOND_GONE = 'c3'.repeat(32);
const PAYOUT_A = 'c37f' + '00'.repeat(18);

describe('GET /api/network/nodes', () => {
  const envKeys = ['CORE4_API_URL', 'WRFCOIN_READER_TOKEN', 'NETWORK_NODES_READ_ENABLED', 'NETWORK_NODES_BOND_IDS', 'DISABLE_FILE_LOG_TRANSPORTS'];
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  let seen: Array<{ path: string; auth: string | undefined }> = [];
  let tip = 100;
  let producerAt: (h: number) => string | null = () => N5;
  let failing = new Set<string>();
  let nodeRoutes = true;
  let upstream: http.Server;
  let clock = 1_000_000;

  const reply = (path: string): Reply => {
    if ([...failing].some((f) => path.startsWith(f))) return { status: 500, json: { ok: false } };
    if (path === '/network/info') return { status: 200, json: { network_id: 'testnet', chain_id: '888', chain_height: tip, genesis_hash: 'ee'.repeat(32) } };
    let m;
    if ((m = /^\/chain\/block\/(\d+)$/.exec(path))) {
      const h = Number(m[1]);
      const key = producerAt(h);
      return { status: 200, json: { ok: true, data: { height: h, hash: 'cd'.repeat(32), timestamp: `2026-10-31T12:${String(h % 60).padStart(2, '0')}:00+00:00`, producer_pubkey: key ? bytes(key) : new Array(32).fill(0) } } };
    }
    if ((m = /^\/node\/bonds\/([0-9a-f]{64})$/.exec(path))) {
      if (!nodeRoutes) return { status: 404, json: { ok: false } };
      const id = m[1];
      const known = id === BOND_A || id === BOND_B;
      return { status: 200, json: {
        height: String(tip), activation_height: '0', epoch: '3', deployment_id: id, status: known ? 'REGISTERED' : 'UNKNOWN',
        principal_base_units: known ? '25036000000' : null, escrow_balance_base_units: known ? '25036000000' : null,
        escrow_locked_base_units: null, escrow_spendable_base_units: null, jailed: known ? false : null,
        registration: known ? { registered_epoch: 1, last_change_epoch: 1, exit_effective_height: null, principal_units: 25036000000,
          binding: { service_alias: id === BOND_A ? 'ws-node' : 'laptop', payout_account: id === BOND_A ? bytes(PAYOUT_A) : new Array(20).fill(7), owner_account: new Array(20).fill(1) } } : null,
      } };
    }
    if ((m = /^\/node\/settlement\/(\d+)$/.exec(path))) {
      const e = Number(m[1]);
      if (e === 3) return { status: 200, json: { epoch: '3', status: 'OPEN', payouts_base_units: {}, provisional_base_units: { [BOND_A]: '18962962944' } } };
      if (e === 2) return { status: 200, json: { epoch: '2', status: 'PAID', payouts_base_units: { [BOND_A]: '18962962944', [BOND_GONE]: '1' } } };
      return { status: 200, json: { epoch: String(e), status: 'UNKNOWN', payouts_base_units: null } };
    }
    if ((m = /^\/addresses\/(0x[0-9a-f]{40})$/.exec(path))) {
      return { status: 200, json: { ok: true, data: { address: m[1], earned_balance_total: m[1] === `0x${PAYOUT_A}` ? '37925925888' : '5' } } };
    }
    if (path === '/transactions/oracle/status') return { status: 200, json: { oracle_set: ['oracle-n5', 'oracle-ws'], oracle_quorum: 2 } };
    return { status: 404, json: { ok: false } };
  };

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      seen.push({ path, auth: req.headers.authorization });
      const r = reply(path);
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
      NETWORK_NODES_READ_ENABLED: 'true',
      NETWORK_NODES_BOND_IDS: `${BOND_B}, not-an-id`,
      DISABLE_FILE_LOG_TRANSPORTS: 'true',
    });
    seen = [];
    tip = 100;
    producerAt = (h) => (h % 4 === 0 ? MANGO : N5);
    failing = new Set();
    nodeRoutes = true;
    clock = 1_000_000;
  });

  function makeApp() {
    const { createNetworkNodesRouter } = require('../server/routes/network-nodes-routes');
    const app = express();
    app.use('/api/network', createNetworkNodesRouter({ now: () => clock, rateLimit: (_q: unknown, _s: unknown, next: () => void) => next() }));
    return app;
  }

  it('counts each producer from the block producer keys and names them from the core4 genesis roster', async () => {
    const r = await request(makeApp()).get('/api/network/nodes');
    expect(r.status).toBe(200);
    expect(r.body.chain).toEqual({ networkId: 'testnet', chainId: '888', height: 100, status: 'ok' });
    const p = r.body.producers;
    expect(p.status).toBe('ok');
    expect(p.window).toEqual({ fromHeight: 37, toHeight: 100, read: 64, unreadable: 0, unsigned: 0 });
    const byId = Object.fromEntries(p.members.map((m: any) => [m.producerId, m]));
    expect(byId['mango-mini'].blocksInWindow).toBe(16);
    expect(byId['n5-node-a'].blocksInWindow).toBe(48);
    expect(byId['n5-node-a'].lastBlock).toEqual({ height: 99, time: '2026-10-31T12:39:00.000Z' });
    expect(byId['mango-mini'].lastBlock.height).toBe(100);
    // Seated in the roster, no block in the window: zero blocks, never "unknown".
    expect(byId['producer-standby']).toMatchObject({ blocksInWindow: 0, lastBlock: null });
    expect(byId['n5-node-a'].earnedTotal).toBe('5');
    expect(p.unrostered).toEqual([]);
    for (const s of seen) expect(s.auth).toBe(`Bearer ${READER}`);
  });

  it('lists a key that signs blocks but is not in the roster, and counts unsigned blocks', async () => {
    producerAt = (h) => (h === 100 ? STRANGER : h === 99 ? null : N5);
    const r = await request(makeApp()).get('/api/network/nodes');
    expect(r.body.producers.unrostered).toEqual([{ publicKey: STRANGER, blocksInWindow: 1, lastBlock: { height: 100, time: '2026-10-31T12:40:00.000Z' } }]);
    expect(r.body.producers.window.unsigned).toBe(1);
  });

  it('finds bonds in settlement epochs and the configured list, keeps only REGISTERED ones, with paid totals', async () => {
    const r = await request(makeApp()).get('/api/network/nodes');
    const b = r.body.bonded;
    expect(b.status).toBe('ok');
    expect(b.epoch).toBe(3);
    expect(b.discovery).toEqual({ settlementEpochs: [3, 2, 1, 0], configured: 1 });
    expect(b.nodes.map((n: any) => n.deploymentId).sort()).toEqual([BOND_A, BOND_B].sort());
    const a = b.nodes.find((n: any) => n.deploymentId === BOND_A);
    expect(a).toEqual({
      deploymentId: BOND_A, alias: 'ws-node', principal: '25036000000', escrowBalance: '25036000000', jailed: false,
      registeredEpoch: 1, exitEffectiveHeight: null, payoutAddress: `0x${PAYOUT_A}`, earnedTotal: '37925925888',
      lastPayout: { epoch: 3, status: 'PROVISIONAL', amount: '18962962944' },
    });
    expect(b.nodes.find((n: any) => n.deploymentId === BOND_B).lastPayout).toBeNull();
    expect(r.body.attesters).toEqual({ status: 'ok', quorum: 2, ids: ['oracle-n5', 'oracle-ws'] });
  });

  it('marks a section unavailable (no rows, no zeros) when its reads fail, and keeps the others', async () => {
    nodeRoutes = false;
    failing = new Set(['/transactions/oracle', '/addresses/']);
    const r = await request(makeApp()).get('/api/network/nodes');
    expect(r.status).toBe(200);
    expect(r.body.bonded).toEqual({ status: 'unavailable', epoch: null, discovery: { settlementEpochs: [], configured: 0 }, nodes: [] });
    expect(r.body.attesters).toEqual({ status: 'unavailable', quorum: null, ids: [] });
    expect(r.body.producers.members.every((m: any) => m.earnedTotal === null)).toBe(true);
    expect(r.body.producers.status).toBe('ok');
  });

  it('reports unreadable blocks instead of counting them, and 502 when the node answers nothing', async () => {
    failing = new Set(['/chain/block/100']);
    let r = await request(makeApp()).get('/api/network/nodes');
    expect(r.body.producers.window).toMatchObject({ read: 63, unreadable: 1 });
    failing = new Set(['/']);
    r = await request(makeApp()).get('/api/network/nodes');
    expect(r.status).toBe(502);
  });

  it('reads only new blocks on the next rebuild and serves one snapshot per minute', async () => {
    const app = makeApp();
    await request(app).get('/api/network/nodes');
    const blockReads = () => seen.filter((s) => s.path.startsWith('/chain/block/')).length;
    expect(blockReads()).toBe(64);
    await request(app).get('/api/network/nodes');
    expect(blockReads()).toBe(64);
    tip = 102;
    clock += 61_000;
    const r = await request(app).get('/api/network/nodes');
    expect(blockReads()).toBe(66);
    expect(r.body.producers.window).toMatchObject({ fromHeight: 39, toHeight: 102, read: 64 });
  });

  it('is 404 while switched off, 503 without a Reader credential, 400 with a query', async () => {
    process.env.NETWORK_NODES_READ_ENABLED = 'yes';
    expect((await request(makeApp()).get('/api/network/nodes')).status).toBe(404);
    process.env.NETWORK_NODES_READ_ENABLED = 'true';
    delete process.env.WRFCOIN_READER_TOKEN;
    expect((await request(makeApp()).get('/api/network/nodes')).status).toBe(503);
    process.env.WRFCOIN_READER_TOKEN = READER;
    expect((await request(makeApp()).get('/api/network/nodes?x=1')).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('roster matches core4 genesis_producer_pins.rs byte for byte', () => {
    const { TESTNET_GENESIS_PRODUCER_ROSTER } = require('../server/routes/network-nodes-routes');
    expect(TESTNET_GENESIS_PRODUCER_ROSTER).toEqual([
      { producerId: 'n5-node-a', publicKey: N5, payoutAddress: '0x680d51f7543ca70029866956376306d47ce60ed0' },
      { producerId: 'producer-standby', publicKey: 'cd77a1f439ec6896727f585e81228795c8008c8f8db7763bb9c42afa8d119aaa', payoutAddress: '0x39ee2e595a55c71256282fe5c42a398594985b1a' },
      { producerId: 'mango-mini', publicKey: MANGO, payoutAddress: '0xc536d2026661522cb8631b3c723d4af43784a990' },
    ]);
  });
});

describe('capabilities: networkNodesRead', () => {
  const saved = process.env.NETWORK_NODES_READ_ENABLED;
  afterAll(() => { if (saved === undefined) delete process.env.NETWORK_NODES_READ_ENABLED; else process.env.NETWORK_NODES_READ_ENABLED = saved; });
  it('is unavailable while off and configured (unverified) when on', async () => {
    const { createCapabilitiesRouter } = require('../server/routes/capabilities-routes');
    const app = express();
    app.use('/api', createCapabilitiesRouter());
    process.env.NETWORK_NODES_READ_ENABLED = 'false';
    expect((await request(app).get('/api/capabilities')).body.features.networkNodesRead).toEqual({ status: 'unavailable', reasonCode: 'not_wired' });
    process.env.NETWORK_NODES_READ_ENABLED = 'true';
    expect((await request(app).get('/api/capabilities')).body.features.networkNodesRead).toEqual({ status: 'configured', reasonCode: 'unverified' });
  });
});
