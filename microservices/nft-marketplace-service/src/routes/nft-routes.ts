import { Router } from 'express';
import { NFTController } from '../controllers/nft-controller.js';

const router = Router();

// GET /api/nft/marketplace - Get marketplace overview
router.get('/marketplace', NFTController.getMarketplace);

// GET /api/nft/all - Get all NFTs with pagination
router.get('/all', NFTController.getAllNFTs);

// GET /api/nft/:tokenId - Get specific NFT details
router.get('/:tokenId', NFTController.getNFT);

// GET /api/nft/collection/:collectionId - Get collection details
router.get('/collection/:collectionId', NFTController.getCollection);

export { router as nftRoutes };
