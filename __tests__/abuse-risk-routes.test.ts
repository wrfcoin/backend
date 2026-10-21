import {
  createAbuseRiskRouter,
} from '../server/routes/abuse-risk-routes.js';
import {
  AbuseRiskService,
} from '../server/services/abuse-risk-service.js';

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

describe('Abuse Risk Routes', () => {
  let service: AbuseRiskService;
  let router: any;

  beforeEach(() => {
    service = new AbuseRiskService();
    router = createAbuseRiskRouter(service);
  });

  test('GET /factors publishes transparent risk-factor documentation', () => {
    const req = mockReq();
    const res = mockRes();

    getHandler(router, 'GET', '/factors')(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBeGreaterThan(0);
    expect(res.body.data[0]).toHaveProperty('key');
    expect(res.body.data[0]).toHaveProperty('rationale');
    expect(res.body.data[0]).toHaveProperty('warnThreshold');
  });

  test('POST /assess returns audit-safe assessment without raw participant id', () => {
    const req = mockReq({}, {
      participantId: 'participant-private-123',
      actorClass: 'human',
      indicators: {
        spam_burst: 0.85,
        duplicate_payload: 0.72,
        reciprocal_cluster_rate: 0.61,
      },
      evidenceConfidence: 0.88,
      appealOverturnRate: 0.06,
    });
    const res = mockRes();

    getHandler(router, 'POST', '/assess')(req, res);

    expect(res.statusCode).toBe(201);
    const data = res.body.data;
    expect(data.assessmentId).toMatch(/^RISK-\d{6}$/);
    expect(data.participantRef).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(data)).not.toContain('participant-private-123');
    expect(data.privacySafeTelemetry).toBe(true);
    expect(data.falsePositiveHandling).toHaveProperty('recommendedAction');
  });

  test('POST /:id/outcome updates metrics endpoint', () => {
    const createReq = mockReq({}, {
      participantId: 'participant-metrics-1',
      actorClass: 'ai_agent',
      indicators: { spam_burst: 0.9, coordinated_timing_pattern: 0.9 },
    });
    const createRes = mockRes();
    getHandler(router, 'POST', '/assess')(createReq, createRes);
    const assessmentId = createRes.body.data.assessmentId;

    const outcomeReq = mockReq({ id: assessmentId }, { outcome: 'confirmed_abuse' });
    const outcomeRes = mockRes();
    getHandler(router, 'POST', '/:id/outcome')(outcomeReq, outcomeRes);

    expect(outcomeRes.statusCode).toBe(200);
    expect(outcomeRes.body.data.metrics.outcomes.confirmed_abuse).toBe(1);

    const metricsReq = mockReq();
    const metricsRes = mockRes();
    getHandler(router, 'GET', '/metrics')(metricsReq, metricsRes);

    expect(metricsRes.statusCode).toBe(200);
    expect(metricsRes.body.data.totalAssessments).toBe(1);
    expect(metricsRes.body.data.precision).toBe(1);
  });
});
