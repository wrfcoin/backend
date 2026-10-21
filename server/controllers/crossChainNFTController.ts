/**
 * Cross-Chain NFT Controller - TypeScript Implementation
 * Handles cross-chain NFT bridging, metadata synchronization, and multi-chain support
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { crosschainLogger } from '../utils/logger.js';
import {
  ControllerResponse,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
} from '../../shared/types/security-types.js';

// =====================================================
// INPUT VALIDATION SCHEMAS
// Security: Prevent injection attacks via strict input validation
// =====================================================

// Ethereum address validation
const ethereumAddressSchema = z
  .string()
  .min(10, 'Address is required')
  .max(128, 'Address too long')
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format');

// NFT ID validation (alphanumeric with underscores/hyphens)
const nftIdSchema = z
  .string()
  .min(1, 'NFT ID is required')
  .max(128, 'NFT ID too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'NFT ID contains invalid characters');

// Chain name validation
const chainNameSchema = z
  .string()
  .min(1, 'Chain name is required')
  .max(32, 'Chain name too long')
  .regex(/^[a-z0-9-]+$/, 'Chain name must be lowercase alphanumeric with hyphens');

// Status validation
const nftStatusSchema = z
  .enum(['active', 'bridging', 'locked', 'burned', 'minted'])
  .optional();

const bridgeStatusSchema = z
  .enum(['pending', 'confirmed', 'failed', 'cancelled'])
  .optional();

// Priority validation
const prioritySchema = z
  .enum(['low', 'medium', 'high', 'urgent'])
  .optional();

// Pagination schemas
const pageSchema = z
  .string()
  .optional()
  .transform((val) => {
    const num = val ? parseInt(val, 10) : 1;
    return isNaN(num) || num < 1 ? 1 : Math.min(num, 10000);
  });

const limitSchema = z
  .string()
  .optional()
  .transform((val) => {
    const num = val ? parseInt(val, 10) : 20;
    return isNaN(num) || num < 1 ? 20 : Math.min(num, 100);
  });

// Request body schemas
const initiateBridgeSchema = z.object({
  nftId: nftIdSchema,
  fromChain: chainNameSchema,
  toChain: chainNameSchema,
  toAddress: ethereumAddressSchema,
});

const syncMetadataSchema = z.object({
  targetChains: z.array(chainNameSchema).max(20, 'Too many target chains').optional(),
  priority: prioritySchema,
});

// Query schemas
const nftQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  owner: ethereumAddressSchema.optional(),
  chain: chainNameSchema.optional(),
  status: nftStatusSchema,
});

const bridgeTransactionsQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  nftId: nftIdSchema.optional(),
  status: bridgeStatusSchema,
  fromChain: chainNameSchema.optional(),
  toChain: chainNameSchema.optional(),
});

// Cross-Chain NFT interfaces
interface CrossChainNFT {
  id: string;
  tokenId: string;
  originalChain: string;
  currentChain: string;
  contractAddress: EthereumAddress;
  owner: EthereumAddress;
  metadata: {
    name: string;
    description: string;
    image: string;
    attributes: Array<{
      trait_type: string;
      value: string | number;
    }>;
    external_url?: string;
    animation_url?: string;
  };
  bridgeHistory: BridgeTransaction[];
  status: 'active' | 'bridging' | 'locked' | 'burned' | 'minted';
  supportedChains: string[];
  bridgeFees: Record<string, PositiveNumber>;
  createdAt: Date;
  updatedAt: Date;
}

interface BridgeTransaction {
  id: string;
  nftId: string;
  fromChain: string;
  toChain: string;
  fromAddress: EthereumAddress;
  toAddress: EthereumAddress;
  bridgeType: 'lock_mint' | 'burn_mint' | 'wrapper';
  status: 'pending' | 'confirmed' | 'failed' | 'cancelled';
  transactions: {
    lockTxHash?: string;
    mintTxHash?: string;
    burnTxHash?: string;
    releaseTxHash?: string;
  };
  fees: {
    bridgeFee: PositiveNumber;
    gasFee: PositiveNumber;
    total: PositiveNumber;
  };
  confirmations: {
    required: number;
    current: number;
  };
  estimatedTime: number; // minutes
  actualTime?: number; // minutes
  errorMessage?: string;
  timestamp: Date;
  completedAt?: Date;
}

interface ChainConfig {
  chainId: string;
  name: string;
  network: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  bridgeContract: EthereumAddress;
  supported: boolean;
  bridgeFee: PositiveNumber;
  averageBlockTime: number; // seconds
  confirmationsRequired: number;
  maxGasPrice: PositiveNumber;
}

interface MetadataSyncJob {
  id: string;
  nftId: string;
  sourceChain: string;
  targetChains: string[];
  status: 'pending' | 'syncing' | 'completed' | 'failed';
  progress: {
    totalChains: number;
    completedChains: number;
    failedChains: string[];
  };
  metadataHash: string;
  syncType: 'initial' | 'update' | 'repair';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  createdAt: Date;
  completedAt?: Date;
}

interface BridgeAnalytics {
  totalNFTs: number;
  totalBridgeTransactions: number;
  successfulBridges: number;
  failedBridges: number;
  averageBridgeTime: number; // minutes
  totalVolume: PositiveNumber;
  topChains: Array<{
    chainId: string;
    name: string;
    volume: number;
    transactions: number;
  }>;
  recentActivity: Array<{
    timestamp: Date;
    type: 'bridge' | 'mint' | 'burn';
    chain: string;
    value: PositiveNumber;
  }>;
}

// Enhanced request interface
interface CrossChainNFTRequest extends Request {
  storage?: {
    getAllNFTs: () => Promise<CrossChainNFT[]>;
    getNFT: (id: string) => Promise<CrossChainNFT | null>;
    createNFT: (nft: Partial<CrossChainNFT>) => Promise<CrossChainNFT>;
    updateNFT: (
      id: string,
      updates: Partial<CrossChainNFT>
    ) => Promise<CrossChainNFT>;
    getBridgeTransactions: (
      nftId?: string,
      status?: string
    ) => Promise<BridgeTransaction[]>;
    createBridgeTransaction: (
      transaction: Partial<BridgeTransaction>
    ) => Promise<BridgeTransaction>;
    updateBridgeTransaction: (
      id: string,
      updates: Partial<BridgeTransaction>
    ) => Promise<BridgeTransaction>;
    getChainConfigs: () => Promise<ChainConfig[]>;
    getMetadataSyncJobs: (status?: string) => Promise<MetadataSyncJob[]>;
    createMetadataSyncJob: (
      job: Partial<MetadataSyncJob>
    ) => Promise<MetadataSyncJob>;
    getBridgeAnalytics: () => Promise<BridgeAnalytics>;
  };
  bridgeService?: {
    initiateBridge: (
      nftId: string,
      fromChain: string,
      toChain: string,
      toAddress: EthereumAddress
    ) => Promise<string>;
    checkBridgeStatus: (transactionId: string) => Promise<any>;
    syncMetadata: (nftId: string, targetChains: string[]) => Promise<boolean>;
    validateChainSupport: (chainId: string) => Promise<boolean>;
    estimateBridgeFee: (
      fromChain: string,
      toChain: string
    ) => Promise<PositiveNumber>;
  };
}

/**
 * Get all cross-chain NFTs
 */
export const getAllNFTs = async (
  req: CrossChainNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate query parameters with Zod
    const validationResult = nftQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      const errorResponse: PaginatedResponse<CrossChainNFT> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Invalid query parameters',
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
      return;
    }

    const { page, limit, owner, chain, status } = validationResult.data;

    let nfts: CrossChainNFT[] = [];
    if (req.storage) {
      nfts = await req.storage.getAllNFTs();
    } else {
      // Mock NFTs for development
      nfts = [
        {
          id: 'nft_1',
          tokenId: '12345',
          originalChain: 'ethereum',
          currentChain: 'polygon',
          contractAddress:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          owner:
            '0x2345678901234567890123456789012345678901' as EthereumAddress,
          metadata: {
            name: 'Climate Data NFT #12345',
            description:
              'Unique weather data collection from San Francisco Bay Area',
            image:
              'https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
            attributes: [
              { trait_type: 'Data Type', value: 'Weather' },
              { trait_type: 'Location', value: 'San Francisco' },
              { trait_type: 'Rarity', value: 'Rare' },
            ],
            external_url: 'https://wrfcoin.org/nft/12345',
          },
          bridgeHistory: [
            {
              id: 'bridge_1',
              nftId: 'nft_1',
              fromChain: 'ethereum',
              toChain: 'polygon',
              fromAddress:
                '0x2345678901234567890123456789012345678901' as EthereumAddress,
              toAddress:
                '0x2345678901234567890123456789012345678901' as EthereumAddress,
              bridgeType: 'lock_mint',
              status: 'confirmed',
              transactions: {
                lockTxHash: '0xabc123...',
                mintTxHash: '0xdef456...',
              },
              fees: {
                bridgeFee: 0.01 as PositiveNumber,
                gasFee: 0.005 as PositiveNumber,
                total: 0.015 as PositiveNumber,
              },
              confirmations: {
                required: 12,
                current: 15,
              },
              estimatedTime: 15,
              actualTime: 12,
              timestamp: new Date(Date.now() - 86400000),
              completedAt: new Date(Date.now() - 86340000),
            },
          ],
          status: 'active',
          supportedChains: ['ethereum', 'polygon', 'bsc', 'avalanche'],
          bridgeFees: {
            ethereum: 0.02 as PositiveNumber,
            polygon: 0.01 as PositiveNumber,
            bsc: 0.005 as PositiveNumber,
            avalanche: 0.01 as PositiveNumber,
          },
          createdAt: new Date('2024-01-15'),
          updatedAt: new Date(),
        },
      ];
    }

    // Apply filters
    if (owner) {
      nfts = nfts.filter(
        nft => nft.owner.toLowerCase() === owner.toLowerCase()
      );
    }
    if (chain) {
      nfts = nfts.filter(nft => nft.currentChain === chain);
    }
    if (status) {
      nfts = nfts.filter(nft => nft.status === status);
    }

    // Sort by creation date (most recent first)
    nfts.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedNFTs = nfts.slice(startIndex, endIndex);
    const totalPages = Math.ceil(nfts.length / limit);

    const response: PaginatedResponse<CrossChainNFT> = {
      success: true,
      data: paginatedNFTs,
      message: `Retrieved ${paginatedNFTs.length} cross-chain NFTs`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: nfts.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
  } catch (error) {
    crosschainLogger.error('Error in getAllNFTs', { module: 'CrossChainNFTController', operation: 'getAllNFTs', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<CrossChainNFT> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve cross-chain NFTs',
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
  }
};

/**
 * Initiate cross-chain bridge
 */
export const initiateBridge = async (
  req: CrossChainNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate request body with Zod
    const validationResult = initiateBridgeSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<BridgeTransaction> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Validation failed: ' + validationResult.error.issues.map(e => e.message).join(', '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    const { nftId, fromChain, toChain, toAddress } = validationResult.data;

    // Get NFT
    let nft: CrossChainNFT | null = null;
    if (req.storage) {
      nft = await req.storage.getNFT(nftId);
    }

    if (!nft) {
      const notFoundResponse: ControllerResponse<BridgeTransaction> = {
        success: false,
        error: 'NFT not found',
        message: `No NFT found with ID ${nftId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return;
    }

    if (nft.currentChain !== fromChain) {
      const errorResponse: ControllerResponse<BridgeTransaction> = {
        success: false,
        error: 'Chain mismatch',
        message: `NFT is currently on ${nft.currentChain}, not ${fromChain}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    if (!nft.supportedChains.includes(toChain)) {
      const errorResponse: ControllerResponse<BridgeTransaction> = {
        success: false,
        error: 'Unsupported chain',
        message: `NFT does not support bridging to ${toChain}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    if (nft.status !== 'active') {
      const errorResponse: ControllerResponse<BridgeTransaction> = {
        success: false,
        error: 'NFT not available',
        message: 'NFT must be in active status to bridge',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Validate chain support
    if (req.bridgeService) {
      const fromChainSupported =
        await req.bridgeService.validateChainSupport(fromChain);
      const toChainSupported =
        await req.bridgeService.validateChainSupport(toChain);

      if (!fromChainSupported || !toChainSupported) {
        const errorResponse: ControllerResponse<BridgeTransaction> = {
          success: false,
          error: 'Chain not supported',
          message: 'One or both chains are not supported by the bridge',
          timestamp: new Date().toISOString(),
          requestId,
        };
        res.status(400).json(errorResponse);
        return;
      }
    }

    // Estimate fees
    let bridgeFee = nft.bridgeFees[toChain] || (0.01 as PositiveNumber);
    if (req.bridgeService) {
      bridgeFee = await req.bridgeService.estimateBridgeFee(fromChain, toChain);
    }

    // Create bridge transaction
    const transactionData: Partial<BridgeTransaction> = {
      id: `bridge_${uuidv4()}`,
      nftId,
      fromChain,
      toChain,
      fromAddress: nft.owner,
      toAddress: toAddress as EthereumAddress,
      bridgeType: 'lock_mint',
      status: 'pending',
      transactions: {},
      fees: {
        bridgeFee,
        gasFee: 0.005 as PositiveNumber,
        total: (bridgeFee + 0.005) as PositiveNumber,
      },
      confirmations: {
        required: 12,
        current: 0,
      },
      estimatedTime: 15,
      timestamp: new Date(),
    };

    let bridgeTransaction: BridgeTransaction;
    if (req.storage) {
      bridgeTransaction =
        await req.storage.createBridgeTransaction(transactionData);
    } else {
      bridgeTransaction = transactionData as BridgeTransaction;
    }

    // Initiate bridge if service is available
    if (req.bridgeService) {
      try {
        const txHash = await req.bridgeService.initiateBridge(
          nftId,
          fromChain,
          toChain,
          toAddress as EthereumAddress
        );
        bridgeTransaction.transactions.lockTxHash = txHash;

        // Update NFT status
        if (req.storage) {
          await req.storage.updateNFT(nftId, {
            status: 'bridging',
            updatedAt: new Date(),
          });
        }
      } catch (error) {
        bridgeTransaction.status = 'failed';
        bridgeTransaction.errorMessage = (error as Error).message;
      }
    }

    const response: ControllerResponse<BridgeTransaction> = {
      success: bridgeTransaction.status !== 'failed',
      data: bridgeTransaction,
      message:
        bridgeTransaction.status === 'failed'
          ? 'Bridge initiation failed'
          : 'Bridge transaction initiated successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res
      .status(bridgeTransaction.status === 'failed' ? 400 : 201)
      .json(response);
  } catch (error) {
    crosschainLogger.error('Error in initiateBridge', { module: 'CrossChainNFTController', operation: 'initiateBridge', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<BridgeTransaction> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to initiate bridge transaction',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

/**
 * Get bridge transactions
 */
export const getBridgeTransactions = async (
  req: CrossChainNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate query parameters with Zod
    const validationResult = bridgeTransactionsQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      const errorResponse: PaginatedResponse<BridgeTransaction> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Invalid query parameters',
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
      return;
    }

    const { page, limit, nftId, status, fromChain, toChain } = validationResult.data;

    let transactions: BridgeTransaction[] = [];
    if (req.storage) {
      transactions = await req.storage.getBridgeTransactions(nftId, status);
    } else {
      // Mock transactions for development
      transactions = [
        {
          id: 'bridge_1',
          nftId: 'nft_1',
          fromChain: 'ethereum',
          toChain: 'polygon',
          fromAddress:
            '0x2345678901234567890123456789012345678901' as EthereumAddress,
          toAddress:
            '0x2345678901234567890123456789012345678901' as EthereumAddress,
          bridgeType: 'lock_mint',
          status: 'confirmed',
          transactions: {
            lockTxHash: '0xabc123...',
            mintTxHash: '0xdef456...',
          },
          fees: {
            bridgeFee: 0.01 as PositiveNumber,
            gasFee: 0.005 as PositiveNumber,
            total: 0.015 as PositiveNumber,
          },
          confirmations: {
            required: 12,
            current: 15,
          },
          estimatedTime: 15,
          actualTime: 12,
          timestamp: new Date(Date.now() - 86400000),
          completedAt: new Date(Date.now() - 86340000),
        },
      ];
    }

    // Apply additional filters
    if (fromChain) {
      transactions = transactions.filter(tx => tx.fromChain === fromChain);
    }
    if (toChain) {
      transactions = transactions.filter(tx => tx.toChain === toChain);
    }

    // Sort by timestamp (most recent first)
    transactions.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedTransactions = transactions.slice(startIndex, endIndex);
    const totalPages = Math.ceil(transactions.length / limit);

    const response: PaginatedResponse<BridgeTransaction> = {
      success: true,
      data: paginatedTransactions,
      message: `Retrieved ${paginatedTransactions.length} bridge transactions`,
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
  } catch (error) {
    crosschainLogger.error('Error in getBridgeTransactions', { module: 'CrossChainNFTController', operation: 'getBridgeTransactions', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<BridgeTransaction> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve bridge transactions',
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
  }
};

/**
 * Sync NFT metadata across chains
 */
export const syncMetadata = async (
  req: CrossChainNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate nftId parameter with Zod
    const nftIdValidation = nftIdSchema.safeParse(req.params.nftId);
    if (!nftIdValidation.success) {
      const errorResponse: ControllerResponse<MetadataSyncJob> = {
        success: false,
        error: nftIdValidation.error.issues[0].message,
        message: 'Please provide a valid NFT ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    // SECURITY: Validate request body with Zod
    const bodyValidation = syncMetadataSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      const errorResponse: ControllerResponse<MetadataSyncJob> = {
        success: false,
        error: bodyValidation.error.issues[0].message,
        message: 'Validation failed: ' + bodyValidation.error.issues.map(e => e.message).join(', '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nftId = nftIdValidation.data;
    const { targetChains, priority } = bodyValidation.data;

    // Get NFT
    let nft: CrossChainNFT | null = null;
    if (req.storage) {
      nft = await req.storage.getNFT(nftId);
    }

    if (!nft) {
      const notFoundResponse: ControllerResponse<MetadataSyncJob> = {
        success: false,
        error: 'NFT not found',
        message: `No NFT found with ID ${nftId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return;
    }

    // Use supported chains if target chains not specified
    const chainsToSync =
      targetChains ||
      nft.supportedChains.filter(chain => chain !== nft.currentChain);

    // Create sync job
    const syncJobData: Partial<MetadataSyncJob> = {
      id: `sync_${uuidv4()}`,
      nftId,
      sourceChain: nft.currentChain,
      targetChains: chainsToSync,
      status: 'pending',
      progress: {
        totalChains: chainsToSync.length,
        completedChains: 0,
        failedChains: [],
      },
      metadataHash: `0x${require('crypto').createHash('sha256').update(JSON.stringify(nft.metadata)).digest('hex')}`,
      syncType: 'update',
      priority: priority || 'medium',
      createdAt: new Date(),
    };

    let syncJob: MetadataSyncJob;
    if (req.storage) {
      syncJob = await req.storage.createMetadataSyncJob(syncJobData);
    } else {
      syncJob = syncJobData as MetadataSyncJob;
    }

    // Initiate sync if service is available
    if (req.bridgeService) {
      const syncStarted = await req.bridgeService.syncMetadata(
        nftId,
        chainsToSync
      );
      if (syncStarted) {
        syncJob.status = 'syncing';
      } else {
        syncJob.status = 'failed';
      }
    }

    const response: ControllerResponse<MetadataSyncJob> = {
      success: syncJob.status !== 'failed',
      data: syncJob,
      message:
        syncJob.status === 'failed'
          ? 'Metadata sync failed to start'
          : 'Metadata sync job created successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(syncJob.status === 'failed' ? 400 : 201).json(response);
  } catch (error) {
    crosschainLogger.error('Error in syncMetadata', { module: 'CrossChainNFTController', operation: 'syncMetadata', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<MetadataSyncJob> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to sync metadata',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

/**
 * Get bridge analytics
 */
export const getBridgeAnalytics = async (
  req: CrossChainNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    let analytics: BridgeAnalytics;
    if (req.storage) {
      analytics = await req.storage.getBridgeAnalytics();
    } else {
      // Mock analytics for development
      analytics = {
        totalNFTs: 1250,
        totalBridgeTransactions: 3420,
        successfulBridges: 3285,
        failedBridges: 135,
        averageBridgeTime: 12.5,
        totalVolume: 15750.25 as PositiveNumber,
        topChains: [
          {
            chainId: 'ethereum',
            name: 'Ethereum',
            volume: 5420,
            transactions: 1250,
          },
          {
            chainId: 'polygon',
            name: 'Polygon',
            volume: 3280,
            transactions: 985,
          },
        ],
        recentActivity: [
          {
            timestamp: new Date(Date.now() - 3600000),
            type: 'bridge',
            chain: 'ethereum',
            value: 0.025 as PositiveNumber,
          },
        ],
      };
    }

    const response: ControllerResponse<BridgeAnalytics> = {
      success: true,
      data: analytics,
      message: 'Bridge analytics retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error) {
    crosschainLogger.error('Error in getBridgeAnalytics', { module: 'CrossChainNFTController', operation: 'getBridgeAnalytics', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<BridgeAnalytics> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve bridge analytics',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

/**
 * Get NFT transfers (alias for getBridgeTransactions)
 */
export const getNFTTransfers = getBridgeTransactions;

/**
 * Get NFT transfer by ID
 */
export const getNFTTransferById = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();
  try {
    const { id } = req.params;
    res.json({
      success: true,
      transfer: { id, status: 'pending', timestamp: new Date().toISOString() },
      requestId,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message, requestId });
  }
};

/**
 * Create NFT transfer (alias for initiateBridge)
 */
export const createNFTTransfer = initiateBridge;

/**
 * Update NFT transfer status
 */
export const updateNFTTransferStatus = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();
  try {
    const { id } = req.params;
    const { status } = req.body;
    res.json({
      success: true,
      transfer: { id, status, updatedAt: new Date().toISOString() },
      requestId,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message, requestId });
  }
};

/**
 * Get bridge visualization data
 */
export const getBridgeVisualization = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();
  try {
    res.json({
      success: true,
      visualization: {
        chains: [],
        transfers: [],
        metrics: { totalTransfers: 0, activeChains: 0 },
      },
      requestId,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message, requestId });
  }
};

// Export all controller methods
export default {
  getAllNFTs,
  initiateBridge,
  getBridgeTransactions,
  syncMetadata,
  getBridgeAnalytics,
  getNFTTransfers,
  getNFTTransferById,
  createNFTTransfer,
  updateNFTTransferStatus,
  getBridgeVisualization,
};
