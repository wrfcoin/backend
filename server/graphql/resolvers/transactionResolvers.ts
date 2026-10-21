import { db } from '../../db.js';
import { storage } from '../../storage.js';
import { eq, desc, and } from 'drizzle-orm';
import {
  transactions,
  blocks,
  computationalNfts,
} from '../../../shared/schema.js';
import { graphqlLogger } from '../../utils/logger.js';
import * as wsManager from '../../websocket.js';
import { pubsub } from '../../../graphql/subscriptions/pubsub.js';
import type {
  Transaction,
  Block,
} from '../../../shared/types/blockchain-types.js';
import type { ComputationalNft } from '../../../shared/types/api-types.js';

// Utility function to safely extract error message from unknown error type
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
  return 'Unknown error occurred';
}

interface TransactionParent {
  id: string;
  blockId?: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  fee: string;
  status: string;
  timestamp: Date;
}

interface GraphQLContext {
  user?: any;
  db: typeof db;
}

const NEW_TRANSACTION_EVENT = 'NEW_TRANSACTION';

// Individual transaction field resolvers
const Transaction = {
  // Resolve related block for a transaction
  block: async (
    parent: TransactionParent,
    _args: any,
    _context: GraphQLContext
  ): Promise<Block | null> => {
    if (!parent.blockId) return null;

    try {
      // Get the related block
      const [block] = await db
        .select()
        .from(blocks)
        .where(eq(blocks.id, parseInt(parent.blockId.toString(), 10)));

      if (!block) return null;

      // Transform to match the Block interface
      return {
        hash: block.hash as any,
        number: block.height,
        timestamp: block.timestamp,
        parentHash: block.prevHash as any,
        transactions: [], // This would need to be populated separately
        miner: (block.validator || '') as any,
        difficulty: block.difficulty.toString(),
        gasUsed: 0, // Not tracked in our schema
        gasLimit: 0, // Not tracked in our schema
        nonce: block.nonce || '',
      };
    } catch (error) {
      graphqlLogger.error('Error fetching block for transaction', {
        operation: 'graphql:transaction:block',
        blockId: parent.blockId,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return null;
    }
  },

  // Resolve related NFTs for a transaction
  computationalNfts: async parent => {
    try {
      // Get any computational NFTs related to this transaction
      const nfts = await db
        .select()
        .from(computationalNfts)
        .where(eq(computationalNfts.transactionId, parent.id));

      return nfts;
    } catch (error) {
      graphqlLogger.error('Error fetching NFTs for transaction', {
        operation: 'graphql:transaction:nfts',
        transactionId: parent.id,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return [];
    }
  },
};

// Query resolvers
const Query = {
  // Get transaction by hash
  transaction: async (_, { txHash }) => {
    try {
      // Direct database query using txId field
      const [result] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.txId, txHash));

      return result;
    } catch (error) {
      graphqlLogger.error('Error fetching transaction by hash', {
        operation: 'graphql:transaction:getByHash',
        txHash,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return null;
    }
  },

  // Get transactions with pagination
  transactions: async (_, { limit = 10, offset = 0 }) => {
    try {
      const results = await db
        .select()
        .from(transactions)
        .orderBy(desc(transactions.timestamp))
        .limit(limit)
        .offset(offset);

      return results;
    } catch (error) {
      graphqlLogger.error('Error fetching transactions', {
        operation: 'graphql:transactions:list',
        limit,
        offset,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return [];
    }
  },

  // Get pending transactions
  pendingTransactions: async (_, { limit = 10 }) => {
    try {
      // Direct database query
      const results = await db
        .select()
        .from(transactions)
        .where(eq(transactions.status, 'PENDING'))
        .orderBy(desc(transactions.timestamp))
        .limit(limit);

      return results;
    } catch (error) {
      graphqlLogger.error('Error fetching pending transactions', {
        operation: 'graphql:transactions:pending',
        limit,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return [];
    }
  },

  // Get transactions by block hash
  transactionsByBlock: async (_, { blockHash }) => {
    try {
      // First get the block ID using hash field
      const [block] = await db
        .select()
        .from(blocks)
        .where(eq(blocks.hash, blockHash));

      if (!block) return [];

      // Then get transactions for that block
      const results = await db
        .select()
        .from(transactions)
        .where(eq(transactions.blockId, block.id))
        .orderBy(desc(transactions.timestamp));

      return results;
    } catch (error) {
      graphqlLogger.error('Error fetching transactions by block', {
        operation: 'graphql:transactions:getByBlock',
        blockHash,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return [];
    }
  },

  // Get transactions by sender address
  transactionsBySender: async (_, { address, limit = 10, offset = 0 }) => {
    try {
      // Direct database query using fromAddress field
      const results = await db
        .select()
        .from(transactions)
        .where(eq(transactions.fromAddress, address))
        .orderBy(desc(transactions.timestamp))
        .limit(limit)
        .offset(offset);

      return results;
    } catch (error) {
      graphqlLogger.error('Error fetching transactions by sender', {
        operation: 'graphql:transactions:getBySender',
        address,
        limit,
        offset,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return [];
    }
  },

  // Get transactions by recipient address
  transactionsByRecipient: async (_, { address, limit = 10, offset = 0 }) => {
    try {
      // Direct database query using toAddress field
      const results = await db
        .select()
        .from(transactions)
        .where(eq(transactions.toAddress, address))
        .orderBy(desc(transactions.timestamp))
        .limit(limit)
        .offset(offset);

      return results;
    } catch (error) {
      graphqlLogger.error('Error fetching transactions by recipient', {
        operation: 'graphql:transactions:getByRecipient',
        address,
        limit,
        offset,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return [];
    }
  },
};

// Mutation resolvers
const Mutation = {
  // Create a new transaction
  createTransaction: async (
    _,
    { senderAddress, recipientAddress, amount, fee, operationType, data }
  ) => {
    try {
      // Create the transaction directly in the database
      const [transaction] = await db
        .insert(transactions)
        .values({
          txId: `tx${Math.random().toString(36).substring(2, 10)}`,
          fromAddress: senderAddress,
          toAddress: recipientAddress,
          amount: amount,
          fee: fee,
          type: operationType || 'transfer',
          status: 'PENDING',
          timestamp: new Date(),
          data: data || null,
        })
        .returning();

      // Broadcast the new transaction via WebSocket
      wsManager.broadcastTransaction(transaction);

      try {
        await pubsub.publish(NEW_TRANSACTION_EVENT, {
          newTransaction: transaction,
        });
      } catch (publishError) {
        graphqlLogger.warn('Failed to publish new transaction subscription event', {
          operation: 'graphql:transaction:publish',
          transactionId: transaction.id,
          error:
            publishError instanceof Error
              ? { name: publishError.name, message: publishError.message }
              : 'Unknown error',
        });
      }

      return transaction;
    } catch (error) {
      graphqlLogger.error('Error creating transaction', {
        operation: 'graphql:transaction:create',
        senderAddress,
        recipientAddress,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      throw new Error(
        `Failed to create transaction: ${getErrorMessage(error)}`
      );
    }
  },
};

// Subscription resolvers (not yet implemented)
const Subscription = {
  newTransaction: {
    subscribe: () => {
      return pubsub.asyncIterator([NEW_TRANSACTION_EVENT]);
    },
    resolve: (payload: any) => payload.newTransaction || payload.transaction,
  },
};

module.exports = {
  Transaction,
  Query,
  Mutation,
  Subscription,
  NEW_TRANSACTION_EVENT,
};
