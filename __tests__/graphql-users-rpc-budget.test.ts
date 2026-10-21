import { jest } from '@jest/globals';

jest.mock('../graphql/context.js', () => ({
  requireAuth: jest.fn(),
  requireVerifiedWallet: jest.fn(),
}));
jest.mock('../utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock('../graphql/error-handler.js', () => ({
  withPerformanceMonitoring: (
    _operation: string,
    resolver: (...args: any[]) => any
  ) => resolver,
  withRetry: (operation: () => Promise<any>) => operation(),
  formatError: (error: unknown) => error,
  authenticationError: (message: string) => new Error(message),
  notFoundError: (resource: string) => new Error(`${resource} not found`),
  validationError: (message: string) => new Error(message),
  databaseError: (message: string) => new Error(message),
  blockchainError: (message: string) => new Error(message),
  timeoutError: (message: string) => new Error(message),
  ErrorCode: {},
}));
jest.mock('drizzle-orm', () => {
  const expression = (...args: unknown[]) => ({ args });
  return {
    eq: expression,
    gte: expression,
    desc: expression,
    asc: expression,
    and: expression,
    or: expression,
    like: expression,
    sql: expression,
  };
});
jest.mock('../shared/schema.js', () => ({
  users: {
    id: 'id',
    username: 'username',
    email: 'email',
    walletAddress: 'walletAddress',
    displayName: 'displayName',
    reputation: 'reputation',
    lastActiveAt: 'lastActiveAt',
    lastLogin: 'lastLogin',
    updatedAt: 'updatedAt',
    createdAt: 'createdAt',
    isVerified: 'isVerified',
  },
  transactions: {},
  nfts: {},
  userAchievements: {},
  achievements: {},
  weatherStations: {},
  votes: {},
  proposals: {},
  computationalNfts: {},
  carbonCredits: {},
  carbonFootprints: {},
  ammSwaps: {},
  stakingDeposits: {},
  stakingRewards: {},
  liquidityPositions: {},
  computeRewards: {},
}));

import { userResolvers } from '../graphql/resolvers/user-resolvers.js';

const createUser = (index: number) => ({
  id: index,
  username: `user-${index}`,
  email: `user-${index}@example.com`,
  walletAddress: `0x${index.toString(16).padStart(40, '0')}`,
  displayName: `User ${index}`,
  bio: null,
  avatar: null,
  location: null,
  isVerified: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastActiveAt: new Date('2026-01-01T00:00:00.000Z'),
});

describe('GraphQL users RPC budget', () => {
  it('caps a request at 41 provider calls and 10 concurrent calls', async () => {
    const userRecords = Array.from({ length: 20 }, (_, index) =>
      createUser(index + 1)
    );
    const findMany = jest.fn<any>().mockResolvedValue(userRecords);
    const getBlockNumber = jest.fn<any>().mockResolvedValue(1000);

    let inFlight = 0;
    let maxInFlight = 0;
    const boundedRpcResult = jest.fn<any>().mockImplementation(
      () =>
        new Promise<bigint>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          setImmediate(() => {
            inFlight -= 1;
            resolve(1n);
          });
        })
    );

    const context = {
      db: {
        query: {
          users: { findMany },
        },
      },
      provider: { getBlockNumber },
      contracts: {
        wrfToken: { balanceOf: boundedRpcResult },
        wrfGovernor: { getVotes: boundedRpcResult },
      },
      requestId: 'rpc-budget-test',
      clientIP: '127.0.0.1',
    };

    const result = await (userResolvers.Query.users as any)(
      null,
      {
        first: 100,
        skip: 0,
        orderBy: 'joinedAt',
        orderDirection: 'desc',
      },
      context
    );

    expect(result).toHaveLength(20);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 })
    );
    expect(getBlockNumber).toHaveBeenCalledTimes(1);
    expect(boundedRpcResult).toHaveBeenCalledTimes(40);
    expect(maxInFlight).toBeLessThanOrEqual(10);
  });
});
