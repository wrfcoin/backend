/**
 * Smoke tests: metrics-api — HTTP request assertions.
 * Addresses #363 (untested api/ endpoint) and #340.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockGetPrometheusMetrics = jest.fn();

jest.mock('../../services/api-metrics.js', () => ({
  apiMetricsService: {
    getPrometheusMetrics: mockGetPrometheusMetrics,
    getRealtimeMetrics: jest.fn().mockReturnValue({}),
    recordRequest: jest.fn(),
  },
}));

jest.mock('../../services/metrics-websocket-integration.js', () => ({
  metricsWebSocketIntegration: {
    getMetrics: jest.fn().mockReturnValue({ connections: 0 }),
  },
}));

jest.mock('../../middleware/api-key-auth.js', () => ({
  apiKeyAuth: {
    authenticate: jest.fn(() => (_req: any, _res: any, next: any) => next()),
  },
}));

jest.mock('../../server/utils/logger.js', () => ({
  performanceLogger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import router from '../../api/metrics-api.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return app;
}

describe('metrics-api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /metrics', () => {
    it('returns 200 with prometheus text format', async () => {
      mockGetPrometheusMetrics.mockReturnValue(
        '# HELP requests_total Total requests\nrequests_total 42\n'
      );
      const res = await request(makeApp()).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
    });

    it('returns 500 when metrics generation fails', async () => {
      mockGetPrometheusMetrics.mockImplementation(() => {
        throw new Error('prom error');
      });
      const res = await request(makeApp()).get('/metrics');
      expect(res.status).toBe(500);
    });
  });
});
