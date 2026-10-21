import crypto from 'crypto';

jest.mock('express-rate-limit', () => () => (_req: unknown, _res: unknown, next: () => void) => next());
jest.mock('helmet', () => () => (_req: unknown, _res: unknown, next: () => void) => next());
jest.mock('../../middleware/production-cors-cleanup', () => ({
  autoConfigureCORS: jest.fn(),
}));

const serverModule = require('../../server/ai_ml_networks_server_impl.js');
const { __testHooks } = serverModule;

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    },
  };
  return res;
}

describe('AI/ML ensemble route hardening', () => {
  it('uses 6-decimal precision for ensemble round IDs', () => {
    const domainBounds = {
      north: 40.1234567,
      south: 39.1234567,
      east: -103.1234567,
      west: -104.1234567,
    };
    const validTimeRange = {
      start: '2026-03-06T00:00:00Z',
      end: '2026-03-06T01:00:00Z',
    };

    const payload = JSON.stringify({
      domainBounds: {
        north: Number(domainBounds.north).toFixed(6),
        south: Number(domainBounds.south).toFixed(6),
        east: Number(domainBounds.east).toFixed(6),
        west: Number(domainBounds.west).toFixed(6),
      },
      validTimeRange: {
        start: new Date(validTimeRange.start).toISOString(),
        end: new Date(validTimeRange.end).toISOString(),
      },
    });
    const expected = `ens_round_${crypto
      .createHash('sha256')
      .update(payload)
      .digest('hex')
      .slice(0, 20)}`;

    expect(__testHooks.computeEnsembleRoundId(domainBounds, validTimeRange)).toBe(expected);
  });

  it('returns 500-safe response shape from handler when scoring fails', async () => {
    const res = mockRes();
    await __testHooks.handleEnsembleModelStatus(
      { params: { modelId: 'model-1' } },
      res,
      {
        scoreClosedEnsembleRounds: async () => {
          throw new Error('boom');
        },
        ensembleStandings: new Map(),
        toLeaderboardStanding: (standing: unknown) => standing,
      }
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
  });

  it('returns 404 when model standing is missing', async () => {
    const result = await __testHooks.resolveEnsembleModelStatus('missing-model', {
      scoreClosedEnsembleRounds: async () => {},
      ensembleStandings: new Map(),
      toLeaderboardStanding: (standing: unknown) => standing,
    });

    expect(result).toEqual({
      status: 404,
      body: { success: false, error: 'Model standing not found' },
    });
  });
});
