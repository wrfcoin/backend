import { createEnvironmentReportsRouter } from '../server/routes/environment-reports-routes.js';

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

describe('Environment Phase2 Report Routes', () => {
  test('ingests soil report and lists canonical reports', () => {
    const router = createEnvironmentReportsRouter();

    const ingestReq = mockReq({}, {
      source: 'soil-station',
      providerId: 'provider-soil',
      region: 'us-midwest',
      actorClass: 'human',
      soilMoisture: 38,
      moistureUnit: 'percent',
      ph: 6.5,
      nitrogenPpm: 40,
      phosphorusPpm: 20,
      potassiumPpm: 65,
      erosionRiskScore: 0.31,
    });
    const ingestRes = mockRes();
    getHandler(router, 'POST', '/soil/ingest')(ingestReq, ingestRes);

    expect(ingestRes.statusCode).toBe(201);
    expect(ingestRes.body.data.domain).toBe('soil');

    const listReq = mockReq({}, {}, { domain: 'soil', limit: '5' });
    const listRes = mockRes();
    getHandler(router, 'GET', '/reports')(listReq, listRes);

    expect(listRes.statusCode).toBe(200);
    expect(listRes.body.count).toBeGreaterThan(0);
    expect(listRes.body.data[0].domain).toBe('soil');
  });

  test('rejects invalid ingest payloads with a 400', () => {
    const router = createEnvironmentReportsRouter();

    const ingestRes = mockRes();
    getHandler(router, 'POST', '/soil/ingest')(
      mockReq({}, {
        source: 'soil-station',
        providerId: 'provider-soil',
        region: 'us-midwest',
        actorClass: 'bad-actor',
        soilMoisture: 38,
        moistureUnit: 'percent',
        ph: 6.5,
        nitrogenPpm: 40,
        phosphorusPpm: 20,
        potassiumPpm: 65,
        erosionRiskScore: 0.31,
      }),
      ingestRes
    );

    expect(ingestRes.statusCode).toBe(400);
    expect(ingestRes.body.success).toBe(false);
    expect(ingestRes.body.error).toContain('actorClass must be one of');
  });

  test('rejects invalid summary domains', () => {
    const router = createEnvironmentReportsRouter();

    const summaryRes = mockRes();
    getHandler(router, 'GET', '/summary/:domain')(mockReq({ domain: 'wildfire' }), summaryRes);

    expect(summaryRes.statusCode).toBe(400);
    expect(summaryRes.body.success).toBe(false);
    expect(summaryRes.body.error).toContain('domain must be one of');
  });

  test('returns phase2 summary and docs endpoint metadata', () => {
    const router = createEnvironmentReportsRouter();

    const summaryRes = mockRes();
    getHandler(router, 'GET', '/summary')(mockReq(), summaryRes);
    expect(summaryRes.statusCode).toBe(200);
    expect(summaryRes.body.data).toHaveProperty('canonicalSchemaVersion', 'env-phase2-v1');
    expect(summaryRes.body.data).toHaveProperty('domains');

    const docsRes = mockRes();
    getHandler(router, 'GET', '/docs')(mockReq(), docsRes);
    expect(docsRes.statusCode).toBe(200);
    expect(docsRes.body.data.endpoints.length).toBeGreaterThanOrEqual(7);
    expect(docsRes.body.data.endpoints).toContainEqual({
      method: 'GET',
      path: '/api/environment/reports/docs',
    });
  });
});
