import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockWeatherServiceInstance = {
  getNearbyStations: jest.fn(),
};
const mockDataServiceInstance = {
  findStationsNearLocation: jest.fn(),
};

jest.mock('../server/services/noaa-nws-api-service', () => {
  return jest.fn().mockImplementation(() => mockWeatherServiceInstance);
});

jest.mock('../server/services/noaa-data-service', () => {
  return jest.fn().mockImplementation(() => mockDataServiceInstance);
});

const mockPubsubIterator = jest.fn(() => ({
  next: jest.fn(),
  return: jest.fn(),
  throw: jest.fn(),
  [Symbol.asyncIterator]() {
    return this;
  },
}));

const mockPubsubPublish = jest.fn().mockResolvedValue(undefined);

jest.mock('../graphql/subscriptions/pubsub.js', () => ({
  pubsub: {
    asyncIterator: mockPubsubIterator,
    publish: mockPubsubPublish,
  },
}));

const mockDbInsert = jest.fn();
const mockWsBroadcastTransaction = jest.fn();

jest.mock('../server/db.js', () => ({
  db: {
    insert: mockDbInsert,
  },
}));

jest.mock('../server/websocket.js', () => ({
  broadcastTransaction: mockWsBroadcastTransaction,
}));

jest.mock('../shared/schema.js', () => ({
  transactions: {},
  blocks: {},
  computationalNfts: {},
}));

jest.mock(
  'drizzle-orm',
  () => ({
    eq: jest.fn(),
    desc: jest.fn(),
    and: jest.fn(),
  }),
  { virtual: true }
);

jest.mock('../server/storage.js', () => ({
  storage: {},
}));

jest.mock(
  '../server/utils/logger.js',
  () => ({
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
    graphqlLogger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
  }),
  { virtual: true }
);

const EnhancedWeatherController = require('../server/controllers/enhanced-weather-controller');
const transactionResolvers = require('../server/graphql/resolvers/transactionResolvers.ts');

describe('Cindy Round 1 backend fixes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('weather stations REST shape', () => {
    it('returns an array for GET /api/weather/stations consumers', async () => {
      const controller = new EnhancedWeatherController();
      controller.useRealData = true;
      mockWeatherServiceInstance.getNearbyStations.mockResolvedValue({
        stations: [
          {
            id: 'KORD',
            name: 'Chicago O Hare',
            latitude: 41.98,
            longitude: -87.9,
            distance: 12,
          },
          {
            id: 'KORD',
            name: 'Chicago O Hare duplicate',
            latitude: 41.98,
            longitude: -87.9,
            distance: 14,
          },
        ],
      });
      mockDataServiceInstance.findStationsNearLocation.mockResolvedValue({
        stations: [
          {
            id: 'USW00094846',
            name: 'Chicago Midway',
            latitude: 41.7868,
            longitude: -87.7522,
            distance: 18,
          },
        ],
      });

      const headers: Record<string, string> = {};
      const json = jest.fn();
      const set = jest.fn((key: string, value: string) => {
        headers[key] = value;
        return res;
      });
      const res = {
        json,
        set,
        status: jest.fn().mockReturnThis(),
      } as any;
      const req = {
        query: { lat: '41.98', lng: '-87.9', limit: '10', radius: '50', source: 'all' },
      } as any;

      await controller.getNearbyStations(req, res);

      expect(set).toHaveBeenCalledWith('X-WRFCoin-Station-Count', '2');
      expect(headers['X-WRFCoin-Station-Source']).toBe('NOAA');
      expect(Array.isArray(json.mock.calls[0][0])).toBe(true);
      expect(json.mock.calls[0][0]).toHaveLength(2);
      expect(json.mock.calls[0][0][0]).toHaveProperty('id', 'KORD');
    });
  });

  describe('transaction subscriptions', () => {
    it('subscribes newTransaction without throwing and uses the NEW_TRANSACTION topic', async () => {
      const iterator = transactionResolvers.Subscription.newTransaction.subscribe();

      expect(mockPubsubIterator).toHaveBeenCalledWith(['NEW_TRANSACTION']);
      expect(iterator).toBeDefined();
    });

    it('publishes newTransaction events when a transaction is created', async () => {
      const mockTransaction = {
        id: 'tx-123',
        txId: 'tx-123',
        fromAddress: '0xabc',
        toAddress: '0xdef',
        amount: '10',
        fee: '1',
        type: 'transfer',
        status: 'PENDING',
        timestamp: new Date(),
        data: null,
      };

      const mockReturning = jest.fn().mockResolvedValue([mockTransaction]);
      const mockValues = jest.fn().mockReturnValue({ returning: mockReturning });

      mockDbInsert.mockReturnValue({ values: mockValues });

      const created = await transactionResolvers.Mutation.createTransaction(
        null,
        {
          senderAddress: '0xabc',
          recipientAddress: '0xdef',
          amount: '10',
          fee: '1',
          operationType: 'transfer',
          data: null,
        }
      );

      expect(created).toEqual(mockTransaction);
      expect(mockDbInsert).toHaveBeenCalled();
      expect(mockValues).toHaveBeenCalled();
      expect(mockReturning).toHaveBeenCalled();
      expect(mockWsBroadcastTransaction).toHaveBeenCalledWith(mockTransaction);
      expect(mockPubsubPublish).toHaveBeenCalledWith('NEW_TRANSACTION', {
        newTransaction: mockTransaction,
      });
    });
  });
});
