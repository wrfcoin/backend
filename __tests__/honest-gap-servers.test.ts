/**
 * backend#1118 — cross_chain_protocol_server.js and compute_networks_server.ts
 * must answer with the explicit honest-gap 501 envelope, never fabricated
 * success data. Boots both real Express apps (ephemeral ports) and hits the
 * routes through supertest.
 */
import request from 'supertest';
import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import path from 'path';

process.env.NODE_ENV = 'development';
process.env.CORS_ORIGIN = 'http://localhost:3000';
process.env.CROSS_CHAIN_PORT = '0';
process.env.COMPUTE_NETWORKS_PORT = '0';

jest.mock('../server/utils/otel-setup.js', () => ({
  initializeOTel: async () => {},
}));
jest.mock('../server/utils/graceful-shutdown', () => ({
  registerGracefulShutdown: () => {},
}));
// input-validation pulls jsdom (ESM-only under jest); neither server uses the
// validators on the routes under test.
jest.mock('../middleware/input-validation', () => ({
  transferValidation: [],
  addressValidation: [],
  handleValidationErrors: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// Keep winston from opening file transports under logs/ during the test.
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
const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => noopLogger };
jest.mock('../server/utils/logger', () =>
  new Proxy({}, { get: (_t, prop) => (prop === '__esModule' ? true : noopLogger) })
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const crossChain = require('../server/cross_chain_protocol_server.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const compute = require('../server/compute_networks_server.ts');

const crossApp = crossChain.app;
const computeApp = compute.default ?? compute;

afterAll(async () => {
  await new Promise<void>(resolve => crossChain.server.close(() => resolve()));
  await new Promise<void>(resolve => compute.server.close(() => resolve()));
});

function expectNotWired(res: request.Response, capability: string) {
  expect(res.status).toBe(501);
  expect(res.body.success).toBe(false);
  expect(res.body.unavailable).toBe(true);
  expect(typeof res.body.reason).toBe('string');
  expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
  expect(res.body.error.capability).toBe(capability);
}

describe('cross_chain_protocol_server — honest gaps (#1118)', () => {
  it('protocol catalog is marked not wired and carries no fabricated live metrics', async () => {
    const res = await request(crossApp).get('/api/crosschain/protocols');
    expect(res.status).toBe(200);
    expect(res.body.integration.wired).toBe(false);
    expect(res.body.active_protocols).toBe(0);
    for (const entry of Object.values<any>(res.body.protocols)) {
      expect(entry.status).toBe('not_wired');
      expect(entry).not.toHaveProperty('daily_volume');
      expect(entry).not.toHaveProperty('success_rate');
    }
  });

  it('single protocol returns the catalog entry with metrics explicitly unavailable', async () => {
    const res = await request(crossApp).get('/api/crosschain/protocols/axelar');
    expect(res.status).toBe(200);
    expect(res.body.protocol.name).toBe('Axelar Network');
    expect(res.body.metrics.unavailable).toBe(true);
    expect(res.body).not.toHaveProperty('metrics.uptime');
  });

  it('unknown protocol is still a 404', async () => {
    const res = await request(crossApp).get('/api/crosschain/protocols/nope');
    expect(res.status).toBe(404);
  });

  it('send keeps input validation, then refuses honestly instead of faking a message id', async () => {
    const missing = await request(crossApp).post('/api/crosschain/send').send({ protocol: 'axelar' });
    expect(missing.status).toBe(400);

    const unknown = await request(crossApp).post('/api/crosschain/send').send({
      protocol: 'nope', source_chain: 'a', destination_chain: 'b', message_type: 'x', payload: 'y',
    });
    expect(unknown.status).toBe(404);

    const res = await request(crossApp).post('/api/crosschain/send').send({
      protocol: 'axelar', source_chain: 'ethereum', destination_chain: 'polygon',
      message_type: 'token_transfer', payload: { amount: 1 },
    });
    expectNotWired(res, 'crosschain.send');
    expect(res.body).not.toHaveProperty('message_id');
  });

  it.each([
    ['/api/crosschain/messages/abc', 'crosschain.message_status'],
    ['/api/crosschain/messages', 'crosschain.messages'],
    ['/api/crosschain/metrics', 'crosschain.metrics'],
    ['/api/crosschain/bridge-status', 'crosschain.bridge_status'],
    ['/api/crosschain/protocols/ibc/chains', 'crosschain.supported_chains'],
    ['/api/blockchain/status', 'blockchain.status'],
    ['/api/mining/cross-chain-rewards', 'mining.cross_chain_rewards'],
    ['/api/wallet/balance', 'wallet.balance'],
    ['/api/layer2/performance', 'layer2.performance'],
    ['/api/privacy/features', 'privacy.features'],
  ])('GET %s is an explicit 501 (%s)', async (route, capability) => {
    const res = await request(crossApp).get(route);
    expectNotWired(res, capability);
  });

  it('source no longer simulates block production or message completion', () => {
    const src = readFileSync(path.join(__dirname, '../server/cross_chain_protocol_server.js'), 'utf8');
    expect(src).not.toMatch(/setInterval\(/);
    expect(src).not.toMatch(/setTimeout\(/);
    expect(src).not.toMatch(/require\(['"]\.\.\/services\/CrossChainMetricsService/);
  });
});

describe('compute_networks_server — honest gaps (#1118)', () => {
  it('network catalog is marked not wired and drops fabricated totals', async () => {
    const res = await request(computeApp).get('/api/compute/networks');
    expect(res.status).toBe(200);
    expect(res.body.integration.wired).toBe(false);
    expect(res.body.active_networks).toBe(0);
    expect(res.body).not.toHaveProperty('total_compute_power');
    expect(res.body).not.toHaveProperty('total_nodes');
    expect(res.body).not.toHaveProperty('summary');
    for (const entry of Object.values<any>(res.body.networks)) {
      expect(entry.status).toBe('not_wired');
    }
  });

  it('single network returns the catalog entry with metrics explicitly unavailable', async () => {
    const res = await request(computeApp).get('/api/compute/networks/flux');
    expect(res.status).toBe(200);
    expect(res.body.metrics.unavailable).toBe(true);
    expect(res.body.metrics).not.toHaveProperty('queue_length');
    expect(res.body.metrics).not.toHaveProperty('utilization');
    expect((await request(computeApp).get('/api/compute/networks/nope')).status).toBe(404);
  });

  it('submit keeps validation, then refuses honestly instead of queueing into memory', async () => {
    expect((await request(computeApp).post('/api/compute/submit').send({})).status).toBe(400);
    expect((await request(computeApp).post('/api/compute/submit').send({ task: 't', network: 'nope' })).status).toBe(404);
    const res = await request(computeApp).post('/api/compute/submit').send({ task: 't', network: 'flux' });
    expectNotWired(res, 'compute.submit');
    expect(res.body).not.toHaveProperty('job_id');
    expect(res.body.error.details).toMatch(/forecast-jobs/);
  });

  it.each([
    ['get', '/api/flux/status', 'compute.flux.status'],
    ['get', '/api/iexec/status', 'compute.iexec.status'],
    ['get', '/api/icp/status', 'compute.icp.status'],
    ['get', '/api/aioz/status', 'compute.aioz.status'],
    ['get', '/api/compute/flux/status', 'compute.flux.status'],
    ['get', '/api/compute/jobs/abc', 'compute.job_status'],
    ['get', '/api/compute/jobs', 'compute.jobs'],
    ['delete', '/api/compute/jobs/abc', 'compute.job_cancel'],
    ['get', '/api/compute/job/abc/metrics', 'compute.job_metrics'],
    ['get', '/api/compute/metrics', 'compute.metrics'],
    ['get', '/api/compute/optimize-capacity', 'compute.optimize_capacity'],
  ])('%s %s is an explicit 501 (%s)', async (method, route, capability) => {
    const res = await (request(computeApp) as any)[method](route);
    expectNotWired(res, capability);
  });

  it.each([
    ['/api/compute/submit-batch', {}, { tasks: [{ taskType: 'ai' }] }, 'compute.submit_batch'],
    ['/api/compute/submit-distributed', {}, { workloadType: 'x', dataSize: 5 }, 'compute.submit_distributed'],
    ['/api/compute/submit-quantum', {}, { algorithm: 'shor', complexity: 4 }, 'compute.submit_quantum'],
  ])('POST %s validates then 501s', async (route, bad, good, capability) => {
    expect((await request(computeApp).post(route).send(bad)).status).toBe(400);
    const res = await request(computeApp).post(route).send(good);
    expectNotWired(res, capability);
  });

  it('real routers mounted on the same app are untouched (backend#47 forecast jobs still answer)', async () => {
    const res = await request(computeApp).get('/api/compute/forecast-jobs');
    expect(res.status).not.toBe(501);
    expect(res.status).not.toBe(404);
  });

  it('acceptance: no Math.random()-based metric remains in the source', () => {
    const src = readFileSync(path.join(__dirname, '../server/compute_networks_server.ts'), 'utf8');
    expect(src).not.toMatch(/Math\.random\(/);
    expect(src).not.toMatch(/activeJobs/);
  });
});
