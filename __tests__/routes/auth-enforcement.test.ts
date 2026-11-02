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

const miningRoutes = require('../../server/routes/mining-routes.js');
const nftRoutes = require('../../server/routes/nft-routes.js');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mining', miningRoutes);
  app.use('/api/nft', nftRoutes);
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

});
