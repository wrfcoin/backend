import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { NFTService } from '../../../microservices/nft-marketplace-service/src/services/nft-service.js';
import { DatabaseService } from '../../../microservices/nft-marketplace-service/src/services/database.js';

// Mock MongoDB connection for tests
jest.mock('../../../microservices/nft-marketplace-service/src/services/database', () => ({
  DatabaseService: {
    getInstance: jest.fn(() => ({
      connect: jest.fn(),
      isHealthy: jest.fn(() => true),
      getConnectionStatus: jest.fn(() => 'connected'),
    })),
  },
}));

// Mock Mongoose models
jest.mock('../../../microservices/nft-marketplace-service/src/models/nft-model', () => ({
  NFT: {
    findOne: jest.fn(() => ({
      select: jest.fn(() => Promise.resolve(null)),
    })),
    find: jest.fn(),
    countDocuments: jest.fn(),
    insertMany: jest.fn(),
  },
  NFTCollection: {
    findOne: jest.fn(() => ({
      select: jest.fn(() => Promise.resolve(null)),
    })),
    find: jest.fn(),
    insertMany: jest.fn(),
  },
  NFTMarketplace: {
    findOne: jest.fn(),
    create: jest.fn(),
  },
}));

describe('NFTService', () => {
  let nftService: NFTService;

  beforeEach(() => {
    nftService = new NFTService();
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create NFTService instance', () => {
      expect(nftService).toBeInstanceOf(NFTService);
    });
  });

  describe('getNFTById', () => {
    it('should return null for non-existent NFT', async () => {
      const { NFT } = require('../../../microservices/nft-marketplace-service/src/models/nft-model');
      NFT.findOne.mockReturnValue({
        select: jest.fn(() => Promise.resolve(null)),
      });

      const result = await nftService.getNFTById('invalid-token');
      expect(result).toBeNull();
    });
  });

  describe('getCollectionById', () => {
    it('should return null for non-existent collection', async () => {
      const { NFTCollection } = require('../../../microservices/nft-marketplace-service/src/models/nft-model');
      NFTCollection.findOne.mockReturnValue({
        select: jest.fn(() => Promise.resolve(null)),
      });

      const result = await nftService.getCollectionById('invalid-collection');
      expect(result).toBeNull();
    });
  });

  describe('getAllNFTs', () => {
    it('should return paginated NFT results', async () => {
      const { NFT } = require('../../../microservices/nft-marketplace-service/src/models/nft-model');
      const mockNFTs: any[] = [
        {
          tokenId: 'CL0001',
          name: 'Test NFT',
          description: 'Test Description',
          image: '/test.jpg',
          price: '1.0 WRF',
          owner: '0x123',
          collectionId: 'test_collection',
          attributes: [],
        },
      ];

      const mockChain = {
        select: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        sort: jest.fn(() => Promise.resolve(mockNFTs)),
      };

      // Type the mock chain properly
      const typedMockChain = mockChain as any;

      NFT.find.mockReturnValue(typedMockChain);
      typedMockChain.select.mockReturnValue(typedMockChain);
      typedMockChain.skip.mockReturnValue(typedMockChain);
      typedMockChain.limit.mockReturnValue(typedMockChain);
      NFT.countDocuments.mockResolvedValue(1);

      const result = await nftService.getAllNFTs(1, 20);

      expect(result.nfts).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.pages).toBe(1);
      expect(result.nfts[0].tokenId).toBe('CL0001');
    });
  });
});
