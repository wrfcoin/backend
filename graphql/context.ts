/**
 * GraphQL Context Creation
 * Handles authentication, database connections, and request context
 */

import { Request, Response } from 'express';
import { ethers } from 'ethers';
import * as jwt from 'jsonwebtoken';
import { JWT_ISSUER, JWT_AUDIENCE } from '../server/auth/jwt-constants.js';
import { db } from '../database/index.js';
import { logger } from '../utils/logger.js';
import { SecureWalletService } from '../services/secure-wallet-service.js';
import {
  serviceClientManager,
  ServiceClient,
} from './services/service-registry.js';
import {
  createDataLoaders,
  DataLoaders,
  withDataLoaderMonitoring,
} from './dataloaders.js';
// @ts-ignore
import blockchainAdapter from '../server/blockchain_adapter.js';

export interface GraphQLContext {
  // Database
  db: typeof db;

  // Authentication
  user?: {
    address: string;
    nonce: string;
    verified: boolean;
  };

  // Blockchain
  provider: ethers.Provider;
  blockchainAdapter: any; // Using any for CommonJS adapter
  contracts: {
    wrfToken: ethers.Contract;
    carbonCredits: ethers.Contract;
    computationalNFT: ethers.Contract;
    wrfGovernor: ethers.Contract;
    weatherOracle: ethers.Contract;
    carbonCreditAMM: ethers.Contract;
  };

  // Services
  walletService: SecureWalletService;
  services: {
    mainApi: ServiceClient;
    crossChain: ServiceClient;
    wallet: ServiceClient;
    compute: ServiceClient;
    aiml: ServiceClient;
    storage: ServiceClient;
    iot: ServiceClient;
    governance: ServiceClient;
    weatherEarnings: ServiceClient;
    nodeDiscovery: ServiceClient;
  };

  // DataLoaders for batching and caching
  loaders: DataLoaders;

  // Request context
  req?: Request;
  res?: Response;
  connection?: any; // WebSocket connection for subscriptions
  isSubscription?: boolean;

  // IP and rate limiting
  clientIP: string;
  requestId: string;
}

// Contract ABIs (simplified for demo - in production, load from artifacts)
const CONTRACT_ABIS = {
  wrfToken: [
    'function balanceOf(address owner) view returns (uint256)',
    'function totalSupply() view returns (uint256)',
    'function getWeatherStationInfo(address station) view returns (bool, uint256, uint256)',
    'event WeatherRewardClaimed(address indexed station, uint256 amount, uint256 timestamp)',
  ],
  carbonCredits: [
    'function getCreditDetails(uint256 tokenId) view returns (uint256, string, string, uint256, uint256, string, bool, address)',
    'function getTradingInfo(uint256 tokenId) view returns (bool, uint256)',
    'function balanceOf(address owner) view returns (uint256)',
    'event CreditIssued(uint256 indexed tokenId, address indexed issuer, uint256 carbonOffset, string projectType)',
    'event CreditRetired(uint256 indexed tokenId, address indexed retiringEntity, uint256 carbonOffset)',
  ],
  computationalNFT: [
    'function getComputeJob(uint256 tokenId) view returns (uint8, string, uint8, uint256, address, bool, string)',
    'function getProviderStats(address provider) view returns (bool, uint256, uint256, uint256, uint256)',
    'event ComputeJobCreated(uint256 indexed tokenId, address indexed creator, uint8 modelType, string modelName, uint256 stakeAmount)',
    'event ComputeJobExecuted(uint256 indexed tokenId, address indexed provider, uint8 status, string resultHash)',
  ],
  wrfGovernor: [
    'function proposals(uint256 proposalId) view returns (uint256, address, uint256, uint256, uint256, uint256, uint256, bool, bool)',
    'function state(uint256 proposalId) view returns (uint8)',
    'function hasVoted(uint256 proposalId, address account) view returns (bool)',
    'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)',
  ],
  weatherOracle: [
    'function getLatestWeatherData(bytes32 stationId) view returns (tuple)',
    'function getDataQualityScore(bytes32 stationId) view returns (uint256)',
    'function isStationActive(bytes32 stationId) view returns (bool)',
    'event WeatherDataUpdated(bytes32 indexed stationId, tuple data)',
  ],
  carbonCreditAMM: [
    'function getReserves() view returns (uint256, uint256, uint256)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function feeBasisPoints() view returns (uint256)',
    'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  ],
};

// Contract addresses (loaded from environment)
const CONTRACT_ADDRESSES = {
  wrfToken: process.env.WRF_TOKEN_ADDRESS!,
  carbonCredits: process.env.CARBON_CREDITS_ADDRESS!,
  computationalNFT: process.env.COMPUTATIONAL_NFT_ADDRESS!,
  wrfGovernor: process.env.WRF_GOVERNOR_ADDRESS!,
  weatherOracle: process.env.WEATHER_ORACLE_ADDRESS!,
  carbonCreditAMM: process.env.CARBON_CREDIT_AMM_ADDRESS!,
};

export async function createContext({
  req,
  res,
  connection,
  isSubscription = false,
}: {
  req?: Request;
  res?: Response;
  connection?: any;
  isSubscription?: boolean;
}): Promise<GraphQLContext> {
  // Get client IP
  const clientIP =
    req?.ip ||
    req?.socket?.remoteAddress ||
    connection?.context?.request?.socket?.remoteAddress ||
    'unknown';

  // Generate request ID
  const requestId =
    (req?.headers['x-request-id'] as string) ||
    `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    // Initialize blockchain provider
    const provider = new ethers.JsonRpcProvider(
      process.env.BLOCKCHAIN_RPC_URL || 'http://localhost:8556'
    );

    // Initialize contracts
    const contracts = {
      wrfToken: new ethers.Contract(
        CONTRACT_ADDRESSES.wrfToken,
        CONTRACT_ABIS.wrfToken,
        provider
      ),
      carbonCredits: new ethers.Contract(
        CONTRACT_ADDRESSES.carbonCredits,
        CONTRACT_ABIS.carbonCredits,
        provider
      ),
      computationalNFT: new ethers.Contract(
        CONTRACT_ADDRESSES.computationalNFT,
        CONTRACT_ABIS.computationalNFT,
        provider
      ),
      wrfGovernor: new ethers.Contract(
        CONTRACT_ADDRESSES.wrfGovernor,
        CONTRACT_ABIS.wrfGovernor,
        provider
      ),
      weatherOracle: new ethers.Contract(
        CONTRACT_ADDRESSES.weatherOracle,
        CONTRACT_ABIS.weatherOracle,
        provider
      ),
      carbonCreditAMM: new ethers.Contract(
        CONTRACT_ADDRESSES.carbonCreditAMM,
        CONTRACT_ABIS.carbonCreditAMM,
        provider
      ),
    };

    // Initialize wallet service
    const walletService = new SecureWalletService(provider);

    // Initialize service clients
    const services = {
      mainApi: serviceClientManager.getClient('mainApi'),
      crossChain: serviceClientManager.getClient('crossChain'),
      wallet: serviceClientManager.getClient('wallet'),
      compute: serviceClientManager.getClient('compute'),
      aiml: serviceClientManager.getClient('aiml'),
      storage: serviceClientManager.getClient('storage'),
      iot: serviceClientManager.getClient('iot'),
      governance: serviceClientManager.getClient('governance'),
      weatherEarnings: serviceClientManager.getClient('weatherEarnings'),
      nodeDiscovery: serviceClientManager.getClient('nodeDiscovery'),
    };

    // Handle authentication
    let user: GraphQLContext['user'] | undefined;

    const authHeader =
      req?.headers.authorization || connection?.connectionParams?.authorization;
    if (authHeader) {
      try {
        const token = authHeader.replace('Bearer ', '');
        const decoded = jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE }) as any;

        // Verify the user's wallet signature if present
        if (decoded.address && decoded.signature && decoded.message) {
          const isValidSignature = await walletService.verifySignature(
            decoded.address,
            decoded.signature,
            decoded.message
          );

          if (isValidSignature) {
            user = {
              address: decoded.address,
              nonce: decoded.nonce || '',
              verified: true,
            };
          }
        } else {
          // Basic JWT authentication without wallet verification
          user = {
            address: decoded.address,
            nonce: decoded.nonce || '',
            verified: false,
          };
        }
      } catch (error) {
        logger.warn('Invalid authentication token', {
          error: error instanceof Error ? error.message : String(error),
          clientIP,
          requestId,
        });
        // Don't throw error - allow anonymous access
      }
    }

    // Create a partial context first for DataLoader initialization
    const partialContext = {
      db,
      user,
      provider,
      contracts,
      walletService,
      services,
      req,
      res,
      connection,
      isSubscription,
      clientIP,
      requestId,
    } as Partial<GraphQLContext>;

    // Create DataLoaders with monitoring
    const loaders = createDataLoaders(partialContext as GraphQLContext);
    const monitoredLoaders = {
      weatherStations: withDataLoaderMonitoring(
        loaders.weatherStations,
        'weatherStations'
      ),
      votes: withDataLoaderMonitoring(loaders.votes, 'votes'),
      proposals: withDataLoaderMonitoring(loaders.proposals, 'proposals'),
      tokenBalances: withDataLoaderMonitoring(
        loaders.tokenBalances,
        'tokenBalances'
      ),
      crossChainTransfers: withDataLoaderMonitoring(
        loaders.crossChainTransfers,
        'crossChainTransfers'
      ),
      computeJobs: withDataLoaderMonitoring(loaders.computeJobs, 'computeJobs'),
      aiModels: withDataLoaderMonitoring(loaders.aiModels, 'aiModels'),
      storageNodes: withDataLoaderMonitoring(
        loaders.storageNodes,
        'storageNodes'
      ),
      qualityScores: withDataLoaderMonitoring(
        loaders.qualityScores,
        'qualityScores'
      ),
    };

    const context: GraphQLContext = {
      ...partialContext,
      loaders: monitoredLoaders,
      blockchainAdapter,
    } as GraphQLContext;

    // Log context creation for monitoring
    logger.debug('GraphQL context created', {
      hasUser: !!user,
      userAddress: user?.address,
      isSubscription,
      clientIP,
      requestId,
    });

    return context;
  } catch (error) {
    logger.error('Failed to create GraphQL context', {
      error: error instanceof Error ? error.message : String(error),
      clientIP,
      requestId,
    });
    throw new Error('Failed to initialize GraphQL context');
  }
}

// Helper function to require authentication
export function requireAuth(
  context: GraphQLContext
): NonNullable<GraphQLContext['user']> {
  if (!context.user) {
    throw new Error('Authentication required');
  }
  return context.user;
}

// Helper function to require verified wallet
export function requireVerifiedWallet(
  context: GraphQLContext
): NonNullable<GraphQLContext['user']> {
  const user = requireAuth(context);
  if (!user.verified) {
    throw new Error('Wallet verification required');
  }
  return user;
}

// Helper function to check if user is authorized for admin operations
export async function requireAdmin(
  context: GraphQLContext
): Promise<NonNullable<GraphQLContext['user']>> {
  const user = requireVerifiedWallet(context);

  // Check if user has admin role (this could be stored in database or smart contract)
  const isAdmin = await checkAdminRole(user.address, context);
  if (!isAdmin) {
    throw new Error('Admin privileges required');
  }

  return user;
}

// Check admin role (implement based on your admin system)
async function checkAdminRole(
  address: string,
  context: GraphQLContext
): Promise<boolean> {
  try {
    // Option 1: Check from smart contract
    // const hasAdminRole = await context.contracts.wrfGovernor.hasRole(ADMIN_ROLE, address);

    // Option 2: Check from database
    // const adminRecord = await context.db.query.admins.findFirst({
    //   where: eq(admins.address, address)
    // });

    // For now, check environment variable for admin addresses
    const adminAddresses = (process.env.ADMIN_ADDRESSES || '')
      .split(',')
      .map(addr => addr.trim().toLowerCase());
    return adminAddresses.includes(address.toLowerCase());
  } catch (error) {
    logger.error('Failed to check admin role', {
      address,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// Rate limiting helper for subscriptions
export function checkSubscriptionRateLimit(context: GraphQLContext): void {
  if (!context.isSubscription) return;

  // Implement subscription-specific rate limiting
  // This could use Redis or in-memory store
  const maxSubscriptionsPerIP = 10;

  // For demo purposes, just log
  logger.debug('Subscription rate limit check', {
    clientIP: context.clientIP,
    requestId: context.requestId,
  });
}
