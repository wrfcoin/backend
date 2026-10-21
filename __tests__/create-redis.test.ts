import Redis from 'ioredis';
import { jest } from '@jest/globals';
import { createRedisClient } from '../server/utils/create-redis.js';

jest.mock('ioredis', () => {
  return {
    __esModule: true,
    default: jest.fn(),
  };
});

type RedisMockInstance = {
  set: jest.Mock;
  options: any;
  rawInit: { primary: unknown; secondary: unknown };
};

type RedisMock = jest.MockedFunction<typeof Redis>;

const mockRedisClient = Redis as RedisMock;

function setupRedisFactory() {
  const instances: RedisMockInstance[] = [];

  mockRedisClient.mockReset();
  mockRedisClient.mockImplementation((primary: unknown, secondary?: unknown) => {
    const options = typeof primary === 'string' ? secondary : primary;
    const instance: RedisMockInstance = {
      set: jest.fn(),
      options,
      rawInit: { primary, secondary },
    };

    if (options?.maxRetriesPerRequest === null) {
      instance.set.mockImplementation(() => new Promise(() => {}));
    } else {
      instance.set.mockImplementation(() => Promise.reject(new Error('Redis unavailable')));
    }

    instances.push(instance);
    return instance as any;
  });

  return {
    instances,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      reject(new Error('command timed out without completion'));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

describe('createRedisClient defaults', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  it('applies bounded retry and connect timeout defaults', () => {
    const { instances } = setupRedisFactory();
    process.env.REDIS_HOST = 'redis';
    process.env.REDIS_PORT = '6379';
    delete process.env.REDIS_URL;

    const client = createRedisClient({
      failureMode: 'fail-closed',
    });
    expect(instances).toHaveLength(1);
    expect(client.failureMode).toBe('fail-closed');
    expect(client.options.maxRetriesPerRequest).toBe(3);
    expect(client.options.connectTimeout).toBe(2000);
    expect(instances[0].options).toMatchObject({
      host: 'redis',
      port: 6379,
      connectTimeout: 2000,
      maxRetriesPerRequest: 3,
    });
  });

  it('fails commands fast when Redis is unreachable (instead of waiting forever)', async () => {
    const { instances } = setupRedisFactory();

    const client = createRedisClient({
      failureMode: 'fail-closed',
    });
    const start = Date.now();

    await expect(withTimeout(client.set('health-check', '1'), 200)).rejects.toThrow(
      'Redis unavailable'
    );

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
    expect(instances[0].options.maxRetriesPerRequest).toBe(3);
  });

  it('keeps bounded safety options authoritative over extra ioredis options', () => {
    const { instances } = setupRedisFactory();

    createRedisClient({
      failureMode: 'fail-open-cache',
      extra: {
        connectTimeout: 60_000,
        maxRetriesPerRequest: null,
      },
    });

    expect(instances[0].options).toMatchObject({
      connectTimeout: 2000,
      maxRetriesPerRequest: 3,
    });
  });
});
