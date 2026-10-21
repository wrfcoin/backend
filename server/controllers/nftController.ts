/**
 * NFT Controller - TypeScript Implementation
 * Handles computational and standard NFT operations with comprehensive validation
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { appLogger } from '../utils/logger.js';
import {
  ControllerResponse,
  ComputationalNFT,
  NFTMetadata,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
} from '../../shared/types/security-types.js';

// Enhanced request interface with storage
interface NFTRequest extends Request {
  storage?: {
    createNFT: (nft: Partial<ComputationalNFT>) => Promise<ComputationalNFT>;
    getNFTByTokenId: (tokenId: string) => Promise<ComputationalNFT | null>;
    getNFTById: (id: string) => Promise<ComputationalNFT | null>;
    getNFTsByOwner: (owner: EthereumAddress) => Promise<ComputationalNFT[]>;
    getNFTsByCreator: (creator: EthereumAddress) => Promise<ComputationalNFT[]>;
    updateNFTMetadata: (
      tokenId: string,
      metadata: NFTMetadata
    ) => Promise<ComputationalNFT>;
    updateNFT: (id: string, updates: Partial<ComputationalNFT>) => Promise<ComputationalNFT | null>;
    getAllNFTs: (
      limit?: number,
      offset?: number
    ) => Promise<ComputationalNFT[]>;
  };
}

// NFT creation interface
interface CreateNFTRequest {
  owner: EthereumAddress;
  metadata: NFTMetadata;
  computationData?: {
    algorithm: string;
    inputData: string;
    energyUsed?: number;
  };
}

// Computation result interface
interface ComputationResult {
  outputData: string;
  computeTime: number;
  energyUsed: number;
  isValid: boolean;
}

/**
 * Create new computational NFT
 */
export const createNFT = async (
  req: NFTRequest,
  res: Response
): Promise<ControllerResponse<ComputationalNFT>> => {
  const requestId = uuidv4();

  try {
    const { owner, metadata, computationData } = req.body as CreateNFTRequest;

    // Validate required fields
    if (!owner || !metadata) {
      const errorResponse: ControllerResponse<ComputationalNFT> = {
        success: false,
        error: 'Missing required NFT fields',
        message: 'NFT must include owner address and metadata',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate Ethereum address
    if (!owner.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<ComputationalNFT> = {
        success: false,
        error: 'Invalid owner address format',
        message: 'Owner must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate metadata structure
    if (!metadata.name || !metadata.description) {
      const errorResponse: ControllerResponse<ComputationalNFT> = {
        success: false,
        error: 'Invalid metadata',
        message: 'Metadata must include name and description',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Generate unique token ID
    const tokenId = `nft_${uuidv4().replace(/-/g, '')}`;

    // Create NFT data
    const newNFTData: Partial<ComputationalNFT> = {
      tokenId,
      owner,
      metadata: {
        name: metadata.name,
        description: metadata.description,
        image: metadata.image || `https://api.wrfcoin.io/nft/${tokenId}/image`,
        attributes: metadata.attributes || [],
        external_url: metadata.external_url,
        animation_url: metadata.animation_url,
      },
      computationData: computationData
        ? {
            algorithm: computationData.algorithm,
            inputData: computationData.inputData,
            outputData: '', // Will be populated when computation completes
            computeTime: 0,
            energyUsed: computationData.energyUsed || 0,
          }
        : {
            algorithm: 'standard',
            inputData: '',
            outputData: '',
            computeTime: 0,
            energyUsed: 0,
          },
      timestamp: new Date(),
      isComputed: !computationData, // Standard NFTs are considered "computed"
    };

    // Use storage if available, otherwise create mock response
    let nft: ComputationalNFT;
    if (req.storage) {
      nft = await req.storage.createNFT(newNFTData);
    } else {
      nft = newNFTData as ComputationalNFT;
    }

    const response: ControllerResponse<ComputationalNFT> = {
      success: true,
      data: nft,
      message: 'NFT created successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to create NFT', { module: 'NFTController', operation: 'createNFT', error: (error as Error).message });
    const errorResponse: ControllerResponse<ComputationalNFT> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create NFT',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get NFT by token ID
 */
export const getNFT = async (
  req: NFTRequest,
  res: Response
): Promise<ControllerResponse<ComputationalNFT>> => {
  const requestId = uuidv4();

  try {
    const tokenId = req.params.tokenId;

    if (!tokenId) {
      const errorResponse: ControllerResponse<ComputationalNFT> = {
        success: false,
        error: 'Token ID is required',
        message: 'Please provide a valid token ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let nft: ComputationalNFT | null = null;
    if (req.storage) {
      nft = await req.storage.getNFTByTokenId(tokenId);
    }

    if (!nft) {
      const notFoundResponse: ControllerResponse<ComputationalNFT> = {
        success: false,
        error: 'NFT not found',
        message: `No NFT found with token ID ${tokenId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    const response: ControllerResponse<ComputationalNFT> = {
      success: true,
      data: nft,
      message: 'NFT retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to retrieve NFT', { module: 'NFTController', operation: 'getNFT', error: (error as Error).message });
    const errorResponse: ControllerResponse<ComputationalNFT> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve NFT',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get NFTs owned by address
 */
export const getNFTsByOwner = async (
  req: NFTRequest,
  res: Response
): Promise<PaginatedResponse<ComputationalNFT>> => {
  const requestId = uuidv4();

  try {
    const owner = req.params.owner as EthereumAddress;
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

    // Validate Ethereum address
    if (!owner || !owner.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: PaginatedResponse<ComputationalNFT> = {
        success: false,
        error: 'Invalid owner address format',
        message: 'Owner must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
        pagination: {
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let allNFTs: ComputationalNFT[] = [];
    if (req.storage) {
      allNFTs = await req.storage.getNFTsByOwner(owner);
    }

    // Implement pagination
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedNFTs = allNFTs.slice(startIndex, endIndex);
    const totalPages = Math.ceil(allNFTs.length / limit);

    const response: PaginatedResponse<ComputationalNFT> = {
      success: true,
      data: paginatedNFTs,
      message: `Retrieved ${paginatedNFTs.length} NFTs for owner ${owner}`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: allNFTs.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to retrieve NFTs by owner', { module: 'NFTController', operation: 'getNFTsByOwner', error: (error as Error).message });
    const errorResponse: PaginatedResponse<ComputationalNFT> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve NFTs by owner',
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Execute computation for computational NFT
 */
export const executeComputation = async (
  req: NFTRequest,
  res: Response
): Promise<ControllerResponse<ComputationResult>> => {
  const requestId = uuidv4();

  try {
    const tokenId = req.params.tokenId;
    const { computationInput } = req.body;

    if (!tokenId) {
      const errorResponse: ControllerResponse<ComputationResult> = {
        success: false,
        error: 'Token ID is required',
        message: 'Please provide a valid token ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Get NFT to verify it exists and is computational
    let nft: ComputationalNFT | null = null;
    if (req.storage) {
      nft = await req.storage.getNFTByTokenId(tokenId);
    }

    if (!nft) {
      const notFoundResponse: ControllerResponse<ComputationResult> = {
        success: false,
        error: 'NFT not found',
        message: `No NFT found with token ID ${tokenId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    // Mock computation execution
    const startTime = Date.now();

    // Simulate computation based on algorithm
    let outputData = '';
    let energyUsed = 0;

    switch (nft.computationData.algorithm) {
      case 'weather_analysis':
        outputData = JSON.stringify({
          analysis: 'Weather pattern analyzed',
          confidence: 0.95,
          predictions: ['Temperature increase', 'Humidity stable'],
        });
        energyUsed = 2.5;
        break;
      case 'hash_computation':
        outputData = `0x${Buffer.from(computationInput || nft.computationData.inputData).toString('hex')}`;
        energyUsed = 1.0;
        break;
      default:
        outputData = JSON.stringify({
          result: 'Computation completed',
          input: computationInput || nft.computationData.inputData,
        });
        energyUsed = 1.5;
    }

    const computeTime = Date.now() - startTime;

    const result: ComputationResult = {
      outputData,
      computeTime,
      energyUsed,
      isValid: true,
    };

    // Update NFT with computation results
    if (req.storage) {
      const updatedNFT = await req.storage.updateNFTMetadata(tokenId, {
        ...nft.metadata,
        attributes: [
          ...nft.metadata.attributes,
          {
            trait_type: 'Computation Status',
            value: 'Completed',
          },
          {
            trait_type: 'Compute Time',
            value: computeTime,
          },
          {
            trait_type: 'Energy Used',
            value: energyUsed,
          },
        ],
      });
    }

    const response: ControllerResponse<ComputationResult> = {
      success: true,
      data: result,
      message: 'Computation executed successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to execute computation', { module: 'NFTController', operation: 'executeComputation', error: (error as Error).message });
    const errorResponse: ControllerResponse<ComputationResult> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to execute computation',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * List all NFTs with pagination
 */
export const listNFTs = async (
  req: NFTRequest,
  res: Response
): Promise<PaginatedResponse<ComputationalNFT>> => {
  const requestId = uuidv4();

  try {
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const offset = (page - 1) * limit;

    let allNFTs: ComputationalNFT[] = [];
    if (req.storage) {
      allNFTs = await req.storage.getAllNFTs(limit, offset);
    }

    // For pagination, we need total count (simplified for this implementation)
    const totalCount = allNFTs.length;
    const totalPages = Math.ceil(totalCount / limit);

    const response: PaginatedResponse<ComputationalNFT> = {
      success: true,
      data: allNFTs,
      message: `Retrieved ${allNFTs.length} NFTs`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to retrieve NFTs', { module: 'NFTController', operation: 'listNFTs', error: (error as Error).message });
    const errorResponse: PaginatedResponse<ComputationalNFT> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve NFTs',
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get NFTs authored (created) by a given address.
 *
 * This is distinct from getNFTsByOwner — a creator is the original author;
 * an owner is the current holder. The route param is `address` to match the
 * api.js route definition: GET /api/nfts/creator/:address (#603).
 */
export const getNFTsByCreator = async (
  req: NFTRequest,
  res: Response
): Promise<PaginatedResponse<ComputationalNFT>> => {
  const requestId = uuidv4();

  try {
    const address = req.params.address as EthereumAddress;
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

    if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: PaginatedResponse<ComputationalNFT> = {
        success: false,
        error: 'Invalid creator address format',
        message: 'Address must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let allNFTs: ComputationalNFT[] = [];
    if (req.storage?.getNFTsByCreator) {
      allNFTs = await req.storage.getNFTsByCreator(address);
    }

    const startIndex = (page - 1) * limit;
    const paginatedNFTs = allNFTs.slice(startIndex, startIndex + limit);
    const totalPages = Math.ceil(allNFTs.length / limit);

    const response: PaginatedResponse<ComputationalNFT> = {
      success: true,
      data: paginatedNFTs,
      message: `Retrieved ${paginatedNFTs.length} NFTs created by ${address}`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: allNFTs.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to retrieve NFTs by creator', {
      module: 'NFTController',
      operation: 'getNFTsByCreator',
      error: (error as Error).message,
    });
    const errorResponse: PaginatedResponse<ComputationalNFT> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve NFTs by creator',
      timestamp: new Date().toISOString(),
      requestId,
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Name aliases so api.js route registrations resolve correctly (#603).
// api.js uses getAllNFTs/getNFTById/updateNFTStatus; the controller uses
// listNFTs/getNFT/no-update-status — add the missing names here.
export const getAllNFTs = listNFTs;
export const getNFTById = getNFT;
export const updateNFTStatus = async (req: NFTRequest, res: Response): Promise<ControllerResponse<ComputationalNFT>> => {
  const requestId = uuidv4();
  try {
    const { id } = req.params;
    const updates = req.body as Partial<ComputationalNFT>;
    let updated: ComputationalNFT | null = null;
    if (req.storage?.updateNFT) {
      updated = await req.storage.updateNFT(id, updates);
    }
    if (!updated) {
      res.status(404).json({ success: false, error: 'NFT not found', timestamp: new Date().toISOString(), requestId });
      return { success: false, error: 'NFT not found', timestamp: new Date().toISOString(), requestId };
    }
    const response: ControllerResponse<ComputationalNFT> = {
      success: true,
      data: updated,
      message: 'NFT updated',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to update NFT', { module: 'NFTController', operation: 'updateNFTStatus', error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Internal server error', timestamp: new Date().toISOString(), requestId });
    return { success: false, error: 'Internal server error', timestamp: new Date().toISOString(), requestId };
  }
};

// Export all controller methods
export default {
  createNFT,
  getNFT,
  getNFTById,
  getNFTsByOwner,
  getNFTsByCreator,
  getAllNFTs,
  updateNFTStatus,
  executeComputation,
  listNFTs,
};
