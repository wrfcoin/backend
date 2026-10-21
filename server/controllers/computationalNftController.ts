/**
 * Computational NFT Controller - TypeScript Implementation
 * Handles computational NFTs with execution capabilities and result storage
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import createLogger from '../utils/logger.js';
const nftLogger = createLogger('nft');
import {
  ControllerResponse,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
} from '../../shared/types/security-types.js';

// Zod validation schemas for Computational NFT operations
const ethereumAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');
const tokenIdSchema = z.string().max(128).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid token ID format');
const nftIdSchema = z.string().max(256).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid NFT ID format');

const computationTypeSchema = z.enum([
  'weather_analysis',
  'climate_modeling',
  'data_processing',
  'ml_inference',
  'custom',
]);

const codeLanguageSchema = z.enum(['javascript', 'python', 'wasm', 'rust']);

const codeSchema = z.object({
  language: codeLanguageSchema,
  source: z.string().min(1).max(1000000, 'Source code too large'),
  dependencies: z.array(z.string().max(256)).max(100).default([]),
  entryPoint: z.string().min(1).max(256),
});

const computeRequirementsSchema = z.object({
  cpu: z.number().min(1).max(128).default(1),
  memory: z.number().min(64).max(1048576).default(512), // MB
  storage: z.number().min(1).max(1048576).default(100), // MB
  maxRuntime: z.number().min(1).max(86400).default(30), // seconds
});

const metadataSchema = z.object({
  parameters: z.record(z.string(), z.unknown()).default({}),
  expectedInputs: z.array(z.string().max(256)).max(100).default([]),
  expectedOutputs: z.array(z.string().max(256)).max(100).default([]),
  computeRequirements: computeRequirementsSchema.default({} as any),
  tags: z.array(z.string().max(64)).max(50).default([]),
}).default({} as any);

const createNftSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(10000).optional(),
  owner: ethereumAddressSchema,
  creator: ethereumAddressSchema,
  computationType: computationTypeSchema,
  code: codeSchema,
  metadata: metadataSchema,
});

const executeNftSchema = z.object({
  nftId: nftIdSchema,
  executor: ethereumAddressSchema,
  inputs: z.record(z.string(), z.unknown()),
  maxGasLimit: z.number().min(21000).max(100000000).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  resultStorage: z.enum(['blockchain', 'ipfs', 'temporary']).optional(),
});

const transferOwnershipSchema = z.object({
  newOwner: ethereumAddressSchema,
});

// Computational NFT interfaces
interface ComputationalNFT {
  id: string;
  tokenId: string;
  name: string;
  description: string;
  owner: EthereumAddress;
  creator: EthereumAddress;
  computationType:
    | 'weather_analysis'
    | 'climate_modeling'
    | 'data_processing'
    | 'ml_inference'
    | 'custom';
  code: {
    language: 'javascript' | 'python' | 'wasm' | 'rust';
    source: string;
    dependencies: string[];
    entryPoint: string;
  };
  metadata: {
    parameters: Record<string, any>;
    expectedInputs: string[];
    expectedOutputs: string[];
    computeRequirements: {
      cpu: number; // cores
      memory: number; // MB
      storage: number; // MB
      maxRuntime: number; // seconds
    };
    tags: string[];
  };
  status: 'active' | 'suspended' | 'deprecated';
  executionCount: number;
  totalRewards: PositiveNumber;
  createdAt: Date;
  updatedAt: Date;
}

interface ExecutionRequest {
  nftId: string;
  inputs: Record<string, any>;
  maxGasLimit?: number;
  priority?: 'low' | 'normal' | 'high';
  resultStorage?: 'blockchain' | 'ipfs' | 'temporary';
}

interface ExecutionResult {
  id: string;
  nftId: string;
  executor: EthereumAddress;
  inputs: Record<string, any>;
  outputs: Record<string, any>;
  executionTime: number; // milliseconds
  gasUsed: number;
  cost: PositiveNumber;
  status: 'success' | 'failed' | 'timeout' | 'error';
  errorMessage?: string;
  blockNumber?: number;
  transactionHash?: string;
  timestamp: Date;
}

interface NFTMarketplace {
  nftId: string;
  price: PositiveNumber;
  currency: 'WRF' | 'ETH';
  seller: EthereumAddress;
  executionRights: 'transfer' | 'license' | 'unlimited';
  licenseTerms?: string;
  isActive: boolean;
  createdAt: Date;
}

// Enhanced request interface
interface ComputationalNFTRequest extends Request {
  storage?: {
    getAllNFTs: () => Promise<ComputationalNFT[]>;
    getNFT: (id: string) => Promise<ComputationalNFT | null>;
    createNFT: (nft: Partial<ComputationalNFT>) => Promise<ComputationalNFT>;
    updateNFT: (
      id: string,
      updates: Partial<ComputationalNFT>
    ) => Promise<ComputationalNFT>;
    getExecutionHistory: (
      nftId: string,
      limit?: number
    ) => Promise<ExecutionResult[]>;
    createExecution: (
      execution: Partial<ExecutionResult>
    ) => Promise<ExecutionResult>;
    getMarketListings: () => Promise<NFTMarketplace[]>;
  };
  executor?: {
    executeNFT: (nft: ComputationalNFT, inputs: any) => Promise<any>;
    validateCode: (code: any) => Promise<boolean>;
    estimateGas: (nft: ComputationalNFT, inputs: any) => Promise<number>;
  };
  blockchain?: {
    mintNFT: (nft: ComputationalNFT) => Promise<string>;
    transferNFT: (
      tokenId: string,
      from: EthereumAddress,
      to: EthereumAddress
    ) => Promise<string>;
  };
}

/**
 * Create computational NFT
 */
export const createComputationalNFT = async (
  req: ComputationalNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    // Zod validation
    const validationResult = createNftSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<ComputationalNFT> = {
        success: false,
        error: 'Validation failed',
        message: validationResult.error.issues[0]?.message || 'Invalid input data',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    const {
      name,
      description,
      owner,
      creator,
      computationType,
      code,
      metadata,
    } = validationResult.data;

    // Validate code if executor is available
    let codeValid = true;
    if (req.executor) {
      codeValid = await req.executor.validateCode(code);
    }

    if (!codeValid) {
      const errorResponse: ControllerResponse<ComputationalNFT> = {
        success: false,
        error: 'Invalid code',
        message: 'Code validation failed - syntax or security issues detected',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Create NFT data
    const nftData: Partial<ComputationalNFT> = {
      id: `cnft_${uuidv4()}`,
      tokenId: '', // Will be set after minting
      name,
      description: description || '',
      owner: owner as EthereumAddress,
      creator: creator as EthereumAddress,
      computationType,
      code: {
        ...code,
        dependencies: code.dependencies || [],
      },
      metadata: {
        parameters: metadata?.parameters || {},
        expectedInputs: metadata?.expectedInputs || [],
        expectedOutputs: metadata?.expectedOutputs || [],
        computeRequirements: metadata?.computeRequirements || {
          cpu: 1,
          memory: 512,
          storage: 100,
          maxRuntime: 30,
        },
        tags: metadata?.tags || [],
      },
      status: 'active',
      executionCount: 0,
      totalRewards: 0 as PositiveNumber,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let nft: ComputationalNFT;
    if (req.storage) {
      nft = await req.storage.createNFT(nftData);
    } else {
      nft = nftData as ComputationalNFT;
    }

    // Mint NFT on blockchain
    let tokenId = '';
    if (req.blockchain) {
      tokenId = await req.blockchain.mintNFT(nft);
      nft.tokenId = tokenId;

      // Update with token ID
      if (req.storage) {
        nft = await req.storage.updateNFT(nft.id, { tokenId });
      }
    } else {
      nft.tokenId = `token_${uuidv4()}`;
    }

    const response: ControllerResponse<ComputationalNFT> = {
      success: true,
      data: nft,
      message: 'Computational NFT created successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
  } catch (error) {
    nftLogger.error('Error in createComputationalNFT', { error: (error as Error).message });
    const errorResponse: ControllerResponse<ComputationalNFT> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create computational NFT',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

/**
 * Execute computational NFT
 */
export const executeNFT = async (
  req: ComputationalNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    // Zod validation
    const validationResult = executeNftSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<ExecutionResult> = {
        success: false,
        error: 'Validation failed',
        message: validationResult.error.issues[0]?.message || 'Invalid input data',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    const { nftId, inputs, maxGasLimit, priority, resultStorage, executor } =
      validationResult.data;

    // Get NFT
    let nft: ComputationalNFT | null = null;
    if (req.storage) {
      nft = await req.storage.getNFT(nftId);
    }

    if (!nft) {
      const notFoundResponse: ControllerResponse<ExecutionResult> = {
        success: false,
        error: 'NFT not found',
        message: `No computational NFT found with ID ${nftId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return;
    }

    if (nft.status !== 'active') {
      const errorResponse: ControllerResponse<ExecutionResult> = {
        success: false,
        error: 'NFT not executable',
        message: 'NFT must be in active status to execute',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Validate inputs against expected inputs
    const expectedInputs = nft.metadata.expectedInputs;
    if (expectedInputs.length > 0) {
      const missingInputs = expectedInputs.filter(input => !(input in inputs));
      if (missingInputs.length > 0) {
        const errorResponse: ControllerResponse<ExecutionResult> = {
          success: false,
          error: 'Missing required inputs',
          message: `Missing inputs: ${missingInputs.join(', ')}`,
          timestamp: new Date().toISOString(),
          requestId,
        };
        res.status(400).json(errorResponse);
        return;
      }
    }

    // Estimate gas if available
    let estimatedGas = maxGasLimit || 1000000;
    if (req.executor) {
      estimatedGas = await req.executor.estimateGas(nft, inputs);
    }

    // Execute NFT
    const startTime = Date.now();
    let executionResult: any;
    let gasUsed = 0;
    let status: 'success' | 'failed' | 'timeout' | 'error' = 'success';
    let errorMessage: string | undefined;

    try {
      if (req.executor) {
        executionResult = await req.executor.executeNFT(nft, inputs);
        gasUsed = Math.floor(estimatedGas * 0.8); // Mock gas usage
      } else {
        // Mock execution for development
        executionResult = {
          processed: true,
          result: `Computation completed for ${nft.computationType}`,
          timestamp: new Date().toISOString(),
        };
        gasUsed = 500000;
      }
    } catch (error) {
      status = 'error';
      errorMessage = (error as Error).message;
      executionResult = null;
    }

    const executionTime = Date.now() - startTime;

    // Calculate cost based on gas used and priority
    const baseCostPerGas = 0.000001; // WRF per gas unit
    const priorityMultiplier = {
      low: 0.8,
      normal: 1.0,
      high: 1.5,
    }[priority || 'normal'];

    const cost = (gasUsed *
      baseCostPerGas *
      priorityMultiplier) as PositiveNumber;

    // Create execution record
    const execution: Partial<ExecutionResult> = {
      id: `exec_${uuidv4()}`,
      nftId,
      executor: executor as EthereumAddress,
      inputs,
      outputs: executionResult || {},
      executionTime,
      gasUsed,
      cost,
      status,
      errorMessage,
      timestamp: new Date(),
    };

    let result: ExecutionResult;
    if (req.storage) {
      result = await req.storage.createExecution(execution);

      // Update NFT execution count and rewards
      await req.storage.updateNFT(nftId, {
        executionCount: nft.executionCount + 1,
        totalRewards: (nft.totalRewards + cost) as PositiveNumber,
        updatedAt: new Date(),
      });
    } else {
      result = execution as ExecutionResult;
    }

    const response: ControllerResponse<ExecutionResult> = {
      success: status === 'success',
      data: result,
      message:
        status === 'success'
          ? 'NFT executed successfully'
          : `Execution ${status}: ${errorMessage || 'Unknown error'}`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(status === 'success' ? 200 : 400).json(response);
  } catch (error) {
    nftLogger.error('Error in executeNFT', { error: (error as Error).message });
    const errorResponse: ControllerResponse<ExecutionResult> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to execute computational NFT',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

/**
 * Get all computational NFTs
 */
export const getAllNFTs = async (
  req: ComputationalNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const computationType = req.query.computationType as string;
    const owner = req.query.owner as string;
    const status = req.query.status as string;

    let nfts: ComputationalNFT[] = [];
    if (req.storage) {
      nfts = await req.storage.getAllNFTs();
    } else {
      // Mock NFTs for development
      nfts = [
        {
          id: 'cnft_1',
          tokenId: 'token_1',
          name: 'Weather Pattern Analyzer',
          description: 'Analyzes weather patterns using machine learning',
          owner:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          creator:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          computationType: 'weather_analysis',
          code: {
            language: 'python',
            source: 'def analyze_weather(data): return {"pattern": "stable"}',
            dependencies: ['numpy', 'pandas'],
            entryPoint: 'analyze_weather',
          },
          metadata: {
            parameters: { accuracy: 0.95 },
            expectedInputs: ['temperature', 'humidity', 'pressure'],
            expectedOutputs: ['pattern', 'confidence'],
            computeRequirements: {
              cpu: 2,
              memory: 1024,
              storage: 200,
              maxRuntime: 60,
            },
            tags: ['weather', 'ml', 'analysis'],
          },
          status: 'active',
          executionCount: 156,
          totalRewards: 78.5 as PositiveNumber,
          createdAt: new Date('2024-03-01'),
          updatedAt: new Date(),
        },
      ];
    }

    // Apply filters
    if (computationType) {
      nfts = nfts.filter(nft => nft.computationType === computationType);
    }
    if (owner) {
      nfts = nfts.filter(
        nft => nft.owner.toLowerCase() === owner.toLowerCase()
      );
    }
    if (status) {
      nfts = nfts.filter(nft => nft.status === status);
    }

    // Sort by execution count (most popular first)
    nfts.sort((a, b) => b.executionCount - a.executionCount);

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedNFTs = nfts.slice(startIndex, endIndex);
    const totalPages = Math.ceil(nfts.length / limit);

    const response: PaginatedResponse<ComputationalNFT> = {
      success: true,
      data: paginatedNFTs,
      message: `Retrieved ${paginatedNFTs.length} computational NFTs`,
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
    nftLogger.error('Error in getAllNFTs', { error: (error as Error).message });
    const errorResponse: PaginatedResponse<ComputationalNFT> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve computational NFTs',
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
 * Get execution history for NFT
 */
export const getExecutionHistory = async (
  req: ComputationalNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const nftId = req.params.nftId;
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

    if (!nftId) {
      const errorResponse: PaginatedResponse<ExecutionResult> = {
        success: false,
        error: 'NFT ID is required',
        message: 'Please provide a valid NFT ID',
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

    let executions: ExecutionResult[] = [];
    if (req.storage) {
      executions = await req.storage.getExecutionHistory(nftId, limit);
    } else {
      // Mock execution history
      executions = [
        {
          id: 'exec_1',
          nftId,
          executor:
            '0x2345678901234567890123456789012345678901' as EthereumAddress,
          inputs: { temperature: 22.5, humidity: 65 },
          outputs: { pattern: 'stable', confidence: 0.92 },
          executionTime: 1250,
          gasUsed: 450000,
          cost: 0.45 as PositiveNumber,
          status: 'success',
          timestamp: new Date(Date.now() - 3600000),
        },
      ];
    }

    // Sort by timestamp (most recent first)
    executions.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    const totalPages = Math.ceil(executions.length / limit);

    const response: PaginatedResponse<ExecutionResult> = {
      success: true,
      data: executions,
      message: `Retrieved ${executions.length} execution records`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: executions.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
  } catch (error) {
    nftLogger.error('Error in getExecutionHistory', { error: (error as Error).message });
    const errorResponse: PaginatedResponse<ExecutionResult> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve execution history',
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

// Export all controller methods
// Additional controller methods for comprehensive API support

const getAllComputationalNFTs = async (
  req: ComputationalNFTRequest,
  res: Response
): Promise<void> => {
  return getAllNFTs(req, res);
};

const getComputationalNFTById = async (
  req: ComputationalNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const { id } = req.params;

    if (!id) {
      const errorResponse: ControllerResponse<ComputationalNFT> = {
        success: false,
        error: 'Missing NFT ID',
        message: 'NFT ID is required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    let nft: ComputationalNFT | null = null;
    if (req.storage) {
      nft = await req.storage.getNFT(id);
    }

    if (!nft) {
      const notFoundResponse: ControllerResponse<ComputationalNFT> = {
        success: false,
        error: 'NFT not found',
        message: `No computational NFT found with ID ${id}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return;
    }

    const response: ControllerResponse<ComputationalNFT> = {
      success: true,
      data: nft,
      message: 'NFT retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error) {
    nftLogger.error('Error in getComputationalNFTById', { error: (error as Error).message });
    const errorResponse: ControllerResponse<ComputationalNFT> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve computational NFT',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

const updateComputationalNFT = async (
  req: ComputationalNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const { id } = req.params;
    const updateData = req.body;

    if (!id) {
      const errorResponse: ControllerResponse<ComputationalNFT> = {
        success: false,
        error: 'Missing NFT ID',
        message: 'NFT ID is required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    let nft: ComputationalNFT | null = null;
    if (req.storage) {
      nft = await req.storage.updateNFT(id, updateData);
    }

    if (!nft) {
      const notFoundResponse: ControllerResponse<ComputationalNFT> = {
        success: false,
        error: 'NFT not found',
        message: `No computational NFT found with ID ${id}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return;
    }

    const response: ControllerResponse<ComputationalNFT> = {
      success: true,
      data: nft,
      message: 'NFT updated successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error) {
    nftLogger.error('Error in updateComputationalNFT', { error: (error as Error).message });
    const errorResponse: ControllerResponse<ComputationalNFT> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to update computational NFT',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

const executeComputationalNFT = async (
  req: ComputationalNFTRequest,
  res: Response
): Promise<void> => {
  // Set NFT ID from params
  req.body.nftId = req.params.id;
  return executeNFT(req, res);
};

const verifyComputationalNFT = async (
  req: ComputationalNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const { id } = req.params;

    if (!id) {
      const errorResponse: ControllerResponse<any> = {
        success: false,
        error: 'Missing NFT ID',
        message: 'NFT ID is required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Mock verification logic
    const verificationResult = {
      nftId: id,
      verified: true,
      codeHash: 'sha256:abcd1234...',
      metadataValid: true,
      ownershipValid: true,
      timestamp: new Date().toISOString(),
    };

    const response: ControllerResponse<any> = {
      success: true,
      data: verificationResult,
      message: 'NFT verification completed',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error) {
    nftLogger.error('Error in verifyComputationalNFT', { error: (error as Error).message });
    const errorResponse: ControllerResponse<any> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to verify computational NFT',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

const transferNFTOwnership = async (
  req: ComputationalNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const { id } = req.params;

    if (!id) {
      const errorResponse: ControllerResponse<any> = {
        success: false,
        error: 'Missing required fields',
        message: 'NFT ID is required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Zod validation for body
    const validationResult = transferOwnershipSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<any> = {
        success: false,
        error: 'Validation failed',
        message: validationResult.error.issues[0]?.message || 'Invalid input data',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    const { newOwner } = validationResult.data;

    // Mock transfer logic
    const transferResult = {
      nftId: id,
      previousOwner: '0x1234567890123456789012345678901234567890',
      newOwner: newOwner,
      txHash: 'tx_' + uuidv4(),
      timestamp: new Date().toISOString(),
    };

    const response: ControllerResponse<any> = {
      success: true,
      data: transferResult,
      message: 'NFT ownership transferred successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error) {
    nftLogger.error('Error in transferNFTOwnership', { error: (error as Error).message });
    const errorResponse: ControllerResponse<any> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to transfer NFT ownership',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

const getAvailableModelTypes = async (
  req: ComputationalNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const modelTypes = [
      {
        type: 'weather_analysis',
        name: 'Weather Analysis',
        description: 'Analyze weather patterns and forecasts',
        languages: ['python', 'javascript'],
        examples: ['temperature_trend', 'precipitation_forecast'],
      },
      {
        type: 'climate_modeling',
        name: 'Climate Modeling',
        description: 'Model climate change scenarios',
        languages: ['python', 'rust'],
        examples: ['carbon_cycle', 'greenhouse_effect'],
      },
      {
        type: 'data_processing',
        name: 'Data Processing',
        description: 'Process and transform environmental data',
        languages: ['python', 'javascript', 'rust'],
        examples: ['sensor_data_cleaning', 'time_series_analysis'],
      },
      {
        type: 'ml_inference',
        name: 'Machine Learning Inference',
        description: 'Run ML models on environmental data',
        languages: ['python', 'wasm'],
        examples: ['air_quality_prediction', 'species_classification'],
      },
    ];

    const response: ControllerResponse<any> = {
      success: true,
      data: modelTypes,
      message: 'Available model types retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error) {
    nftLogger.error('Error in getAvailableModelTypes', { error: (error as Error).message });
    const errorResponse: ControllerResponse<any> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve available model types',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

const getNFTMarketplace = async (
  req: ComputationalNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const marketplaceData = {
      featured: [
        {
          id: 'cnft_featured_1',
          name: 'Advanced Weather Predictor',
          description: 'ML-powered weather prediction model',
          price: 50.0,
          category: 'weather_analysis',
          rating: 4.8,
          executions: 1247,
        },
      ],
      categories: [
        { name: 'Weather Analysis', count: 45 },
        { name: 'Climate Modeling', count: 28 },
        { name: 'Data Processing', count: 67 },
        { name: 'ML Inference', count: 34 },
      ],
      trending: [
        { id: 'cnft_trending_1', name: 'Air Quality Monitor', executions: 892 },
        {
          id: 'cnft_trending_2',
          name: 'Carbon Footprint Calculator',
          executions: 756,
        },
      ],
    };

    const response: ControllerResponse<any> = {
      success: true,
      data: marketplaceData,
      message: 'NFT marketplace data retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error) {
    nftLogger.error('Error in getNFTMarketplace', { error: (error as Error).message });
    const errorResponse: ControllerResponse<any> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve NFT marketplace data',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

const getSampleModels = async (
  req: ComputationalNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const sampleModels = [
      {
        name: 'Temperature Analyzer',
        type: 'weather_analysis',
        language: 'python',
        code: `def analyze_temperature(data):
    return {
        "average": sum(data) / len(data),
        "trend": "stable" if abs(data[-1] - data[0]) < 2 else "changing"
    }`,
        description: 'Analyzes temperature data trends',
      },
      {
        name: 'Air Quality Classifier',
        type: 'ml_inference',
        language: 'python',
        code: `def classify_air_quality(pm25, pm10, o3):
    if pm25 > 150 or pm10 > 250 or o3 > 200:
        return "unhealthy"
    elif pm25 > 100 or pm10 > 150 or o3 > 160:
        return "moderate"
    else:
        return "good"`,
        description: 'Classifies air quality based on pollutant levels',
      },
    ];

    const response: ControllerResponse<any> = {
      success: true,
      data: sampleModels,
      message: 'Sample models retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error) {
    nftLogger.error('Error in getSampleModels', { error: (error as Error).message });
    const errorResponse: ControllerResponse<any> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve sample models',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

const getNFTsByRegion = async (
  req: ComputationalNFTRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const { regionCode } = req.params;

    if (!regionCode) {
      const errorResponse: ControllerResponse<any> = {
        success: false,
        error: 'Missing region code',
        message: 'Region code is required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Mock region-specific NFTs
    const regionNFTs = [
      {
        id: `cnft_${regionCode}_1`,
        name: `${regionCode.toUpperCase()} Climate Monitor`,
        description: `Climate monitoring NFT for ${regionCode} region`,
        region: regionCode,
        executions: 245,
        rating: 4.5,
      },
    ];

    const response: ControllerResponse<any> = {
      success: true,
      data: regionNFTs,
      message: `NFTs for region ${regionCode} retrieved successfully`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error) {
    nftLogger.error('Error in getNFTsByRegion', { error: (error as Error).message });
    const errorResponse: ControllerResponse<any> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve NFTs by region',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};
export default {
  createComputationalNFT,
  executeNFT,
  getAllNFTs,
  getExecutionHistory,
  getAllComputationalNFTs,
  getComputationalNFTById,
  updateComputationalNFT,
  executeComputationalNFT,
  verifyComputationalNFT,
  transferNFTOwnership,
  getAvailableModelTypes,
  getNFTMarketplace,
  getSampleModels,
  getNFTsByRegion,
};
