import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

describe('Wave 3 auth hardening', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env.JWT_SECRET =
      'test-jwt-secret-1234567890-abcdefghijklmnopqrstuvwxyz';
    process.env.SERVICE_TOKEN =
      'test-service-token-1234567890-abcdefghijklmnopqrstuvwxyz';
    process.env.NODE_ENV = 'test';
    delete process.env.ENABLE_DEMO_USERS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('denies admin users without explicit granular permission', () => {
    const { AuthMiddleware } = require('../microservices/api-gateway/src/middleware/auth-middleware');

    const middleware = AuthMiddleware.requirePermission('users', 'delete');
    const req = {
      user: {
        id: 'admin-1',
        address: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        role: 'admin',
        permissions: [],
      },
    };
    const res = {
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

    middleware(req, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('allows users with explicit granular permission', () => {
    const { AuthMiddleware } = require('../microservices/api-gateway/src/middleware/auth-middleware');

    const middleware = AuthMiddleware.requirePermission('users', 'delete');
    const req = {
      user: {
        id: 'admin-1',
        address: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        role: 'admin',
        permissions: ['users:delete'],
      },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();

    middleware(req, res as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('disables demo user seeding by default in test mode', async () => {
    const { AuthService } = require('../microservices/api-gateway/src/services/auth-service');

    expect(AuthService.isDemoSeedingEnabled()).toBe(false);

    await AuthService.seedDemoUsers();

    await expect(
      AuthService.getUserByAddress('0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234')
    ).resolves.toBeNull();
  });

  it('only seeds demo users when explicitly enabled for tests', async () => {
    process.env.ENABLE_DEMO_USERS = 'true';
    const { AuthService } = require('../microservices/api-gateway/src/services/auth-service');

    expect(AuthService.isDemoSeedingEnabled()).toBe(true);

    await AuthService.seedDemoUsers();

    const admin = await AuthService.getUserByAddress(
      '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234'
    );
    expect(admin?.role).toBe('admin');
  });
});
