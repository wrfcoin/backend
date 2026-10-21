/**
 * Computational NFT Routes
 *
 * These routes handle all operations related to computational NFTs,
 * with a focus on weather models, climate simulations, and air quality monitoring.
 */

const express = require('express');
import { Request, Response } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import computationalNftController from '../controllers/computationalNftController.js';

const router = express.Router();

// All computational NFT operations require authentication (#231)
router.use(authenticateJWT);

// Get all NFTs
router.get('/', computationalNftController.getAllComputationalNFTs);

// Get model types for NFT creation
router.get('/model-types', computationalNftController.getAvailableModelTypes);

// Get marketplace NFTs
router.get('/marketplace', computationalNftController.getNFTMarketplace);

// Get sample models for marketplace
router.get('/sample-models', computationalNftController.getSampleModels);

// Get NFTs by region
router.get('/region/:regionCode', computationalNftController.getNFTsByRegion);

// Get a single NFT
router.get('/:id', computationalNftController.getComputationalNFTById);

// Create a new NFT
router.post('/', computationalNftController.createComputationalNFT);

// Update an NFT
router.put('/:id', computationalNftController.updateComputationalNFT);

// Execute an NFT computation
router.post('/:id/execute', computationalNftController.executeComputationalNFT);

// Verify an NFT result
router.post('/:id/verify', computationalNftController.verifyComputationalNFT);

// Transfer NFT ownership
router.post('/:id/transfer', computationalNftController.transferNFTOwnership);

export default router;
