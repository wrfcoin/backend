import { beforeEach, describe, expect, it, jest } from '@jest/globals';

describe('shared pg pool registry', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('reuses the same pool for identical connection config', () => {
    const poolFactory = jest.fn((config: unknown) => ({
      config,
      on: jest.fn(),
      end: jest.fn(),
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
    }));

    jest.doMock('pg', () => ({
      Pool: poolFactory,
    }));

    const { getSharedPgPool } = require('../server/utils/shared-pg-pool.js');
    const first = getSharedPgPool({ connectionString: 'postgres://one' });
    const second = getSharedPgPool({ connectionString: 'postgres://one' });

    expect(first).toBe(second);
    expect(poolFactory).toHaveBeenCalledTimes(1);
  });

  it('creates a new pool when the connection config changes', () => {
    const poolFactory = jest.fn((config: unknown) => ({
      config,
      on: jest.fn(),
      end: jest.fn(),
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
    }));

    jest.doMock('pg', () => ({
      Pool: poolFactory,
    }));

    const { getSharedPgPool } = require('../server/utils/shared-pg-pool.js');
    const first = getSharedPgPool({ connectionString: 'postgres://one' });
    const second = getSharedPgPool({ connectionString: 'postgres://two' });

    expect(first).not.toBe(second);
    expect(poolFactory).toHaveBeenCalledTimes(2);
  });
});
