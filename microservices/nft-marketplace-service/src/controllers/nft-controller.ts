import { Request, Response } from 'express';
import { ApiResponse, ApiError } from '../models/nft-types.js';
import { BaseResponse, ErrorResponse, NFTErrorCodes } from '../types/api.js';
import { NFTService } from '../services/nft-service.js';

// Database-backed NFT controller - no more mock data!

function createApiResponse<T>(
  data: T,
  meta?: Record<string, string | number | boolean>
): BaseResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
    meta,
  };
}

function createApiError(
  code: string,
  message: string,
  details?: unknown
): ErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      details,
    },
    timestamp: new Date().toISOString(),
  };
}

export class NFTController {
  private static nftService = new NFTService();

  static async getMarketplace(req: Request, res: Response) {
    try {
      const marketplaceData =
        await NFTController.nftService.getMarketplaceStats();
      res.json(createApiResponse(marketplaceData));
    } catch (error) {
      console.error('Marketplace error:', error);
      res
        .status(500)
        .json(
          createApiError(
            'MARKETPLACE_ERROR',
            'Failed to fetch marketplace data',
            error
          )
        );
    }
  }

  static async getNFT(req: Request, res: Response) {
    try {
      const { tokenId } = req.params;

      if (!tokenId) {
        return res
          .status(400)
          .json(
            createApiError(
              NFTErrorCodes.INVALID_TOKEN_ID,
              'Token ID is required'
            )
          );
      }

      const nft = await NFTController.nftService.getNFTById(tokenId);

      if (!nft) {
        return res
          .status(404)
          .json(createApiError(NFTErrorCodes.NFT_NOT_FOUND, 'NFT not found'));
      }

      return res.json(createApiResponse(nft));
    } catch (error) {
      console.error('NFT fetch error:', error);
      return res
        .status(500)
        .json(
          createApiError('NFT_ERROR', 'Failed to fetch NFT details', error)
        );
    }
  }

  static async getCollection(req: Request, res: Response) {
    try {
      const { collectionId } = req.params;

      const collection =
        await NFTController.nftService.getCollectionById(collectionId);

      if (!collection) {
        return res
          .status(404)
          .json(
            createApiError(
              NFTErrorCodes.COLLECTION_NOT_FOUND,
              'Collection not found'
            )
          );
      }

      return res.json(createApiResponse(collection));
    } catch (error) {
      console.error('Collection fetch error:', error);
      return res
        .status(500)
        .json(
          createApiError(
            'COLLECTION_ERROR',
            'Failed to fetch collection details',
            error
          )
        );
    }
  }

  static async getAllNFTs(req: Request, res: Response) {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = parseInt(req.query.limit as string, 10) || 20;

      if (page < 1 || limit < 1 || limit > 100) {
        return res
          .status(400)
          .json(
            createApiError(
              NFTErrorCodes.VALIDATION_ERROR,
              'Invalid pagination parameters'
            )
          );
      }

      const result = await NFTController.nftService.getAllNFTs(page, limit);
      return res.json(createApiResponse(result));
    } catch (error) {
      console.error('NFTs fetch error:', error);
      return res
        .status(500)
        .json(createApiError('NFTS_ERROR', 'Failed to fetch NFTs', error));
    }
  }
}
