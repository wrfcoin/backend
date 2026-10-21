import { describe, it, expect, jest } from '@jest/globals';
import { createRequire } from 'module';
import { analyticsResolvers } from '../../graphql/resolvers/analytics-resolvers.js';
import { carbonCreditResolvers } from '../../graphql/resolvers/carbon-credit-resolvers.js';
import {
  blocks,
  computationalNfts,
  computationalTasks,
  nfts,
  proposals,
  transactions,
  users,
  validators,
  votes,
  weatherData,
  weatherForecasts,
} from '../../shared/schema.js';

const nodeRequire = createRequire(__filename);
const { DataIndexingService } = nodeRequire(
  '../../server/services/data-indexing-service.js'
);

jest.mock(
  'graphql',
  () => ({
    GraphQLError: class GraphQLError extends Error {},
  }),
  { virtual: true }
);

jest.mock(
  'drizzle-orm',
  () => ({
    eq: jest.fn((left: unknown, right: unknown) => ({ left, right })),
    gte: jest.fn((left: unknown, right: unknown) => ({ left, right })),
    desc: jest.fn((value: unknown) => ({ value, direction: 'desc' })),
    asc: jest.fn((value: unknown) => ({ value, direction: 'asc' })),
    and: jest.fn((...conditions: unknown[]) => conditions),
    or: jest.fn((...conditions: unknown[]) => conditions),
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => ({
        strings,
        values,
      }),
      { raw: jest.fn((value: unknown) => value) }
    ),
  }),
  { virtual: true }
);

jest.mock(
  '../../shared/schema.js',
  () => {
    const tables = {
      users: {},
      weatherData: {},
      weatherForecasts: {},
      validators: {},
      nfts: {},
      transactions: {},
      blocks: {},
      computationalNfts: {},
      computationalTasks: {},
      proposals: {},
      votes: {},
      carbonTrades: {},
      carbonCredits: {},
    };

    return tables;
  },
  { virtual: true }
);

jest.mock(
  '../../graphql/context.js',
  () => ({
    requireAuth: jest.fn((handler: unknown) => handler),
    requireVerifiedWallet: jest.fn((handler: unknown) => handler),
  }),
  { virtual: true }
);

jest.mock(
  '../../graphql/error-handler.js',
  () => ({
    formatError: jest.fn((error: unknown) => error),
  }),
  { virtual: true }
);

jest.mock(
  '../../graphql/subscriptions/pubsub.js',
  () => ({
    pubsub: {
      publish: jest.fn(),
      subscribe: jest.fn(),
    },
  }),
  { virtual: true }
);

jest.mock(
  '../../server/utils/logger.js',
  () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  { virtual: true }
);

jest.mock(
  'lru-cache',
  () => ({
    LRUCache: class LRUCache {
      private store = new Map<string, unknown>();

      constructor(_options: unknown) {}

      get(key: string) {
        return this.store.get(key);
      }

      set(key: string, value: unknown) {
        this.store.set(key, value);
        return this;
      }

      delete(key: string) {
        return this.store.delete(key);
      }

      clear() {
        this.store.clear();
      }
    },
  }),
  { virtual: true }
);

type SelectRow = Record<string, unknown>;

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};

const resolveTableName = (table: unknown) => {
  if (table === users) return 'users';
  if (table === weatherData) return 'weather_data';
  if (table === weatherForecasts) return 'weather_forecasts';
  if (table === nfts) return 'nfts';
  if (table === validators) return 'validators';
  if (table === transactions) return 'transactions';
  if (table === computationalNfts) return 'computational_nfts';
  if (table === computationalTasks) return 'computational_tasks';
  if (table === proposals) return 'proposals';
  if (table === votes) return 'votes';
  if (table === blocks) return 'blocks';
  return 'unknown';
};

const createSelectQueue = (results: SelectRow[][]) => {
  let index = 0;
  const fromTables: string[] = [];

  const select = jest.fn(() => {
    const result = results[index++] ?? [];
    const chain: any = {
      from: jest.fn((table: unknown) => {
        fromTables.push(resolveTableName(table));
        return chain;
      }),
      where: jest.fn(() => chain),
      groupBy: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      then: (resolve: (value: SelectRow[]) => void, reject: (reason?: unknown) => void) =>
        Promise.resolve(result).then(resolve, reject),
    };

    return chain;
  });

  return { select, fromTables };
};

const createCarbonCreditCredit = (overrides: Record<string, unknown> = {}) => ({
  id: 'cc-1',
  nftId: '1',
  metadata: {
    carbonOffset: '10.5',
    projectType: 'renewable_energy',
    verificationStandard: 'VCS',
    issuanceDate: new Date('2024-01-01'),
    expiryDate: new Date('2030-01-01'),
    location: 'California',
    isRetired: false,
    certificationHash: 'QmTest123',
    forSale: true,
    price: '100.0',
  },
  creator: '0x1234567890123456789012345678901234567890',
  owner: '0x1234567890123456789012345678901234567890',
  createdAt: new Date('2024-01-01'),
  ...overrides,
});

const createIndexingService = (rows: unknown[]) => {
  const service = new DataIndexingService({ maxPageSize: 1000 });
  const query = jest.fn().mockResolvedValue({ rows });

  service.storageManager = {
    pool: {
      query,
    },
  } as any;
  service.logger = {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  } as any;

  return { service, query };
};

describe('backend overflow performance queue', () => {
  describe('platformAnalytics', () => {
    it('uses SQL count queries instead of loading whole tables', async () => {
      const { select, fromTables } = createSelectQueue([
        [{ count: 12 }],
        [{ count: 5 }],
        [{ count: 21 }],
        [{ count: 8 }],
        [{ count: 44 }],
        [{ count: 7 }],
        [{ count: 9 }],
        [{ count: 3 }],
        [{ count: 2 }],
        [{ count: 11 }],
        [{ count: 4 }],
        [{ count: 6 }],
        [{ count: 19 }],
        [{ count: 10 }],
      ]);

      const context: any = {
        db: {
          select,
          query: {
            users: { findMany: jest.fn() },
            weatherData: { findMany: jest.fn() },
            weatherForecasts: { findMany: jest.fn() },
            nfts: { findMany: jest.fn() },
            validators: { findMany: jest.fn() },
            transactions: { findMany: jest.fn() },
            computationalNfts: { findMany: jest.fn() },
            computationalTasks: { findMany: jest.fn() },
            proposals: { findMany: jest.fn() },
            votes: { findMany: jest.fn() },
            blocks: { findMany: jest.fn() },
          },
        },
        contracts: {
          wrfToken: {
            totalSupply: jest.fn().mockResolvedValue(BigInt('200')),
            MAX_SUPPLY: jest.fn().mockResolvedValue(BigInt('1000')),
          },
        },
        requestId: 'test-request-id',
      };

      const result = await analyticsResolvers.Query.platformAnalytics(
        null,
        { timeframe: 'month' },
        context
      );

      expect(result.totalUsers).toBe(12);
      expect(result.activeUsers).toBe(5);
      expect(result.totalWeatherData).toBe(21);
      expect(result.totalWeatherForecasts).toBe(8);
      expect(result.totalNFTs).toBe(44);
      expect(result.totalValidators).toBe(7);
      expect(result.totalTransactions).toBe(9);
      expect(result.totalComputationalNFTs).toBe(3);
      expect(result.completedJobs).toBe(2);
      expect(result.totalProposals).toBe(11);
      expect(result.activeProposals).toBe(4);
      expect(result.totalVotes).toBe(6);
      expect(result.totalBlocks).toBe(19);
      expect(result.totalBlocksInPeriod).toBe(10);
      expect(result.tokenSupply).toBe('200');
      expect(result.maxTokenSupply).toBe('1000');
      expect(result.supplyUtilization).toBe('20.00');
      expect(fromTables).toEqual([
        'users',
        'users',
        'weather_data',
        'weather_forecasts',
        'nfts',
        'validators',
        'transactions',
        'computational_nfts',
        'computational_tasks',
        'proposals',
        'proposals',
        'votes',
        'blocks',
        'blocks',
      ]);
      expect(context.db.query.users.findMany).not.toHaveBeenCalled();
      expect(context.db.query.weatherData.findMany).not.toHaveBeenCalled();
    });
  });

  describe('weatherAnalytics', () => {
    it('pushes aggregation into SQL and returns compact daily buckets', async () => {
      const { select, fromTables } = createSelectQueue([
        [
          {
            totalDataPoints: 3,
            avgTemperature: 21.5,
            avgHumidity: 56.25,
            avgPressure: 1011.5,
          },
        ],
        [
          {
            date: '2024-01-01',
            dataPoints: 2,
            avgTemperature: 20,
            avgHumidity: 55,
            avgPressure: 1009,
          },
          {
            date: '2024-01-02',
            dataPoints: 1,
            avgTemperature: 24,
            avgHumidity: 60,
            avgPressure: 1014,
          },
        ],
      ]);

      const context: any = {
        db: {
          select,
          query: {
            weatherData: { findMany: jest.fn() },
          },
        },
        requestId: 'test-request-id',
      };

      const result = await analyticsResolvers.Query.weatherAnalytics(
        null,
        { timeframe: 'week', stationId: 'station-1' },
        context
      );

      expect(result.totalDataPoints).toBe(3);
      expect(result.avgTemperature).toBe('21.50');
      expect(result.avgHumidity).toBe('56.25');
      expect(result.avgPressure).toBe('1011.50');
      expect(result.avgConfidence).toBe('90.00');
      expect(result.dailyData).toEqual([
        {
          date: '2024-01-01',
          dataPoints: 2,
          avgTemperature: 20,
          avgHumidity: 55,
          avgPressure: 1009,
        },
        {
          date: '2024-01-02',
          dataPoints: 1,
          avgTemperature: 24,
          avgHumidity: 60,
          avgPressure: 1014,
        },
      ]);
      expect(fromTables).toEqual(['weather_data', 'weather_data']);
      expect(context.db.query.weatherData.findMany).not.toHaveBeenCalled();
    });
  });

  describe('carbonCredit resolvers', () => {
    it('starts the single-credit blockchain calls in parallel', async () => {
      const credit = createCarbonCreditCredit();
      const callOrder: string[] = [];
      const getCreditDetails = createDeferred<any>();
      const getTradingInfo = createDeferred<[boolean, bigint]>();
      const ownerOf = createDeferred<string>();

      const context: any = {
        db: {
          query: {
            nfts: { findFirst: jest.fn().mockResolvedValue(credit) },
          },
        },
        contracts: {
          carbonCredits: {
            getCreditDetails: jest.fn(() => {
              callOrder.push('getCreditDetails');
              return getCreditDetails.promise;
            }),
            getTradingInfo: jest.fn(() => {
              callOrder.push('getTradingInfo');
              return getTradingInfo.promise;
            }),
            ownerOf: jest.fn(() => {
              callOrder.push('ownerOf');
              return ownerOf.promise;
            }),
          },
        },
        requestId: 'test-request-id',
      };

      const resultPromise = carbonCreditResolvers.Query.carbonCredit(
        null,
        { id: credit.nftId },
        context
      );

      await Promise.resolve();
      expect(callOrder).toEqual([
        'getCreditDetails',
        'getTradingInfo',
        'ownerOf',
      ]);

      getCreditDetails.resolve([
        BigInt('10500'),
        'renewable_energy',
        'VCS',
        BigInt(Math.floor(new Date('2024-01-01').getTime() / 1000)),
        BigInt(Math.floor(new Date('2030-01-01').getTime() / 1000)),
        'California',
        false,
        '0xissuer000000000000000000000000000000000000',
      ]);
      getTradingInfo.resolve([true, BigInt('100')]);
      ownerOf.resolve('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');

      const result = await resultPromise;

      expect(result).toMatchObject({
        id: credit.nftId,
        tokenId: credit.nftId,
        carbonOffset: '10500',
        projectType: 'renewable_energy',
        verificationStandard: 'VCS',
        location: 'California',
        isRetired: false,
        forSale: true,
        price: '100',
        owner: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      });
    });

    it('starts per-credit blockchain calls in parallel for the list resolver', async () => {
      const credit = createCarbonCreditCredit({ nftId: '2' });
      const callOrder: string[] = [];
      const getTradingInfo = createDeferred<[boolean, bigint]>();
      const ownerOf = createDeferred<string>();

      const context: any = {
        db: {
          query: {
            nfts: {
              findMany: jest.fn().mockResolvedValue([credit]),
            },
          },
        },
        contracts: {
          carbonCredits: {
            getTradingInfo: jest.fn(() => {
              callOrder.push('getTradingInfo');
              return getTradingInfo.promise;
            }),
            ownerOf: jest.fn(() => {
              callOrder.push('ownerOf');
              return ownerOf.promise;
            }),
          },
        },
        requestId: 'test-request-id',
      };

      const resultPromise = carbonCreditResolvers.Query.carbonCredits(
        null,
        { first: 1, skip: 0 },
        context
      );

      await Promise.resolve();
      expect(callOrder).toEqual(['getTradingInfo', 'ownerOf']);

      getTradingInfo.resolve([false, BigInt('42')]);
      ownerOf.resolve('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');

      const result = await resultPromise;

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: credit.nftId,
        tokenId: credit.nftId,
        forSale: false,
        price: '42',
        owner: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      });
    });
  });

  describe('DataIndexingService.getRealtimeDataStream', () => {
    it('caps realtime stream rows with an explicit limit', async () => {
      const rows = Array.from({ length: 250 }, (_, index) => ({
        id: index + 1,
      }));
      const { service, query } = createIndexingService(rows);

      const result = await service.getRealtimeDataStream('STATION-1', {
        limit: 250,
        maxAge: 60000,
        includeQuality: false,
      });

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('LIMIT $3');
      expect(params[0]).toBe('STATION-1');
      expect(params[2]).toBe(250);
      expect(result.truncated).toBe(true);
      expect(result.dataPoints).toHaveLength(250);
    });

    it('defaults realtime stream rows to 500 when no limit is provided', async () => {
      const { service, query } = createIndexingService([{ id: 1 }]);

      const result = await service.getRealtimeDataStream('STATION-1');

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('LIMIT $3');
      expect(params[0]).toBe('STATION-1');
      expect(params[2]).toBe(500);
      expect(result.truncated).toBe(false);
    });
  });
});
