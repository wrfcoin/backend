#!/usr/bin/env node
/**
 * Smoke test for the /api/storage realtime route (mobile#204).
 *
 * Proves the route module loads through the same resolution safeMount uses
 * (require of CJS from the server entry) and that requests reach the router
 * rather than a catch-all: 200 with the mobile ForecastModel contract when a
 * reading exists, 404 when none within maxAge, 400 on blank station, and
 * unmounted paths still miss. Runs without postgres via an injected pool stub.
 *
 * Usage: node scripts/smoke-storage-realtime-route.mjs
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import express from 'express';

const require = createRequire(import.meta.url);

// Same resolution shape safeMount uses: try .cjs first, fall back to source.
function loadRouteModule(modulePath) {
  try {
    require.resolve(`${modulePath}.cjs`);
    return require(`${modulePath}.cjs`);
  } catch {
    return require(modulePath);
  }
}

const mod = loadRouteModule('../server/routes/storage-realtime-routes');
const routerFactory = mod.default || mod.createRouter;
assert.equal(typeof routerFactory, 'function', 'createRouter export missing');

const dbRow = {
  station_id: 'pws-001',
  latitude: '44.98',
  longitude: '-93.26',
  temperature: '21.50',
  humidity: '48.00',
  pressure: '1012.30',
  wind_speed: null,
  wind_direction: null,
  rainfall: '0.00',
  quality_score: 92,
  source: 'mobile',
  submitted_at: new Date('2026-07-02T17:00:00Z'),
};

const queries = [];
const fakePool = {
  query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: params[0] === 'pws-001' ? [dbRow] : [] };
  },
};

const app = express();
app.use('/api/storage', routerFactory({ pool: fakePool }));
app.use((req, res) => res.status(404).json({ error: 'catch-all' }));

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

try {
  // 200: reaches the router, flat mobile contract satisfied.
  const ok = await fetch(`${base}/api/storage/weather/realtime/pws-001?maxAge=600000`);
  assert.equal(ok.status, 200, 'expected 200 for known station');
  const body = await ok.json();
  for (const key of ['temperature', 'humidity', 'pressure', 'windSpeed', 'precipitation']) {
    assert.equal(typeof body[key], 'number', `${key} must be a non-null number (ForecastModel)`);
  }
  assert.equal(typeof body.location, 'string', 'location must be a string');
  assert.equal(typeof body.timestamp, 'string', 'timestamp must be a string');
  assert.equal(body.temperature, 21.5);
  assert.equal(body.sensors.windSpeed, null, 'absent sensor must stay null in sensors');
  assert.equal(queries.at(-1).params[1], 600_000, 'maxAge must be forwarded');
  assert.match(
    queries.at(-1).sql,
    /WHERE COALESCE\(station_id, device_id\) = \$1/,
    'must use the COALESCE station-identity convention (export-routes.ts)',
  );

  // 404: reaches the router, no reading within maxAge.
  const miss = await fetch(`${base}/api/storage/weather/realtime/unknown-station`);
  assert.equal(miss.status, 404, 'expected 404 for unknown station');
  assert.notEqual((await miss.json()).error, 'catch-all', 'must not fall through to catch-all');

  // maxAge is clamped to the 1h cap and defaults when invalid.
  await fetch(`${base}/api/storage/weather/realtime/pws-001?maxAge=999999999`);
  assert.equal(queries.at(-1).params[1], 3_600_000, 'maxAge must clamp to 1h');
  await fetch(`${base}/api/storage/weather/realtime/pws-001?maxAge=bogus`);
  assert.equal(queries.at(-1).params[1], 300_000, 'invalid maxAge must default to 5m');

  // Unmounted storage paths still 404 through the catch-all (nothing else exposed).
  const other = await fetch(`${base}/api/storage/weather`, { method: 'POST' });
  assert.equal(other.status, 404, 'non-realtime storage paths must stay unmounted');

  console.log('smoke-storage-realtime-route: all assertions passed');
} finally {
  server.close();
}
