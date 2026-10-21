import { db } from '../../db.js';
import { storage } from '../../storage.js';
import { eq, desc, lte } from 'drizzle-orm';
import { blocks, transactions } from '../../../shared/schema.js';
import { graphqlLogger } from '../../utils/logger.js';
import type {
  Block,
  Transaction,
} from '../../../shared/types/blockchain-types.js';

// Individual block field resolvers
const Block = {
  // Resolve related transactions for a block
  transactions: async parent => {
    try {
      // Try using storage first
      const txs = await storage.getTransactionsByBlockHash(parent.blockHash);
      if (txs && txs.length > 0) return txs;

      // Fall back to direct database query
      const results = await db
        .select()
        .from(transactions)
        .where(eq(transactions.blockId, parent.id))
        .orderBy(desc(transactions.timestamp));

      return results;
    } catch (error) {
      graphqlLogger.error('Error fetching transactions for block', {
        operation: 'graphql:block:transactions',
        blockId: parent.id,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return [];
    }
  },
};

// Query resolvers
const Query = {
  // Get block by hash
  block: async (_, { blockHash }) => {
    try {
      // Try using storage first
      const block = await storage.getBlockByHash(blockHash);
      if (block) return block;

      // Fall back to direct database query
      const [result] = await db
        .select()
        .from(blocks)
        .where(eq(blocks.hash, blockHash));

      return result;
    } catch (error) {
      graphqlLogger.error('Error fetching block by hash', {
        operation: 'graphql:block:getByHash',
        blockHash,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return null;
    }
  },

  // Get block by height
  blockByHeight: async (_, { height }) => {
    try {
      // Try using storage first
      const block = await storage.getBlockByHeight(height);
      if (block) return block;

      // Fall back to direct database query
      const [result] = await db
        .select()
        .from(blocks)
        .where(eq(blocks.height, height));

      return result;
    } catch (error) {
      graphqlLogger.error('Error fetching block by height', {
        operation: 'graphql:block:getByHeight',
        height,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return null;
    }
  },

  // Get blocks with pagination
  blocks: async (_, { limit = 10, offset = 0 }) => {
    try {
      const results = await db
        .select()
        .from(blocks)
        .orderBy(desc(blocks.height))
        .limit(limit)
        .offset(offset);

      return results;
    } catch (error) {
      graphqlLogger.error('Error fetching blocks', {
        operation: 'graphql:blocks:list',
        limit,
        offset,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return [];
    }
  },

  // Get latest blocks
  latestBlocks: async (_, { limit = 10 }) => {
    try {
      // Try using storage first
      const latestBlocks = await storage.getLatestBlocks(limit);
      if (latestBlocks && latestBlocks.length > 0) return latestBlocks;

      // Fall back to direct database query
      const results = await db
        .select()
        .from(blocks)
        .orderBy(desc(blocks.height))
        .limit(limit);

      return results;
    } catch (error) {
      graphqlLogger.error('Error fetching latest blocks', {
        operation: 'graphql:blocks:latest',
        limit,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return [];
    }
  },
};

// Mutation resolvers
const Mutation = {
  // No block mutations since these are created through the Rust blockchain core
};

// Subscription resolvers
const Subscription = {
  // New block subscription - we're not implementing full subscription support yet
  newBlock: {
    subscribe: () => {
      throw new Error('Subscriptions not supported in this implementation');
    },
  },
};

module.exports = {
  Block,
  Query,
  Mutation,
  Subscription,
};
