/**
 * Smoke tests for server/routes/security-admin-routes.ts
 * Issue #357 — security-admin-routes has 7 endpoints and zero tests
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const passthrough = (_req: any, _res: any, next: any) => next();

const mockGetStats = jest.fn();
const mockUpdateConfig = jest.fn();
const mockGetBlockedIPs = jest.fn();
const mockUnblockIP = jest.fn();

const mockRaspAdmin = {
  getStats: mockGetStats,
  updateConfig: mockUpdateConfig,
  getBlockedIPs: mockGetBlockedIPs,
  unblockIP: mockUnblockIP,
};

const mockGetSessionServiceHealth = jest.fn();

jest.mock('../../server/middleware/auth', () => ({
  authenticateJWT: passthrough,
  getSessionServiceHealth: mockGetSessionServiceHealth,
}));
jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: passthrough,
  getSessionServiceHealth: mockGetSessionServiceHealth,
}));
jest.mock('../../server/middleware/rbac-middleware', () => ({
  requireAdmin: jest.fn(() => passthrough),
  requirePermission: jest.fn(() => passthrough),
  RESOURCES: {},
}));
jest.mock('../../server/middleware/rbac-middleware.js', () => ({
  requireAdmin: jest.fn(() => passthrough),
  requirePermission: jest.fn(() => passthrough),
  RESOURCES: {},
}));
jest.mock('../../src/middleware/rasp', () => ({
  raspAdmin: mockRaspAdmin,
}));
jest.mock('../../src/middleware/rasp.js', () => ({
  raspAdmin: mockRaspAdmin,
}));
jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  const router = require('../../server/routes/security-admin-routes');
  app.use('/', router.default ?? router);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetStats.mockReturnValue({
    config: { enabled: true, blockingMode: false, monitoringOnly: true, alertThreshold: 100 },
    blockedIPs: [],
    requestCount: 0,
    anomalyCount: 0,
  });
  mockGetBlockedIPs.mockReturnValue([]);
  mockGetSessionServiceHealth.mockResolvedValue({ healthy: true, latencyMs: 5 });
});

describe('GET /rasp', () => {
  it('returns 200 with RASP stats', async () => {
    const app = buildApp();
    const res = await request(app).get('/rasp');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('config');
  });

  it('returns 500 when getStats throws', async () => {
    mockGetStats.mockImplementationOnce(() => { throw new Error('rasp error'); });
    const app = buildApp();
    const res = await request(app).get('/rasp');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /rasp/config', () => {
  it('returns 200 when config is updated successfully', async () => {
    mockUpdateConfig.mockReturnValue(undefined);
    const app = buildApp();
    const res = await request(app)
      .post('/rasp/config')
      .send({ enabled: true, blockingMode: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockUpdateConfig).toHaveBeenCalled();
  });

  it('returns 500 when updateConfig throws', async () => {
    mockUpdateConfig.mockImplementationOnce(() => { throw new Error('update failed'); });
    const app = buildApp();
    const res = await request(app)
      .post('/rasp/config')
      .send({ enabled: false });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /rasp/blocking-mode', () => {
  it('returns 400 when enabled field is missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/rasp/blocking-mode').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 200 when blocking mode is toggled', async () => {
    mockUpdateConfig.mockReturnValue(undefined);
    const app = buildApp();
    const res = await request(app)
      .post('/rasp/blocking-mode')
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /rasp/blocked-ips', () => {
  it('returns 200 with list of blocked IPs', async () => {
    mockGetBlockedIPs.mockReturnValueOnce(['192.168.1.1', '10.0.0.5']);
    const app = buildApp();
    const res = await request(app).get('/rasp/blocked-ips');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.blockedIPs).toEqual(['192.168.1.1', '10.0.0.5']);
  });
});

describe('POST /rasp/unblock-ip', () => {
  it('returns 400 when ip is missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/rasp/unblock-ip').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 200 when IP is unblocked', async () => {
    mockUnblockIP.mockReturnValue(undefined);
    const app = buildApp();
    const res = await request(app)
      .post('/rasp/unblock-ip')
      .send({ ip: '192.168.1.100' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockUnblockIP).toHaveBeenCalledWith('192.168.1.100');
  });
});

describe('GET /session-health', () => {
  it('returns 200 with session service health', async () => {
    mockGetSessionServiceHealth.mockResolvedValueOnce({ healthy: true, latencyMs: 12 });
    const app = buildApp();
    const res = await request(app).get('/session-health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /overview', () => {
  it('returns 200 with combined security overview', async () => {
    mockGetSessionServiceHealth.mockResolvedValueOnce({ healthy: true });
    const app = buildApp();
    const res = await request(app).get('/overview');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
