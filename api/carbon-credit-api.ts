/**
 * Carbon Credit Market API
 * RESTful API for comprehensive carbon credit market infrastructure
 * Supports all operations from Task 34: EnhancedCarbonCredits, AMM, Yield Farming, Insurance, Oracles
 */

import express, { Request, Response, NextFunction } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { ethers } from 'ethers';
import helmet from 'helmet';
import winston from 'winston';
import { SecureWalletService } from '../services/secure-wallet-service.js';
import { smartContractService } from '../blockchain/services/smart-contract-service.js';
import { authenticateJWT } from '../server/middleware/auth.js';
import type { AuthenticatedRequest } from '../shared/types/security-types.js';

// Import contract ABIs
// Use require for JSON imports to avoid import assertion issues
const EnhancedCarbonCreditsABI = require('./abis/EnhancedCarbonCredits.json');
const CarbonCreditAMMABI = require('./abis/CarbonCreditAMM.json');
const CarbonCreditsABI = require('./abis/CarbonCredits.json');

const router = express.Router();

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/carbon-api.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// Security middleware
router.use(helmet());

// Rate limiting - different tiers for different operations
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per windowMs
  message: { success: false, error: 'Too many requests from this IP' },
});

const tradingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 trading operations per minute
  message: { success: false, error: 'Trading rate limit exceeded' },
});

// API Response interfaces
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
  requestId: string;
}

interface PaginationParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

// Helper functions
const successResponse = <T>(data: T, requestId: string): ApiResponse<T> => ({
  success: true,
  data,
  timestamp: new Date().toISOString(),
  requestId,
});

const errorResponse = (
  error: string,
  requestId: string
): ApiResponse<never> => ({
  success: false,
  error,
  timestamp: new Date().toISOString(),
  requestId,
});

// Validation middleware
const handleValidationErrors = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json(
      errorResponse(
        `Validation failed: ${errors
          .array()
          .map(e => e.msg)
          .join(', ')}`,
        (req.headers['x-request-id'] as string) || 'unknown'
      )
    );
    return;
  }
  next();
};

// Blockchain connection setup
let provider: ethers.Provider;
let secureWalletService: SecureWalletService;
let contracts: {
  enhancedCarbonCredits: any; // Using any to avoid TypeScript contract method issues
  carbonCreditAMM: any;
  yieldFarmingManager: any;
  carbonCreditInsurance: any;
  oracleAggregator: any;
  wrfToken: any;
};

// Initialize blockchain connections
const initializeContracts = async () => {
  provider = new ethers.JsonRpcProvider(
    process.env.BLOCKCHAIN_RPC_URL || process.env.DEVNET_RPC_URL || 'http://localhost:8556'
  );

  // Initialize secure wallet service
  secureWalletService = new SecureWalletService(provider);

  // Contract addresses from deployment
  const contractAddresses = {
    enhancedCarbonCredits: process.env.ENHANCED_CARBON_CREDITS_ADDRESS,
    carbonCreditAMM: process.env.CARBON_CREDIT_AMM_ADDRESS,
    yieldFarmingManager: process.env.YIELD_FARMING_MANAGER_ADDRESS,
    carbonCreditInsurance: process.env.CARBON_CREDIT_INSURANCE_ADDRESS,
    oracleAggregator: process.env.ORACLE_AGGREGATOR_ADDRESS,
    wrfToken: process.env.WRF_TOKEN_ADDRESS,
  };

  // Validate contract addresses before initialization
  const validateAddress = (address: string | undefined, name: string): string => {
    if (!address || !ethers.isAddress(address)) {
      logger.warn(`Invalid or missing contract address for ${name}: ${address}`);
      return ethers.ZeroAddress; // Use zero address as fallback for optional contracts
    }
    return address;
  };

  // Contract ABIs loaded from local artifacts
  contracts = {
    enhancedCarbonCredits: new ethers.Contract(
      validateAddress(contractAddresses.enhancedCarbonCredits, 'EnhancedCarbonCredits'),
      EnhancedCarbonCreditsABI.abi,
      provider
    ),
    carbonCreditAMM: new ethers.Contract(
      validateAddress(contractAddresses.carbonCreditAMM, 'CarbonCreditAMM'),
      CarbonCreditAMMABI.abi,
      provider
    ),
    yieldFarmingManager: new ethers.Contract(
      validateAddress(contractAddresses.yieldFarmingManager, 'YieldFarmingManager'),
      CarbonCreditAMMABI.abi, // Uses similar AMM interface
      provider
    ),
    carbonCreditInsurance: new ethers.Contract(
      validateAddress(contractAddresses.carbonCreditInsurance, 'CarbonCreditInsurance'),
      CarbonCreditsABI.abi, // Basic ERC721-like interface
      provider
    ),
    oracleAggregator: new ethers.Contract(
      validateAddress(contractAddresses.oracleAggregator, 'OracleAggregator'),
      [], // Oracle has minimal interface, will be populated when needed
      provider
    ),
    wrfToken: new ethers.Contract(
      validateAddress(contractAddresses.wrfToken, 'WRFToken'),
      [
        'function balanceOf(address) view returns (uint256)',
        'function transfer(address, uint256) returns (bool)',
        'function approve(address, uint256) returns (bool)',
        'function allowance(address, address) view returns (uint256)',
      ],
      provider
    ),
  };

  logger.info('Contract instances initialized with ABIs', {
    enhancedCarbonCredits: contractAddresses.enhancedCarbonCredits,
    carbonCreditAMM: contractAddresses.carbonCreditAMM,
    yieldFarmingManager: contractAddresses.yieldFarmingManager,
  });
};

// ===== CARBON CREDIT TOKEN OPERATIONS =====

/**
 * @route GET /api/carbon-credits/batches
 * @desc Get all carbon credit batches with pagination and filtering
 */
(router as any).get(
  '/carbon-credits/batches',
  generalLimiter,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('projectType').optional().isString(),
    query('registryStandard').optional().isString(),
    query('vintage').optional().isInt({ min: 2000, max: 2100 }),
    query('isActive').optional().isBoolean(),
  ],
  handleValidationErrors,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        page = 1,
        limit = 20,
        projectType,
        registryStandard,
        vintage,
        isActive,
      } = req.query;
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';

      // Query blockchain for carbon credit batches
      const batches = await contracts.enhancedCarbonCredits.getAllBatches({
        page: Number(page),
        limit: Number(limit),
        filters: {
          projectType,
          registryStandard,
          vintage: vintage ? Number(vintage) : undefined,
          isActive: isActive !== undefined ? Boolean(isActive) : undefined,
        },
      });

      logger.info('Carbon credit batches retrieved', {
        page,
        limit,
        projectType,
        registryStandard,
        vintage,
        requestId,
      });

      res.json(
        successResponse(
          {
            batches: batches.items,
            pagination: {
              currentPage: Number(page),
              totalPages: Math.ceil(batches.total / Number(limit)),
              totalItems: batches.total,
              itemsPerPage: Number(limit),
            },
          },
          requestId
        )
      );
    } catch (error) {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      logger.error('Error retrieving carbon credit batches', {
        error,
        requestId,
      });
      res
        .status(500)
        .json(
          errorResponse('Failed to retrieve carbon credit batches', requestId)
        );
    }
  }
);

/**
 * @route GET /api/carbon-credits/batches/:tokenId
 * @desc Get specific carbon credit batch details
 */
(router as any).get(
  '/carbon-credits/batches/:tokenId',
  generalLimiter,
  [param('tokenId').isNumeric()],
  handleValidationErrors,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { tokenId } = req.params;
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';

      const batch = await contracts.enhancedCarbonCredits.getBatch(tokenId);
      const supply = await contracts.enhancedCarbonCredits.totalSupply(tokenId);
      const uri = await contracts.enhancedCarbonCredits.uri(tokenId);

      const batchDetails = {
        tokenId: Number(tokenId),
        totalSupply: supply.toString(),
        uri,
        ...batch,
      };

      logger.info('Carbon credit batch details retrieved', {
        tokenId,
        requestId,
      });

      res.json(successResponse(batchDetails, requestId));
    } catch (error) {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      logger.error('Error retrieving carbon credit batch', {
        error,
        tokenId: req.params.tokenId,
        requestId,
      });
      res
        .status(404)
        .json(errorResponse('Carbon credit batch not found', requestId));
    }
  }
);

/**
 * @route POST /api/carbon-credits/batches/:tokenId/retire
 * @desc Retire carbon credits (burn tokens permanently)
 */
(router as any).post(
  '/carbon-credits/batches/:tokenId/retire',
  tradingLimiter,
  [
    param('tokenId').isNumeric(),
    body('amount')
      .isNumeric()
      .custom(value => value > 0),
    body('retirementReason').isString().isLength({ min: 10, max: 500 }),
    body('beneficiary').optional().isString(),
    body('walletAddress').isEthereumAddress(),
    body('signature').isString().isLength({ min: 130, max: 132 }),
  ],
  handleValidationErrors,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { tokenId } = req.params;
      const {
        amount,
        retirementReason,
        beneficiary,
        walletAddress,
        signature,
      } = req.body;
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';

      // Generate a secure nonce for this transaction
      const nonce = secureWalletService.generateNonce();
      const expiry = Date.now() + 15 * 60 * 1000; // 15 minutes expiry

      // Create the expected transaction message
      const contractAddress = process.env.ENHANCED_CARBON_CREDITS_ADDRESS!;
      const functionName = 'retire';
      const params = [tokenId, amount, retirementReason, beneficiary || ''];

      // Verify the signature matches the transaction request
      if (
        !secureWalletService.verifyTransactionRequest(
          walletAddress,
          signature,
          contractAddress,
          functionName,
          params,
          nonce,
          expiry
        )
      ) {
        secureWalletService.logSecurityEvent(
          'Invalid signature for retirement',
          walletAddress,
          {
            tokenId,
            amount,
            requestId,
          }
        );
        res
          .status(401)
          .json(
            errorResponse(
              'Invalid signature for transaction request',
              requestId
            )
          );
        return;
      }

      // Check if user has sufficient balance
      const hasBalance = await secureWalletService.checkWalletBalance(
        walletAddress,
        contractAddress,
        amount.toString()
      );

      if (!hasBalance) {
        res
          .status(400)
          .json(errorResponse('Insufficient token balance', requestId));
        return;
      }

      // For actual execution, admin wallet handles the transaction on behalf of user
      // This requires the user to have pre-approved the admin wallet as operator
      const adminWallet = secureWalletService.createAdminWallet();
      if (!adminWallet) {
        res
          .status(500)
          .json(errorResponse('Service temporarily unavailable', requestId));
        return;
      }

      const contract = contracts.enhancedCarbonCredits.connect(adminWallet);

      // Execute retirement transaction on behalf of user
      const tx = await contract.retireFrom(
        walletAddress,
        tokenId,
        amount,
        retirementReason,
        beneficiary || ''
      );
      const receipt = await tx.wait();

      secureWalletService.logSecurityEvent(
        'Carbon credits retired',
        walletAddress,
        {
          tokenId,
          amount,
          retirementReason,
          txHash: receipt.hash,
          requestId,
        }
      );

      logger.info('Carbon credits retired', {
        tokenId,
        amount,
        retirementReason,
        walletAddress,
        txHash: receipt.hash,
        requestId,
      });

      res.json(
        successResponse(
          {
            transactionHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            tokenId: Number(tokenId),
            amountRetired: amount,
            retirementReason,
            beneficiary,
            gasUsed: receipt.gasUsed.toString(),
          },
          requestId
        )
      );
    } catch (error) {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      logger.error('Error retiring carbon credits', { error, requestId });
      res
        .status(500)
        .json(errorResponse('Failed to retire carbon credits', requestId));
    }
  }
);

/**
 * @route POST /api/carbon-credits/transfer
 * @desc Transfer carbon credits between addresses
 */
(router as any).post(
  '/carbon-credits/transfer',
  authenticateJWT,  // SECURITY: Require JWT authentication instead of privateKey
  tradingLimiter,
  [
    body('tokenId').isNumeric(),
    body('to').isEthereumAddress(),
    body('amount')
      .isNumeric()
      .custom(value => value > 0),
  ],
  handleValidationErrors,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { tokenId, to, amount } = req.body;
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      const userAddress = req.user?.walletAddress;

      if (!userAddress) {
        res.status(400).json(errorResponse('User wallet address not found in token', requestId));
        return;
      }

      // Use SmartContractService with HSM-backed signing
      const result = await smartContractService.callContract({
        contractAddress: contracts.enhancedCarbonCredits.target as string,
        functionName: 'safeTransferFrom',
        args: [userAddress, to, tokenId, amount, '0x'],
        isReadOnly: false,
      });

      logger.info('Carbon credits transferred', {
        tokenId,
        to,
        amount,
        from: userAddress,
        txHash: result.transactionHash,
        requestId,
      });

      res.json(
        successResponse(
          {
            transactionHash: result.transactionHash,
            blockNumber: result.blockNumber,
            from: userAddress,
            to,
            tokenId: Number(tokenId),
            amount,
            gasUsed: result.gasUsed?.toString(),
          },
          requestId
        )
      );
    } catch (error) {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      logger.error('Error transferring carbon credits', { error, requestId });
      res
        .status(500)
        .json(errorResponse('Failed to transfer carbon credits', requestId));
    }
  }
);

// ===== AMM TRADING OPERATIONS =====

/**
 * @route GET /api/amm/pools
 * @desc Get all AMM pools with their current state
 */
(router as any).get(
  '/amm/pools',
  generalLimiter,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';

      // Get all pools from factory
      const pools = await contracts.carbonCreditAMM.getAllPools();

      const poolsWithState = await Promise.all(
        pools.map(async (poolAddress: string) => {
          const poolContract = new ethers.Contract(poolAddress, [], provider);
          const [token0, token1, reserves, fee] = await Promise.all([
            poolContract.token0(),
            poolContract.token1(),
            poolContract.getReserves(),
            poolContract.feeBasisPoints(),
          ]);

          return {
            address: poolAddress,
            token0,
            token1,
            reserve0: reserves[0].toString(),
            reserve1: reserves[1].toString(),
            fee: fee.toString(),
            tvl: ethers.formatEther(reserves[0].add(reserves[1])),
          };
        })
      );

      logger.info('AMM pools retrieved', {
        poolCount: poolsWithState.length,
        requestId,
      });

      res.json(successResponse({ pools: poolsWithState }, requestId));
    } catch (error) {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      logger.error('Error retrieving AMM pools', { error, requestId });
      res
        .status(500)
        .json(errorResponse('Failed to retrieve AMM pools', requestId));
    }
  }
);

/**
 * @route POST /api/amm/swap
 * @desc Execute token swap through AMM
 */
(router as any).post(
  '/amm/swap',
  authenticateJWT,  // SECURITY: Require JWT authentication instead of privateKey
  tradingLimiter,
  [
    body('tokenIn').isEthereumAddress(),
    body('tokenOut').isEthereumAddress(),
    body('amountIn')
      .isString()
      .custom(value => !isNaN(parseFloat(value)) && parseFloat(value) > 0),
    body('amountOutMin')
      .isString()
      .custom(value => !isNaN(parseFloat(value)) && parseFloat(value) >= 0),
    body('deadline').isInt({ min: Math.floor(Date.now() / 1000) }),
  ],
  handleValidationErrors,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { tokenIn, tokenOut, amountIn, amountOutMin, deadline } = req.body;
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      const userAddress = req.user?.walletAddress;

      if (!userAddress) {
        res.status(400).json(errorResponse('User wallet address not found in token', requestId));
        return;
      }

      // Use SmartContractService with HSM-backed signing
      const result = await smartContractService.callContract({
        contractAddress: contracts.carbonCreditAMM.target as string,
        functionName: 'swapExactTokensForTokens',
        args: [
          ethers.parseEther(amountIn),
          ethers.parseEther(amountOutMin),
          [tokenIn, tokenOut],
          userAddress,
          deadline,
        ],
        isReadOnly: false,
      });

      logger.info('AMM swap executed', {
        tokenIn,
        tokenOut,
        amountIn,
        amountOutMin,
        txHash: result.transactionHash,
        requestId,
      });

      res.json(
        successResponse(
          {
            transactionHash: result.transactionHash,
            blockNumber: result.blockNumber,
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            gasUsed: result.gasUsed?.toString(),
          },
          requestId
        )
      );
    } catch (error) {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      logger.error('Error executing AMM swap', { error, requestId });
      res.status(500).json(errorResponse('Failed to execute swap', requestId));
    }
  }
);

/**
 * @route POST /api/amm/add-liquidity
 * @desc Add liquidity to AMM pool
 */
(router as any).post(
  '/amm/add-liquidity',
  authenticateJWT,  // SECURITY: Require JWT authentication instead of privateKey
  tradingLimiter,
  [
    body('tokenA').isEthereumAddress(),
    body('tokenB').isEthereumAddress(),
    body('amountADesired')
      .isString()
      .custom(value => !isNaN(parseFloat(value)) && parseFloat(value) > 0),
    body('amountBDesired')
      .isString()
      .custom(value => !isNaN(parseFloat(value)) && parseFloat(value) > 0),
    body('amountAMin')
      .isString()
      .custom(value => !isNaN(parseFloat(value)) && parseFloat(value) >= 0),
    body('amountBMin')
      .isString()
      .custom(value => !isNaN(parseFloat(value)) && parseFloat(value) >= 0),
    body('deadline').isInt({ min: Math.floor(Date.now() / 1000) }),
  ],
  handleValidationErrors,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const {
        tokenA,
        tokenB,
        amountADesired,
        amountBDesired,
        amountAMin,
        amountBMin,
        deadline,
      } = req.body;
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      const userAddress = req.user?.walletAddress;

      if (!userAddress) {
        res.status(400).json(errorResponse('User wallet address not found in token', requestId));
        return;
      }

      // Use SmartContractService with HSM-backed signing
      const result = await smartContractService.callContract({
        contractAddress: contracts.carbonCreditAMM.target as string,
        functionName: 'addLiquidity',
        args: [
          tokenA,
          tokenB,
          ethers.parseEther(amountADesired),
          ethers.parseEther(amountBDesired),
          ethers.parseEther(amountAMin),
          ethers.parseEther(amountBMin),
          userAddress,
          deadline,
        ],
        isReadOnly: false,
      });

      logger.info('Liquidity added to AMM', {
        tokenA,
        tokenB,
        amountADesired,
        amountBDesired,
        txHash: result.transactionHash,
        requestId,
      });

      res.json(
        successResponse(
          {
            transactionHash: result.transactionHash,
            blockNumber: result.blockNumber,
            tokenA,
            tokenB,
            amountADesired,
            amountBDesired,
            gasUsed: result.gasUsed?.toString(),
          },
          requestId
        )
      );
    } catch (error) {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      logger.error('Error adding liquidity to AMM', { error, requestId });
      res.status(500).json(errorResponse('Failed to add liquidity', requestId));
    }
  }
);

// ===== YIELD FARMING OPERATIONS =====

/**
 * @route GET /api/yield-farming/pools
 * @desc Get all yield farming pools with APY and reward rates
 */
(router as any).get(
  '/yield-farming/pools',
  generalLimiter,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';

      const pools = await contracts.yieldFarmingManager.getAllFarms();

      const poolsWithRewards = await Promise.all(
        pools.map(async (farmAddress: string) => {
          const farmDetails =
            await contracts.yieldFarmingManager.getFarmConfiguration(
              farmAddress
            );
          const rewardTokens =
            await contracts.yieldFarmingManager.getRewardTokens(farmAddress);

          return {
            address: farmAddress,
            liquidityPool: farmDetails.liquidityPool,
            carbonBasketToken: farmDetails.carbonBasketToken,
            baseRewardRate: farmDetails.baseRewardRate.toString(),
            qualityMultiplier: farmDetails.qualityMultiplier.toString(),
            vintageBonus: farmDetails.vintageBonus.toString(),
            minStakeDuration: farmDetails.minStakeDuration.toString(),
            farmType: farmDetails.farmType,
            isActive: farmDetails.isActive,
            rewardTokens,
          };
        })
      );

      logger.info('Yield farming pools retrieved', {
        poolCount: poolsWithRewards.length,
        requestId,
      });

      res.json(successResponse({ pools: poolsWithRewards }, requestId));
    } catch (error) {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      logger.error('Error retrieving yield farming pools', {
        error,
        requestId,
      });
      res
        .status(500)
        .json(
          errorResponse('Failed to retrieve yield farming pools', requestId)
        );
    }
  }
);

/**
 * @route POST /api/yield-farming/stake
 * @desc Stake LP tokens in yield farming pool
 */
(router as any).post(
  '/yield-farming/stake',
  authenticateJWT,  // SECURITY: Require JWT authentication instead of privateKey
  tradingLimiter,
  [
    body('farmAddress').isEthereumAddress(),
    body('amount')
      .isString()
      .custom(value => !isNaN(parseFloat(value)) && parseFloat(value) > 0),
    body('lockDuration').optional().isInt({ min: 0 }),
  ],
  handleValidationErrors,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { farmAddress, amount, lockDuration } = req.body;
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      const userAddress = req.user?.walletAddress;

      if (!userAddress) {
        res.status(400).json(errorResponse('User wallet address not found in token', requestId));
        return;
      }

      // Use SmartContractService with HSM-backed signing
      const result = await smartContractService.callContract({
        contractAddress: contracts.yieldFarmingManager.target as string,
        functionName: 'stake',
        args: [farmAddress, ethers.parseEther(amount), lockDuration || 0],
        isReadOnly: false,
      });

      logger.info('Tokens staked in yield farming', {
        farmAddress,
        amount,
        lockDuration,
        txHash: result.transactionHash,
        requestId,
      });

      res.json(
        successResponse(
          {
            transactionHash: result.transactionHash,
            blockNumber: result.blockNumber,
            farmAddress,
            amount,
            lockDuration: lockDuration || 0,
            gasUsed: result.gasUsed?.toString(),
          },
          requestId
        )
      );
    } catch (error) {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      logger.error('Error staking in yield farming', { error, requestId });
      res.status(500).json(errorResponse('Failed to stake tokens', requestId));
    }
  }
);

/**
 * @route POST /api/yield-farming/claim-rewards
 * @desc Claim accumulated farming rewards
 */
(router as any).post(
  '/yield-farming/claim-rewards',
  authenticateJWT,  // SECURITY: Require JWT authentication instead of privateKey
  tradingLimiter,
  [
    body('farmAddress').isEthereumAddress(),
  ],
  handleValidationErrors,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { farmAddress } = req.body;
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      const userAddress = req.user?.walletAddress;

      if (!userAddress) {
        res.status(400).json(errorResponse('User wallet address not found in token', requestId));
        return;
      }

      // Use SmartContractService with HSM-backed signing
      const result = await smartContractService.callContract({
        contractAddress: contracts.yieldFarmingManager.target as string,
        functionName: 'claimRewards',
        args: [farmAddress],
        isReadOnly: false,
      });

      logger.info('Yield farming rewards claimed', {
        farmAddress,
        user: userAddress,
        txHash: result.transactionHash,
        requestId,
      });

      res.json(
        successResponse(
          {
            transactionHash: result.transactionHash,
            blockNumber: result.blockNumber,
            farmAddress,
            user: userAddress,
            gasUsed: result.gasUsed?.toString(),
          },
          requestId
        )
      );
    } catch (error) {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      logger.error('Error claiming yield farming rewards', {
        error,
        requestId,
      });
      res.status(500).json(errorResponse('Failed to claim rewards', requestId));
    }
  }
);

// ===== INSURANCE OPERATIONS =====

/**
 * @route GET /api/insurance/policies
 * @desc Get available insurance policies and coverage options
 */
(router as any).get(
  '/insurance/policies',
  generalLimiter,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';

      const coverageTypes =
        await contracts.carbonCreditInsurance.getCoverageTypes();
      const policies = await Promise.all(
        coverageTypes.map(async (coverageType: string) => {
          const coverageDetails =
            await contracts.carbonCreditInsurance.getCoverageDetails(
              coverageType
            );
          return {
            coverageType,
            ...coverageDetails,
          };
        })
      );

      logger.info('Insurance policies retrieved', {
        policyCount: policies.length,
        requestId,
      });

      res.json(successResponse({ policies }, requestId));
    } catch (error) {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      logger.error('Error retrieving insurance policies', { error, requestId });
      res
        .status(500)
        .json(
          errorResponse('Failed to retrieve insurance policies', requestId)
        );
    }
  }
);

/**
 * @route POST /api/insurance/create-policy
 * @desc Create new insurance policy
 */
(router as any).post(
  '/insurance/create-policy',
  authenticateJWT,  // SECURITY: Require JWT authentication instead of privateKey
  tradingLimiter,
  [
    body('coverageType')
      .isString()
      .isIn([
        'PROJECT_FAILURE',
        'VERIFICATION_RISK',
        'REGULATORY_RISK',
        'DELIVERY_GUARANTEE',
        'INVALIDATION_COVER',
      ]),
    body('tokenId').isNumeric(),
    body('coverageAmount')
      .isString()
      .custom(value => !isNaN(parseFloat(value)) && parseFloat(value) > 0),
    body('duration').isInt({ min: 30, max: 365 * 5 }), // 30 days to 5 years
  ],
  handleValidationErrors,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { coverageType, tokenId, coverageAmount, duration } = req.body;
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      const userAddress = req.user?.walletAddress;

      if (!userAddress) {
        res.status(400).json(errorResponse('User wallet address not found in token', requestId));
        return;
      }

      // Calculate premium (read-only call)
      const premiumResult = await smartContractService.callContract({
        contractAddress: contracts.carbonCreditInsurance.target as string,
        functionName: 'calculatePremium',
        args: [coverageType, tokenId, ethers.parseEther(coverageAmount), duration],
        isReadOnly: true,
      });
      const premium = premiumResult.result as string | undefined;

      // Create policy with HSM-backed signing
      const result = await smartContractService.callContract({
        contractAddress: contracts.carbonCreditInsurance.target as string,
        functionName: 'createPolicy',
        args: [coverageType, tokenId, ethers.parseEther(coverageAmount), duration],
        value: premium,
        isReadOnly: false,
      });

      logger.info('Insurance policy created', {
        coverageType,
        tokenId,
        coverageAmount,
        duration,
        premium: String(premium),
        txHash: result.transactionHash,
        requestId,
      });

      res.json(
        successResponse(
          {
            transactionHash: result.transactionHash,
            blockNumber: result.blockNumber,
            coverageType,
            tokenId: Number(tokenId),
            coverageAmount,
            duration,
            premium: ethers.formatEther(premium as string),
            gasUsed: result.gasUsed?.toString(),
          },
          requestId
        )
      );
    } catch (error) {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      logger.error('Error creating insurance policy', { error, requestId });
      res
        .status(500)
        .json(errorResponse('Failed to create insurance policy', requestId));
    }
  }
);

// ===== ORACLE DATA FEEDS =====

/**
 * @route GET /api/oracles/carbon-prices
 * @desc Get current carbon credit prices from oracle feeds
 */
(router as any).get(
  '/oracles/carbon-prices',
  generalLimiter,
  [
    query('projectType').optional().isString(),
    query('vintage').optional().isInt({ min: 2000, max: 2100 }),
    query('registryStandard').optional().isString(),
  ],
  handleValidationErrors,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectType, vintage, registryStandard } = req.query;
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';

      const priceData = await contracts.oracleAggregator.getCarbonCreditPrices({
        projectType,
        vintage: vintage ? Number(vintage) : undefined,
        registryStandard,
      });

      logger.info('Carbon credit prices retrieved from oracles', {
        projectType,
        vintage,
        registryStandard,
        requestId,
      });

      res.json(successResponse(priceData, requestId));
    } catch (error) {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      logger.error('Error retrieving carbon credit prices', {
        error,
        requestId,
      });
      res
        .status(500)
        .json(
          errorResponse('Failed to retrieve carbon credit prices', requestId)
        );
    }
  }
);

/**
 * @route GET /api/oracles/weather-data
 * @desc Get weather data for risk assessment and derivatives
 */
(router as any).get(
  '/oracles/weather-data',
  generalLimiter,
  [
    query('location').isString().notEmpty(),
    query('startDate').isISO8601(),
    query('endDate').isISO8601(),
    query('metrics').optional().isString(),
  ],
  handleValidationErrors,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { location, startDate, endDate, metrics } = req.query;
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';

      const weatherData = await contracts.oracleAggregator.getWeatherData(
        location as string,
        new Date(startDate as string),
        new Date(endDate as string),
        metrics ? (metrics as string).split(',') : undefined
      );

      logger.info('Weather data retrieved from oracles', {
        location,
        startDate,
        endDate,
        metrics,
        requestId,
      });

      res.json(successResponse(weatherData, requestId));
    } catch (error) {
      const requestId = (req.headers['x-request-id'] as string) || 'unknown';
      logger.error('Error retrieving weather data', { error, requestId });
      res
        .status(500)
        .json(errorResponse('Failed to retrieve weather data', requestId));
    }
  }
);

// Error handling middleware
router.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  const requestId = (req.headers['x-request-id'] as string) || 'unknown';
  logger.error('API Error', {
    error: error.message,
    stack: error.stack,
    requestId,
  });
  res.status(500).json(errorResponse('Internal server error', requestId));
});

// Initialize contracts on module load
initializeContracts().catch((error) => {
  logger.error('Failed to initialize carbon credit contracts', { error: error.message });
});

export { router as carbonCreditAPI };
