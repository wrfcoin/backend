import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';

const mockFetch = jest.fn<(path: string, opts?: any) => Promise<any>>();
jest.mock('../../shared/core4-route-client.js', () => ({
  extractCore4Data: (p: any) => p,
  fetchCore4Json: (...a: [string, any?]) => mockFetch(...a),
  sendCore4Error: (res: any, r: any) => res.status(r?.status || 502).json({ success: false }),
  sendCore4Unavailable: (res: any) => res.status(503).json({ success: false }),
  toNullable: (v: any) => v ?? null,
}));

const mockLoggerWarn = jest.fn();
jest.mock('../../server/utils/logger', () => ({
  logger: { warn: (...a: unknown[]) => mockLoggerWarn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const explorer = require('../../server/routes/explorer-routes.js');
const blockchain = require('../../server/routes/blockchain-routes.js');

function handler(router: any, path: string): Function {
  const layer = router.stack.find((l: any) => l.route && l.route.path === path);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function res(): any {
  const r: any = { statusCode: 200, body: null, headers: {} };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.set = (k: string, v: string) => { r.headers[k] = v; return r; };
  return r;
}
const req = (query: any = {}, headers: any = {}): any => ({ params: {}, query, headers, body: {}, method: 'GET', url: '/' });

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
function chainBlocks(tipAgeSec: number, count = 30, spacingSec = 60, height = 500) {
  return Array.from({ length: count }, (_, i) => ({
    height: height - i,
    hash: `0x${height - i}`,
    prev_block_hash: '0x0',
    timestamp: new Date(NOW - (tipAgeSec + i * spacingSec) * 1000).toISOString(),
    tx_count: 0,
  }));
}
function upstream(over: { blocks?: any[]; network?: any; faucet?: any; blocksFail?: boolean } = {}) {
  mockFetch.mockImplementation(async (path: string) => {
    if (path === '/chain/blocks') {
      return over.blocksFail ? { ok: false, status: 503, payload: {} } : { ok: true, status: 200, payload: { blocks: over.blocks ?? chainBlocks(30), chain_height: 500 } };
    }
    if (path === '/network/info') return { ok: true, status: 200, payload: over.network ?? { peer_count: 4 } };
    if (path.startsWith('/addresses/')) return over.faucet ?? { ok: true, status: 200, payload: { balance: '1000000' } };
    return { ok: false, status: 404, payload: {} };
  });
}

describe('GET /api/explorer/summary (B1)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] });
    mockFetch.mockReset();
    explorer.resetExplorerSummaryCacheForTests();
    delete process.env.EXPLORER_FAUCET_ADDRESS;
    delete process.env.EXPLORER_SUMMARY_TTL_MS;
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
    delete process.env.WRFCOIN_READER_TOKEN;
  });
  afterEach(() => jest.useRealTimers());

  it('reports height, tip age, blocks/min, producing, peers and faucet funded', async () => {
    process.env.EXPLORER_FAUCET_ADDRESS = 'wrf1faucetaddress';
    upstream();
    const r = res();
    await handler(explorer, '/summary')(req(), r);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ state: 'ok', status: 'producing', height: 500, tipAgeSeconds: 30, blocksPerMinute: 1, blocksSampled: 30, peerCount: 4, faucetFunded: true, stallThresholdSeconds: 180 });
    expect(r.headers['Cache-Control']).toBe('public, max-age=10');
  });

  it('is stalled once the tip is older than 180 s (node-dashboard CHAIN_STALL_SECONDS), producing at 180', async () => {
    upstream({ blocks: chainBlocks(181) });
    let r = res();
    await handler(explorer, '/summary')(req(), r);
    expect(r.body.status).toBe('stalled');
    explorer.resetExplorerSummaryCacheForTests();
    upstream({ blocks: chainBlocks(180) });
    r = res();
    await handler(explorer, '/summary')(req(), r);
    expect(r.body.status).toBe('producing');
  });

  it('faucetFunded is null when no faucet account is configured, false for a 404 or zero balance', async () => {
    upstream();
    let r = res();
    await handler(explorer, '/summary')(req(), r);
    expect(r.body.faucetFunded).toBeNull();
    process.env.EXPLORER_FAUCET_ADDRESS = 'wrf1faucetaddress';
    explorer.resetExplorerSummaryCacheForTests();
    upstream({ faucet: { ok: false, status: 404, payload: {} } });
    r = res(); await handler(explorer, '/summary')(req(), r);
    expect(r.body.faucetFunded).toBe(false);
    explorer.resetExplorerSummaryCacheForTests();
    upstream({ faucet: { ok: true, status: 200, payload: { balance: '0' } } });
    r = res(); await handler(explorer, '/summary')(req(), r);
    expect(r.body.faucetFunded).toBe(false);
  });

  it('exposes no address, location or operator detail', async () => {
    process.env.EXPLORER_FAUCET_ADDRESS = 'wrf1faucetaddress';
    upstream({ network: { peer_count: 4, peers: ['10.0.0.9:9000'], node_id: 'secret' } });
    const r = res();
    await handler(explorer, '/summary')(req(), r);
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/wrf1faucetaddress|10\.0\.0\.9|secret|0x|lat|lon/i);
    expect(Object.keys(r.body).sort()).toEqual(['blocksPerMinute', 'blocksSampled', 'faucetFunded', 'generatedAt', 'height', 'peerCount', 'stallThresholdSeconds', 'state', 'status', 'tipAgeSeconds']);
  });

  it('SINGLE FLIGHT: concurrent callers share one upstream fan-out', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    mockFetch.mockImplementation(async (path: string) => {
      await gate;
      if (path === '/chain/blocks') return { ok: true, status: 200, payload: { blocks: chainBlocks(30), chain_height: 500 } };
      return { ok: true, status: 200, payload: { peer_count: 2 } };
    });
    const out = [res(), res(), res(), res(), res()];
    const pending = out.map((r) => handler(explorer, '/summary')(req(), r));
    release();
    await Promise.all(pending);
    expect(mockFetch).toHaveBeenCalledTimes(2); // /chain/blocks + /network/info, once
    expect(new Set(out.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  it('CACHE: a second call inside the TTL makes no upstream call; after the TTL it refreshes; TTL never below 10 s', async () => {
    process.env.EXPLORER_SUMMARY_TTL_MS = '1'; // clamped up to 10 s
    upstream();
    await handler(explorer, '/summary')(req(), res());
    const first = mockFetch.mock.calls.length;
    await handler(explorer, '/summary')(req(), res());
    expect(mockFetch.mock.calls.length).toBe(first);
    jest.setSystemTime(NOW + 9_000);
    await handler(explorer, '/summary')(req(), res());
    expect(mockFetch.mock.calls.length).toBe(first);
    jest.setSystemTime(NOW + 10_500);
    await handler(explorer, '/summary')(req(), res());
    expect(mockFetch.mock.calls.length).toBe(first * 2);
  });

  it('DEGRADED: a failing upstream returns 200 state=degraded (never a 500) and is cached for the TTL', async () => {
    upstream({ blocksFail: true });
    let r = res();
    await handler(explorer, '/summary')(req(), r);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ state: 'degraded', status: 'unknown', height: null, tipAgeSeconds: null, blocksPerMinute: null, peerCount: null, faucetFunded: null });
    const calls = mockFetch.mock.calls.length;
    await handler(explorer, '/summary')(req(), res());
    expect(mockFetch.mock.calls.length).toBe(calls);
  });

  it('DEGRADED: a thrown upstream (network error) is also 200 degraded', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = res();
    await handler(explorer, '/summary')(req(), r);
    expect(r.statusCode).toBe(200);
    expect(r.body.state).toBe('degraded');
  });

  it('null height falls back to the tip (500) and null peer_count is unknown, not 0', async () => {
    mockFetch.mockImplementation(async (path: string) =>
      path === '/chain/blocks'
        ? { ok: true, status: 200, payload: { blocks: chainBlocks(30), chain_height: null } }
        : { ok: true, status: 200, payload: { peer_count: null } });
    const r = res();
    await handler(explorer, '/summary')(req(), r);
    expect(r.body).toMatchObject({ state: 'ok', height: 500, peerCount: null });
  });

  it.each([null, '', '   ', true, false, '0x1f', '0xdeadbeefdeadbeefdeadbeef', '12.5', -3, 1.5, 'abc', [], {}, 2 ** 60])(
    'count %p is unknown (never coerced to a number)',
    async (bad) => {
      explorer.resetExplorerSummaryCacheForTests();
      mockFetch.mockImplementation(async (path: string) =>
        path === '/chain/blocks'
          ? { ok: true, status: 200, payload: { blocks: chainBlocks(30), chain_height: bad } }
          : { ok: true, status: 200, payload: { peer_count: bad } });
      const r = res();
      await handler(explorer, '/summary')(req(), r);
      expect(r.body.peerCount).toBeNull();
      expect(r.body.height).toBe(500); // tip, not the bad chain_height
    },
  );

  it('zero is a valid known count; decimal strings parse', async () => {
    mockFetch.mockImplementation(async (path: string) =>
      path === '/chain/blocks'
        ? { ok: true, status: 200, payload: { blocks: chainBlocks(30, 30, 60, 500), chain_height: '0' } }
        : { ok: true, status: 200, payload: { peer_count: 0 } });
    const r = res();
    await handler(explorer, '/summary')(req(), r);
    expect(r.body).toMatchObject({ height: 0, peerCount: 0 });
    explorer.resetExplorerSummaryCacheForTests();
    mockFetch.mockImplementation(async (path: string) =>
      path === '/chain/blocks'
        ? { ok: true, status: 200, payload: { blocks: chainBlocks(30), chain_height: '500' } }
        : { ok: true, status: 200, payload: { peer_count: '7' } });
    const r2 = res();
    await handler(explorer, '/summary')(req(), r2);
    expect(r2.body).toMatchObject({ height: 500, peerCount: 7 });
  });

  it('LOG CANARY: a failing upstream never writes its error text, coordinates or operator markers to the log', async () => {
    mockLoggerWarn.mockClear();
    const canary = 'operator-marker-7f3a lat=12.345678 lon=-98.765432 http://10.9.8.7:8556/secret';
    mockFetch.mockRejectedValue(new Error(canary));
    await handler(explorer, '/summary')(req(), res());
    explorer.resetExplorerSummaryCacheForTests();
    mockFetch.mockResolvedValue({ ok: false, status: 503, payload: { error: canary } });
    await handler(explorer, '/summary')(req(), res());
    expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(mockLoggerWarn.mock.calls);
    expect(logged).not.toMatch(/operator-marker|12\.345678|98\.765432|10\.9\.8\.7|secret|ECONN/);
    expect(mockLoggerWarn.mock.calls[0][1]).toEqual({ code: 'EXPLORER_UPSTREAM_ERROR', upstreamStatus: null });
    expect(mockLoggerWarn.mock.calls[1][1]).toEqual({ code: 'EXPLORER_UPSTREAM_STATUS', upstreamStatus: 503 });
  });

  it('a failing peer read leaves the rest of the summary intact (peerCount null)', async () => {
    mockFetch.mockImplementation(async (path: string) =>
      path === '/chain/blocks' ? { ok: true, status: 200, payload: { blocks: chainBlocks(30), chain_height: 500 } } : { ok: false, status: 500, payload: {} });
    const r = res();
    await handler(explorer, '/summary')(req(), r);
    expect(r.body).toMatchObject({ state: 'ok', height: 500, peerCount: null });
  });
});

describe('GET /api/blockchain/blocks anonymous bounds (B1)', () => {
  const blocks = (n: number) => Array.from({ length: n }, (_, i) => ({ height: n - 1 - i, hash: `0x${i}`, prev_block_hash: '0x0', timestamp: '2026-01-01T00:00:00.000Z', tx_count: 0 }));
  beforeEach(() => {
    mockFetch.mockReset();
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
    delete process.env.WRFCOIN_READER_TOKEN;
    mockFetch.mockImplementation(async (_p: string, o: any) => ({ ok: true, status: 200, payload: { blocks: blocks(Math.min(Number(o?.query?.limit ?? 10), 1000)), chain_height: 5000 } }));
  });
  const upstreamLimit = () => Number(mockFetch.mock.calls[0][1].query.limit);

  it('limit is capped at 30 for anonymous callers', async () => {
    const r = res();
    await handler(blockchain, '/blocks')(req({ limit: '100' }), r);
    expect(r.body.pagination.limit).toBe(30);
    expect(r.body.data.length).toBeLessThanOrEqual(30);
    expect(upstreamLimit()).toBeLessThanOrEqual(30);
  });
  it('offset cannot reach deeper than the 30 most recent blocks: limit + offset <= 30', async () => {
    for (const [limit, offset] of [['10', '5000'], ['30', '1'], ['1', '999999'], ['20', '20']]) {
      mockFetch.mockClear();
      const r = res();
      await handler(blockchain, '/blocks')(req({ limit, offset }), r);
      expect(r.body.pagination.limit + r.body.pagination.offset).toBeLessThanOrEqual(30);
      expect(upstreamLimit()).toBeLessThanOrEqual(30);
    }
  });
  it('an in-bounds page is unchanged (limit 10, offset 10)', async () => {
    const r = res();
    await handler(blockchain, '/blocks')(req({ limit: '10', offset: '10' }), r);
    expect(r.body.pagination).toMatchObject({ limit: 10, offset: 10 });
    expect(upstreamLimit()).toBe(20);
  });
  it('the operator and Reader bearers keep the original limit (100) and unbounded offset', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'op-token-for-test';
    process.env.WRFCOIN_READER_TOKEN = 'reader-token-for-test';
    for (const token of ['op-token-for-test', 'reader-token-for-test']) {
      mockFetch.mockClear();
      const r = res();
      await handler(blockchain, '/blocks')(req({ limit: '100', offset: '200' }, { authorization: `Bearer ${token}` }), r);
      expect(r.body.pagination).toMatchObject({ limit: 100, offset: 200 });
      expect(upstreamLimit()).toBe(300);
    }
  });
});
