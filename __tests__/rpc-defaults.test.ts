import { describe, it, expect, beforeEach } from '@jest/globals';

describe('blockchain RPC default port', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
    delete process.env.DEVNET_RPC_URL;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('DEVNET defaults to :8556 when DEVNET_RPC_URL is unset', async () => {
    const { NetworkConfig } = await import('../server/utils/constants.js');
    expect(NetworkConfig.DEVNET.rpcUrl).toBe('http://localhost:8556');
  });

  it('DEVNET uses DEVNET_RPC_URL when set', async () => {
    process.env.DEVNET_RPC_URL = 'http://192.0.2.2:8556';
    const { NetworkConfig } = await import('../server/utils/constants.js');
    expect(NetworkConfig.DEVNET.rpcUrl).toBe('http://192.0.2.2:8556');
  });
});
