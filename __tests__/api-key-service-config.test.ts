import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

describe('ApiKeyService secret validation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('fails fast when API_KEY_ENCRYPTION_KEY is missing', async () => {
    delete process.env.API_KEY_ENCRYPTION_KEY;
    jest.doMock('../drizzle/db.js', () => ({
      __esModule: true,
      default: {},
    }));
    jest.doMock('../server/utils/logger.js', () => ({
      appLogger: {
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      },
      logError: jest.fn(),
    }));

    const { ApiKeyService } = await import('../services/api-key-service.js');

    expect(() => new ApiKeyService()).toThrow(
      'FATAL: API_KEY_ENCRYPTION_KEY environment variable must be set. Generate one with: openssl rand -hex 32'
    );
  });
});
