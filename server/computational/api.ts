/**
 * Computational NFT API
 *
 * TypeScript implementation providing REST API endpoints
 * for computational NFT operations and management.
 */

import express from 'express';
import { Request, Response, Router } from 'express';
import {
  computationalManager,
  ComputationalNFT,
  COMPUTATION_TYPES,
} from './manager.js';

const router: Router = express.Router();

// Types
interface CreateNFTRequest {
  owner: string;
  wasmModule: string;
  computationType: string;
  resourceTier: string;
  metadata?: any;
}

interface ExecuteTaskRequest {
  inputData: any;
}

/**
 * Create a new computational NFT
 */
router.post(
  '/nfts',
  async (req: Request<{}, any, CreateNFTRequest>, res: Response) => {
    try {
      const { owner, wasmModule, computationType, resourceTier, metadata } =
        req.body;

      // Validation
      if (!owner || !wasmModule) {
        return res.status(400).json({
          success: false,
          error: 'Owner and WASM module are required',
        });
      }

      if (!Object.values(COMPUTATION_TYPES).includes(computationType as any)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid computation type',
        });
      }

      const nftId = await computationalManager.registerNFT({
        owner,
        wasmModule,
        computationType,
        resourceTier: resourceTier || 'BASIC',
        metadata,
      });

      res.json({
        success: true,
        data: {
          nftId,
          message: 'Computational NFT created successfully',
        },
      });
    } catch (error) {
      console.error('Error creating computational NFT:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create computational NFT',
      });
    }
  }
);

/**
 * Get NFT details
 */
router.get('/nfts/:nftId', (req: Request, res: Response) => {
  try {
    const { nftId } = req.params;
    const nft = computationalManager.getNFT(nftId);

    if (!nft) {
      return res.status(404).json({
        success: false,
        error: 'NFT not found',
      });
    }

    res.json({
      success: true,
      data: nft,
    });
  } catch (error) {
    console.error('Error fetching NFT:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch NFT',
    });
  }
});

/**
 * List NFTs by owner
 */
router.get('/nfts/owner/:owner', (req: Request, res: Response) => {
  try {
    const { owner } = req.params;
    const nfts = computationalManager.getNFTsByOwner(owner);

    res.json({
      success: true,
      data: {
        owner,
        nfts,
        count: nfts.length,
      },
    });
  } catch (error) {
    console.error('Error fetching NFTs by owner:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch NFTs',
    });
  }
});

/**
 * Execute computational task
 */
router.post(
  '/nfts/:nftId/execute',
  async (
    req: Request<{ nftId: string }, {}, ExecuteTaskRequest>,
    res: Response
  ) => {
    try {
      const { nftId } = req.params;
      const { inputData } = req.body;

      if (!inputData) {
        return res.status(400).json({
          success: false,
          error: 'Input data is required',
        });
      }

      const result = await computationalManager.executeTask(nftId, inputData);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('Error executing computational task:', error);
      res.status(500).json({
        success: false,
        error:
          error instanceof Error ? error.message : 'Failed to execute task',
      });
    }
  }
);

/**
 * Get performance statistics
 */
router.get('/stats/performance', (req: Request, res: Response) => {
  try {
    const stats = computationalManager.getPerformanceStats();

    res.json({
      success: true,
      data: {
        ...stats,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Error fetching performance stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch performance statistics',
    });
  }
});

/**
 * Get supported computation types
 */
router.get('/types', (req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      computationTypes: Object.values(COMPUTATION_TYPES),
      resourceTiers: ['BASIC', 'STANDARD', 'PREMIUM', 'ENTERPRISE'],
      executionEnvironments: ['wasm', 'docker', 'native'],
    },
  });
});

/**
 * Health check endpoint
 */
router.get('/health', (req: Request, res: Response) => {
  const stats = computationalManager.getPerformanceStats();

  res.json({
    success: true,
    data: {
      status: 'healthy',
      service: 'Computational NFT API',
      nftsManaged: stats.totalNFTs,
      verifiedNFTs: stats.verifiedNFTs,
      queueLength: stats.queueLength,
      timestamp: new Date().toISOString(),
    },
  });
});

export default router;
