/**
 * backend#1173 (codex r45) — the real-ONNX path of POST /api/ai/inference:
 * when onnxruntime-node loads and runs the model, the response says so
 * (`executed_by: 'local_onnx'`, `result.engine: 'onnxruntime-node'`). The
 * fallback path is covered in aiml-sidecar-honest-gap.test.ts.
 *
 * onnxruntime-node is replaced by a minimal fake session so no native model
 * file is needed; fs/promises is in-memory so the registry is never written.
 */
import request from 'supertest';
import path from 'path';
import { describe, expect, it, jest } from '@jest/globals';

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
const mockSessionCreate = jest.fn(async (_file: string) => ({
  inputNames: ['input'],
  outputNames: ['output'],
  run: async () => ({ output: { data: Float32Array.from([0.9]) } }),
}));
jest.mock('onnxruntime-node', () => ({
  InferenceSession: { create: mockSessionCreate },
  Tensor: class { constructor(public type: string, public data: unknown, public dims: number[]) {} },
}));
jest.mock('express-rate-limit', () => () => (_req: unknown, _res: unknown, next: () => void) => next());
jest.mock('helmet', () => () => (_req: unknown, _res: unknown, next: () => void) => next());
jest.mock('../middleware/production-cors-cleanup', () => ({
  __esModule: true,
  default: { autoConfigureCORS: () => {} },
}));
jest.mock('../server/utils/otel-setup.js', () => ({ initializeOTel: async () => {} }));

const app = require('../server/ai_ml_networks_server_impl.js');

describe('POST /api/ai/inference — real ONNX path label (#1173)', () => {
  it('reports ONNX execution only when onnxruntime-node actually ran the model', async () => {
    const modelPath = path.resolve(__dirname, '../data/aiml-models/onnx-1173.onnx');
    mockFiles.set(modelPath, 'fake-model-bytes');

    const reg = await request(app).post('/api/ai/models').send({
      name: 'anomaly', network: 'near', model_type: 'anomaly', file_path: 'onnx-1173.onnx',
    });
    expect(reg.status).toBe(201);

    const inf = await request(app).post('/api/ai/inference').send({
      model_id: reg.body.model.id, input_data: { t: [1, 2, 3] },
    });
    expect(inf.status).toBe(200);
    expect(mockSessionCreate).toHaveBeenCalledWith(modelPath);
    expect(inf.body.result.engine).toBe('onnxruntime-node');
    expect(inf.body.executed_by).toBe('local_onnx');
    expect(inf.body.network).toBe('Near Protocol');
    expect(inf.body.status).toBe('completed');
  });
});

describe('image classification uses actual model output (Refs #1431)', () => {
  const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24)]);

  it('returns ONNX labels when the registered image model executes', async () => {
    const name = 'image-onnx-1431.onnx';
    mockFiles.set(path.resolve(__dirname, '../data/aiml-models', name), 'synthetic');
    const reg = await request(app).post('/api/ai/models').send({
      name: 'image', network: 'near', model_type: 'weather_image_classification',
      file_path: name, labels: ['rain'],
    });
    expect(reg.status).toBe(201);
    const res = await request(app).post('/api/aiml/image/classify')
      .attach('image', image, { filename: 'image.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(mockSessionCreate).toHaveBeenCalledWith(path.resolve(__dirname, '../data/aiml-models', name));
    expect(res.body.result.model.engine).toBe('onnxruntime-node');
    expect(res.body.result.model.fallback_used).toBe(false);
    expect(res.body.result.top_label).toBe('rain');
    expect(res.body.result.labels).toEqual([{ label: 'rain', confidence: 1 }]);
  });

  it.each(['throw', 'empty'])('refuses labels when ONNX execution is %s', async mode => {
    mockSessionCreate.mockImplementationOnce(async () => {
      if (mode === 'throw') throw new Error('synthetic model failure');
      return { inputNames: ['input'], outputNames: ['output'], run: async () => ({ output: { data: Float32Array.from([]) } }) };
    });
    const res = await request(app).post('/api/aiml/image/classify')
      .attach('image', image, { filename: 'image.png', contentType: 'image/png' });
    expect(res.status).toBe(503);
    expect(res.body.unavailable).toBe(true);
    expect(res.body.error.code).toBe('SIDECAR_UNAVAILABLE');
    expect(res.body.error.capability).toBe('aiml.image.classify');
    expect(res.body).not.toHaveProperty('result');
  });
});
