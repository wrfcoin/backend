import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const request = require('supertest');
const express = require('express');

const TEST_TOKEN = 'Bearer valid-token';
const TEST_USER = {
  id: 'jwt-user-42',
  address: '0x' + 'a'.repeat(40),
};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const mockRequireAuth = (req: any, res: any, next: any) => {
  if (req.headers.authorization !== TEST_TOKEN) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Please provide a valid token.',
    });
  }

  req.user = {
    ...TEST_USER,
    roles: req.headers['x-test-admin'] === 'true' ? ['admin'] : ['user'],
  };
  next();
};

const mockRequireAdmin = [
  mockRequireAuth,
  (req: any, res: any, next: any) => {
    if (!req.user?.roles?.includes('admin')) {
      return res.status(403).json({
        success: false,
        error: 'Admin privilege required for this operation.',
      });
    }

    next();
  },
];

const passthrough = (_req: any, _res: any, next: any) => next();

const mockFetchCore4Json = jest.fn();
const mockExtractCore4Data = jest.fn((payload: any) => payload);
const mockForwardCore4Headers = jest.fn(() => ({}));

const mockGovernanceController = {
  submitComputationalNFTProposal: jest.fn((req: any, res: any) =>
    res.status(201).json({
      success: true,
      proposer: req.user.id,
    })
  ),
  listProposals: jest.fn((_req: any, res: any) => res.status(200).json({ success: true, proposals: [] })),
  getProposal: jest.fn((_req: any, res: any) => res.status(200).json({ success: true })),
  submitReview: jest.fn((_req: any, res: any) => res.status(200).json({ success: true })),
  stakeForProposal: jest.fn((_req: any, res: any) => res.status(200).json({ success: true })),
  reportComputationComplete: jest.fn((_req: any, res: any) => res.status(200).json({ success: true })),
  getGovernanceStats: jest.fn((_req: any, res: any) => res.status(200).json({ success: true })),
  calculateEpochRewards: jest.fn((req: any, res: any) =>
    res.status(200).json({
      success: true,
      actor: req.user.id,
    })
  ),
  recordSlashingEvent: jest.fn((_req: any, res: any) => res.status(200).json({ success: true })),
  updateGovernanceParameters: jest.fn((_req: any, res: any) => res.status(200).json({ success: true })),
  updateNodeTypeWeights: jest.fn((_req: any, res: any) => res.status(200).json({ success: true })),
  getTransparencyReport: jest.fn((_req: any, res: any) => res.status(200).json({ success: true })),
  getRewardGovernanceState: jest.fn((_req: any, res: any) => res.status(200).json({ success: true })),
};

jest.mock('../../server/middleware/authMiddleware', () => ({
  requireAuth: mockRequireAuth,
  requireAdmin: mockRequireAdmin,
}));

jest.mock('../../middleware/rateLimiting', () => ({
  generalLimiter: passthrough,
  transferLimiter: passthrough,
}));

jest.mock('../../server/utils/logger', () => ({
  logger: mockLogger,
}));

jest.mock('../../utils/logger', () => ({
  logger: mockLogger,
}));

jest.mock('../../shared/core4-route-client.js', () => ({
  extractCore4Data: mockExtractCore4Data,
  fetchCore4Json: mockFetchCore4Json,
  forwardCore4Headers: mockForwardCore4Headers,
  sendCore4Unavailable: (res: any, error: any, message = 'Blockchain node unavailable') =>
    res.status(503).json({
      success: false,
      error: {
        code: 'CORE4_UNAVAILABLE',
        message,
        details: error instanceof Error ? error.message : String(error ?? 'Unknown error'),
      },
    }),
  sendCore4Error: (res: any, response: any, fallbackMessage: string) =>
    res.status(response?.status || 502).json({
      success: false,
      error: {
        code: 'CORE4_ERROR',
        message: response?.payload?.error?.message ?? fallbackMessage,
      },
    }),
  sendNotImplemented: (res: any, message: string) =>
    res.status(501).json({
      success: false,
      error: {
        code: 'NOT_IMPLEMENTED',
        message,
      },
    }),
}));

jest.mock('../../server/controllers/governanceController', () => mockGovernanceController);

const miningRoutes = require('../../server/routes/mining-routes.js');
const nftRoutes = require('../../server/routes/nft-routes.js');
const governanceRoutes = require('../../server/routes/governance.js');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mining', miningRoutes);
  app.use('/api/nft', nftRoutes);
  app.use('/api/governance', governanceRoutes);
  return app;
}

describe('auth-enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchCore4Json.mockImplementation(async (path: string) => {
      if (path === '/nft/nft-123') {
        return {
          ok: true,
          status: 200,
          payload: {
            id: 'nft-123',
            title: 'Storm Badge',
          },
        };
      }

      throw new Error(`Unexpected core4 path: ${path}`);
    });
  });

  it('rejects unauthenticated access to mining routes', async () => {
    const res = await request(createApp()).get('/api/mining/setup/hardware');

    expect(res.status).toBe(401);
  });

  it('allows authenticated access to mining routes', async () => {
    const res = await request(createApp())
      .get('/api/mining/setup/hardware')
      .set('Authorization', TEST_TOKEN);

    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('rejects unauthenticated access to nft routes', async () => {
    const res = await request(createApp()).get('/api/nft/nft-123');

    expect(res.status).toBe(401);
  });

  it('allows authenticated access to nft routes', async () => {
    const previousReader = process.env.WRFCOIN_READER_TOKEN;
    process.env.WRFCOIN_READER_TOKEN = 'test-only-nft-auth-enforcement-reader';
    try {
      const res = await request(createApp())
        .get('/api/nft/nft-123')
        .set('Authorization', TEST_TOKEN);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('nft-123');
      expect(mockFetchCore4Json).toHaveBeenCalledWith(
        '/nft/nft-123',
        expect.objectContaining({
          headers: { authorization: 'Bearer test-only-nft-auth-enforcement-reader' },
        })
      );
    } finally {
      if (previousReader === undefined) delete process.env.WRFCOIN_READER_TOKEN;
      else process.env.WRFCOIN_READER_TOKEN = previousReader;
    }
  });


  it('rejects unauthenticated legacy governance proposal creation', async () => {
    const res = await request(createApp())
      .post('/api/governance/computational-nft/proposals')
      .send({ title: 'Test proposal' });

    expect(res.status).toBe(401);
    expect(mockGovernanceController.submitComputationalNFTProposal).not.toHaveBeenCalled();
  });

  it('allows authenticated legacy governance proposal creation', async () => {
    const res = await request(createApp())
      .post('/api/governance/computational-nft/proposals')
      .set('Authorization', TEST_TOKEN)
      .send({ title: 'Test proposal' });

    expect(res.status).toBe(201);
    expect(res.body.proposer).toBe(TEST_USER.id);
    expect(mockGovernanceController.submitComputationalNFTProposal).toHaveBeenCalled();
  });

  it('blocks non-admin legacy governance reward actions', async () => {
    const res = await request(createApp())
      .post('/api/governance/rewards/calculate-epoch')
      .set('Authorization', TEST_TOKEN)
      .send({});

    expect(res.status).toBe(403);
    expect(mockGovernanceController.calculateEpochRewards).not.toHaveBeenCalled();
  });

  it('allows admin legacy governance reward actions', async () => {
    const res = await request(createApp())
      .post('/api/governance/rewards/calculate-epoch')
      .set('Authorization', TEST_TOKEN)
      .set('X-Test-Admin', 'true')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.actor).toBe(TEST_USER.id);
    expect(mockGovernanceController.calculateEpochRewards).toHaveBeenCalled();
  });
});
