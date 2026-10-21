import { readFileSync } from 'node:fs';
import { createWeatherCommitRevealService } from '../server/routes/weather-commit-reveal-routes';

describe('backend#1313 migration replay guards (source contract)', () => {
  const sql = readFileSync('drizzle/migrations/0026_mobile_station_collect_pubkey.sql', 'utf8');
  it.each([
    'mobile_station_registrations_collect_pubkey_shape_check',
    'mobile_station_registrations_collect_not_owner_check',
  ])('guards constraint %s on the target relation before adding it', (name) => {
    expect(sql).toMatch(new RegExp(
      `IF NOT EXISTS\\s*\\([\\s\\S]*?FROM pg_constraint[\\s\\S]*?conrelid\\s*=\\s*'"mobile_station_registrations"'::regclass[\\s\\S]*?conname\\s*=\\s*'${name}'[\\s\\S]*?\\) THEN[\\s\\S]*?ADD CONSTRAINT "${name}"`
    ));
  });
});

describe('backend#1313 actual inline /api/weather/commit branch', () => {
  // Execute the exact production branch, injecting the real commit service.
  // Avoid booting unrelated routers, timers, secrets and database connections.
  const source = readFileSync('server/enhanced_unified_api_optimized.ts', 'utf8');
  const marker = "} else if (path === '/api/weather/commit' && req.method === 'POST') {";
  const start = source.indexOf(marker);
  const end = source.indexOf("} else if (path === '/api/weather/reveal'", start);
  if (start < 0 || end < 0) throw new Error('Production commit branch was not found');
  const branch = source.slice(start + marker.length, end);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const handleCommit = new AsyncFunction(
    'req', 'weatherCommitRevealService', 'realtimeWsHub', 'success', 'error', branch
  );

  it.each([`mob-${'a'.repeat(32)}`, `MOB-${'a'.repeat(32)}`, 'mob-arbitrary', ' mob-arbitrary ', 'ｍｏｂ-arbitrary'])
  ('refuses %s before database work or any core4 request', async (stationId) => {
    const db = { execute: jest.fn(async () => ({ rows: [{ id: 1 }] })) };
    const previousFetch = global.fetch;
    const fetchSpy = jest.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ height: 10, success: true }),
    })) as unknown as typeof fetch & jest.Mock;
    global.fetch = fetchSpy;
    const success = jest.fn();
    const error = jest.fn();
    try {
      await handleCommit({ body: {
        stationId, nonce: 'test-nonce',
        readings: [{ temperature_c: 20, pressure_hpa: 1000, humidity_percent: 50, timestamp: '2026-09-29T00:00:00Z' }],
      } }, createWeatherCommitRevealService({ db, core4BaseUrl: 'http://127.0.0.1:9999', core4Token: 'test-operator' }), null, success, error);
      expect(error).toHaveBeenCalledWith(400, expect.stringMatching(/mobile.*oracle|mob-.*oracle/i));
      expect(success).not.toHaveBeenCalled();
      expect(db.execute).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = previousFetch;
    }
  });
});


describe('backend#1315 inline commit rejects invalid station IDs before I/O', () => {
  const source = readFileSync('server/enhanced_unified_api_optimized.ts', 'utf8');
  const marker = "} else if (path === '/api/weather/commit' && req.method === 'POST') {";
  const start = source.indexOf(marker);
  const end = source.indexOf("} else if (path === '/api/weather/reveal'", start);
  if (start < 0 || end < 0) throw new Error('Production commit branch was not found');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const handle = new AsyncFunction('req', 'weatherCommitRevealService', 'realtimeWsHub', 'success', 'error', source.slice(start + marker.length, end));
  it.each([
    123, true, null, undefined, ['mob-hidden'], { stationId: 'mob-hidden' },
    '\u200Bmob-hidden', '\u200Dmob-hidden', 'WX\u2060-1', '\u202Emob-hidden', '\u00ADWX-1', '\uFEFFWX-1',
  ])('rejects %j with 400 and zero database/core4 calls', async (stationId) => {
    const db = { execute: jest.fn(async () => ({ rows: [{ id: 1 }] })) };
    const previousFetch = global.fetch;
    const fetchSpy = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ height: 10, success: true }) })) as unknown as typeof fetch & jest.Mock;
    global.fetch = fetchSpy;
    const success = jest.fn();
    const error = jest.fn();
    try {
      await handle({ body: { stationId, nonce: 'test-nonce', readings: [
        { temperature_c: 20, pressure_hpa: 1000, humidity_percent: 50, timestamp: '2026-09-29T00:00:00Z' },
      ] } }, createWeatherCommitRevealService({ db, core4BaseUrl: 'http://127.0.0.1:9999', core4Token: 'test-operator' }), null, success, error);
      expect(error).toHaveBeenCalledWith(400, expect.stringMatching(/stationId.*string.*format/i));
      expect(success).not.toHaveBeenCalled();
      expect(db.execute).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = previousFetch;
    }
  });
});
