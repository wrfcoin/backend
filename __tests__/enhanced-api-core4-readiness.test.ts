import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// backend#1224: detailed probe bodies are served only to an operator/reader
// bearer token; these tests exercise that detailed contract.
process.env.WRFCOIN_READER_TOKEN = 'test-reader-token';
const READER_REQ: any = { headers: { authorization: 'Bearer test-reader-token' } };

// #758: the live runtime entrypoint (enhanced_unified_api_optimized) must gate
// /api/ready on core4 /readyz, while keeping /health (liveness) independent of
// core4 readiness. These tests exercise the operational-probes factory the
// entrypoint wires up.
describe('enhanced API operational probes — core4 readiness gating (#758)', () => {
  let createEnhancedApiOperationalProbes: any;

  beforeEach(() => {
    jest.resetModules();
    ({ createEnhancedApiOperationalProbes } = require('../server/enhanced_unified_api_operational_probes'));
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

  const healthyCache = async () => ({ status: 'healthy' });

  it('fails readiness when core4 reports not ready', async () => {
    const probes = createEnhancedApiOperationalProbes({
      state: { draining: false },
      getCacheHealthStatus: healthyCache,
      probeCore4Readiness: async () => ({
        status: 'down',
        readinessStatus: 'not_ready',
        reachable: true,
        url: 'http://wrfcoin-node:8556/readyz',
        httpStatus: 503,
        lastError: 'core4 /readyz returned 503',
      }),
    });

    const readyRes = createResponse();
    await probes.readinessHandler(READER_REQ, readyRes);
    expect(readyRes.statusCode).toBe(503);
    expect(readyRes.body.status).toBe('not_ready');
    expect(readyRes.body.dependencies.core4.status).toBe('down');

    // Liveness must stay green even when core4 is not ready.
    const liveRes = createResponse();
    probes.livenessHandler(READER_REQ, liveRes);
    expect(liveRes.statusCode).toBe(200);
    expect(liveRes.body.status).toBe('alive');
  });

  it('fails readiness when required safeMount entries are missing', async () => {
    const probes = createEnhancedApiOperationalProbes({
      state: { draining: false },
      getCacheHealthStatus: healthyCache,
      probeCore4Readiness: async () => ({ status: 'up', readinessStatus: 'ready' }),
      safeMountReadiness: {
        requiredMissing: [
          {
            mountPath: '/api/modules',
            modulePath: './routes/module-controller-routes',
            reason: 'MODULE_NOT_FOUND',
          },
        ],
        optionalMissing: [],
      },
    });

    const readyRes = createResponse();
    await probes.readinessHandler(READER_REQ, readyRes);
    expect(readyRes.statusCode).toBe(503);
    expect(readyRes.body.status).toBe('not_ready');
    expect(readyRes.body.dependencies.safeMounts.status).toBe('down');
    expect(Array.isArray(readyRes.body.dependencies.safeMounts.requiredMissing)).toBe(true);
  });

  it('fails readiness when required safeMount entries are missing without a core4 probe', async () => {
    const probes = createEnhancedApiOperationalProbes({
      state: { draining: false },
      getCacheHealthStatus: healthyCache,
      safeMountReadiness: {
        requiredMissing: [
          {
            mountPath: '/api/modules',
            modulePath: './routes/module-controller-routes',
            reason: 'MODULE_NOT_FOUND',
          },
        ],
        optionalMissing: [],
      },
    });

    const readyRes = createResponse();
    await probes.readinessHandler(READER_REQ, readyRes);
    expect(readyRes.statusCode).toBe(503);
    expect(readyRes.body.status).toBe('not_ready');
    expect(readyRes.body.dependencies.core4).toBeUndefined();
    expect(readyRes.body.dependencies.safeMounts.status).toBe('down');
    expect(Array.isArray(readyRes.body.dependencies.safeMounts.requiredMissing)).toBe(true);
  });

  it('keeps readiness when only optional safeMount entries are missing', async () => {
    const probes = createEnhancedApiOperationalProbes({
      state: { draining: false },
      getCacheHealthStatus: healthyCache,
      probeCore4Readiness: async () => ({ status: 'up', readinessStatus: 'ready' }),
      safeMountReadiness: {
        requiredMissing: [],
        optionalMissing: [
          {
            mountPath: '/api/n8n',
            modulePath: './routes/n8n-routes',
            reason: 'OPTIONAL_TIMEOUT',
          },
        ],
      },
    });

    const readyRes = createResponse();
    await probes.readinessHandler(READER_REQ, readyRes);
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.body.status).toBe('ready');
    expect(readyRes.body.dependencies.safeMounts.status).toBe('degraded');
    expect(readyRes.body.dependencies.safeMounts.requiredMissing).toEqual([]);
  });

  it('keeps /health (liveness) green when only core4 readiness is failing', async () => {
    const probes = createEnhancedApiOperationalProbes({
      state: { draining: false },
      getCacheHealthStatus: healthyCache,
      probeCore4Readiness: async () => ({
        status: 'down',
        readinessStatus: 'not_ready',
      }),
    });

    const healthRes = createResponse();
    await probes.healthHandler(READER_REQ, healthRes);
    // cache healthy + core4 non-critical for /health => not unhealthy (200).
    expect(healthRes.statusCode).toBe(200);
    expect(['healthy', 'degraded']).toContain(healthRes.body.status);
  });

  it('passes readiness when core4 is ready and cache is healthy', async () => {
    const probes = createEnhancedApiOperationalProbes({
      state: { draining: false },
      getCacheHealthStatus: healthyCache,
      probeCore4Readiness: async () => ({
        status: 'up',
        readinessStatus: 'ready',
        reachable: true,
        httpStatus: 200,
      }),
    });

    const readyRes = createResponse();
    await probes.readinessHandler(READER_REQ, readyRes);
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.body.status).toBe('ready');
    expect(readyRes.body.dependencies.core4.status).toBe('up');
  });

  it('fails readiness when core4 probe is unreachable (down)', async () => {
    const probes = createEnhancedApiOperationalProbes({
      state: { draining: false },
      getCacheHealthStatus: healthyCache,
      probeCore4Readiness: async () => ({
        status: 'down',
        readinessStatus: null,
        reachable: false,
        lastError: 'connect ECONNREFUSED',
      }),
    });

    const readyRes = createResponse();
    await probes.readinessHandler(READER_REQ, readyRes);
    expect(readyRes.statusCode).toBe(503);
    expect(readyRes.body.status).toBe('not_ready');
  });

  it('still fails readiness while draining even if core4 is ready', async () => {
    const probes = createEnhancedApiOperationalProbes({
      state: { draining: true },
      getCacheHealthStatus: healthyCache,
      probeCore4Readiness: async () => ({ status: 'up', readinessStatus: 'ready' }),
    });

    const readyRes = createResponse();
    await probes.readinessHandler(READER_REQ, readyRes);
    expect(readyRes.statusCode).toBe(503);
    expect(readyRes.body.status).toBe('not_ready');
  });

  it('preserves cache-only behaviour when no core4 probe is supplied (backward compat)', async () => {
    const probes = createEnhancedApiOperationalProbes({
      state: { draining: false },
      getCacheHealthStatus: healthyCache,
    });

    const readyRes = createResponse();
    await probes.readinessHandler(READER_REQ, readyRes);
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.body.status).toBe('ready');
    expect(readyRes.body.dependencies.core4).toBeUndefined();
  });
});
