/**
 * backend#1173 — ai_ml_networks_server_impl.js must not list Bittensor, NEAR,
 * Fetch.ai or SingularityNET as active/operational (no client for any exists),
 * nor report their invented validator/service counts. The real local surface —
 * ONNX model registry, inference, ensemble, advisories — keeps its contract.
 *
 * The registry persists through fs/promises; it is replaced with an in-memory
 * store so the test never writes data/aiml-model-registry.json.
 */
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import path from 'path';

const mockFiles = new Map<string, string>();
jest.mock('fs/promises', () => ({
  mkdir: async () => undefined,
  readFile: async (p: string) => {
    if (!mockFiles.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return mockFiles.get(p);
  },
  writeFile: async (p: string, data: string) => { mockFiles.set(p, data); },
  access: async (p: string) => {
    if (!mockFiles.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
}));
// Force the statistical fallback: no native ONNX runtime in the unit test.
jest.mock('onnxruntime-node', () => { throw new Error('not installed in test'); }, { virtual: true });
jest.mock('express-rate-limit', () => () => (_req: unknown, _res: unknown, next: () => void) => next());
jest.mock('helmet', () => () => (_req: unknown, _res: unknown, next: () => void) => next());
jest.mock('../middleware/production-cors-cleanup', () => ({
  __esModule: true,
  default: { autoConfigureCORS: () => {} },
}));
jest.mock('../server/utils/otel-setup.js', () => ({ initializeOTel: async () => {} }));

// NODE_ENV=test (jest default) keeps the module from binding port 6001.
const app = require('../server/ai_ml_networks_server_impl.js');

const SOURCE = path.join(__dirname, '../server/ai_ml_networks_server_impl.js');

describe('ai_ml_networks_server — honest gaps (#1173)', () => {
  it.each([
    ['/api/aiml/networks/status', 'aiml.networks.status'],
    ['/api/ai/networks', 'ai.networks'],
    ['/api/ai/networks/bittensor', 'ai.network'],
  ])('%s refuses unwired network access with a stable 503 envelope', async (route, capability) => {
    const res = await request(app).get(route);
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.unavailable).toBe(true);
    expect(res.body.error.code).toBe('SIDECAR_UNAVAILABLE');
    expect(res.body.error.capability).toBe(capability);
    expect(res.body.reason).toBe(res.body.error.message);
    for (const field of ['networks', 'network', 'metrics', 'model_deployments', 'system_status']) {
      expect(res.body).not.toHaveProperty(field);
    }
  });

  it('unknown AI networks retain 404 for status and local registry lookup', async () => {
    for (const route of ['/api/ai/networks/nope', '/api/ai/networks/nope/models']) {
      expect((await request(app).get(route)).status).toBe(404);
    }
  });

  it('/api/ai/networks/:network/models carries the notice', async () => {
    const res = await request(app).get('/api/ai/networks/near/models');
    expect(res.status).toBe(200);
    expect(res.body.integration.wired).toBe(false);
    expect(res.body.scope).toBe('local ONNX model registry');
    expect(res.body.total_models).toBe(0);
  });

  it('/api/ai/metrics: active_networks 0 and no success rate before any inference', async () => {
    const res = await request(app).get('/api/ai/metrics');
    expect(res.status).toBe(200);
    expect(res.body.metrics.active_networks).toBe(0);
    expect(res.body.metrics.total_networks).toBe(4);
    expect(res.body.metrics.inferences_processed).toBe(0);
    expect(res.body.metrics.model_success_rate).toBeNull();
  });

  it('local model registration and inference keep their contract (and say where they ran)', async () => {
    const modelPath = path.resolve(__dirname, '../data/aiml-models/test-1173.onnx');
    mockFiles.set(modelPath, 'not-a-real-model');

    const missing = await request(app).post('/api/ai/models').send({ name: 'x' });
    expect(missing.status).toBe(400);

    const reg = await request(app).post('/api/ai/models').send({
      name: 'anomaly', network: 'bittensor', model_type: 'anomaly', file_path: 'test-1173.onnx',
    });
    expect(reg.status).toBe(201);
    expect(reg.body.model.network).toBe('bittensor');

    const inf = await request(app).post('/api/ai/inference').send({
      model_id: reg.body.model.id, input_data: { t: [1, 2, 3] },
    });
    expect(inf.status).toBe(200);
    expect(inf.body.status).toBe('completed');
    expect(inf.body.model_id).toBe(reg.body.model.id);
    expect(inf.body.network).toBe('Bittensor');
    // Codex r45: with no ONNX runtime the fallback ran, so the response must
    // not claim ONNX execution.
    expect(inf.body.result.engine).toBe('statistical-fallback');
    expect(inf.body.executed_by).toBe('local_statistical_fallback');
    expect(inf.body.executed_by).not.toMatch(/onnx/i);

    const metrics = await request(app).get('/api/ai/metrics');
    expect(metrics.body.metrics.inferences_processed).toBe(1);
    expect(metrics.body.metrics.model_success_rate).toBe(1);
    expect(metrics.body.metrics.active_networks).toBe(0);
  });

  it('source scan: no third-party network is claimed active; no invented totals', () => {
    const src = readFileSync(SOURCE, 'utf8');
    const catalog = src.slice(src.indexOf('const aiNetworks = {'), src.indexOf('const AI_NETWORKS_NOTICE'));
    expect(catalog).not.toMatch(/status: 'active'/);
    expect(src).not.toMatch(/system_status: 'operational'/);
    expect(src).not.toMatch(/150 \+ 25000/);
    expect(src).not.toMatch(/Math\.random/);
  });
});

describe('image classification requires model output (Refs #1431)', () => {
  const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24)]);

  function expectUnavailable(res: any) {
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.unavailable).toBe(true);
    expect(res.body.error.code).toBe('SIDECAR_UNAVAILABLE');
    expect(res.body.error.capability).toBe('aiml.image.classify');
    expect(res.body).not.toHaveProperty('result');
    expect(res.body).not.toHaveProperty('labels');
  }

  it('refuses hash-derived weather labels without a registered image model', async () => {
    expectUnavailable(await request(app).post('/api/aiml/image/classify')
      .attach('image', image, { filename: 'image.png', contentType: 'image/png' }));
  });

  it('refuses labels when a registered model has no ONNX runtime', async () => {
    const name = 'image-1431.onnx';
    mockFiles.set(path.resolve(__dirname, '../data/aiml-models', name), 'synthetic');
    const reg = await request(app).post('/api/ai/models').send({
      name: 'image', network: 'near', model_type: 'weather_image_classification',
      file_path: name, labels: ['rain', 'clear_sky'],
    });
    expect(reg.status).toBe(201);
    expectUnavailable(await request(app).post('/api/aiml/image/classify')
      .attach('image', image, { filename: 'image.png', contentType: 'image/png' }));
  });

  it('retains invalid/missing image 400 controls', async () => {
    expect((await request(app).post('/api/aiml/image/classify')).status).toBe(400);
    expect((await request(app).post('/api/aiml/image/classify')
      .attach('image', Buffer.from('invalid'), { filename: 'image.png', contentType: 'image/png' })).status).toBe(400);
  });
});
