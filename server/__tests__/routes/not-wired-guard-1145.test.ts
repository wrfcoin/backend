/**
 * backend#1145 — the live entrypoint served Math.random() data at
 * GET /api/stats, /api/security/metrics and /api/currency/*, and the
 * safeMounted achievement / privacy / n8n controllers always reached their
 * "Mock … for development" branches because nothing on the live entrypoint
 * injects req.storage / req.n8nService.
 *
 *   1. requireWiredStorage answers the honest-gap 501 envelope when the
 *      dependency is absent and passes through when it is present.
 *   2. buildLiveStats reads core4 + weather_stations, lists sourceless
 *      fields under `unavailable`, and refuses (503) instead of estimating
 *      when core4 does not answer.
 *   3. Acceptance gate: no Math.random() call and no MOCK_DATA_GENERATORS
 *      remain in the entrypoint; each guarded route file installs the guard
 *      before its controller routes.
 *
 * This file is .ts on purpose: __tests__/server-js-suites-combined.test.ts
 * re-runs exactly the eight legacy `server/__tests__/**.test.js` suites as a
 * contamination control and pins that count; a ninth .js file there would
 * break the control's premise rather than the code it protects.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { requireWiredStorage, notWiredEnvelope, NOT_WIRED_CODE } = require('../../middleware/require-wired-storage');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildLiveStats, NO_SOURCE } = require('../../utils/live-stats');

function fakeRes() {
  const res: any = { statusCode: null, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

describe('requireWiredStorage (backend#1145)', () => {
  it('answers 501 with the honest-gap envelope when the dependency is absent', () => {
    const guard = requireWiredStorage('privacy', { see: 'wrfcoin/backend#1145' });
    const res = fakeRes();
    const next = jest.fn();

    guard({}, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(501);
    expect(res.body).toMatchObject({
      success: false,
      unavailable: true,
      error: { code: NOT_WIRED_CODE, capability: 'privacy', see: 'wrfcoin/backend#1145' },
    });
    expect(res.body.reason).toMatch(/no storage implementation is injected/);
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('checks the named dependency (n8nService) rather than storage when asked', () => {
    const guard = requireWiredStorage('n8n', { needs: 'n8nService' });
    const res = fakeRes();
    guard({ storage: {} }, res, jest.fn());
    expect(res.statusCode).toBe(501);
    expect(res.body.reason).toMatch(/no n8nService implementation/);
  });

  it('passes through untouched when a real implementation is injected', () => {
    const guard = requireWiredStorage('achievement');
    const res = fakeRes();
    const next = jest.fn();
    guard({ storage: { getAllAchievements: async () => [] } }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  it('envelope shape mirrors backend#1118 sendNotWired', () => {
    const env = notWiredEnvelope({ capability: 'x.y', message: 'm', details: 'd' });
    expect(Object.keys(env).sort()).toEqual(['error', 'reason', 'success', 'timestamp', 'unavailable']);
    expect(env.error).toEqual({ code: 'NOT_IMPLEMENTED', message: 'm', capability: 'x.y', details: 'd' });
  });
});

describe('buildLiveStats (backend#1145)', () => {
  const core4 = {
    '/blockchain': { ok: true, status: 200, payload: { success: true, data: { height: 4321, pending_transactions: 2 } } },
    '/network/info': { ok: true, status: 200, payload: { success: true, data: { peer_count: 3, chain_id: 'wrf-testnet', sync_status: 'synced' } } },
    '/mining/stats': { ok: true, status: 200, payload: { success: true, data: { chain_height: 4321, total_transactions: 99, avg_block_time_secs: 12.5, difficulty: 7 } } },
  };
  const extractCore4Data = (payload: any) => (payload && 'data' in payload ? payload.data : null);
  const toNullable = (v: unknown) => (v === undefined ? null : v);

  it('reads real chain figures and the station count, and lists sourceless fields as unavailable', async () => {
    const result = await buildLiveStats({
      fetchCore4Json: async (p: string) => (core4 as any)[p],
      extractCore4Data,
      toNullable,
      countActiveStations: async () => 5,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      currentBlockHeight: 4321,
      totalTransactions: 99,
      pendingTransactions: 2,
      peerCount: 3,
      chainId: 'wrf-testnet',
      syncStatus: 'synced',
      avgBlockTimeSecs: 12.5,
      difficulty: 7,
      weatherStations: 5,
    });
    for (const field of ['totalUsers', 'price', 'marketCap', 'activeValidators', 'networkHashRate', 'totalEarnings']) {
      expect(result.data).not.toHaveProperty(field);
      expect(result.data.unavailable[field]).toBe(NO_SOURCE[field]);
    }
    expect(result.data.source.weatherStations).toBe('weather_stations WHERE is_active');
  });

  it('refuses with 503 instead of estimating when a core4 route does not answer', async () => {
    const result = await buildLiveStats({
      fetchCore4Json: async (p: string) => (p === '/mining/stats' ? { ok: false, status: 502, payload: null } : (core4 as any)[p]),
      extractCore4Data,
      toNullable,
      countActiveStations: async () => 5,
    });

    expect(result).toMatchObject({ ok: false, status: 503, message: 'Blockchain node unavailable' });
    expect(result.details.failedRoutes).toEqual([{ route: '/mining/stats', status: 502 }]);
    expect(result).not.toHaveProperty('data');
  });

  it('reports the station count as unavailable, not zero, when the database query fails', async () => {
    const result = await buildLiveStats({
      fetchCore4Json: async (p: string) => (core4 as any)[p],
      extractCore4Data,
      toNullable,
      countActiveStations: async () => { throw new Error('pool exhausted'); },
    });

    expect(result.ok).toBe(true);
    expect(result.data.weatherStations).toBeNull();
    expect(result.data.unavailable.weatherStations).toMatch(/pool exhausted/);
    expect(result.data.source.weatherStations).toBeNull();
  });
});

describe('acceptance gate (backend#1145)', () => {
  const serverDir = path.join(__dirname, '..', '..');
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('the live entrypoint has no Math.random() call and no mock data generators', () => {
    const src = stripComments(fs.readFileSync(path.join(serverDir, 'enhanced_unified_api_optimized.ts'), 'utf8'));
    expect(src).not.toMatch(/Math\.random\(/);
    expect(src).not.toMatch(/MOCK_DATA_GENERATORS|memoizedOperations/);
    expect(src).toMatch(/buildLiveStats\(/);
    expect(src).toMatch(/notWired\(\s*'security\.metrics'/);
    expect(src).toMatch(/notWired\(\s*'currency\.rates'/);
  });

  it.each([
    ['routes/achievementRoutes.ts', 'requireWiredStorage(\'achievement\'', 'router.get(\'/:userId\''],
    ['routes/privacyRoutes.ts', 'requireWiredStorage(\'privacy\'', 'router.get(\'/status\''],
    ['routes/n8n-routes.js', 'requireWiredStorage(\'n8n\', { needs: \'n8nService\'', 'router.get(\'/status\''],
  ])('%s installs the guard before its first controller route', (file: string, guard: string, firstRoute: string) => {
    const src = fs.readFileSync(path.join(serverDir, file), 'utf8');
    const guardAt = src.indexOf(guard);
    const routeAt = src.indexOf(firstRoute);
    expect(guardAt).toBeGreaterThan(-1);
    expect(routeAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(routeAt);
  });

  it('privacy keeps the core4-backed /stealth-address route in front of the guard', () => {
    const src = fs.readFileSync(path.join(serverDir, 'routes/privacyRoutes.ts'), 'utf8');
    expect(src.indexOf('\'/stealth-address\'')).toBeLessThan(src.indexOf('requireWiredStorage(\'privacy\''));
  });
});
