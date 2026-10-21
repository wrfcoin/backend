// OpenTelemetry must be initialized before other imports for auto-instrumentation
import { initializeOTel } from './utils/otel-setup.js';
void initializeOTel().catch(() => {});

/**
 * Enhanced Cross-Chain Server - TypeScript
 * Advanced multi-chain functionality with type safety
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import { PoolClient } from 'pg';
const { getSharedPgPool } = require('./utils/shared-pg-pool');
import { crosschainLogger } from './utils/logger.js';
import {
  ApiResponse,
  ApiError,
  ApiResult,
  CrossChainBridge,
  CrossChainTransaction,
  PaginationParams,
  PaginatedResponse,
} from '../shared/types/api-types.js';
import {
  EthereumAddress,
  PositiveNumber,
  SecureHash,
} from '../shared/types/security-types.js';
import {
  BridgeTransaction,
  BridgeStatus,
  NetworkInfo,
} from '../shared/types/blockchain-types.js';
import strictCorsConfig from './utils/strict-cors-config.js';

const { resolveAllowedOrigins } = strictCorsConfig;
const { createDatabaseSSLConfig } = require('./config/secure-ssl-config.js');
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');

// Enhanced bridge protocol definitions
interface BridgeProtocol {
  name: string;
  description: string;
  supported_chains: string[];
  native_token: string;
  fees: {
    base: number;
    percentage: number;
  };
  average_time: string;
  security_model: string;
  logo: string;
  tvl?: string;
  daily_volume?: string;
  status: 'active' | 'maintenance' | 'deprecated';
}

interface CrossChainTransferRequest {
  fromChain: string;
  toChain: string;
  fromAddress: EthereumAddress;
  toAddress: EthereumAddress;
  amount: PositiveNumber;
  token: string;
  protocol: string;
}

interface BridgeStatistics {
  totalVolume: string;
  totalTransactions: number;
  activeProtocols: number;
  averageTime: string;
  successRate: number;
}

const app = express();
const PORT: number = parseInt(process.env.PORT || '8002', 10);
const probeState = { draining: false };

// Database connection - uses secure SSL config with rejectUnauthorized: true
const pool = getSharedPgPool({
  connectionString: process.env.DATABASE_URL,
  ssl: createDatabaseSSLConfig(),
});

// CORS configuration
app.use(
  cors({
    origin: resolveAllowedOrigins({ developmentDefaults: [
      'https://wrfcoin.replit.app',
      'https://78d83de6-3c2e-4513-8977-f64d83a9e3cb-00-33g6fqpn548lr.worf.replit.dev',
      'http://localhost:5000',
      'http://0.0.0.0:5000',
    ] }),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);

app.use(express.json());
app.use(
  createHealthMiddleware(
    'enhanced-crosschain-server',
    {
      database: {
        critical: false,
        check: async () => {
          await pool.query('SELECT 1');
          return { status: 'up' };
        },
      },
    },
    { state: probeState }
  ).router
);

// Enhanced bridge protocols with real data
const ENHANCED_BRIDGE_PROTOCOLS: Record<string, BridgeProtocol> = {
  axelar: {
    name: 'Axelar Network',
    description: 'Universal Web3 interoperability platform',
    supported_chains: [
      'ethereum',
      'polygon',
      'avalanche',
      'cosmos',
      'moonbeam',
      'fantom',
      'osmosis',
    ],
    native_token: 'AXL',
    fees: { base: 0.1, percentage: 0.1 },
    average_time: '2-8 minutes',
    security_model: 'Proof of Stake',
    logo: '🔗',
    tvl: '$1.2B',
    daily_volume: '$45M',
    status: 'active',
  },
  layerzero: {
    name: 'LayerZero',
    description: 'Omnichain interoperability protocol',
    supported_chains: [
      'ethereum',
      'bsc',
      'avalanche',
      'polygon',
      'arbitrum',
      'optimism',
      'fantom',
    ],
    native_token: 'ZRO',
    fees: { base: 0.05, percentage: 0.05 },
    average_time: '1-5 minutes',
    security_model: 'Ultra Light Node',
    logo: '⚡',
    tvl: '$890M',
    daily_volume: '$32M',
    status: 'active',
  },
  wormhole: {
    name: 'Wormhole',
    description: 'Generic message passing protocol',
    supported_chains: [
      'ethereum',
      'solana',
      'terra',
      'bsc',
      'polygon',
      'avalanche',
      'oasis',
    ],
    native_token: 'W',
    fees: { base: 0.15, percentage: 0.05 },
    average_time: '3-10 minutes',
    security_model: 'Guardian Network',
    logo: '🌀',
    tvl: '$2.1B',
    daily_volume: '$67M',
    status: 'active',
  },
  stargate: {
    name: 'Stargate Finance',
    description: 'Fully composable liquidity transport protocol',
    supported_chains: [
      'ethereum',
      'bsc',
      'avalanche',
      'polygon',
      'arbitrum',
      'optimism',
      'fantom',
    ],
    native_token: 'STG',
    fees: { base: 0.06, percentage: 0.1 },
    average_time: '1-3 minutes',
    security_model: 'LayerZero + Liquidity Pools',
    logo: '🌟',
    tvl: '$156M',
    daily_volume: '$12M',
    status: 'active',
  },
  synapse: {
    name: 'Synapse Protocol',
    description: 'Cross-chain layer for DeFi',
    supported_chains: [
      'ethereum',
      'bsc',
      'polygon',
      'avalanche',
      'arbitrum',
      'optimism',
      'harmony',
    ],
    native_token: 'SYN',
    fees: { base: 0.04, percentage: 0.04 },
    average_time: '5-15 minutes',
    security_model: 'Validators + Optimistic Security',
    logo: '🔄',
    tvl: '$78M',
    daily_volume: '$8M',
    status: 'active',
  },
};

// Supported network configurations
const SUPPORTED_NETWORKS: Record<string, NetworkInfo> = {
  ethereum: {
    chainId: 1,
    networkName: 'Ethereum Mainnet',
    rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/',
    blockExplorerUrl: 'https://etherscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    consensusType: 'PoS',
    blockTime: 12,
    finalityBlocks: 32,
  },
  polygon: {
    chainId: 137,
    networkName: 'Polygon Mainnet',
    rpcUrl: 'https://polygon-rpc.com',
    blockExplorerUrl: 'https://polygonscan.com',
    nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
    consensusType: 'PoS',
    blockTime: 2,
    finalityBlocks: 256,
  },
  avalanche: {
    chainId: 43114,
    networkName: 'Avalanche C-Chain',
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    blockExplorerUrl: 'https://snowtrace.io',
    nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
    consensusType: 'PoS',
    blockTime: 2,
    finalityBlocks: 1,
  },
};

// Helper functions
function createApiResponse<T>(
  data: T,
  meta?: Record<string, any>
): ApiResponse<T> {
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
): ApiError {
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

// Calculate bridge fees with precision safety
function calculateBridgeFee(amount: number, protocol: BridgeProtocol): number {
  // Use integer arithmetic to avoid floating point precision issues
  const baseFeeBasisPoints = Math.floor(protocol.fees.base * 10000);
  const percentageFeeBasisPoints = Math.floor(protocol.fees.percentage * 100);

  const baseFee = baseFeeBasisPoints / 10000;
  const percentageFee = (amount * percentageFeeBasisPoints) / 10000;

  return baseFee + percentageFee;
}

// Validate cross-chain transfer with enhanced security
function validateTransfer(request: CrossChainTransferRequest): string[] {
  const errors: string[] = [];

  // Protocol validation
  if (!request.protocol || typeof request.protocol !== 'string') {
    errors.push('Protocol is required and must be a string');
  } else if (!ENHANCED_BRIDGE_PROTOCOLS[request.protocol]) {
    errors.push('Unsupported bridge protocol');
  }

  // Chain validation
  if (!request.fromChain || typeof request.fromChain !== 'string') {
    errors.push('Source chain is required and must be a string');
  } else if (!SUPPORTED_NETWORKS[request.fromChain]) {
    errors.push('Unsupported source chain');
  }

  if (!request.toChain || typeof request.toChain !== 'string') {
    errors.push('Target chain is required and must be a string');
  } else if (!SUPPORTED_NETWORKS[request.toChain]) {
    errors.push('Unsupported target chain');
  }

  if (request.fromChain === request.toChain) {
    errors.push('Source and target chains cannot be the same');
  }

  // Address validation with enhanced security
  if (!request.fromAddress || typeof request.fromAddress !== 'string') {
    errors.push('Source address is required and must be a string');
  } else if (!/^0x[a-fA-F0-9]{40}$/.test(request.fromAddress)) {
    errors.push('Invalid source address format');
  } else if (
    request.fromAddress === '0x0000000000000000000000000000000000000000'
  ) {
    errors.push('Source address cannot be zero address');
  }

  if (!request.toAddress || typeof request.toAddress !== 'string') {
    errors.push('Target address is required and must be a string');
  } else if (!/^0x[a-fA-F0-9]{40}$/.test(request.toAddress)) {
    errors.push('Invalid target address format');
  } else if (
    request.toAddress === '0x0000000000000000000000000000000000000000'
  ) {
    errors.push('Target address cannot be zero address');
  }

  // Amount validation with security checks
  if (typeof request.amount !== 'number') {
    errors.push('Amount must be a number');
  } else if (request.amount <= 0) {
    errors.push('Amount must be positive');
  } else if (request.amount > Number.MAX_SAFE_INTEGER) {
    errors.push('Amount exceeds maximum safe integer');
  } else if (!Number.isFinite(request.amount)) {
    errors.push('Amount must be a finite number');
  }

  // Token validation
  if (!request.token || typeof request.token !== 'string') {
    errors.push('Token is required and must be a string');
  } else if (request.token.length > 10) {
    errors.push('Token symbol too long (max 10 characters)');
  } else if (!/^[A-Za-z0-9_]+$/.test(request.token)) {
    errors.push('Token symbol contains invalid characters');
  }

  // Cross-validation: ensure protocol supports both chains
  if (
    request.protocol &&
    request.fromChain &&
    request.toChain &&
    ENHANCED_BRIDGE_PROTOCOLS[request.protocol] &&
    SUPPORTED_NETWORKS[request.fromChain] &&
    SUPPORTED_NETWORKS[request.toChain]
  ) {
    const protocol = ENHANCED_BRIDGE_PROTOCOLS[request.protocol];
    if (!protocol.supported_chains.includes(request.fromChain)) {
      errors.push(
        `Protocol ${request.protocol} does not support source chain ${request.fromChain}`
      );
    }
    if (!protocol.supported_chains.includes(request.toChain)) {
      errors.push(
        `Protocol ${request.protocol} does not support target chain ${request.toChain}`
      );
    }
  }

  return errors;
}

// Get all bridge protocols
app.get(
  '/api/bridges',
  (req: Request, res: Response<ApiResult<BridgeProtocol[]>>): void => {
    try {
      const protocols = Object.values(ENHANCED_BRIDGE_PROTOCOLS).filter(
        protocol => protocol.status === 'active'
      );

      res.json(createApiResponse(protocols));
    } catch (error) {
      res
        .status(500)
        .json(
          createApiError(
            'BRIDGES_ERROR',
            'Failed to fetch bridge protocols',
            error
          )
        );
    }
  }
);

// Get specific bridge protocol
app.get(
  '/api/bridges/:protocol',
  (
    req: Request<{ protocol: string }>,
    res: Response<ApiResult<BridgeProtocol>>
  ): void => {
    try {
      const { protocol } = req.params;

      const bridgeProtocol = ENHANCED_BRIDGE_PROTOCOLS[protocol.toLowerCase()];
      if (!bridgeProtocol) {
        res
          .status(404)
          .json(
            createApiError('PROTOCOL_NOT_FOUND', 'Bridge protocol not found')
          );
        return;
      }

      res.json(createApiResponse(bridgeProtocol));
    } catch (error) {
      res
        .status(500)
        .json(
          createApiError(
            'BRIDGE_ERROR',
            'Failed to fetch bridge protocol',
            error
          )
        );
    }
  }
);

// Get supported networks
app.get(
  '/api/networks',
  (req: Request, res: Response<ApiResult<NetworkInfo[]>>): void => {
    try {
      const networks = Object.values(SUPPORTED_NETWORKS);
      res.json(createApiResponse(networks));
    } catch (error) {
      res
        .status(500)
        .json(
          createApiError(
            'NETWORKS_ERROR',
            'Failed to fetch supported networks',
            error
          )
        );
    }
  }
);

// Initiate cross-chain transfer
app.post(
  '/api/bridges/transfer',
  async (
    req: Request<{}, ApiResult<BridgeTransaction>, CrossChainTransferRequest>,
    res: Response<ApiResult<BridgeTransaction>>
  ): Promise<void> => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const transferRequest: CrossChainTransferRequest = req.body;

      // Validate transfer request
      const validationErrors = validateTransfer(transferRequest);
      if (validationErrors.length > 0) {
        res
          .status(400)
          .json(
            createApiError(
              'VALIDATION_ERROR',
              'Invalid transfer request',
              validationErrors
            )
          );
        return;
      }

      const protocol = ENHANCED_BRIDGE_PROTOCOLS[transferRequest.protocol];

      // Create bridge transaction record with enhanced security
      const transactionId = `bridge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const sourceHash =
        `0x${Buffer.from(`${transactionId}_source`).toString('hex').padEnd(64, '0')}` as SecureHash;

      // Validate fee calculation doesn't result in NaN or infinity
      const fee = calculateBridgeFee(transferRequest.amount, protocol);
      if (!Number.isFinite(fee) || fee < 0) {
        res
          .status(400)
          .json(
            createApiError('FEE_CALCULATION_ERROR', 'Invalid fee calculation')
          );
        return;
      }

      // Ensure total amount doesn't exceed reasonable limits
      const totalAmount = transferRequest.amount + fee;
      if (totalAmount > Number.MAX_SAFE_INTEGER) {
        res
          .status(400)
          .json(
            createApiError(
              'AMOUNT_TOO_LARGE',
              'Total amount exceeds maximum safe value'
            )
          );
        return;
      }

      const insertQuery = `
      INSERT INTO bridge_transactions (
        id, source_chain, target_chain, source_hash, amount, token,
        sender, recipient, status, protocol, fee, created_at, estimated_completion
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW() + INTERVAL '${protocol.average_time}')
      RETURNING *
    `;

      const result = await client.query(insertQuery, [
        transactionId,
        transferRequest.fromChain,
        transferRequest.toChain,
        sourceHash,
        transferRequest.amount,
        transferRequest.token,
        transferRequest.fromAddress,
        transferRequest.toAddress,
        'pending',
        transferRequest.protocol,
        fee,
      ]);

      await client.query('COMMIT');

      const bridgeTransaction: BridgeTransaction = {
        id: transactionId,
        sourceChain: SUPPORTED_NETWORKS[transferRequest.fromChain].chainId,
        targetChain: SUPPORTED_NETWORKS[transferRequest.toChain].chainId,
        sourceHash,
        amount: transferRequest.amount as PositiveNumber,
        token: transferRequest.token as EthereumAddress,
        sender: transferRequest.fromAddress,
        recipient: transferRequest.toAddress,
        status: 'pending' as BridgeStatus,
        createdAt: new Date(),
        confirmations: 0,
        requiredConfirmations:
          SUPPORTED_NETWORKS[transferRequest.fromChain].finalityBlocks,
      };

      res.json(
        createApiResponse(bridgeTransaction, {
          protocol: protocol.name,
          estimatedTime: protocol.average_time,
          fee,
          feeToken: transferRequest.token,
        })
      );
    } catch (error) {
      await client.query('ROLLBACK');
      crosschainLogger.error('Error initiating bridge transfer', { error: error instanceof Error ? error.message : String(error) });
      res
        .status(500)
        .json(
          createApiError(
            'TRANSFER_ERROR',
            'Failed to initiate cross-chain transfer',
            error
          )
        );
    } finally {
      client.release();
    }
  }
);

// Get bridge transaction status
app.get(
  '/api/bridges/transactions/:transactionId',
  async (
    req: Request<{ transactionId: string }>,
    res: Response<ApiResult<BridgeTransaction>>
  ): Promise<void> => {
    try {
      const { transactionId } = req.params;

      const query = `
      SELECT * FROM bridge_transactions WHERE id = $1
    `;

      const result = await pool.query(query, [transactionId]);

      if (result.rows.length === 0) {
        res
          .status(404)
          .json(
            createApiError(
              'TRANSACTION_NOT_FOUND',
              'Bridge transaction not found'
            )
          );
        return;
      }

      const transaction = result.rows[0];
      res.json(createApiResponse(transaction));
    } catch (error) {
      crosschainLogger.error('Error fetching bridge transaction', { error: error instanceof Error ? error.message : String(error) });
      res
        .status(500)
        .json(
          createApiError(
            'TRANSACTION_ERROR',
            'Failed to fetch bridge transaction',
            error
          )
        );
    }
  }
);

// Get bridge statistics
app.get(
  '/api/bridges/stats',
  async (
    req: Request,
    res: Response<ApiResult<BridgeStatistics>>
  ): Promise<void> => {
    try {
      const statsQuery = `
      SELECT 
        SUM(amount) as total_volume,
        COUNT(*) as total_transactions,
        COUNT(DISTINCT protocol) as active_protocols,
        AVG(EXTRACT(EPOCH FROM (completed_at - created_at))/60) as avg_time_minutes,
        (COUNT(*) FILTER (WHERE status = 'completed')::float / COUNT(*) * 100) as success_rate
      FROM bridge_transactions
      WHERE created_at >= NOW() - INTERVAL '30 days'
    `;

      const result = await pool.query(statsQuery);
      const stats = result.rows[0];

      const bridgeStats: BridgeStatistics = {
        totalVolume: `$${(parseFloat(stats.total_volume) || 0).toLocaleString()}`,
        totalTransactions: parseInt(stats.total_transactions) || 0,
        activeProtocols: parseInt(stats.active_protocols) || 0,
        averageTime: `${Math.round(parseFloat(stats.avg_time_minutes) || 0)} minutes`,
        successRate: parseFloat(stats.success_rate) || 0,
      };

      res.json(createApiResponse(bridgeStats));
    } catch (error) {
      crosschainLogger.error('Error fetching bridge statistics', { error: error instanceof Error ? error.message : String(error) });
      res
        .status(500)
        .json(
          createApiError(
            'STATS_ERROR',
            'Failed to fetch bridge statistics',
            error
          )
        );
    }
  }
);

// Get transaction history with pagination
app.get(
  '/api/bridges/history/:address',
  async (
    req: Request<
      { address: string },
      ApiResult<PaginatedResponse<BridgeTransaction>>,
      {},
      PaginationParams
    >,
    res: Response<ApiResult<PaginatedResponse<BridgeTransaction>>>
  ): Promise<void> => {
    try {
      const { address } = req.params;
      const {
        page = 1,
        limit = 20,
        sortBy = 'created_at',
        sortOrder = 'desc',
      } = req.query;

      // Validate address format
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        res
          .status(400)
          .json(
            createApiError('INVALID_ADDRESS', 'Invalid Ethereum address format')
          );
        return;
      }

      const validatedPage = Math.max(1, Number(page));
      const validatedLimit = Math.min(100, Math.max(1, Number(limit)));
      const offset = (validatedPage - 1) * validatedLimit;

      const countQuery = `
      SELECT COUNT(*) as total 
      FROM bridge_transactions 
      WHERE sender = $1 OR recipient = $1
    `;

      const historyQuery = `
      SELECT * FROM bridge_transactions 
      WHERE sender = $1 OR recipient = $1
      ORDER BY ${sortBy} ${sortOrder.toUpperCase()}
      LIMIT $2 OFFSET $3
    `;

      const [countResult, historyResult] = await Promise.all([
        pool.query(countQuery, [address]),
        pool.query(historyQuery, [address, validatedLimit, offset]),
      ]);

      const total = parseInt(countResult.rows[0].total);
      const totalPages = Math.ceil(total / validatedLimit);

      const response: PaginatedResponse<BridgeTransaction> = {
        data: historyResult.rows,
        pagination: {
          page: validatedPage,
          limit: validatedLimit,
          total,
          totalPages,
          hasNext: validatedPage < totalPages,
          hasPrev: validatedPage > 1,
        },
      };

      res.json(createApiResponse(response));
    } catch (error) {
      crosschainLogger.error('Error fetching bridge history', { error: error instanceof Error ? error.message : String(error) });
      res
        .status(500)
        .json(
          createApiError(
            'HISTORY_ERROR',
            'Failed to fetch bridge transaction history',
            error
          )
        );
    }
  }
);

// Error handler
app.use((error: Error, req: Request, res: Response, next: Function) => {
  crosschainLogger.error('Unhandled error', { error: error.message });
  res.status(500).json(
    createApiError('INTERNAL_SERVER_ERROR', 'An unexpected error occurred', {
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    })
  );
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  crosschainLogger.info(`Enhanced Cross-Chain Server (TypeScript) running on port ${PORT}`);
  crosschainLogger.info(`Health check: http://0.0.0.0:${PORT}/health`);
  crosschainLogger.info(`Bridge protocols: ${Object.keys(ENHANCED_BRIDGE_PROTOCOLS).length} active protocols`);
  crosschainLogger.info(`Supported networks: ${Object.keys(SUPPORTED_NETWORKS).length} networks`);
});

registerGracefulShutdown({
  serviceName: 'enhanced-crosschain-server',
  server,
  logger: crosschainLogger,
  state: probeState,
  cleanupFns: [
    {
      name: 'enhanced-crosschain-database',
      handler: async () => {
        await pool.end();
      },
    },
  ],
});

export default app;
