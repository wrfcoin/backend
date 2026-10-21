/**
 * Cross-Chain Bridge API
 *
 * This module implements the API endpoints for interacting with the cross-chain bridge functionality.
 * It serves as a JavaScript interface to the Rust-based cross-chain components.
 *
 * It now uses the DatabaseStorage implementation for storing cross-chain transfers
 * instead of the mock in-memory storage.
 */

import * as express from 'express';
import { Request, Response, Router } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod';
// Import real storage from TypeScript implementation
import { storage } from '../storage.js';
import { executeQuery } from '../../database/db.js';
import * as blockchainAdapter from '../blockchain_adapter.js';
import * as websocketModule from '../websocket.js';
import { emitBridgeTransactionEvent } from '../events/cross-chain-event-bus.js';
import { crosschainLogger as crossChainLogger } from '../utils/logger.js';

// =====================================================
// INPUT VALIDATION SCHEMAS
// Security: Prevent injection attacks via strict input validation
// =====================================================

// WRF address validation (similar to ethereum address format)
const wrfAddressSchema = z.string()
  .min(10, 'WRF address is too short')
  .max(128, 'WRF address is too long')
  .regex(/^[a-zA-Z0-9]+$/, 'WRF address contains invalid characters');

// External address validation (supports multiple chain formats)
const externalAddressSchema = z.string()
  .min(10, 'External address is too short')
  .max(128, 'External address is too long')
  .regex(/^[a-zA-Z0-9]+$/, 'External address contains invalid characters');

// Amount validation: numeric string, max uint256 length
const amountSchema = z.string()
  .min(1, 'Amount is required')
  .max(78, 'Amount too large')
  .regex(/^[0-9]+$/, 'Amount must be a numeric string');

// Chain name validation: lowercase alphanumeric with common separators
const chainNameSchema = z.string()
  .min(1, 'Chain name is required')
  .max(32, 'Chain name too long')
  .regex(/^[a-z0-9_-]+$/, 'Chain name must be lowercase alphanumeric');

// Transaction hash validation
const transactionHashSchema = z.string()
  .max(128, 'Transaction hash too long')
  .regex(/^0x[a-fA-F0-9]+$/, 'Transaction hash must be a valid hex string')
  .optional();

// Provider validation
const providerSchema = z.string()
  .max(64, 'Provider name too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Provider name contains invalid characters')
  .optional();

// Fee validation
const feeSchema = z.string()
  .max(78, 'Fee too large')
  .regex(/^[0-9]+$/, 'Fee must be a numeric string')
  .optional();

// Cross-chain send request schema
const crossChainSendSchema = z.object({
  wrf_address: wrfAddressSchema,
  external_address: externalAddressSchema,
  amount: amountSchema,
  chain: chainNameSchema,
  external_transaction_hash: transactionHashSchema,
  provider: providerSchema,
  fee: feeSchema,
});

// Verify request schema
const verifyRequestSchema = z.object({
  tx_id: z.string()
    .min(1, 'Transaction ID is required')
    .max(128, 'Transaction ID too long')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Transaction ID contains invalid characters'),
});

// Transaction ID path parameter schema
const txIdParamSchema = z.string()
  .min(1, 'Transaction ID is required')
  .max(128, 'Transaction ID too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Transaction ID contains invalid characters');

// Query parameters schema
const transactionQuerySchema = z.object({
  chain: chainNameSchema.optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  status: z.string()
    .max(32)
    .regex(/^[a-z_]+$/, 'Invalid status format')
    .optional(),
  limit: z.string()
    .optional()
    .transform((val) => {
      const num = val ? parseInt(val, 10) : 10;
      return isNaN(num) || num < 1 ? 10 : Math.min(num, 100);
    }),
  page: z.string()
    .optional()
    .transform((val) => {
      const num = val ? parseInt(val, 10) : 1;
      return isNaN(num) || num < 1 ? 1 : Math.min(num, 10000);
    }),
});

// Cross-chain API interfaces
interface ChainInfo {
  id: string;
  name: string;
  rpc_url: string;
  token_contract: string;
  supported_tokens: TokenInfo[];
}

interface TokenInfo {
  symbol: string;
  name: string;
  contract: string;
}

interface BridgeTransaction {
  tx_id: string;
  status: string;
  direction?: string;
  from_chain: string;
  to_chain: string;
  amount: number;
  sender_address: string;
  recipient_address: string;
  external_transaction_hash?: string | null;
  wrf_transaction_hash?: string | null;
  source_tx_hash?: string | null;
  destination_tx_hash?: string | null;
  timestamp: string;
  completed_at?: string | null;
  provider?: string | null;
  fee?: string | null;
  trust_state?: string;
  provenance_source?: string;
}

interface CrossChainTransferRequest {
  wrf_address: string;
  external_address: string;
  amount: string;
  chain: string;
  external_transaction_hash?: string;
  provider?: string;
  fee?: string;
}

interface DatabaseTransaction {
  status: string;
  fromChain: string;
  toChain: string;
  amount: number;
  senderAddress: string;
  recipientAddress: string;
  sourceTxHash?: string | null;
  destinationTxHash?: string | null;
  timestamp: string;
  provider?: string | null;
  fee?: string | null;
}

interface DbTransactionResult {
  id: number;
  transferId?: string;
  status: string;
  fromChain: string;
  toChain: string;
  amount: number;
  senderAddress: string;
  recipientAddress: string;
  sourceTxHash?: string | null;
  destinationTxHash?: string | null;
  timestamp: string;
  created_at?: string;
  completedAt?: string | null;
  bridgeProvider?: string | null;
  fees?: string | null;
  metadata?: Record<string, unknown> | string | null;
}

const router: Router = express.Router();

// Utility function to safely extract error message
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as any).message);
  }
  return 'An unknown error occurred';
}

function emitCanonicalBridgeEvent(payload: {
  transaction: BridgeTransaction;
  message: string;
  previous_status?: string;
  new_status?: string;
}): void {
  try {
    emitBridgeTransactionEvent(payload);
  } catch (error) {
    crossChainLogger.warn('Failed to emit canonical bridge event', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Default bridge chains until the real ones are loaded
const SUPPORTED_CHAINS: ChainInfo[] = [
  {
    id: 'ethereum',
    name: 'Ethereum Mainnet',
    rpc_url: 'https://ethereum-rpc.wrfcoin.bridge',
    token_contract: '0x1234567890123456789012345678901234567890',
    supported_tokens: [
      {
        symbol: 'WRF',
        name: 'Wrapped WRF',
        contract: '0x1234567890123456789012345678901234567890',
      },
      {
        symbol: 'USDT',
        name: 'Tether USD',
        contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      },
      {
        symbol: 'USDC',
        name: 'USD Coin',
        contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      },
    ],
  },
  {
    id: 'polygon',
    name: 'Polygon PoS Chain',
    rpc_url: 'https://polygon-rpc.wrfcoin.bridge',
    token_contract: '0x2345678901234567890123456789012345678901',
    supported_tokens: [
      {
        symbol: 'WRF',
        name: 'Wrapped WRF',
        contract: '0x2345678901234567890123456789012345678901',
      },
      {
        symbol: 'USDT',
        name: 'Tether USD',
        contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      },
      {
        symbol: 'USDC',
        name: 'USD Coin',
        contract: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      },
    ],
  },
  {
    id: 'solana',
    name: 'Solana',
    rpc_url: 'https://solana-rpc.wrfcoin.bridge',
    token_contract: 'WRFCFw7C5qnHvVhZHEuEweLMSvAGQbYhFM1G2CnDJDm',
    supported_tokens: [
      {
        symbol: 'WRF',
        name: 'Wrapped WRF',
        contract: 'WRFCFw7C5qnHvVhZHEuEweLMSvAGQbYhFM1G2CnDJDm',
      },
      {
        symbol: 'USDT',
        name: 'Tether USD',
        contract: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      },
      {
        symbol: 'USDC',
        name: 'USD Coin',
        contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      },
    ],
  },
  {
    id: 'avalanche',
    name: 'Avalanche C-Chain',
    rpc_url: 'https://avalanche-rpc.wrfcoin.bridge',
    token_contract: '0x3456789012345678901234567890123456789012',
    supported_tokens: [
      {
        symbol: 'WRF',
        name: 'Wrapped WRF',
        contract: '0x3456789012345678901234567890123456789012',
      },
      {
        symbol: 'USDT',
        name: 'Tether USD',
        contract: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
      },
      {
        symbol: 'USDC',
        name: 'USD Coin',
        contract: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      },
    ],
  },
  {
    id: 'bnbchain',
    name: 'BNB Smart Chain',
    rpc_url: 'https://bsc-rpc.wrfcoin.bridge',
    token_contract: '0x4567890123456789012345678901234567890123',
    supported_tokens: [
      {
        symbol: 'WRF',
        name: 'Wrapped WRF',
        contract: '0x4567890123456789012345678901234567890123',
      },
      {
        symbol: 'USDT',
        name: 'Tether USD',
        contract: '0x55d398326f99059fF775485246999027B3197955',
      },
      {
        symbol: 'USDC',
        name: 'USD Coin',
        contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      },
    ],
  },
  {
    id: 'base',
    name: 'Base',
    rpc_url: 'https://base-rpc.wrfcoin.bridge',
    token_contract: '0x5678901234567890123456789012345678901234',
    supported_tokens: [
      {
        symbol: 'WRF',
        name: 'Wrapped WRF',
        contract: '0x5678901234567890123456789012345678901234',
      },
      {
        symbol: 'USDT',
        name: 'Tether USD',
        contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      },
      {
        symbol: 'USDC',
        name: 'USD Coin',
        contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      },
    ],
  },
  {
    id: 'arbitrum',
    name: 'Arbitrum One',
    rpc_url: 'https://arbitrum-rpc.wrfcoin.bridge',
    token_contract: '0x6789012345678901234567890123456789012345',
    supported_tokens: [
      {
        symbol: 'WRF',
        name: 'Wrapped WRF',
        contract: '0x6789012345678901234567890123456789012345',
      },
      {
        symbol: 'USDT',
        name: 'Tether USD',
        contract: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      },
      {
        symbol: 'USDC',
        name: 'USD Coin',
        contract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      },
    ],
  },
];

// Bridge transaction statuses
const BRIDGE_STATUS: Record<string, string> = {
  INITIATED: 'initiated',
  LOCKED: 'locked',
  MINTED: 'minted',
  BURNED: 'burned',
  UNLOCKED: 'unlocked',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const TERMINAL_BRIDGE_STATUSES = new Set<string>([
  BRIDGE_STATUS.COMPLETED,
  BRIDGE_STATUS.FAILED,
]);

const BRIDGE_TRUST_STATE = {
  PENDING: 'pending',
  CHALLENGE_WINDOW: 'challenge-window',
  FINALIZED: 'finalized',
  DISPUTED: 'disputed',
  HALTED: 'halted',
} as const;

const BRIDGE_PROVENANCE_SOURCE = {
  SIMULATED: 'simulated',
  LOCAL_MANAGER: 'local-manager',
  PRODUCTION_VERIFIED: 'production-verified',
} as const;

// Store in-memory transactions for now (will move to database)
const bridgeTransactions: BridgeTransaction[] = [];

function isDatabaseId(identifier: string): boolean {
  return /^\d+$/.test(identifier);
}

function getBridgeStateDelayMs(): number {
  const fromEnv = Number(process.env.BRIDGE_STATE_DELAY_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return 3000 + Math.random() * 2000;
}

function generateBridgeHash(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}

function parseBridgeMetadata(
  metadata: Record<string, unknown> | string | null | undefined
): Record<string, unknown> {
  if (!metadata) {
    return {};
  }
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata) as Record<string, unknown>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return metadata;
}

function getTrustState(
  status: string,
  metadata?: Record<string, unknown>
): string {
  if (metadata?.halted === true) {
    return BRIDGE_TRUST_STATE.HALTED;
  }
  if (metadata?.challenge_window_open === true) {
    return BRIDGE_TRUST_STATE.CHALLENGE_WINDOW;
  }
  if (status === BRIDGE_STATUS.FAILED) {
    return BRIDGE_TRUST_STATE.DISPUTED;
  }
  if (status === BRIDGE_STATUS.COMPLETED) {
    return BRIDGE_TRUST_STATE.FINALIZED;
  }
  return BRIDGE_TRUST_STATE.PENDING;
}

function formatDatabaseTransactionForResponse(
  transaction: DbTransactionResult
): BridgeTransaction {
  const metadata = parseBridgeMetadata(transaction.metadata);
  const direction =
    typeof metadata.direction === 'string'
      ? metadata.direction
      : transaction.fromChain === 'wrfcoin'
      ? 'outbound'
      : 'inbound';

  const sourceTxHash =
    typeof metadata.sourceTxHash === 'string'
      ? metadata.sourceTxHash
      : transaction.sourceTxHash || null;
  const destinationTxHash =
    typeof metadata.destinationTxHash === 'string'
      ? metadata.destinationTxHash
      : transaction.destinationTxHash || null;

  return {
    tx_id: transaction.id.toString(),
    status: transaction.status,
    direction,
    from_chain: transaction.fromChain,
    to_chain: transaction.toChain,
    amount:
      typeof transaction.amount === 'number'
        ? transaction.amount
        : Number(transaction.amount),
    sender_address: transaction.senderAddress,
    recipient_address: transaction.recipientAddress,
    external_transaction_hash: sourceTxHash,
    wrf_transaction_hash: destinationTxHash,
    source_tx_hash: sourceTxHash,
    destination_tx_hash: destinationTxHash,
    timestamp: transaction.timestamp,
    completed_at: transaction.completedAt || null,
    provider:
      transaction.bridgeProvider ||
      (typeof metadata.provenance_source === 'string'
        ? metadata.provenance_source
        : null),
    fee: transaction.fees || null,
    trust_state: getTrustState(transaction.status, metadata),
    provenance_source:
      typeof metadata.provenance_source === 'string'
        ? metadata.provenance_source
        : BRIDGE_PROVENANCE_SOURCE.LOCAL_MANAGER,
  };
}

function formatInMemoryTransactionForResponse(
  transaction: BridgeTransaction
): BridgeTransaction {
  return {
    ...transaction,
    trust_state: getTrustState(transaction.status),
    provenance_source:
      transaction.provenance_source || BRIDGE_PROVENANCE_SOURCE.SIMULATED,
  };
}

async function createDatabaseTransfer(
  transferId: string,
  dbTransaction: DatabaseTransaction,
  direction: 'inbound' | 'outbound'
): Promise<DbTransactionResult> {
  const metadata = {
    direction,
    sourceTxHash: dbTransaction.sourceTxHash || null,
    destinationTxHash: dbTransaction.destinationTxHash || null,
    trust_state: BRIDGE_TRUST_STATE.PENDING,
    provenance_source: BRIDGE_PROVENANCE_SOURCE.LOCAL_MANAGER,
  };

  const result = await executeQuery(
    `INSERT INTO cross_chain_transfers
      (transfer_id, from_chain, to_chain, from_address, to_address, amount, token_type, status, initiated_at, bridge_provider, fees, metadata)
     VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
     RETURNING
      id,
      transfer_id AS "transferId",
      status,
      from_chain AS "fromChain",
      to_chain AS "toChain",
      from_address AS "senderAddress",
      to_address AS "recipientAddress",
      amount,
      initiated_at::text AS "timestamp",
      completed_at::text AS "completedAt",
      bridge_provider AS "bridgeProvider",
      fees,
      metadata`,
    [
      transferId,
      dbTransaction.fromChain,
      dbTransaction.toChain,
      dbTransaction.senderAddress,
      dbTransaction.recipientAddress,
      dbTransaction.amount.toString(),
      'WRF',
      dbTransaction.status,
      dbTransaction.timestamp,
      dbTransaction.provider || BRIDGE_PROVENANCE_SOURCE.LOCAL_MANAGER,
      dbTransaction.fee || null,
      JSON.stringify(metadata),
    ]
  );

  if (!result?.rows?.[0]) {
    throw new Error('Failed to create cross-chain transfer');
  }

  return result.rows[0] as unknown as DbTransactionResult;
}

async function getDatabaseTransferByIdentifier(
  identifier: string
): Promise<DbTransactionResult | null> {
  const query = isDatabaseId(identifier)
    ? `SELECT
         id,
         transfer_id AS "transferId",
         status,
         from_chain AS "fromChain",
         to_chain AS "toChain",
         from_address AS "senderAddress",
         to_address AS "recipientAddress",
         amount,
         initiated_at::text AS "timestamp",
         completed_at::text AS "completedAt",
         bridge_provider AS "bridgeProvider",
         fees,
         metadata
       FROM cross_chain_transfers
       WHERE id = $1
       LIMIT 1`
    : `SELECT
         id,
         transfer_id AS "transferId",
         status,
         from_chain AS "fromChain",
         to_chain AS "toChain",
         from_address AS "senderAddress",
         to_address AS "recipientAddress",
         amount,
         initiated_at::text AS "timestamp",
         completed_at::text AS "completedAt",
         bridge_provider AS "bridgeProvider",
         fees,
         metadata
       FROM cross_chain_transfers
       WHERE transfer_id = $1
       LIMIT 1`;

  const parameter = isDatabaseId(identifier) ? Number(identifier) : identifier;
  const result = await executeQuery(query, [parameter]);
  return (result?.rows?.[0] as unknown as DbTransactionResult | undefined) || null;
}

async function updateDatabaseTransferState(
  txId: number,
  status: string,
  completedAt: string | null,
  metadata: Record<string, unknown>
): Promise<DbTransactionResult | null> {
  const result = await executeQuery(
    `UPDATE cross_chain_transfers
      SET status = $2,
          completed_at = $3::timestamp,
          metadata = $4::jsonb
      WHERE id = $1
        AND status NOT IN ('completed', 'failed')
      RETURNING
        id,
        transfer_id AS "transferId",
        status,
        from_chain AS "fromChain",
        to_chain AS "toChain",
        from_address AS "senderAddress",
        to_address AS "recipientAddress",
        amount,
        initiated_at::text AS "timestamp",
        completed_at::text AS "completedAt",
        bridge_provider AS "bridgeProvider",
        fees,
        metadata`,
    [txId, status, completedAt, JSON.stringify(metadata)]
  );

  if (result?.rows?.[0]) {
    return result.rows[0] as unknown as DbTransactionResult;
  }
  return null;
}

/**
 * GET /api/cross-chain/networks
 * Get all supported networks for cross-chain bridging
 */
router.get('/networks', async (req: Request, res: Response) => {
  try {
    // In a real implementation, this would call into the Rust blockchain
    // through the blockchain adapter to get the actual supported chains

    res.json(SUPPORTED_CHAINS);
  } catch (error) {
    crossChainLogger.error('Error fetching supported chains', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      error: 'Failed to fetch supported chains',
      details: getErrorMessage(error),
    });
  }
});

/**
 * GET /api/cross-chain/transactions/:id
 * Get the status of a cross-chain transaction
 */
router.get(
  '/transactions/:id',
  async (req: Request, res: Response): Promise<void> => {
    try {
      // SECURITY: Validate transaction ID parameter to prevent injection attacks
      const idValidation = txIdParamSchema.safeParse(req.params.id);
      if (!idValidation.success) {
        res.status(400).json({
          error: 'Invalid transaction ID',
          details: idValidation.error.issues.map((e) => e.message),
        });
        return;
      }
      const id = idValidation.data;

      // First check in-memory
      const memTransaction = bridgeTransactions.find(tx => tx.tx_id === id);

      if (memTransaction) {
        res.json(formatInMemoryTransactionForResponse(memTransaction));
        return;
      }

      // Fall back to durable DB lookup (by numeric ID or transfer_id).
      try {
        const dbTransaction = await getDatabaseTransferByIdentifier(id);
        if (dbTransaction) {
          res.json(formatDatabaseTransactionForResponse(dbTransaction));
          return;
        }
      } catch (dbError) {
        crossChainLogger.warn('Failed to fetch bridge transaction from DB', {
          txId: id,
          error: dbError instanceof Error ? dbError.message : String(dbError),
        });
      }

      // If we get here, transaction was not found
      res.status(404).json({
        error: 'Transaction not found',
        tx_id: id,
      });
    } catch (error) {
      crossChainLogger.error('Error fetching transaction status', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({
        error: 'Failed to fetch transaction status',
        details: getErrorMessage(error),
      });
    }
  }
);

/**
 * GET /api/cross-chain/transactions
 * Get recent cross-chain transactions with optional filters
 */
router.get(
  '/transactions',
  async (req: Request, res: Response): Promise<void> => {
    try {
      // SECURITY: Validate query parameters to prevent injection attacks
      const queryValidation = transactionQuerySchema.safeParse(req.query);
      if (!queryValidation.success) {
        res.status(400).json({
          error: 'Invalid query parameters',
          details: queryValidation.error.issues.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        });
        return;
      }

      const { chain, direction, status, limit: limitNum, page: pageNum } = queryValidation.data;

      // Use the database storage implementation
      let transactions: DbTransactionResult[] = [];

      try {
        if (chain) {
          // If we're filtering by chain, need to determine the direction
          if (chain === 'wrfcoin') {
            if (direction === 'inbound') {
              // Transfers to wrfcoin - for now, return empty array
              transactions = [];
            } else if (direction === 'outbound') {
              // Transfers from wrfcoin - for now, return empty array
              transactions = [];
            } else {
              // All transfers involving wrfcoin - for now, return empty array
              transactions = [];
            }
          } else {
            // For a specific external chain - for now, return empty array
            transactions = [];

            // Also add transactions in the other direction - for now, return empty array
            const outTransactions: DbTransactionResult[] = [];
            transactions = [...transactions, ...outTransactions].slice(
              0,
              limitNum
            );
          }
        } else if (status) {
          // Filter by status only - for now, return empty array
          transactions = [];
        } else {
          // No filters, get all transactions - for now, return empty array
          transactions = [];
        }

        // Transform to the expected format
        const formattedTransactions = transactions.map(tx => ({
          tx_id: tx.id.toString(),
          status: tx.status,
          from_chain: tx.fromChain,
          to_chain: tx.toChain,
          amount: tx.amount,
          sender_address: tx.senderAddress,
          recipient_address: tx.recipientAddress,
          source_tx_hash: tx.sourceTxHash || null,
          destination_tx_hash: tx.destinationTxHash || null,
          timestamp: tx.timestamp,
          completed_at: tx.completedAt || null,
        }));

        // Include in-memory transactions during transition
        let combinedTransactions = [...formattedTransactions];
        if (bridgeTransactions.length > 0) {
          // Apply the same filters that were used for DB transactions
          let filteredMemTransactions = [...bridgeTransactions];

          if (chain) {
            filteredMemTransactions = filteredMemTransactions.filter(
              tx => tx.from_chain === chain || tx.to_chain === chain
            );
          }

          if (direction === 'inbound') {
            filteredMemTransactions = filteredMemTransactions.filter(
              tx => tx.to_chain === 'wrfcoin'
            );
          } else if (direction === 'outbound') {
            filteredMemTransactions = filteredMemTransactions.filter(
              tx => tx.from_chain === 'wrfcoin'
            );
          }

          if (status) {
            filteredMemTransactions = filteredMemTransactions.filter(
              tx => tx.status === status
            );
          }

          // Convert in-memory transactions to match the expected format
          const convertedMemTransactions = filteredMemTransactions.map(tx => ({
            tx_id: tx.tx_id,
            status: tx.status,
            from_chain: tx.from_chain,
            to_chain: tx.to_chain,
            amount: tx.amount,
            sender_address: tx.sender_address,
            recipient_address: tx.recipient_address,
            source_tx_hash: tx.source_tx_hash || null,
            destination_tx_hash: tx.destination_tx_hash || null,
            timestamp: tx.timestamp,
            completed_at: tx.completed_at || null,
          }));

          combinedTransactions = [
            ...combinedTransactions,
            ...convertedMemTransactions,
          ];
        }

        // Sort by timestamp (newest first)
        combinedTransactions.sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        // Apply limit
        const limitedTransactions = combinedTransactions.slice(0, limitNum);

        res.json(limitedTransactions);
      } catch (dbError) {
        crossChainLogger.warn('Database query failed, falling back to in-memory data', { error: dbError instanceof Error ? dbError.message : String(dbError) });

        // Fallback to in-memory implementation
        let filteredTransactions = [...bridgeTransactions];

        if (chain) {
          filteredTransactions = filteredTransactions.filter(
            tx => tx.from_chain === chain || tx.to_chain === chain
          );
        }

        if (direction === 'inbound') {
          filteredTransactions = filteredTransactions.filter(
            tx => tx.to_chain === 'wrfcoin'
          );
        } else if (direction === 'outbound') {
          filteredTransactions = filteredTransactions.filter(
            tx => tx.from_chain === 'wrfcoin'
          );
        }

        if (status) {
          filteredTransactions = filteredTransactions.filter(
            tx => tx.status === status
          );
        }

        // Sort by timestamp (newest first)
        filteredTransactions.sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        // Apply limit
        const limitedTransactions = filteredTransactions.slice(0, limitNum);

        res.json(limitedTransactions);
      }
    } catch (error) {
      crossChainLogger.error('Error fetching transactions', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({
        error: 'Failed to fetch transactions',
        details: getErrorMessage(error),
      });
    }
  }
);

/**
 * POST /api/cross-chain/send
 * Create a new cross-chain message (bridge transaction)
 */
router.post('/send', async (req: Request, res: Response): Promise<void> => {
  try {
    // SECURITY: Validate input using zod schema to prevent injection attacks
    const validationResult = crossChainSendSchema.safeParse(req.body);
    if (!validationResult.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: validationResult.error.issues.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      });
      return;
    }

    const {
      wrf_address,
      external_address,
      amount,
      chain,
      external_transaction_hash,
      provider,
      fee,
    } = validationResult.data;

    // Check if chain is supported
    const supportedChain = SUPPORTED_CHAINS.find(c => c.id === chain);
    if (!supportedChain) {
      res.status(400).json({
        error: 'Unsupported chain',
        chain,
        supported: SUPPORTED_CHAINS.map(c => c.id),
      });
      return;
    }

    // Determine direction based on presence of external transaction hash
    const isInbound = !!external_transaction_hash;
    const direction = isInbound ? 'inbound' : 'outbound';

    // Stable transfer identifier; DB row ID remains canonical tx_id for lifecycle processing.
    const transfer_id = `tx${Math.random().toString(36).substring(2, 10)}`;

    // Create transaction object for database
    const dbTransaction = {
      status: BRIDGE_STATUS.INITIATED,
      fromChain: isInbound ? chain : 'wrfcoin',
      toChain: isInbound ? 'wrfcoin' : chain,
      amount: parseInt(amount, 10),
      senderAddress: isInbound ? external_address : wrf_address,
      recipientAddress: isInbound ? wrf_address : external_address,
      sourceTxHash: external_transaction_hash || null,
      destinationTxHash: null,
      timestamp: new Date().toISOString(),
      provider: provider || null, // Add provider parameter
      fee: fee || null, // Add fee parameter
    };

    let transaction: BridgeTransaction;
    let tx_id = transfer_id;
    try {
      const createdTx = await createDatabaseTransfer(
        transfer_id,
        dbTransaction,
        direction as 'inbound' | 'outbound'
      );
      transaction = formatDatabaseTransactionForResponse(createdTx);
      tx_id = transaction.tx_id;
    } catch (dbError) {
      crossChainLogger.error('Database error storing cross-chain transfer', { error: dbError instanceof Error ? dbError.message : String(dbError) });

      // Fallback to in-memory storage for backward compatibility
      const memoryTransaction = {
        tx_id: transfer_id,
        status: BRIDGE_STATUS.INITIATED,
        direction,
        from_chain: isInbound ? chain : 'wrfcoin',
        to_chain: isInbound ? 'wrfcoin' : chain,
        amount: parseInt(amount, 10),
        sender_address: isInbound ? external_address : wrf_address,
        recipient_address: isInbound ? wrf_address : external_address,
        external_transaction_hash: external_transaction_hash || null,
        wrf_transaction_hash: null,
        timestamp: new Date().toISOString(),
        provider: provider || null, // Add provider parameter
        fee: fee || null, // Add fee parameter
        trust_state: BRIDGE_TRUST_STATE.PENDING,
        provenance_source: BRIDGE_PROVENANCE_SOURCE.SIMULATED,
      };

      // Store in memory array
      bridgeTransactions.push(memoryTransaction);

      // Use this for the rest of the function
      transaction = formatInMemoryTransactionForResponse(memoryTransaction);
      tx_id = transfer_id;
    }

    // Broadcast WebSocket event
    const bridgeCreatedEvent = {
      transaction,
      message: `New ${direction} bridge transaction created`,
    };
    websocketModule.broadcastBridgeTransaction(bridgeCreatedEvent);
    emitCanonicalBridgeEvent(bridgeCreatedEvent);

    // Process the transaction asynchronously
    setTimeout(() => processBridgeTransaction(tx_id), 2000);

    // Return success response
    res.status(200).json({
      success: true,
      tx_id,
      transfer_id,
      direction,
      provider: provider || null, // Include provider in the response
    });
  } catch (error) {
    crossChainLogger.error('Error creating bridge transaction', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      error: 'Failed to create bridge transaction',
      details: getErrorMessage(error),
    });
  }
});

/**
 * POST /api/cross-chain/verify
 * Verify a cross-chain message
 */
router.post('/verify', async (req: Request, res: Response): Promise<void> => {
  try {
    // SECURITY: Validate input using zod schema to prevent injection attacks
    const validationResult = verifyRequestSchema.safeParse(req.body);
    if (!validationResult.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: validationResult.error.issues.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        })),
        valid: false,
      });
      return;
    }

    const { tx_id } = validationResult.data;

    try {
      const dbTransaction = await getDatabaseTransferByIdentifier(tx_id);
      if (dbTransaction) {
        const formatted = formatDatabaseTransactionForResponse(dbTransaction);
        const isValid = formatted.status === BRIDGE_STATUS.COMPLETED;

        res.json({
          valid: isValid,
          tx_id: formatted.tx_id,
          status: formatted.status,
          from_chain: formatted.from_chain,
          to_chain: formatted.to_chain,
          amount: formatted.amount,
          wrf_transaction_hash: formatted.wrf_transaction_hash || null,
          external_transaction_hash: formatted.external_transaction_hash || null,
          trust_state: formatted.trust_state,
          provenance_source: formatted.provenance_source,
        });
        return;
      }

      // Then check in-memory (for backward compatibility during migration)
      const memTransaction = bridgeTransactions.find(
        tx => tx.tx_id === tx_id
      );

      if (!memTransaction) {
        res.status(404).json({
          error: 'Transaction not found',
          tx_id,
          valid: false,
        });
        return;
      }

      const formatted = formatInMemoryTransactionForResponse(memTransaction);
      const isValid = formatted.status === BRIDGE_STATUS.COMPLETED;

      res.json({
        valid: isValid,
        tx_id,
        status: formatted.status,
        from_chain: formatted.from_chain,
        to_chain: formatted.to_chain,
        amount: formatted.amount,
        wrf_transaction_hash: formatted.wrf_transaction_hash || null,
        external_transaction_hash: formatted.external_transaction_hash || null,
        trust_state: formatted.trust_state,
        provenance_source: formatted.provenance_source,
      });
      return;
    } catch (dbError) {
      crossChainLogger.warn('Database error when verifying transaction, falling back to in-memory', { error: dbError instanceof Error ? dbError.message : String(dbError) });

      // Fallback to in-memory
      const memTransaction = bridgeTransactions.find(tx => tx.tx_id === tx_id);

      if (!memTransaction) {
        res.status(404).json({
          error: 'Transaction not found',
          tx_id,
          valid: false,
        });
        return;
      }

      // Check if the transaction is completed
      const formatted = formatInMemoryTransactionForResponse(memTransaction);
      const isValid = formatted.status === BRIDGE_STATUS.COMPLETED;

      res.json({
        valid: isValid,
        tx_id,
        status: formatted.status,
        from_chain: formatted.from_chain,
        to_chain: formatted.to_chain,
        amount: formatted.amount,
        wrf_transaction_hash: formatted.wrf_transaction_hash,
        external_transaction_hash: formatted.external_transaction_hash,
        trust_state: formatted.trust_state,
        provenance_source: formatted.provenance_source,
      });
      return;
    }
  } catch (error) {
    crossChainLogger.error('Error verifying transaction', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      error: 'Failed to verify transaction',
      details: getErrorMessage(error),
      valid: false,
    });
  }
});

/**
 * GET /api/cross-chain/map
 * Get network map for visualizing cross-chain connectivity
 */
router.get('/map', async (req: Request, res: Response) => {
  try {
    // Calculate total value locked in each chain
    const tvlByChain: Record<string, number> = {};

    // Initialize with 0 for all chains
    SUPPORTED_CHAINS.forEach(chain => {
      tvlByChain[chain.id] = 0;
    });
    tvlByChain['wrfcoin'] = 0;

    // Calculate totals from transactions
    bridgeTransactions.forEach(tx => {
      if (tx.from_chain === 'wrfcoin') {
        tvlByChain[tx.to_chain] += tx.amount;
      } else if (tx.to_chain === 'wrfcoin') {
        tvlByChain[tx.from_chain] += tx.amount;
      }
    });

    // Generate network data
    const networkData = {
      nodes: [
        {
          id: 'wrfcoin',
          name: 'Wrfcoin',
          tvl: tvlByChain['wrfcoin'] || 10000000, // Default value for visualization
          isHome: true,
        },
        ...SUPPORTED_CHAINS.map(chain => ({
          id: chain.id,
          name: chain.name,
          tvl:
            tvlByChain[chain.id] ||
            Math.floor(Math.random() * 5000000) + 500000, // Default for visualization
          isHome: false,
        })),
      ],
      links: SUPPORTED_CHAINS.map(chain => {
        const transactions = bridgeTransactions.filter(
          tx =>
            (tx.from_chain === chain.id && tx.to_chain === 'wrfcoin') ||
            (tx.from_chain === 'wrfcoin' && tx.to_chain === chain.id)
        );

        const volume =
          transactions.reduce((sum, tx) => sum + tx.amount, 0) || 100000;

        return {
          source: 'wrfcoin',
          target: chain.id,
          volume,
          transactions: transactions.length,
        };
      }),
      transactions: bridgeTransactions.slice(0, 10), // Recent transactions
    };

    res.json(networkData);
  } catch (error) {
    crossChainLogger.error('Error generating network map', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      error: 'Failed to generate network map',
      details: getErrorMessage(error),
    });
  }
});

/**
 * GET /api/cross-chain/map/svg
 * Get SVG visualization of cross-chain connectivity
 */
router.get('/map/svg', async (req: Request, res: Response) => {
  try {
    // Simple SVG representation of the bridge network
    const width = 800;
    const height = 600;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = 200;

    // Start SVG
    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="5" result="blur"/>
          <feComposite in="SourceGraphic" in2="blur" operator="over"/>
        </filter>
      </defs>
      <rect width="${width}" height="${height}" fill="#121826" />
      
      <!-- Wrfcoin Node (Center) -->
      <circle cx="${centerX}" cy="${centerY}" r="60" fill="#3b82f6" filter="url(#glow)" />
      <text x="${centerX}" y="${centerY}" text-anchor="middle" dy="5" fill="white" font-weight="bold" font-family="Arial, sans-serif">Wrfcoin</text>
    `;

    // Add chains
    const chainCount = SUPPORTED_CHAINS.length;
    SUPPORTED_CHAINS.forEach((chain, index) => {
      const angle = (2 * Math.PI * index) / chainCount;
      const x = centerX + radius * Math.cos(angle);
      const y = centerY + radius * Math.sin(angle);

      // Get chain color
      let color;
      switch (chain.id) {
        case 'ethereum':
          color = '#627eea';
          break;
        case 'polygon':
          color = '#8247e5';
          break;
        case 'solana':
          color = '#14f195';
          break;
        case 'avalanche':
          color = '#e84142';
          break;
        case 'bnbchain':
          color = '#f3ba2f';
          break;
        case 'base':
          color = '#0052ff';
          break;
        case 'arbitrum':
          color = '#28a0f0';
          break;
        default:
          color = '#888888';
      }

      // Add node
      svg += `
        <!-- ${chain.name} Node -->
        <circle cx="${x}" cy="${y}" r="40" fill="${color}" filter="url(#glow)" />
        <text x="${x}" y="${y}" text-anchor="middle" dy="5" fill="white" font-weight="bold" font-family="Arial, sans-serif">${chain.id}</text>
        
        <!-- Connection Line -->
        <line x1="${centerX}" y1="${centerY}" x2="${x}" y2="${y}" stroke="rgba(255,255,255,0.3)" stroke-width="3" />
      `;

      // Add some animated "transaction" dots
      for (let i = 0; i < 2; i++) {
        const animationDuration = 3 + Math.random() * 4;
        const delay = Math.random() * 5;
        const dotSize = 5 + Math.random() * 5;
        const direction = i % 2 === 0 ? 'from' : 'to';

        svg += `
          <circle r="${dotSize}" fill="white">
            <animate 
              attributeName="cx" 
              from="${direction === 'from' ? centerX : x}" 
              to="${direction === 'from' ? x : centerX}" 
              dur="${animationDuration}s" 
              begin="${delay}s"
              repeatCount="indefinite" />
            <animate 
              attributeName="cy" 
              from="${direction === 'from' ? centerY : y}" 
              to="${direction === 'from' ? y : centerY}" 
              dur="${animationDuration}s" 
              begin="${delay}s"
              repeatCount="indefinite" />
            <animate 
              attributeName="opacity" 
              values="0;1;1;0" 
              keyTimes="0;0.1;0.9;1" 
              dur="${animationDuration}s" 
              begin="${delay}s"
              repeatCount="indefinite" />
          </circle>
        `;
      }
    });

    // Close SVG
    svg += '</svg>';

    // Set SVG response
    res.set('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (error) {
    crossChainLogger.error('Error generating network SVG', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      error: 'Failed to generate network SVG',
      details: getErrorMessage(error),
    });
  }
});

/**
 * Process a bridge transaction (simulate the actual bridging process)
 * @param {string} txId - Transaction ID
 */
async function processBridgeTransaction(txId: string): Promise<void> {
  let dbTransaction: DbTransactionResult | null = null;
  let memTransaction: BridgeTransaction | null = null;

  try {
    dbTransaction = await getDatabaseTransferByIdentifier(txId);
  } catch (dbError) {
    crossChainLogger.warn('Error retrieving transaction from database', {
      txId,
      error: dbError instanceof Error ? dbError.message : String(dbError),
    });
  }

  if (!dbTransaction) {
    const txIndex = bridgeTransactions.findIndex(tx => tx.tx_id === txId);
    if (txIndex === -1) {
      crossChainLogger.error('Transaction not found during bridge processing', { txId });
      return;
    }
    memTransaction = bridgeTransactions[txIndex];
  }

  const isInbound = dbTransaction
    ? dbTransaction.fromChain !== 'wrfcoin'
    : memTransaction?.direction === 'inbound';
  if (typeof isInbound !== 'boolean') {
    crossChainLogger.error('Unable to infer transaction direction', { txId });
    return;
  }

  const states: string[] = [
    BRIDGE_STATUS.INITIATED,
    BRIDGE_STATUS.LOCKED,
    isInbound ? BRIDGE_STATUS.MINTED : BRIDGE_STATUS.BURNED,
    isInbound ? BRIDGE_STATUS.COMPLETED : BRIDGE_STATUS.UNLOCKED,
    !isInbound ? BRIDGE_STATUS.COMPLETED : null,
  ].filter(Boolean) as string[];

  if (dbTransaction) {
    processNextDatabaseState(dbTransaction.id, states, 0);
    return;
  }
  processNextState(txId, states, 0);
}

/**
 * Process the next state in a bridge transaction
 * @param {string} txId - Transaction ID
 * @param {Array<string>} states - Array of states
 * @param {number} currentIndex - Current state index
 */
async function processNextState(
  txId: string,
  states: string[],
  currentIndex: number
): Promise<void> {
  if (currentIndex >= states.length) {
    return;
  }

  const txIndex = bridgeTransactions.findIndex(tx => tx.tx_id === txId);

  if (txIndex === -1) {
    crossChainLogger.error('Transaction not found during state processing', { txId });
    return;
  }

  const transaction = bridgeTransactions[txIndex];
  const newStatus = states[currentIndex];

  if (TERMINAL_BRIDGE_STATUSES.has(transaction.status)) {
    return;
  }

  // Update transaction status
  transaction.status = newStatus;
  bridgeTransactions[txIndex] = transaction;

  // If this is the first update after 'INITIATED', generate a transaction hash
  if (currentIndex === 1) {
    if (transaction.direction === 'outbound') {
      // Generate a transaction hash for the Wrfcoin chain
      transaction.wrf_transaction_hash = generateBridgeHash();
    } else {
      // For inbound, we already have the external hash, generate the Wrfcoin one
      transaction.wrf_transaction_hash = generateBridgeHash();
    }
  }

  // This function is for in-memory transactions only
  try {
  } catch (dbError) {
    crossChainLogger.error('Database error updating transaction', { error: dbError instanceof Error ? dbError.message : String(dbError) });
    // Continue with in-memory only
  }

  // Broadcast WebSocket event
  const bridgeUpdatedEvent = {
    transaction,
    message: `Bridge transaction status updated to ${newStatus}`,
  };
  websocketModule.broadcastBridgeTransaction(bridgeUpdatedEvent);
  emitCanonicalBridgeEvent(bridgeUpdatedEvent);

  // Schedule the next state change
  const delay = getBridgeStateDelayMs();
  setTimeout(() => {
    processNextState(txId, states, currentIndex + 1);
  }, delay);
}

/**
 * Process the next state in a database bridge transaction
 * @param {number} txId - Database transaction ID
 * @param {Array<string>} states - Array of states
 * @param {number} currentIndex - Current state index
 */
async function processNextDatabaseState(
  txId: number,
  states: string[],
  currentIndex: number
): Promise<void> {
  if (currentIndex >= states.length) {
    return;
  }

  try {
    const transaction = await getDatabaseTransferByIdentifier(txId.toString());
    if (!transaction) {
      crossChainLogger.warn('Database transaction not found during state processing', { txId });
      return;
    }

    if (TERMINAL_BRIDGE_STATUSES.has(transaction.status)) {
      return;
    }

    const previousStatus = transaction.status;
    const newStatus = states[currentIndex];
    const metadata = parseBridgeMetadata(transaction.metadata);
    const direction =
      (metadata.direction as string | undefined) ||
      (transaction.fromChain === 'wrfcoin' ? 'outbound' : 'inbound');
    const completedAt =
      newStatus === BRIDGE_STATUS.COMPLETED
        ? new Date().toISOString()
        : transaction.completedAt || null;

    if (currentIndex === 1) {
      if (!metadata.sourceTxHash) {
        metadata.sourceTxHash = generateBridgeHash();
      }
      if (!metadata.destinationTxHash) {
        metadata.destinationTxHash = generateBridgeHash();
      }
    }

    metadata.direction = direction;
    metadata.trust_state = getTrustState(newStatus, metadata);
    metadata.provenance_source = BRIDGE_PROVENANCE_SOURCE.LOCAL_MANAGER;
    if (completedAt) {
      metadata.completedAt = completedAt;
    }

    const updatedTransaction = await updateDatabaseTransferState(
      txId,
      newStatus,
      completedAt,
      metadata
    );

    // Already terminal or conflicting update path; treat as idempotent.
    if (!updatedTransaction) {
      return;
    }

    const formattedTransaction =
      formatDatabaseTransactionForResponse(updatedTransaction);
    const databaseBridgeUpdatedEvent = {
      transaction: formattedTransaction,
      previous_status: previousStatus,
      new_status: newStatus,
      message: `Bridge transaction ${txId} updated: ${previousStatus} -> ${newStatus}`,
    };
    websocketModule.broadcastBridgeTransaction(databaseBridgeUpdatedEvent);
    emitCanonicalBridgeEvent(databaseBridgeUpdatedEvent);

    const delay = getBridgeStateDelayMs();
    setTimeout(() => {
      processNextDatabaseState(txId, states, currentIndex + 1);
    }, delay);
  } catch (error) {
    crossChainLogger.error('Error processing database transaction state', { txId, error: error instanceof Error ? error.message : String(error) });
  }
}

export const __bridgeTestInternals = {
  BRIDGE_STATUS,
  bridgeTransactions,
  createDatabaseTransfer,
  getDatabaseTransferByIdentifier,
  processBridgeTransaction,
  processNextState,
  processNextDatabaseState,
  resetDatabaseQueryCache: () => {
    // Reserved for future caching layers.
  },
};

export default router;
