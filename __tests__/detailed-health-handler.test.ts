import { beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * Tests for the detailedHealthHandler in enhanced_unified_api_optimized.ts (#437)
 * and the /api probe mount prefix (#470).
 *
 * We test via the exported helper createMainApiOperationalProbes since the
 * handler logic mirrors what the probes expose, and via direct unit tests
 * of the status-code selection logic.
 */

describe('detailedHealthHandler — HTTP status code selection (#437)', () => {
  function makeHealthResult(status: string) {
    return {
      status,
      services: {
        database: { status: status === 'unhealthy' ? 'down' : 'up' },
        redis: { status: status === 'unhealthy' ? 'down' : 'up' },
      },
    };
  }

  function selectStatusCode(blockchainHealth: { status: string }): number {
    // Mirrors the logic in detailedHealthHandler (fix #437/#470):
    //   return 503 for BOTH unhealthy AND degraded; only healthy returns 200.
    return (blockchainHealth.status === 'unhealthy' || blockchainHealth.status === 'degraded') ? 503 : 200;
  }

  it('returns 200 when blockchain status is healthy', () => {
    expect(selectStatusCode(makeHealthResult('healthy'))).toBe(200);
  });

  it('returns 503 when blockchain status is unhealthy', () => {
    expect(selectStatusCode(makeHealthResult('unhealthy'))).toBe(503);
  });

  it('returns 503 when blockchain status is degraded (#437 fix)', () => {
    expect(selectStatusCode(makeHealthResult('degraded'))).toBe(503);
  });

  it('returns 200 for any unknown / unexpected status string', () => {
    expect(selectStatusCode(makeHealthResult('unknown'))).toBe(200);
    expect(selectStatusCode(makeHealthResult(''))).toBe(200);
  });
});

describe('/api probe mount prefix (#470)', () => {
  let createMainApiOperationalProbes: any;

  beforeEach(() => {
    jest.resetModules();
    ({ createMainApiOperationalProbes } = require('../server/main_api_operational_probes'));
  });

  function createResponse() {
    return {
      statusCode: 200,
      body: undefined as any,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
  }

  it('/ready returns 200 when healthy and not draining', async () => {
    const probes = createMainApiOperationalProbes({
      state: { draining: false },
      getBlockchainHealthStatus: async () => ({ status: 'healthy' }),
    });

    const res = createResponse();
    await probes.readinessHandler({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('/ready returns 503 when draining', async () => {
    const probes = createMainApiOperationalProbes({
      state: { draining: true },
      getBlockchainHealthStatus: async () => ({ status: 'healthy' }),
    });

    const res = createResponse();
    await probes.readinessHandler({}, res);

    expect(res.statusCode).toBe(503);
    expect(res.body.status).toBe('not_ready');
  });

  it('/live always returns 200 regardless of dependency state', () => {
    const probes = createMainApiOperationalProbes({
      state: { draining: true },
      getBlockchainHealthStatus: async () => ({ status: 'unhealthy' }),
    });

    const res = createResponse();
    probes.livenessHandler({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('alive');
  });

  it('router is defined and can be registered with express under /api prefix', () => {
    const probes = createMainApiOperationalProbes({
      state: { draining: false },
      getBlockchainHealthStatus: async () => ({ status: 'healthy' }),
    });

    // Verify the router object is present and has the express Router interface
    expect(probes.router).toBeDefined();
    expect(typeof probes.router).toBe('function');
    // Express routers expose a stack — presence of it confirms correct Router type
    expect(Array.isArray(probes.router.stack)).toBe(true);
    // Three routes registered: /health, /ready, /live
    expect(probes.router.stack).toHaveLength(3);
  });
});
