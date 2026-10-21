import { jest } from '@jest/globals';

jest.mock('../server/middleware/auth.js', () => ({
  authenticateJWT: jest.fn((_req: any, _res: any, next: any) => next()),
}));

import {
  createIntegrityCalibrationRouter,
} from '../server/routes/integrity-calibration-routes.js';
import {
  IntegrityThresholdCalibrationService,
} from '../server/services/integrity-threshold-calibration-service.js';

function mockReq(params: Record<string, string> = {}, body: any = {}, query: any = {}): any {
  return { params, body, query };
}

function mockRes(): any {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

function getHandler(router: any, method: string, pathSuffix: string): Function {
  for (const layer of router.stack) {
    if (
      layer.route &&
      layer.route.path === pathSuffix &&
      layer.route.methods[method.toLowerCase()]
    ) {
      return layer.route.stack[0].handle;
    }
  }
  throw new Error(`No handler found for ${method} ${pathSuffix}`);
}

describe('Integrity Calibration Routes', () => {
  let service: IntegrityThresholdCalibrationService;
  let router: any;

  beforeEach(() => {
    service = new IntegrityThresholdCalibrationService();
    router = createIntegrityCalibrationRouter(service);
  });

  test('GET /config/active returns active calibration config', () => {
    const res = mockRes();
    getHandler(router, 'GET', '/config/active')(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.version).toContain('cal-baseline');
  });

  test('POST /jobs/run executes calibration job and returns fairness metrics', () => {
    const req = mockReq({}, {
      requestedBy: 'analyst-route',
      samples: [
        { actorClass: 'human', model: 'abuse-risk', score: 88, groundTruth: 'abuse' },
        { actorClass: 'human', model: 'abuse-risk', score: 33, groundTruth: 'benign' },
        { actorClass: 'human', model: 'sybil-detection', score: 71, groundTruth: 'abuse' },
        { actorClass: 'ai_agent', model: 'abuse-risk', score: 83, groundTruth: 'abuse' },
        { actorClass: 'ai_agent', model: 'abuse-risk', score: 36, groundTruth: 'benign' },
        { actorClass: 'ai_agent', model: 'sybil-detection', score: 72, groundTruth: 'abuse' },
        { actorClass: 'robot', model: 'abuse-risk', score: 85, groundTruth: 'abuse' },
        { actorClass: 'robot', model: 'abuse-risk', score: 39, groundTruth: 'benign' },
        { actorClass: 'robot', model: 'sybil-detection', score: 70, groundTruth: 'abuse' },
      ],
      referenceSuites: ['security-testing#4'],
    });
    const res = mockRes();

    getHandler(router, 'POST', '/jobs/run')(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.metrics.falsePositiveRateByActorClass).toHaveProperty('human');
    expect(res.body.data.metrics).toHaveProperty('parity');
  });

  test('POST /config/rollback returns 400 for unknown target version', () => {
    const req = mockReq({}, {
      targetVersion: 'missing-version',
      requestedBy: 'analyst-route',
      reason: 'rollback test',
    });
    const res = mockRes();

    getHandler(router, 'POST', '/config/rollback')(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/not found/);
  });

  test('GET /rollback/runbook returns rollback documentation metadata', () => {
    const res = mockRes();
    getHandler(router, 'GET', '/rollback/runbook')(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.runbookPath).toBe('docs/integrity-threshold-calibration-rollback.md');
  });
});
