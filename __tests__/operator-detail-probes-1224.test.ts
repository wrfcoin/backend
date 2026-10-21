/**
 * backend#1224: operational detail (NOAA health, request-path dashboard) is an
 * operator/reader surface. Covers the non-rejecting token predicates, the
 * gated /api/weather/health route and HTML escaping in the dashboard.
 */
import express from 'express';
import request from 'supertest';

const mockGetServicesHealth = jest.fn((_req: any, res: any) =>
  res.status(200).json({ overall: 'healthy', configuration: { useRealData: true } })
);

jest.mock('../server/controllers/enhanced-weather-controller', () =>
  jest.fn().mockImplementation(() => ({ getServicesHealth: mockGetServicesHealth }))
);

const OPERATOR = 'test-operator-token-1224';
const READER = 'test-reader-token-1224';

beforeEach(() => {
  process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR;
  process.env.WRFCOIN_READER_TOKEN = READER;
  mockGetServicesHealth.mockClear();
});
afterAll(() => {
  delete process.env.WRFCOIN_OPERATOR_TOKEN;
  delete process.env.WRFCOIN_READER_TOKEN;
});

describe('operator-token-auth predicates', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { hasOperatorToken, hasOperatorOrReaderToken } = require('../server/middleware/operator-token-auth');
  const req = (authorization?: string) => ({ headers: authorization ? { authorization } : {} });

  it('accept only the configured bearer tokens', () => {
    expect(hasOperatorToken(req(`Bearer ${OPERATOR}`))).toBe(true);
    expect(hasOperatorToken(req(`Bearer ${READER}`))).toBe(false);
    expect(hasOperatorOrReaderToken(req(`Bearer ${OPERATOR}`))).toBe(true);
    expect(hasOperatorOrReaderToken(req(`Bearer ${READER}`))).toBe(true);
    for (const r of [req(), req('Bearer nope'), req(OPERATOR), {}]) {
      expect(hasOperatorToken(r)).toBe(false);
      expect(hasOperatorOrReaderToken(r)).toBe(false);
    }
  });

  it('never matches when the tokens are unset or blank', () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = '  ';
    delete process.env.WRFCOIN_READER_TOKEN;
    expect(hasOperatorOrReaderToken(req('Bearer '))).toBe(false);
    expect(hasOperatorOrReaderToken(req('Bearer   '))).toBe(false);
  });
});

describe('GET /api/weather/health', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const weatherRoutes = require('../server/routes/weather-routes');
  const app = express();
  app.use('/api/weather', weatherRoutes.default ?? weatherRoutes);

  it('rejects anonymous callers without making outbound NOAA calls', async () => {
    const res = await request(app).get('/api/weather/health');

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('useRealData');
    expect(mockGetServicesHealth).not.toHaveBeenCalled();
  });

  it.each([OPERATOR, READER])('serves the detail to a configured bearer token', async token => {
    const res = await request(app).get('/api/weather/health').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.configuration).toEqual({ useRealData: true });
  });
});

describe('monitoring dashboard HTML', () => {
  it('escapes recorded request paths', async () => {
    const { monitoringDashboard } = await import('../server/monitoring/dashboard');
    const hostile = '/api/<img src=x onerror=alert(1)>';
    monitoringDashboard.recordRequest(hostile, 5, false, false);

    const html = monitoringDashboard.generateHTMLDashboard();

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('/api/&lt;img src=x onerror=alert(1)&gt;');
  });
});
