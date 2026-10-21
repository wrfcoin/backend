import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// backend#1224: detailed probe bodies are served only to an operator/reader
// bearer token; these tests exercise that detailed contract.
process.env.WRFCOIN_READER_TOKEN = 'test-reader-token';
const READER_REQ: any = { headers: { authorization: 'Bearer test-reader-token' } };

describe('main_api operational probes', () => {
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

  it('fails health and readiness when core4 becomes unavailable', async () => {
    const probes = createMainApiOperationalProbes({
      state: { draining: false },
      getBlockchainHealthStatus: async () => ({
        status: 'unhealthy',
        services: {
          blockchain: {
            status: 'unhealthy',
            websocket: {
              status: 'down',
              reconnectPending: true,
            },
          },
        },
      }),
    });

    const healthRes = createResponse();
    await probes.healthHandler(READER_REQ, healthRes);
    expect(healthRes.statusCode).toBe(503);
    expect(healthRes.body.status).toBe('unhealthy');
    expect(healthRes.body.dependencies.blockchain.status).toBe('down');
    expect(healthRes.body.dependencies.blockchain.sourceStatus).toBe('unhealthy');

    const readyRes = createResponse();
    await probes.readinessHandler(READER_REQ, readyRes);
    expect(readyRes.statusCode).toBe(503);
    expect(readyRes.body.status).toBe('not_ready');

    const liveRes = createResponse();
    probes.livenessHandler(READER_REQ, liveRes);
    expect(liveRes.statusCode).toBe(200);
    expect(liveRes.body.status).toBe('alive');
  });

  it('still fails readiness while draining', async () => {
    const probes = createMainApiOperationalProbes({
      state: { draining: true },
      getBlockchainHealthStatus: async () => ({
        status: 'healthy',
      }),
    });

    const res = createResponse();
    await probes.readinessHandler(READER_REQ, res);

    expect(res.statusCode).toBe(503);
    expect(res.body.status).toBe('not_ready');
  });
});
