/**
 * backend#1173 — iot_sensor_networks_server.js must not report third-party IoT
 * networks as active or emit invented metrics. Same honest-gap treatment the
 * cross-chain and compute sidecars got in #1118 (honest-gap-servers.test.ts).
 * Boots the real Express app on an ephemeral port and hits it with supertest.
 */
import request from 'supertest';
import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import path from 'path';

process.env.NODE_ENV = 'development';
process.env.IOT_PORT = '0';

jest.mock('../server/utils/otel-setup.js', () => ({
  initializeOTel: async () => {},
}));
jest.mock('../server/utils/graceful-shutdown', () => ({
  registerGracefulShutdown: () => {},
}));
jest.mock('../middleware/production-cors-cleanup', () => ({
  __esModule: true,
  default: { autoConfigureCORS: () => {} },
}));
jest.mock('express-rate-limit', () => () => (_req: unknown, _res: unknown, next: () => void) => next());
// Lineage is best-effort in the handler; keep the test off any database.
jest.mock('../server/services/lineage-service.js', () => ({
  lineageService: { createLineageRecord: async () => ({ lineageId: 'lin_test' }) },
}));
jest.mock('winston', () => {
  const noop = () => {};
  const passthrough = () => ({});
  const format: any = Object.assign(() => passthrough, {
    combine: passthrough, timestamp: passthrough, errors: passthrough, json: passthrough,
    simple: passthrough, printf: passthrough, colorize: passthrough, splat: passthrough,
    label: passthrough, metadata: passthrough, uncolorize: passthrough,
  });
  class Transport { constructor(_opts?: unknown) {} }
  return {
    createLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop, child: () => ({ info: noop, warn: noop, error: noop, debug: noop }) }),
    format,
    transports: { File: Transport, Console: Transport },
  };
});

const iot = require('../server/iot_sensor_networks_server.js');
const app = iot;

afterAll(async () => {
  await new Promise<void>(resolve => iot.server.close(() => resolve()));
});

const SOURCE = path.join(__dirname, '../server/iot_sensor_networks_server.js');

describe('iot_sensor_networks_server — honest gaps (#1173)', () => {
  it.each([
    ['/api/iot/networks', 'iot.networks'],
    ['/api/iot/networks/helium', 'iot.network'],
    ['/api/iot/stream/ttn', 'iot.stream'],
  ])('%s refuses unwired network access with a stable 503 envelope', async (route, capability) => {
    const res = await request(app).get(route);
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.unavailable).toBe(true);
    expect(res.body.error.code).toBe('SIDECAR_UNAVAILABLE');
    expect(res.body.error.capability).toBe(capability);
    expect(res.body.reason).toBe(res.body.error.message);
    for (const field of ['networks', 'network', 'metrics', 'stream', 'active_networks']) {
      expect(res.body).not.toHaveProperty(field);
    }
  });

  it.each(['/api/iot/networks/nope', '/api/iot/stream/nope'])(
    '%s retains unknown-network 404', async route => {
      expect((await request(app).get(route)).status).toBe(404);
    },
  );

  it('POST /api/iot/data stores a reading with no invented quality score or reward', async () => {
    expect((await request(app).post('/api/iot/data').send({})).status).toBe(400);

    const res = await request(app).post('/api/iot/data').send({
      network: 'openaq', sensor_id: 's-1173', data_type: 'pm10', value: 12.5,
    });
    expect(res.status).toBe(200);
    expect(res.body.data_accepted).toBe(true);
    expect(res.body.quality_score).toBeNull();
    expect(res.body.reward_earned).toBeNull();
    expect(res.body.reading_id).toMatch(/^reading_[0-9a-f-]{36}$/);

    const read = await request(app).get('/api/iot/data/openaq');
    expect(read.status).toBe(200);
    expect(read.body.total_readings).toBe(1);
    expect(read.body.readings[0].quality_score).toBeNull();
    expect(read.body.avg_quality_score).toBeNull();
  });

  it('metrics report only what the process holds; the frontend-mapped fields are null, not invented', async () => {
    const res = await request(app).get('/api/iot/metrics');
    expect(res.status).toBe(200);
    const m = res.body.metrics;
    expect(res.body.integration.wired).toBe(false);
    expect(m.active_networks).toBe(0);
    expect(m.total_networks).toBe(10);
    expect(m.readings_held).toBe(1); // the one reading posted above
    expect(m.total_devices).toBeNull();
    expect(m.global_coverage).toBe(false);
    expect(m.network_uptime).toBeNull();
    expect(m.avg_latency).toBeNull();
    for (const k of ['total_sensors', 'total_gateways', 'readings_processed', 'avg_data_quality', 'reward_distribution']) {
      expect(m).not.toHaveProperty(k);
    }
  });

  it('two identical GETs agree (no random fields left anywhere)', async () => {
    for (const route of ['/api/iot/networks', '/api/iot/networks/ttn', '/api/iot/metrics']) {
      const a = await request(app).get(route);
      const b = await request(app).get(route);
      const strip = (body: any) => JSON.stringify({ ...body, timestamp: undefined });
      expect(strip(a.body)).toBe(strip(b.body));
    }
  });

  it('source scan: no Math.random and no active status claim', () => {
    const src = readFileSync(SOURCE, 'utf8');
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/status: 'active'/);
    expect(src).not.toMatch(/WRF today|0\.0001 WRF/);
  });
});
