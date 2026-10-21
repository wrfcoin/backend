import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
const { EventEmitter } = require('events');
const jwt = require('jsonwebtoken');

describe('Byzantine consensus auth hardening', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function createCoordinatorStub() {
    const coordinator = new EventEmitter();
    coordinator.getStatus = jest.fn(() => ({ healthy: true }));
    return coordinator;
  }

  it('fails closed when auth is required without a configured JWT secret', () => {
    delete process.env.JWT_SECRET;
    const {
      ByzantineConsensusMiddleware,
    } = require('../shared/middleware/byzantine-consensus-middleware');

    expect(
      () =>
        new ByzantineConsensusMiddleware(createCoordinatorStub(), {
          requireAuthentication: true,
          corsEnabled: false,
          enableWebSocket: false,
          enableMetrics: false,
        })
    ).toThrow(/JWT_SECRET environment variable must be set/);
  });

  it('rejects missing tokens and accepts valid tokens when auth is enabled', () => {
    process.env.JWT_SECRET =
      'test-jwt-secret-1234567890-abcdefghijklmnopqrstuvwxyz';
    const {
      ByzantineConsensusMiddleware,
    } = require('../shared/middleware/byzantine-consensus-middleware');

    const middleware = new ByzantineConsensusMiddleware(createCoordinatorStub(), {
      requireAuthentication: true,
      corsEnabled: false,
      enableWebSocket: false,
      enableMetrics: false,
    });
    const authMiddleware = (middleware as any).authMiddleware.bind(middleware);
    const unauthenticatedReq = { headers: {} };
    const unauthenticatedRes = {
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
    const next = jest.fn();

    authMiddleware(unauthenticatedReq, unauthenticatedRes as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(unauthenticatedRes.statusCode).toBe(401);

    const token = jwt.sign(
      { sub: 'validator-1' },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'wrfcoin-platform', audience: 'wrfcoin-api' }
    );
    const authenticatedReq = {
      headers: {
        authorization: `Bearer ${token}`,
      },
    };

    authMiddleware(authenticatedReq as any, unauthenticatedRes as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((authenticatedReq as any).user).toBeDefined();
  });
});
