import { createSybilDetectionRouter } from '../server/routes/sybil-detection-routes.js';
import { SybilDetectionService } from '../server/services/sybil-detection-service.js';

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

describe('Sybil Detection Routes', () => {
  let service: SybilDetectionService;
  let router: any;

  beforeEach(() => {
    service = new SybilDetectionService();
    router = createSybilDetectionRouter(service);
  });

  test('GET /thresholds returns explicit versioned thresholds', () => {
    const req = mockReq();
    const res = mockRes();
    getHandler(router, 'GET', '/thresholds')(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.version).toBe('2026-03-04.v1');
    expect(res.body.data.rules).toHaveProperty('ip_node_density');
    expect(res.body.data.rules).toHaveProperty('temporal_sync_score');
  });

  test('POST /detect creates report and stores review evidence', () => {
    const req = mockReq({}, {
      participantId: 'participant-api-1',
      actorClass: 'ai_agent',
      indicators: {
        ip_node_density: 5,
        did_reuse_count: 4,
        temporal_sync_score: 0.81,
        payload_similarity_score: 0.79,
      },
      source: 'api-test',
    });
    const res = mockRes();
    getHandler(router, 'POST', '/detect')(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.data.reportId).toMatch(/^SYB-\d{6}$/);
    expect(res.body.data.participantRef).toMatch(/^[a-f0-9]{20}$/);
    expect(res.body.data.riskLevel).not.toBe('none');
    expect(res.body.data.evidenceArtifacts.length).toBeGreaterThan(0);
  });

  test('evidence endpoints return and append artifacts for an existing report', () => {
    const createReq = mockReq({}, {
      participantId: 'participant-api-2',
      actorClass: 'human',
      indicators: { ip_node_density: 3, reward_destination_overlap: 0.7 },
    });
    const createRes = mockRes();
    getHandler(router, 'POST', '/detect')(createReq, createRes);
    const reportId = createRes.body.data.reportId;

    const listReq = mockReq({ id: reportId });
    const listRes = mockRes();
    getHandler(router, 'GET', '/reports/:id/evidence')(listReq, listRes);
    const initialCount = listRes.body.count;
    expect(initialCount).toBeGreaterThan(0);

    const addReq = mockReq({ id: reportId }, {
      type: 'manual_review_note',
      summary: 'Opened farm-investigation ticket.',
      opaqueReference: 'ticket-42',
    });
    const addRes = mockRes();
    getHandler(router, 'POST', '/reports/:id/evidence')(addReq, addRes);
    expect(addRes.statusCode).toBe(201);

    const listResAfter = mockRes();
    getHandler(router, 'GET', '/reports/:id/evidence')(listReq, listResAfter);
    expect(listResAfter.body.count).toBe(initialCount + 1);
  });
});
