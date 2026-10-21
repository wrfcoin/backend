import { describe, it, expect, beforeEach } from '@jest/globals';

// backend#1224: detailed probe bodies are served only to an operator/reader
// bearer token; these tests exercise that detailed contract.
process.env.WRFCOIN_READER_TOKEN = 'test-reader-token';
const READER_REQ: any = { headers: { authorization: 'Bearer test-reader-token' } };

describe('createHealthMiddleware', () => {
  let createHealthMiddleware: any;

  beforeEach(() => {
    jest.resetModules();
    ({ createHealthMiddleware } = require('../server/middleware/create-health-middleware'));
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

  it('returns detailed health and marks degraded when non-critical deps are down', async () => {
    const probes = createHealthMiddleware('test-service', {
      redis: {
        critical: false,
        check: async () => ({ status: 'down' }),
      },
    });
    const res = createResponse();

    await probes.healthHandler(READER_REQ, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.dependencies.redis.status).toBe('down');
  });

  it('returns readiness 503 when draining or a critical dependency is down', async () => {
    const probes = createHealthMiddleware(
      'test-service',
      {
        db: {
          critical: true,
          check: async () => ({ status: 'down' }),
        },
      },
      { state: { draining: false } }
    );
    const res = createResponse();

    await probes.readinessHandler(READER_REQ, res);

    expect(res.statusCode).toBe(503);
    expect(res.body.status).toBe('not_ready');
  });

  it('returns liveness 200 independently of dependency state', () => {
    const probes = createHealthMiddleware('test-service');
    const res = createResponse();

    probes.livenessHandler(READER_REQ, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('alive');
  });

  // backend#1224: anonymous callers get the status word and HTTP code only.
  describe('anonymous callers', () => {
    const leakyDeps = {
      db: {
        critical: true,
        check: async () => ({ status: 'down', error: 'connect ECONNREFUSED 10.0.0.5:5432' }),
      },
    };

    it.each([
      ['no headers', {}],
      ['no auth header', { headers: {} }],
      ['a wrong bearer token', { headers: { authorization: 'Bearer nope' } }],
    ])('health/ready/live are redacted with %s but keep their HTTP codes', async (_label, req) => {
      const probes = createHealthMiddleware('test-service', leakyDeps);
      const health = createResponse();
      const ready = createResponse();
      const live = createResponse();

      await probes.healthHandler(req, health);
      await probes.readinessHandler(req, ready);
      probes.livenessHandler(req, live);

      expect(health.statusCode).toBe(503);
      expect(ready.statusCode).toBe(503);
      expect(live.statusCode).toBe(200);
      for (const res of [health, ready, live]) {
        expect(Object.keys(res.body).sort()).toEqual(['status', 'timestamp']);
      }
      expect(health.body.status).toBe('unhealthy');
      expect(ready.body.status).toBe('not_ready');
      expect(JSON.stringify([health.body, ready.body])).not.toContain('ECONNREFUSED');
    });

    it('the operator token also unlocks the detailed body', async () => {
      process.env.WRFCOIN_OPERATOR_TOKEN = 'test-operator-token';
      try {
        const probes = createHealthMiddleware('test-service', leakyDeps);
        const res = createResponse();

        await probes.healthHandler({ headers: { authorization: 'Bearer test-operator-token' } }, res);

        expect(res.body.dependencies.db.error).toContain('ECONNREFUSED');
      } finally {
        delete process.env.WRFCOIN_OPERATOR_TOKEN;
      }
    });
  });
});
