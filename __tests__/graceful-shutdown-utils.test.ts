import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

describe('registerGracefulShutdown', () => {
  let registerGracefulShutdown: any;
  let GracefulShutdown: any;

  beforeEach(() => {
    jest.resetModules();
    ({ registerGracefulShutdown } = require('../server/utils/graceful-shutdown'));
    ({ GracefulShutdown } = require('../shared/graceful-shutdown/index.js'));
    GracefulShutdown.resetInstance();
  });

  afterEach(() => {
    GracefulShutdown.resetInstance();
  });

  it('marks the service draining and closes the server during shutdown', async () => {
    const state = { draining: false };
    const cleanup = jest.fn().mockResolvedValue(undefined);
    const close = jest.fn((callback: Function) => callback());
    const server = {
      close,
      on: jest.fn(),
    };

    const shutdown = registerGracefulShutdown({
      serviceName: 'test-service',
      server,
      state,
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      cleanupFns: [
        {
          name: 'cleanup',
          handler: cleanup,
        },
      ],
      timeoutMs: 25,
    });

    const results = await shutdown.shutdown('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(state.draining).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(results.every((result: any) => result.success)).toBe(true);
  });
});
