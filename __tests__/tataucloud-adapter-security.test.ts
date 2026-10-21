import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

describe('TatauCloud adapter hardening', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    delete process.env.TATAU_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rejects non-test initialization without an API key', () => {
    jest.doMock('../utils/logger', () => ({
      appLogger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    }));
    const TatauCloudAdapter = require('../server/integrations/tataucloud/adapter');

    expect(() => new TatauCloudAdapter()).toThrow(
      /TATAU_API_KEY environment variable must be set/
    );
  });

  it('allows test mode initialization without an API key', () => {
    jest.doMock('../utils/logger', () => ({
      appLogger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    }));
    const TatauCloudAdapter = require('../server/integrations/tataucloud/adapter');

    const adapter = new TatauCloudAdapter({ testMode: true });

    expect(adapter.testMode).toBe(true);
  });
});
