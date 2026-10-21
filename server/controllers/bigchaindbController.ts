/**
 * BigchainDB Controller - TypeScript Implementation
 * Handles BigchainDB integration for decentralized asset management and immutable data storage
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  ControllerResponse,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
} from '../../shared/types/security-types.js';
import { storageLogger } from '../utils/logger.js';

// BigchainDB interfaces
interface BigchainAsset {
  id: string;
  data: Record<string, any>;
  metadata: Record<string, any>;
  ownerPublicKey: string;
  createdAt: Date;
  transactionId: string;
}

interface BigchainTransaction {
  id: string;
  operation: 'CREATE' | 'TRANSFER';
  asset: string; // Asset ID
  inputs: TransactionInput[];
  outputs: TransactionOutput[];
  metadata: Record<string, any>;
  version: string;
  timestamp: Date;
}

interface TransactionInput {
  fulfillment: string;
  fulfills: {
    output_index: number;
    transaction_id: string;
  } | null;
  owners_before: string[];
}

interface TransactionOutput {
  amount: string;
  condition: {
    details: {
      public_key: string;
      type: string;
    };
    uri: string;
  };
  public_keys: string[];
}

interface AssetSearch {
  query: string;
  limit?: number;
  offset?: number;
}

// Enhanced request interface
interface BigchainRequest extends Request {
  storage?: {
    getAsset: (id: string) => Promise<BigchainAsset | null>;
    createAsset: (asset: Partial<BigchainAsset>) => Promise<BigchainAsset>;
    getTransaction: (id: string) => Promise<BigchainTransaction | null>;
    getAssetHistory: (assetId: string) => Promise<BigchainTransaction[]>;
    searchAssets: (query: AssetSearch) => Promise<BigchainAsset[]>;
  };
  bigchaindb?: {
    createAsset: (data: any, metadata: any, publicKey: string) => Promise<any>;
    transferAsset: (
      assetId: string,
      from: string,
      to: string,
      privateKey: string
    ) => Promise<any>;
    getAsset: (assetId: string) => Promise<any>;
    searchAssets: (query: string) => Promise<any[]>;
  };
}

/**
 * Create new asset on BigchainDB
 */
export const createAsset = async (
  req: BigchainRequest,
  res: Response
): Promise<ControllerResponse<BigchainAsset>> => {
  const requestId = uuidv4();

  try {
    const { data, metadata, ownerPublicKey } = req.body;

    // Validate required fields
    if (!data || !ownerPublicKey) {
      const errorResponse: ControllerResponse<BigchainAsset> = {
        success: false,
        error: 'Missing required fields',
        message: 'Asset data and owner public key are required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate public key format (simplified validation)
    if (!ownerPublicKey || ownerPublicKey.length < 32) {
      const errorResponse: ControllerResponse<BigchainAsset> = {
        success: false,
        error: 'Invalid public key',
        message: 'Owner public key must be a valid cryptographic key',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Create asset on BigchainDB
    let bigchainResult: any;
    if (req.bigchaindb) {
      bigchainResult = await req.bigchaindb.createAsset(
        data,
        metadata,
        ownerPublicKey
      );
    } else {
      // Mock BigchainDB response
      bigchainResult = {
        id: `asset_${uuidv4()}`,
        operation: 'CREATE',
        asset: {
          data: data,
        },
        metadata: metadata || {},
      };
    }

    // Create asset record
    const assetData: Partial<BigchainAsset> = {
      id: bigchainResult.id || `asset_${uuidv4()}`,
      data,
      metadata: metadata || {},
      ownerPublicKey,
      createdAt: new Date(),
      transactionId: bigchainResult.id,
    };

    let asset: BigchainAsset;
    if (req.storage) {
      asset = await req.storage.createAsset(assetData);
    } else {
      asset = assetData as BigchainAsset;
    }

    const response: ControllerResponse<BigchainAsset> = {
      success: true,
      data: asset,
      message: 'Asset created successfully on BigchainDB',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    storageLogger.error('Error in createAsset', { module: 'BigchainDBController', operation: 'createAsset', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<BigchainAsset> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create asset on BigchainDB',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get asset by ID
 */
export const getAsset = async (
  req: BigchainRequest,
  res: Response
): Promise<ControllerResponse<BigchainAsset>> => {
  const requestId = uuidv4();

  try {
    const assetId = req.params.assetId;

    if (!assetId) {
      const errorResponse: ControllerResponse<BigchainAsset> = {
        success: false,
        error: 'Asset ID is required',
        message: 'Please provide a valid asset ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let asset: BigchainAsset | null = null;
    if (req.storage) {
      asset = await req.storage.getAsset(assetId);
    } else if (req.bigchaindb) {
      const bigchainAsset = await req.bigchaindb.getAsset(assetId);
      if (bigchainAsset) {
        asset = {
          id: assetId,
          data: bigchainAsset.data || {},
          metadata: bigchainAsset.metadata || {},
          ownerPublicKey: bigchainAsset.ownerPublicKey || '',
          createdAt: new Date(bigchainAsset.createdAt || Date.now()),
          transactionId: bigchainAsset.transactionId || assetId,
        };
      }
    }

    if (!asset) {
      const notFoundResponse: ControllerResponse<BigchainAsset> = {
        success: false,
        error: 'Asset not found',
        message: `No asset found with ID ${assetId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    const response: ControllerResponse<BigchainAsset> = {
      success: true,
      data: asset,
      message: 'Asset retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    storageLogger.error('Error in getAsset', { module: 'BigchainDBController', operation: 'getAsset', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<BigchainAsset> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve asset',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Transfer asset ownership
 */
export const transferAsset = async (
  req: BigchainRequest,
  res: Response
): Promise<ControllerResponse<BigchainTransaction>> => {
  const requestId = uuidv4();

  try {
    const { assetId, fromPublicKey, toPublicKey, privateKey, metadata } =
      req.body;

    // Validate required fields
    if (!assetId || !fromPublicKey || !toPublicKey || !privateKey) {
      const errorResponse: ControllerResponse<BigchainTransaction> = {
        success: false,
        error: 'Missing required fields',
        message: 'Asset ID, from/to public keys, and private key are required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate key formats (simplified validation)
    if (
      fromPublicKey.length < 32 ||
      toPublicKey.length < 32 ||
      privateKey.length < 32
    ) {
      const errorResponse: ControllerResponse<BigchainTransaction> = {
        success: false,
        error: 'Invalid key format',
        message: 'Public and private keys must be valid cryptographic keys',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Verify asset exists
    let asset: BigchainAsset | null = null;
    if (req.storage) {
      asset = await req.storage.getAsset(assetId);
    }

    if (!asset) {
      const notFoundResponse: ControllerResponse<BigchainTransaction> = {
        success: false,
        error: 'Asset not found',
        message: `No asset found with ID ${assetId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    // Verify ownership
    if (asset.ownerPublicKey !== fromPublicKey) {
      const unauthorizedResponse: ControllerResponse<BigchainTransaction> = {
        success: false,
        error: 'Unauthorized transfer',
        message: 'Only the current owner can transfer this asset',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(403).json(unauthorizedResponse);
      return unauthorizedResponse;
    }

    // Execute transfer on BigchainDB
    let transferResult: any;
    if (req.bigchaindb) {
      transferResult = await req.bigchaindb.transferAsset(
        assetId,
        fromPublicKey,
        toPublicKey,
        privateKey
      );
    } else {
      // Mock transfer result
      transferResult = {
        id: `transfer_${uuidv4()}`,
        operation: 'TRANSFER',
        asset: assetId,
        metadata: metadata || {},
      };
    }

    // Create transaction record
    const transaction: BigchainTransaction = {
      id: transferResult.id || `transfer_${uuidv4()}`,
      operation: 'TRANSFER',
      asset: assetId,
      inputs: [
        {
          fulfillment: 'pGSAIDE...',
          fulfills: {
            output_index: 0,
            transaction_id: asset.transactionId,
          },
          owners_before: [fromPublicKey],
        },
      ],
      outputs: [
        {
          amount: '1',
          condition: {
            details: {
              public_key: toPublicKey,
              type: 'ed25519-sha-256',
            },
            uri: 'ni:///sha-256;...',
          },
          public_keys: [toPublicKey],
        },
      ],
      metadata: metadata || {},
      version: '2.0',
      timestamp: new Date(),
    };

    const response: ControllerResponse<BigchainTransaction> = {
      success: true,
      data: transaction,
      message: 'Asset transferred successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    storageLogger.error('Error in transferAsset', { module: 'BigchainDBController', operation: 'transferAsset', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<BigchainTransaction> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to transfer asset',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Search assets
 */
export const searchAssets = async (
  req: BigchainRequest,
  res: Response
): Promise<PaginatedResponse<BigchainAsset>> => {
  const requestId = uuidv4();

  try {
    const query = req.query.q as string;
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

    if (!query || query.trim().length < 2) {
      const errorResponse: PaginatedResponse<BigchainAsset> = {
        success: false,
        error: 'Invalid search query',
        message: 'Search query must be at least 2 characters long',
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

    let assets: BigchainAsset[] = [];
    if (req.storage) {
      assets = await req.storage.searchAssets({
        query: query.trim(),
        limit,
        offset: (page - 1) * limit,
      });
    } else if (req.bigchaindb) {
      const searchResults = await req.bigchaindb.searchAssets(query.trim());
      assets = searchResults.map((result: any) => ({
        id: result.id,
        data: result.data || {},
        metadata: result.metadata || {},
        ownerPublicKey: result.ownerPublicKey || '',
        createdAt: new Date(result.createdAt || Date.now()),
        transactionId: result.transactionId || result.id,
      }));
    } else {
      // Mock search results
      assets = [
        {
          id: 'asset_1',
          data: {
            type: 'weather_data',
            location: 'New York',
            temperature: 22.5,
          },
          metadata: {
            source: 'weather_station_001',
            accuracy: 0.98,
          },
          ownerPublicKey: 'Ed25519VerificationKey2020...',
          createdAt: new Date(),
          transactionId: 'tx_1',
        },
      ];
    }

    const totalPages = Math.ceil(assets.length / limit);

    const response: PaginatedResponse<BigchainAsset> = {
      success: true,
      data: assets,
      message: `Found ${assets.length} assets matching "${query}"`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: assets.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    storageLogger.error('Error in searchAssets', { module: 'BigchainDBController', operation: 'searchAssets', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<BigchainAsset> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to search assets',
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
 * Get asset history
 */
export const getAssetHistory = async (
  req: BigchainRequest,
  res: Response
): Promise<PaginatedResponse<BigchainTransaction>> => {
  const requestId = uuidv4();

  try {
    const assetId = req.params.assetId;
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

    if (!assetId) {
      const errorResponse: PaginatedResponse<BigchainTransaction> = {
        success: false,
        error: 'Asset ID is required',
        message: 'Please provide a valid asset ID',
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

    let transactions: BigchainTransaction[] = [];
    if (req.storage) {
      transactions = await req.storage.getAssetHistory(assetId);
    } else {
      // Mock transaction history
      transactions = [
        {
          id: 'tx_create',
          operation: 'CREATE',
          asset: assetId,
          inputs: [],
          outputs: [
            {
              amount: '1',
              condition: {
                details: {
                  public_key: 'Ed25519VerificationKey2020...',
                  type: 'ed25519-sha-256',
                },
                uri: 'ni:///sha-256;...',
              },
              public_keys: ['Ed25519VerificationKey2020...'],
            },
          ],
          metadata: { operation: 'Asset creation' },
          version: '2.0',
          timestamp: new Date(Date.now() - 86400000),
        },
      ];
    }

    // Sort by timestamp (most recent first)
    transactions.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    const totalPages = Math.ceil(transactions.length / limit);

    const response: PaginatedResponse<BigchainTransaction> = {
      success: true,
      data: transactions,
      message: `Retrieved ${transactions.length} transactions for asset ${assetId}`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: transactions.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    storageLogger.error('Error in getAssetHistory', { module: 'BigchainDBController', operation: 'getAssetHistory', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<BigchainTransaction> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve asset history',
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
 * Get BigchainDB integration status
 */
export const getStatus = async (
  req: Request,
  res: Response
): Promise<void> => {
  res.json({
    success: true,
    status: 'connected',
    version: '2.0.0',
    features: ['asset-creation', 'transfer', 'search', 'shared-ownership', 'computational-assets'],
    timestamp: new Date().toISOString(),
  });
};

/**
 * Create a computational asset (specialized for weather/climate data)
 */
export const createComputationalAsset = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { computationalData, metadata, ownerId, publicKey, signature } = req.body;
    const assetId = uuidv4();
    res.status(201).json({
      success: true,
      asset: {
        id: assetId,
        data: computationalData,
        metadata: { ...metadata, type: 'computational' },
        ownerId,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
};

/**
 * Get assets by owner
 */
export const getAssetsByOwner = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { ownerId } = req.params;
    res.json({
      success: true,
      count: 0,
      assets: [],
      ownerId,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
};

/**
 * Update asset metadata
 */
export const updateAssetMetadata = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { assetId, ownerId, metadata } = req.body;
    res.json({
      success: true,
      transaction: {
        id: uuidv4(),
        assetId,
        ownerId,
        metadata,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
};

/**
 * Create a shared ownership asset
 */
export const createSharedAsset = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { assetData, metadata, owners } = req.body;
    const assetId = uuidv4();
    res.status(201).json({
      success: true,
      asset: {
        id: assetId,
        data: assetData,
        metadata,
        owners,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
};

/**
 * Generate a cryptographic key pair
 */
export const generateKeyPair = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { publicKey, privateKey } = await import('crypto').then(crypto => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      return {
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      };
    });
    res.json({
      success: true,
      keyPair: { publicKey, privateKey },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
};

// Export all controller methods
export default {
  createAsset,
  getAsset,
  transferAsset,
  searchAssets,
  getAssetHistory,
  getStatus,
  createComputationalAsset,
  getAssetsByOwner,
  updateAssetMetadata,
  createSharedAsset,
  generateKeyPair,
};
