import { db } from '../../db.js';
import { storage } from '../../storage.js';
import { eq } from 'drizzle-orm';
import { users, wallets } from '../../../shared/schema.js';
import { graphqlLogger } from '../../utils/logger.js';
import type { User, Wallet } from '../../../shared/types/api-types.js';

// Individual user field resolvers
const User = {
  // Resolve wallet for a user
  wallet: async parent => {
    try {
      // Try using storage first
      const wallet = await storage.getWalletByUserId(parent.id);
      if (wallet) return wallet;

      // Fall back to direct database query - find wallet by user's wallet address
      if (!parent.walletAddress) {
        return null;
      }

      const [result] = await db
        .select()
        .from(wallets)
        .where(eq(wallets.address, parent.walletAddress));

      return result;
    } catch (error) {
      graphqlLogger.error('Error fetching wallet for user', {
        operation: 'graphql:user:wallet',
        userId: parent.id,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return null;
    }
  },
};

// Query resolvers
const Query = {
  // Get user by ID
  user: async (_, { id }) => {
    try {
      // Try using storage first
      const user = await storage.getUser(parseInt(id));
      if (user) return user;

      // Fall back to direct database query
      const [result] = await db
        .select()
        .from(users)
        .where(eq(users.id, parseInt(id)));

      return result;
    } catch (error) {
      graphqlLogger.error('Error fetching user by ID', {
        operation: 'graphql:user:getById',
        id,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return null;
    }
  },

  // Get user by username
  userByUsername: async (_, { username }) => {
    try {
      // Try using storage first
      const user = await storage.getUserByUsername(username);
      if (user) return user;

      // Fall back to direct database query
      const [result] = await db
        .select()
        .from(users)
        .where(eq(users.username, username));

      return result;
    } catch (error) {
      graphqlLogger.error('Error fetching user by username', {
        operation: 'graphql:user:getByUsername',
        username,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return null;
    }
  },

  // Get user by wallet address
  userByWalletAddress: async (_, { address }) => {
    try {
      // Find the user by their wallet address field
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.walletAddress, address));

      return user;
    } catch (error) {
      graphqlLogger.error('Error fetching user by wallet address', {
        operation: 'graphql:user:getByWalletAddress',
        address,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return null;
    }
  },
};

module.exports = {
  User,
  Query,
};
