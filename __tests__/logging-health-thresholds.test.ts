import express from 'express';
import request from 'supertest';
import { createDashboardEndpoints, LoggingDashboard } from '../server/utils/logging-dashboard';

describe('mounted logging health thresholds (Refs #1394)', () => {
  const heapLimit = 512 * 1024 * 1024;
  const at = new Date('2026-10-02T12:00:00Z');

  afterEach(() => jest.restoreAllMocks());
  afterAll(() => LoggingDashboard.getInstance().cleanup());

  test.each([
    [0, heapLimit - 1, 200, 'healthy'],
    [10, heapLimit, 200, 'healthy'],
    [11, heapLimit, 206, 'degraded'],
    [0, heapLimit + 1, 206, 'degraded'],
    [11, heapLimit + 1, 206, 'degraded'],
  ])('alerts=%s heap=%s returns HTTP %s / %s', async (alertsLastHour, heapUsed, status, health) => {
    jest.spyOn(LoggingDashboard.getInstance(), 'getDashboardData').mockReturnValue({
      alertStats: { alertsLastHour }, serviceHealth: {}, logFiles: {},
    } as any);
    jest.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: heapUsed, heapTotal: heapUsed, heapUsed, external: 0, arrayBuffers: 0,
    });
    jest.spyOn(process, 'uptime').mockReturnValue(42);
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(at.toISOString());
    const app = express();
    app.get('/health', createDashboardEndpoints().getHealth);
    const response = await request(app).get('/health');
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ status: health, timestamp: '2026-10-02T12:00:00.000Z', uptime: 42 });
    expect(response.body.memory.heapUsed).toBe(heapUsed);
    expect(response.body.alerts.alertsLastHour).toBe(alertsLastHour);
  });

  test('dashboard failure returns HTTP 500 / unhealthy', async () => {
    jest.spyOn(LoggingDashboard.getInstance(), 'getDashboardData').mockImplementation(() => {
      throw new Error('synthetic dashboard failure');
    });
    const app = express();
    app.get('/health', createDashboardEndpoints().getHealth);
    const response = await request(app).get('/health');
    expect(response.status).toBe(500);
    expect(response.body.status).toBe('unhealthy');
  });
});
