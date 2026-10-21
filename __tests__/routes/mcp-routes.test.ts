import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const listModelsMock = jest.fn();
const getModelMock = jest.fn();
const listProvidersMock = jest.fn();
const getProviderMock = jest.fn();
const getContextMock = jest.fn();
const processQueryMock = jest.fn();
const processChatMock = jest.fn();
const executeOperationMock = jest.fn();

jest.mock('../../server/utils/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../server/middleware/authMiddleware', () => {
  const requireAuth = (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: true, message: 'Authentication required' });
    }

    req.user = { sub: 'user-1', roles: req.headers['x-test-role'] === 'admin' ? ['admin'] : ['user'] };
    next();
  };

  const requireAdmin = [
    requireAuth,
    (req: any, res: any, next: any) => {
      if (!req.user?.roles?.includes('admin')) {
        return res.status(403).json({ error: true, message: 'Admin privilege required for this operation.' });
      }
      next();
    },
  ];

  return { requireAuth, requireAdmin };
});

jest.mock('../../server/mcp/modelRegistry', () => ({
  listModels: listModelsMock,
  getModel: getModelMock,
}));

jest.mock('../../server/mcp/contextProvider', () => ({
  listProviders: listProvidersMock,
  getProvider: getProviderMock,
  getContext: getContextMock,
}));

jest.mock('../../server/mcp/dataProcessor', () => ({
  processQuery: processQueryMock,
  processChat: processChatMock,
  executeOperation: executeOperationMock,
}));

import router from '../../server/routes/mcp-routes.js';

describe('mcp-routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listModelsMock.mockResolvedValue([{ id: 'm1', name: 'model', provider: 'local', version: '1', capabilities: [], contextTypes: [] }]);
    getModelMock.mockResolvedValue(null);
    listProvidersMock.mockResolvedValue([]);
    getProviderMock.mockResolvedValue(null);
    getContextMock.mockResolvedValue({ data: [] });
    processQueryMock.mockResolvedValue({ ok: true });
    processChatMock.mockResolvedValue({ ok: true });
    executeOperationMock.mockResolvedValue({ ok: true });
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/mcp', router);
    return app;
  }

  it('returns the honest retired response before model listing', async () => {
    const response = await request(createApp()).get('/api/mcp/models');

    expect(response.status).toBe(501);
    expect(response.body).toMatchObject({
      success: false,
      unavailable: true,
      error: {
        code: 'NOT_IMPLEMENTED',
        capability: 'mcp-context',
        see: 'wrfcoin/backend#1181',
      },
    });
    expect(listModelsMock).not.toHaveBeenCalled();
  });

  it('returns the same retired response before execute authorization', async () => {
    const response = await request(createApp())
      .post('/api/mcp/execute')
      .set('Authorization', 'Bearer token')
      .send({ operation: 'get_transaction' });

    expect(response.status).toBe(501);
    expect(response.body).toMatchObject({
      unavailable: true,
      error: { code: 'NOT_IMPLEMENTED', capability: 'mcp-context' },
    });
    expect(executeOperationMock).not.toHaveBeenCalled();
  });

  it('does not fabricate an allowlist response on the retired execute surface', async () => {
    const response = await request(createApp())
      .post('/api/mcp/execute')
      .set('Authorization', 'Bearer token')
      .set('x-test-role', 'admin')
      .send({ operation: 'delete_everything' });

    expect(response.status).toBe(501);
    expect(response.body).toMatchObject({
      unavailable: true,
      error: { code: 'NOT_IMPLEMENTED', capability: 'mcp-context' },
    });
    expect(executeOperationMock).not.toHaveBeenCalled();
  });
});
