import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { nftRoutes } from '../routes/nft-routes.js';

// Mock the NFTService
jest.mock('../services/nft-service', () => ({
  NFTService: jest.fn().mockImplementation(() => ({
    getMarketplaceStats: jest.fn(),
    getNFTById: jest.fn(),
    getCollectionById: jest.fn(),
    getAllNFTs: jest.fn(),
  })),
}));

describe('NFT Controller', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/nft', nftRoutes);
  });

  describe('GET /api/nft/marketplace', () => {
    it('should return marketplace data', async () => {
      const { NFTService } = require('../services/nft-service');
      const mockService = new NFTService();

      mockService.getMarketplaceStats.mockResolvedValue({
        totalNFTs: 100,
        activeListings: 25,
        floorPrice: '0.5 WRF',
        volume24h: '1000 WRF',
        topCollections: [],
      });

      const response = await request(app)
        .get('/api/nft/marketplace')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('totalNFTs');
    });
  });

  describe('GET /api/nft/:tokenId', () => {
    it('should return NFT details', async () => {
      const { NFTService } = require('../services/nft-service');
      const mockService = new NFTService();

      mockService.getNFTById.mockResolvedValue({
        tokenId: 'CL0001',
        name: 'Test NFT',
        description: 'Test Description',
        image: '/test.jpg',
        price: '1.0 WRF',
        owner: '0x123',
        collection: 'test_collection',
        attributes: [],
      });

      const response = await request(app).get('/api/nft/CL0001').expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.tokenId).toBe('CL0001');
    });

    it('should return 404 for non-existent NFT', async () => {
      const { NFTService } = require('../services/nft-service');
      const mockService = new NFTService();

      mockService.getNFTById.mockResolvedValue(null);

      const response = await request(app).get('/api/nft/invalid').expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('NFT_NOT_FOUND');
    });
  });

  describe('GET /api/nft/all', () => {
    it('should return paginated NFT list', async () => {
      const { NFTService } = require('../services/nft-service');
      const mockService = new NFTService();

      mockService.getAllNFTs.mockResolvedValue({
        nfts: [],
        total: 0,
        pages: 0,
      });

      const response = await request(app)
        .get('/api/nft/all?page=1&limit=10')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('nfts');
      expect(response.body.data).toHaveProperty('total');
      expect(response.body.data).toHaveProperty('pages');
    });
  });
});
