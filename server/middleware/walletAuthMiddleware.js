/**
 * Wallet Authentication Middleware
 *
 * This middleware handles wallet-based authentication without requiring user registration.
 * It allows anonymous access to the platform while enabling enhanced features for
 * registered users who choose to associate their wallets with accounts.
 */

const { verifySignature } = require('../utils/cryptoUtils');
const { logger } = require('../utils/logger');
const walletController = require('../controllers/walletController');
const { db } = require('../db');
const {
  wallets,
  users,
  walletUserAssociations,
} = require('../../shared/schema');
const { eq, and } = require('drizzle-orm');

/**
 * Verifies a wallet signature to authenticate the user
 * @param {string} walletAddress - The wallet address
 * @param {string} signature - The signature to verify
 * @param {string} message - The message that was signed
 * @returns {Promise<boolean>} - Whether the signature is valid
 */
async function verifyWalletSignature(walletAddress, signature, message) {
  try {
    return verifySignature(walletAddress, signature, message);
  } catch (error) {
    logger.error('Error verifying wallet signature', {
      walletAddress,
      error: error.message,
      stack: error.stack,
    });
    return false;
  }
}

/**
 * Middleware to authenticate based on wallet signature
 * Does not require login but enables enhanced functionality if user has an account
 */
const walletAuth = async (req, res, next) => {
  try {
    // Check if auth headers exist
    const walletAddress = req.headers['x-wallet-address'];
    const signature = req.headers['x-wallet-signature'];
    const message = req.headers['x-wallet-message'];

    if (!walletAddress) {
      // Allow anonymous access - no wallet provided
      req.isWalletAuthenticated = false;
      req.isUserAuthenticated = false;
      return next();
    }

    // Skip signature verification for some operations. An unverified
    // X-Wallet-Address is only a claim, so nothing is written for it here:
    // no wallet row is created until a signature proves the caller holds
    // the address (backend#1223 — anonymous GETs used to insert rows).
    const skipVerification =
      req.path.includes('/nonce') || req.method === 'GET';

    if (skipVerification) {
      req.isWalletAuthenticated = false;
      req.isUserAuthenticated = false;
      return next();
    }

    // Verify signature if provided
    if (signature && message) {
      const isValid = await verifyWalletSignature(
        walletAddress,
        signature,
        message
      );

      if (!isValid) {
        logger.warn('Invalid wallet signature', {
          walletAddress,
          path: req.path,
          method: req.method,
        });

        return res.status(401).json({
          success: false,
          message: 'Invalid wallet signature',
        });
      }

      // Signature is valid - wallet is authenticated, so it may now be
      // created on first use.
      req.isWalletAuthenticated = true;
      const wallet = await walletController.getOrCreateWallet(walletAddress);
      req.wallet = wallet;

      // Check if wallet is associated with a user account
      const walletAssociation = await db
        .select({
          association: walletUserAssociations,
          user: users,
        })
        .from(walletUserAssociations)
        .innerJoin(users, eq(walletUserAssociations.userId, users.id))
        .where(
          and(
            eq(walletUserAssociations.walletId, wallet.id),
            eq(walletUserAssociations.isAuthorized, true)
          )
        )
        .limit(1);

      if (walletAssociation && walletAssociation.length > 0) {
        // Wallet is associated with a user account
        req.user = walletAssociation[0].user;
        req.isUserAuthenticated = true;

        // Update last used timestamp
        await db
          .update(walletUserAssociations)
          .set({ lastUsed: new Date() })
          .where(
            eq(walletUserAssociations.id, walletAssociation[0].association.id)
          );
      } else {
        // Wallet is not associated with a user account
        req.isUserAuthenticated = false;
      }
    } else {
      // No signature provided
      req.isWalletAuthenticated = false;
      req.isUserAuthenticated = false;
    }

    next();
  } catch (error) {
    logger.error('Error in wallet auth middleware', {
      error: error.message,
      stack: error.stack,
      path: req.path,
      method: req.method,
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error during authentication',
    });
  }
};

/**
 * Middleware to require wallet authentication for protected routes
 * This is used for routes that require wallet ownership verification
 */
const requireWalletAuth = (req, res, next) => {
  if (!req.isWalletAuthenticated) {
    return res.status(401).json({
      success: false,
      message: 'Wallet authentication required',
    });
  }

  next();
};

/**
 * Middleware to require full user authentication (wallet + account)
 * This is used for enhanced features that require a user account
 */
const requireUserAuth = (req, res, next) => {
  if (!req.isUserAuthenticated) {
    return res.status(401).json({
      success: false,
      message: 'User authentication required',
    });
  }

  next();
};

/**
 * Middleware to check for specific roles
 * @param {string[]} roles - Array of roles to check for
 */
const requireRoles = roles => {
  return (req, res, next) => {
    if (!req.isUserAuthenticated || !req.user) {
      return res.status(401).json({
        success: false,
        message: 'User authentication required',
      });
    }

    // Check if user has any of the required roles
    const userRoles = req.user.roles || [];
    const hasRequiredRole = roles.some(role => userRoles.includes(role));

    if (!hasRequiredRole) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
      });
    }

    next();
  };
};

/**
 * Helper function to associate a wallet with a user account
 * @param {string} walletAddress - Wallet address
 * @param {number} userId - User ID
 * @returns {Promise<boolean>} - Whether the association was successful
 */
async function associateWalletWithUser(walletAddress, userId) {
  try {
    const wallet = await walletController.getOrCreateWallet(walletAddress);

    if (!wallet) {
      throw new Error('Wallet not found');
    }

    const association = await walletController.associateWalletWithUser(
      wallet.id,
      userId,
      true, // Make it primary by default
      'WALLET'
    );

    return !!association;
  } catch (error) {
    logger.error('Error associating wallet with user', {
      walletAddress,
      userId,
      error: error.message,
      stack: error.stack,
    });

    return false;
  }
}

module.exports = {
  walletAuth,
  requireWalletAuth,
  requireUserAuth,
  requireRoles,
  associateWalletWithUser,
  verifyWalletSignature,
};
