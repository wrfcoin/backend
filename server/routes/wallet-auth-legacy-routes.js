/**
 * Legacy Wallet Authentication Routes
 *
 * These routes handle the wallet-first authentication system,
 * allowing users to use the platform without registration
 * but with the option to associate wallets with accounts.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const {
  wallets,
  users,
  walletUserAssociations,
} = require('../../shared/schema');
const {
  walletAuth,
  requireWalletAuth,
  requireUserAuth,
  associateWalletWithUser,
  verifyWalletSignature,
} = require('../middleware/walletAuthMiddleware');
const walletController = require('../controllers/walletController');
const { logger } = require('../utils/logger');
const { eq, and } = require('drizzle-orm');
const {
  createRateLimitMiddleware,
  RATE_LIMIT_PRESETS,
} = require('../../shared/middleware/rate-limit-redis');

const walletLoginRateLimiter = createRateLimitMiddleware({
  ...RATE_LIMIT_PRESETS.auth,
  message: 'Too many wallet login attempts, please try again later.',
});

router.use('/nonce', walletLoginRateLimiter);
router.use('/verify', walletLoginRateLimiter);

// Apply wallet auth middleware to all wallet routes
router.use(walletAuth);

/**
 * Get a nonce for wallet signature verification
 */
router.get('/nonce/:address', async (req, res) => {
  try {
    const { address } = req.params;

    if (!address) {
      return res.status(400).json({
        success: false,
        message: 'Wallet address is required',
      });
    }

    // Lookup only: an anonymous GET must never insert a wallet row
    // (backend#1223). New wallets register through /api/auth/*.
    const [wallet] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.address, address));

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found',
      });
    }

    // Generate a nonce for this wallet
    const nonce = walletController.generateWalletNonce(address);

    // Store nonce in DB or cache for later verification

    await db
      .update(wallets)
      .set({
        metadata: {
          ...wallet.metadata,
          nonce: nonce,
          nonceCreatedAt: new Date().toISOString(),
        },
      })
      .where(eq(wallets.id, wallet.id));

    return res.status(200).json({
      success: true,
      nonce,
      message: 'Sign this nonce to authenticate',
    });
  } catch (error) {
    logger.error('Error generating nonce', {
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: 'Error generating nonce',
    });
  }
});

/**
 * Verify wallet authentication
 */
router.post('/verify', async (req, res) => {
  try {
    const { address, signature, message } = req.body;

    if (!address || !signature || !message) {
      return res.status(400).json({
        success: false,
        message: 'Address, signature, and message are required',
      });
    }

    // Get wallet to verify nonce
    const wallet = await walletController.getWallet(address);

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found',
      });
    }

    // Verify signature matches expected message with nonce
    const storedNonce = wallet.metadata?.nonce;
    const nonceCreatedAt = wallet.metadata?.nonceCreatedAt;

    if (!storedNonce || !nonceCreatedAt) {
      return res.status(400).json({
        success: false,
        message: 'Get a nonce first before verifying',
      });
    }

    // Check if nonce is expired (5 minutes)
    const nonceDate = new Date(nonceCreatedAt);
    const now = new Date();
    const diffMinutes = (now - nonceDate) / (1000 * 60);

    if (diffMinutes > 5) {
      return res.status(400).json({
        success: false,
        message: 'Nonce expired, please get a new one',
      });
    }

    // Check if the message matches the expected format with the nonce
    const expectedMessage = `Wrfcoin Authentication\nWallet: ${address}\nNonce: ${storedNonce}`;

    if (message !== expectedMessage) {
      logger.warn('Invalid message format for verification', {
        expectedMessage,
        receivedMessage: message,
      });

      return res.status(400).json({
        success: false,
        message: 'Invalid message format',
      });
    }

    // Verify signature
    const isSignatureValid = await verifyWalletSignature(
      address,
      signature,
      message
    );

    if (!isSignatureValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid signature',
      });
    }

    // Clear the nonce to prevent replay attacks
    await db
      .update(wallets)
      .set({
        metadata: {
          ...wallet.metadata,
          nonce: null,
          nonceCreatedAt: null,
          lastAuthenticated: new Date().toISOString(),
        },
      })
      .where(eq(wallets.id, wallet.id));

    // Check if wallet is associated with a user account
    const walletAssociations = await db
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
      );

    let userInfo = null;

    if (walletAssociations && walletAssociations.length > 0) {
      // Wallet is associated with a user account
      const user = walletAssociations[0].user;

      userInfo = {
        id: user.id,
        username: user.username,
        email: user.email,
        roles: user.roles,
        isFullyAuthenticated: true,
      };

      // Update last used timestamp
      await db
        .update(walletUserAssociations)
        .set({ lastUsed: new Date() })
        .where(
          eq(walletUserAssociations.id, walletAssociations[0].association.id)
        );
    }

    return res.status(200).json({
      success: true,
      message: 'Authentication successful',
      wallet: {
        address: wallet.address,
        network: wallet.network,
        balance: wallet.balance,
        createdAt: wallet.createdAt,
      },
      user: userInfo,
      isWalletOnly: !userInfo,
    });
  } catch (error) {
    logger.error('Error verifying wallet authentication', {
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: 'Error verifying wallet authentication',
    });
  }
});

/**
 * Associate a wallet with a user account
 * Requires user authentication
 */
router.post('/associate', requireUserAuth, async (req, res) => {
  try {
    const { walletAddress } = req.body;

    if (!walletAddress) {
      return res.status(400).json({
        success: false,
        message: 'Wallet address is required',
      });
    }

    // Get wallet
    const wallet = await walletController.getOrCreateWallet(walletAddress);

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found',
      });
    }

    // Check if wallet is already associated with this user
    const existingAssociation = await db
      .select()
      .from(walletUserAssociations)
      .where(
        and(
          eq(walletUserAssociations.walletId, wallet.id),
          eq(walletUserAssociations.userId, req.user.id)
        )
      );

    if (existingAssociation && existingAssociation.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Wallet already associated with this user',
      });
    }

    // Associate wallet with user
    const association = await walletController.associateWalletWithUser(
      wallet.id,
      req.user.id,
      req.body.isPrimary || false,
      'WALLET'
    );

    if (!association) {
      return res.status(500).json({
        success: false,
        message: 'Error associating wallet with user',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Wallet associated with user',
      association: {
        id: association.id,
        walletId: association.walletId,
        userId: association.userId,
        isPrimary: association.isPrimary,
        createdAt: association.createdAt,
        lastUsed: association.lastUsed,
      },
    });
  } catch (error) {
    logger.error('Error associating wallet with user', {
      error: error.message,
      stack: error.stack,
      userId: req.user?.id,
    });

    return res.status(500).json({
      success: false,
      message: 'Error associating wallet with user',
    });
  }
});

/**
 * Get all wallets for a user
 * Requires user authentication
 */
router.get('/wallets', requireUserAuth, async (req, res) => {
  try {
    const userWallets = await walletController.getUserWallets(req.user.id);

    return res.status(200).json({
      success: true,
      wallets: userWallets.map(wallet => ({
        id: wallet.id,
        address: wallet.address,
        network: wallet.network,
        balance: wallet.balance,
        createdAt: wallet.createdAt,
        isPrimary: wallet.isPrimary,
        lastUsed: wallet.lastUsed,
        associationId: wallet.associationId,
      })),
    });
  } catch (error) {
    logger.error('Error getting user wallets', {
      error: error.message,
      stack: error.stack,
      userId: req.user?.id,
    });

    return res.status(500).json({
      success: false,
      message: 'Error getting user wallets',
    });
  }
});

/**
 * Set primary wallet for a user
 * Requires user authentication
 */
router.post('/set-primary', requireUserAuth, async (req, res) => {
  try {
    const { walletId } = req.body;

    if (!walletId) {
      return res.status(400).json({
        success: false,
        message: 'Wallet ID is required',
      });
    }

    // Check if wallet belongs to user
    const userWallets = await walletController.getUserWallets(req.user.id);
    const walletBelongsToUser = userWallets.some(
      wallet => wallet.id === walletId
    );

    if (!walletBelongsToUser) {
      return res.status(403).json({
        success: false,
        message: 'Wallet does not belong to user',
      });
    }

    // Find the association to update
    const walletToUpdate = userWallets.find(wallet => wallet.id === walletId);

    if (!walletToUpdate) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found',
      });
    }

    // First, set all wallets for this user to non-primary
    await db
      .update(walletUserAssociations)
      .set({ isPrimary: false })
      .where(eq(walletUserAssociations.userId, req.user.id));

    // Then set the selected wallet as primary
    await db
      .update(walletUserAssociations)
      .set({
        isPrimary: true,
        lastUsed: new Date(),
      })
      .where(eq(walletUserAssociations.id, walletToUpdate.associationId));

    return res.status(200).json({
      success: true,
      message: 'Primary wallet updated',
      walletId: walletId,
    });
  } catch (error) {
    logger.error('Error setting primary wallet', {
      error: error.message,
      stack: error.stack,
      userId: req.user?.id,
    });

    return res.status(500).json({
      success: false,
      message: 'Error setting primary wallet',
    });
  }
});

/**
 * Deauthorize a wallet-user association
 * Requires user authentication
 */
router.post('/deauthorize', requireUserAuth, async (req, res) => {
  try {
    const { associationId } = req.body;

    if (!associationId) {
      return res.status(400).json({
        success: false,
        message: 'Association ID is required',
      });
    }

    // Check if association belongs to user
    const userWallets = await walletController.getUserWallets(req.user.id);
    const associationBelongsToUser = userWallets.some(
      wallet => wallet.associationId === associationId
    );

    if (!associationBelongsToUser) {
      return res.status(403).json({
        success: false,
        message: 'Association does not belong to user',
      });
    }

    // Deauthorize the association
    const success = await walletController.deauthorizeWallet(associationId);

    if (!success) {
      return res.status(500).json({
        success: false,
        message: 'Error deauthorizing wallet',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Wallet deauthorized',
    });
  } catch (error) {
    logger.error('Error deauthorizing wallet', {
      error: error.message,
      stack: error.stack,
      userId: req.user?.id,
    });

    return res.status(500).json({
      success: false,
      message: 'Error deauthorizing wallet',
    });
  }
});

/**
 * Get wallet by address
 * Public endpoint
 */
router.get('/:address', async (req, res) => {
  try {
    const { address } = req.params;

    if (!address) {
      return res.status(400).json({
        success: false,
        message: 'Wallet address is required',
      });
    }

    const wallet = await walletController.getWallet(address);

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found',
      });
    }

    // Don't return sensitive data for public endpoint
    return res.status(200).json({
      success: true,
      wallet: {
        address: wallet.address,
        network: wallet.network,
        balance: wallet.balance,
        createdAt: wallet.createdAt,
      },
    });
  } catch (error) {
    logger.error('Error getting wallet', {
      error: error.message,
      stack: error.stack,
      address: req.params.address,
    });

    return res.status(500).json({
      success: false,
      message: 'Error getting wallet',
    });
  }
});

module.exports = router;
