/**
 * Account Abstraction Routes
 *
 * This module defines the API routes for the account abstraction wallet layer,
 * enabling features like meta-transactions, delegated signing, and sponsorship.
 */

const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middleware/auth');
const controllerModule = require('../controllers/accountAbstractionController');
const controller = controllerModule.default ?? controllerModule;

// All account abstraction operations require authentication (#231)
router.use(authenticateJWT);
const crypto = require('crypto');
const { verifySignature: verifyWalletSignature } = require('../utils/cryptoUtils');
const storageModule = require('../storage');
const storage =
  storageModule.storage ??
  storageModule.default?.storage ??
  storageModule.default ??
  storageModule;
const { generateId } = require('../utils/id-generator');
const { walletLogger } = require('../utils/logger');
import * as nobleSecp256k1 from '@noble/secp256k1';

type DelegationPayload = {
  delegator: string;
  delegatee: string;
  permissions: unknown;
  expiresAt: string;
};

type SponsoredOperationPayload = {
  type: string;
  from: string;
  to: string;
  target?: string;
  value?: number;
  amount: number;
  data?: string;
  nonce?: number;
};

export function buildDelegationSigningPayload(
  delegation: DelegationPayload
): string {
  return JSON.stringify({
    delegator: delegation.delegator,
    delegatee: delegation.delegatee,
    permissions: delegation.permissions,
    expiresAt: delegation.expiresAt,
  });
}

export function buildSponsoredTransactionSigningPayload(
  operation: SponsoredOperationPayload,
  sponsorId: string,
  reason?: string
): string {
  return JSON.stringify({
    type: operation.type,
    from: operation.from,
    to: operation.to,
    target: operation.target ?? operation.to,
    value: operation.value ?? operation.amount,
    amount: operation.amount,
    data: operation.data ?? '',
    nonce: operation.nonce ?? 0,
    sponsorId,
    reason: reason ?? '',
  });
}

/**
 * Create a new smart wallet for a user
 * @route POST /api/wallet
 * @body {number} userId - The ID of the user to create the wallet for
 * @body {string} publicKey - The public key to associate with the wallet
 */
router.post('/wallet', async (req, res) => {
  try {
    const { userId, publicKey } = req.body;

    if (!userId || !publicKey) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters',
      });
      return;
    }

    const result = await controller.createWallet(userId, publicKey);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: unknown) {
    walletLogger.error('Error in wallet creation route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Get wallet details
 * @route GET /api/wallet/:address
 * @param {string} address - The address of the wallet to retrieve
 */
router.get('/wallet/:address', async (req, res) => {
  try {
    const { address } = req.params;

    if (!address) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameter: address',
      });
      return;
    }

    const result = await controller.getWallet(address);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error: unknown) {
    walletLogger.error('Error in get wallet route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Create a new operation
 * @route POST /api/operation
 * @body {number} walletId - The ID of the wallet to create the operation for
 * @body {string} operationType - The type of operation to create
 * @body {string} target - The target address for the operation
 * @body {number} value - The value to send in the operation
 * @body {string} data - The data to include in the operation
 * @body {number} nonce - The nonce for the operation
 */
router.post('/operation', async (req, res) => {
  try {
    const { walletId, operationType, target, value, data, nonce } = req.body;

    if (
      !walletId ||
      !operationType ||
      !target ||
      value === undefined ||
      !nonce
    ) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters',
      });
      return;
    }

    const result = await controller.createOperation(
      walletId,
      operationType,
      target,
      value,
      data,
      nonce
    );

    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: unknown) {
    walletLogger.error('Error in create operation route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Sign an operation
 * @route POST /api/operation/:operationId/sign
 * @param {string} operationId - The ID of the operation to sign
 * @body {string} signature - The signature to add to the operation
 */
router.post('/operation/:operationId/sign', async (req, res) => {
  try {
    const { operationId } = req.params;
    const { signature } = req.body;

    if (!operationId || !signature) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters',
      });
      return;
    }

    const result = await controller.signOperation(operationId, signature);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: unknown) {
    walletLogger.error('Error in sign operation route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Execute an operation
 * @route POST /api/operation/:operationId/execute
 * @param {string} operationId - The ID of the operation to execute
 */
router.post('/operation/:operationId/execute', async (req, res) => {
  try {
    const { operationId } = req.params;

    if (!operationId) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameter: operationId',
      });
      return;
    }

    const result = await controller.executeOperation(operationId);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: unknown) {
    walletLogger.error('Error in execute operation route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Create a new bundle of operations
 * @route POST /api/bundle
 * @body {string[]} operations - The operations to include in the bundle
 */
router.post('/bundle', async (req, res) => {
  try {
    const { operations } = req.body;

    if (!operations || !Array.isArray(operations) || operations.length === 0) {
      res.status(400).json({
        success: false,
        error:
          'Missing required parameter: operations (must be a non-empty array)',
      });
      return;
    }

    const result = await controller.createBundle(operations);

    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: unknown) {
    walletLogger.error('Error in create bundle route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Execute a bundle
 * @route POST /api/bundle/:bundleId/execute
 * @param {string} bundleId - The ID of the bundle to execute
 */
router.post('/bundle/:bundleId/execute', async (req, res) => {
  try {
    const { bundleId } = req.params;

    if (!bundleId) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameter: bundleId',
      });
      return;
    }

    const result = await controller.executeBundle(bundleId);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: unknown) {
    walletLogger.error('Error in execute bundle route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Create a new delegation
 * @route POST /api/delegation
 * @body {object} delegation - The delegation details
 * @body {string} signature - The signature of the delegation message
 */
router.post('/delegation', async (req, res) => {
  try {
    const { delegation, signature } = req.body;

    if (!delegation || !signature) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters',
      });
      return;
    }

    // Verify the delegation has all required fields
    if (
      !delegation.delegator ||
      !delegation.delegatee ||
      !delegation.permissions ||
      !delegation.expiresAt
    ) {
      res.status(400).json({
        success: false,
        error: 'Delegation is missing required fields',
      });
      return;
    }

    // Check if the delegator wallet exists
    const delegatorWallet = await storage.getWalletByAddress(
      delegation.delegator
    );
    if (!delegatorWallet) {
      res.status(404).json({
        success: false,
        error: 'Delegator wallet not found',
      });
      return;
    }

    // Check if the delegatee wallet exists
    const delegateeWallet = await storage.getWalletByAddress(
      delegation.delegatee
    );
    if (!delegateeWallet) {
      res.status(404).json({
        success: false,
        error: 'Delegatee wallet not found',
      });
      return;
    }

    // Create a hash of the delegation for verification
    const delegationString = buildDelegationSigningPayload(delegation);
    const delegationHash = crypto
      .createHash('sha256')
      .update(delegationString)
      .digest('hex');

    const isValidSignature = await verifyWalletSignature(
      delegation.delegator,
      signature,
      delegationString
    );
    if (!isValidSignature) {
      res.status(400).json({
        success: false,
        error: 'Invalid signature',
      });
      return;
    }

    walletLogger.info('Processing delegation', {
      delegator: delegation.delegator,
      delegatee: delegation.delegatee,
      permissions: delegation.permissions,
      expiresAt: delegation.expiresAt,
      service: 'account-abstraction-routes'
    });

    // Generate a delegation ID
    const delegationId = generateId('dlg');

    // Create the delegation in the database
    const newDelegation = await storage.createDelegation({
      delegationId,
      delegator: delegation.delegator,
      delegatee: delegation.delegatee,
      permissions: delegation.permissions,
      expiresAt: new Date(delegation.expiresAt),
      status: 'ACTIVE',
      signature,
      active: true,
      metadata: {
        hash: delegationHash,
        createdBy: req.ip,
      },
    });

    res.status(201).json({
      success: true,
      delegation: newDelegation,
    });
  } catch (error: unknown) {
    walletLogger.error('Error in create delegation route', { error: { message: (error as Error).message, stack: (error as Error).stack } });

    // Handle specific database errors
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '23505'
    ) {
      // PostgreSQL unique violation
      res.status(409).json({
        success: false,
        error: 'A delegation with these parameters already exists',
      });
      return;
    }

    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '23503'
    ) {
      // PostgreSQL foreign key violation
      res.status(400).json({
        success: false,
        error: 'Invalid wallet reference',
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Sign a delegation
 * @route POST /api/delegation/:delegationId/sign
 * @param {string} delegationId - The ID of the delegation to sign
 * @body {string} signature - The signature to add to the delegation
 */
router.post('/delegation/:delegationId/sign', async (req, res) => {
  try {
    const { delegationId } = req.params;
    const { signature } = req.body;

    if (!delegationId || !signature) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters',
      });
      return;
    }

    const result = await controller.signDelegation(delegationId, signature);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: unknown) {
    walletLogger.error('Error in sign delegation route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Revoke a delegation
 * @route POST /api/delegation/:delegationId/revoke
 * @param {string} delegationId - The ID of the delegation to revoke
 */
router.post('/delegation/:delegationId/revoke', async (req, res) => {
  try {
    const { delegationId } = req.params;

    if (!delegationId) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameter: delegationId',
      });
      return;
    }

    // Check if the delegation exists first
    const delegation = await storage.getDelegationById(delegationId);
    if (!delegation) {
      res.status(404).json({
        success: false,
        error: 'Delegation not found',
      });
      return;
    }

    // Check if the delegation has already been revoked
    if (delegation.status === 'REVOKED') {
      res.status(409).json({
        success: false,
        error: 'Delegation is already revoked',
      });
      return;
    }

    const result = await controller.revokeDelegation(delegationId);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: unknown) {
    walletLogger.error('Error in revoke delegation route', { error: { message: (error as Error).message, stack: (error as Error).stack } });

    // Handle specific database errors
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '23505'
    ) {
      // PostgreSQL unique violation
      res.status(409).json({
        success: false,
        error: 'A database constraint was violated',
      });
      return;
    }

    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '23503'
    ) {
      // PostgreSQL foreign key violation
      res.status(400).json({
        success: false,
        error: 'Invalid delegation reference',
      });
      return;
    }

    res.status(500).json({
      success: false,
      error:
        'Internal server error: ' +
        (error instanceof Error ? error.message : 'Unknown error'),
    });
  }
});

/**
 * Create a new sponsor
 * @route POST /api/sponsor
 * @body {number} walletId - The ID of the wallet to sponsor
 * @body {string} sponsorAddress - The address of the sponsor
 * @body {number} maxAllowance - The maximum amount the sponsor will pay
 * @body {string[]} allowedOperations - The operations that the sponsor will pay for
 * @body {string[]} contractWhitelist - The contracts that the sponsor will pay for interactions with
 */
router.post('/sponsor', async (req, res) => {
  try {
    const {
      walletId,
      sponsorAddress,
      maxAllowance,
      allowedOperations,
      contractWhitelist,
    } = req.body;

    if (!walletId || !sponsorAddress || !maxAllowance) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters',
      });
      return;
    }

    const result = await controller.createSponsor(
      walletId,
      sponsorAddress,
      maxAllowance,
      allowedOperations,
      contractWhitelist
    );

    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: unknown) {
    walletLogger.error('Error in create sponsor route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Get sponsors for a wallet
 * @route GET /api/wallet/:walletId/sponsors
 * @param {number} walletId - The ID of the wallet to get sponsors for
 */
router.get('/wallet/:walletId/sponsors', async (req, res) => {
  try {
    const { walletId } = req.params;

    if (!walletId) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameter: walletId',
      });
      return;
    }

    const result = await controller.getSponsors(walletId);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error: unknown) {
    walletLogger.error('Error in get sponsors route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Estimate gas for an operation
 * @route POST /api/gas/estimate
 * @body {string} operationType - The type of operation
 * @body {string} target - The target address
 * @body {number} value - The value to send
 * @body {string} data - The data to send
 */
router.post('/gas/estimate', async (req, res) => {
  try {
    const { operationType, target, value, data } = req.body;

    if (!operationType || !target) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters',
      });
      return;
    }

    const result = await controller.estimateGas(
      operationType,
      target,
      value,
      data
    );

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: unknown) {
    walletLogger.error('Error in estimate gas route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Create a recovery request
 * @route POST /api/recovery
 * @body {number} walletId - The ID of the wallet to recover
 * @body {string} requestorAddress - The address requesting recovery
 * @body {string} recoveryMethod - The method of recovery
 * @body {object} evidence - Evidence supporting the recovery request
 */
router.post('/recovery', async (req, res) => {
  try {
    const { walletId, requestorAddress, recoveryMethod, evidence } = req.body;

    if (!walletId || !requestorAddress || !recoveryMethod) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters',
      });
      return;
    }

    const result = await controller.createRecoveryRequest(
      walletId,
      requestorAddress,
      recoveryMethod,
      evidence
    );

    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: unknown) {
    walletLogger.error('Error in create recovery request route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Approve a recovery request
 * @route POST /api/recovery/:requestId/approve
 * @param {string} requestId - The ID of the recovery request to approve
 * @body {string} approverAddress - The address approving the recovery
 * @body {string} newAddress - The new address for the wallet
 * @body {string} newPublicKey - The new public key for the wallet
 */
router.post('/recovery/:requestId/approve', async (req, res) => {
  try {
    const { requestId } = req.params;
    const { approverAddress, newAddress, newPublicKey } = req.body;

    if (!requestId || !approverAddress || !newAddress || !newPublicKey) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters',
      });
      return;
    }

    const result = await controller.approveRecoveryRequest(
      requestId,
      approverAddress,
      newAddress,
      newPublicKey
    );

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: unknown) {
    walletLogger.error('Error in approve recovery route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Complete a recovery
 * @route POST /api/recovery/:requestId/complete
 * @param {string} requestId - The ID of the recovery request to complete
 */
router.post('/recovery/:requestId/complete', async (req, res) => {
  try {
    const { requestId } = req.params;

    if (!requestId) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameter: requestId',
      });
      return;
    }

    const result = await controller.completeRecovery(requestId);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: unknown) {
    walletLogger.error('Error in complete recovery route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Process a meta-transaction
 * @route POST /api/meta-transaction
 * @body {object} operation - The operation to process
 * @body {string} signature - The signature of the operation
 */
router.post('/meta-transaction', async (req, res) => {
  try {
    const { operation, signature } = req.body;

    if (!operation || !signature) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters',
      });
      return;
    }

    // Verify the operation has all required fields
    if (
      !operation.type ||
      !operation.from ||
      !operation.to ||
      !operation.amount
    ) {
      res.status(400).json({
        success: false,
        error: 'Operation is missing required fields',
      });
      return;
    }

    // Create a hash of the operation for verification
    const operationString = JSON.stringify(operation);
    const operationHash = crypto
      .createHash('sha256')
      .update(operationString)
      .digest('hex');

    // Verify the signature in production environment
    try {
      // Get the wallet's public key
      const wallet = await controller.getWallet(operation.from);
      if (!wallet.success) {
        res.status(404).json({
          success: false,
          error: 'Wallet not found',
        });
        return;
      }

      // Verify signature using @noble/secp256k1
      const { createHash } = require('crypto');

      // Create message hash
      const messageHash = createHash('sha256').update(operationString).digest();

      // Parse signature (assuming it's in hex format)
      let signatureBuffer;
      try {
        signatureBuffer = Buffer.from(
          operation.signature.replace('0x', ''),
          'hex'
        );
      } catch (e) {
        res.status(400).json({
          success: false,
          error: 'Invalid signature format',
        });
        return;
      }

      // Get public key from wallet
      let publicKeyBuffer;
      try {
        publicKeyBuffer = Buffer.from(
          wallet.data.publicKey.replace('0x', ''),
          'hex'
        );
      } catch (e) {
        res.status(400).json({
          success: false,
          error: 'Invalid public key format',
        });
        return;
      }

      // Verify signature
      const isValidSignature = nobleSecp256k1.verify(
        signatureBuffer.slice(0, 64), // signature (r,s)
        messageHash,
        publicKeyBuffer
      );

      if (!isValidSignature) {
        res.status(400).json({
          success: false,
          error: 'Invalid signature',
        });
        return;
      }
    } catch (error: unknown) {
      walletLogger.error('Signature verification error', { error: { message: (error as Error).message, stack: (error as Error).stack } });
      res.status(400).json({
        success: false,
        error: 'Signature verification failed',
      });
      return;
    }

    // Process the meta-transaction
    // In a real implementation, this would be handled by a relayer service
    walletLogger.info('Processing meta-transaction', {
      from: operation.from,
      to: operation.to,
      amount: operation.amount,
      service: 'account-abstraction-routes'
    });

    // For testing purposes, simulate a successful transaction
    const txId = 'tx' + crypto.randomBytes(4).toString('hex');

    res.status(200).json({
      success: true,
      transaction: {
        id: txId,
        status: 'PENDING',
        type: operation.type,
        from: operation.from,
        to: operation.to,
        amount: operation.amount,
        timestamp: new Date().toISOString(),
      },
      meta: {
        gasless: true,
        relayer: 'Wrfcoin Relayer Service',
      },
    });
  } catch (error: unknown) {
    walletLogger.error('Error in meta-transaction route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * Process a sponsored transaction
 * @route POST /api/sponsored-transaction
 * @body {object} operation - The operation to process
 * @body {string} signature - The signature of the operation
 * @body {string} sponsorId - The ID of the sponsor
 * @body {string} reason - The reason for the sponsorship
 */
router.post('/sponsored-transaction', async (req, res) => {
  try {
    const { operation, signature, sponsorId, reason } = req.body;

    if (!operation || !signature || !sponsorId) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters',
      });
      return;
    }

    // Verify the operation has all required fields
    if (
      !operation.type ||
      !operation.from ||
      !operation.to ||
      !operation.amount
    ) {
      res.status(400).json({
        success: false,
        error: 'Operation is missing required fields',
      });
      return;
    }

    // Create a hash of the operation for verification
    const operationString = JSON.stringify(operation);
    const operationHash = crypto
      .createHash('sha256')
      .update(operationString)
      .digest('hex');

    const sponsorAuthorizationPayload = buildSponsoredTransactionSigningPayload(
      operation,
      sponsorId,
      reason
    );

    // Verify the signature and check sponsor allowance in production
    try {
      const hasValidAuthorizationSignature = await verifyWalletSignature(
        operation.from,
        signature,
        sponsorAuthorizationPayload
      );
      if (!hasValidAuthorizationSignature) {
        res.status(400).json({
          success: false,
          error: 'Invalid sponsor authorization signature',
        });
        return;
      }

      // Check sponsor allowance
      const sponsor = await controller.getSponsor(sponsorId);
      if (!sponsor.success) {
        res.status(404).json({
          success: false,
          error: 'Sponsor not found',
        });
        return;
      }

      if (sponsor.data.maxAllowance < operation.value) {
        res.status(400).json({
          success: false,
          error: 'Operation exceeds sponsor allowance',
        });
        return;
      }
    } catch (error: unknown) {
      walletLogger.error('Sponsored transaction verification error', { error: { message: (error as Error).message, stack: (error as Error).stack } });
      res.status(400).json({
        success: false,
        error: 'Transaction verification failed',
      });
      return;
    }

    // For now, simulate verification and processing
    walletLogger.info('Processing sponsored transaction', {
      from: operation.from,
      to: operation.to,
      amount: operation.amount,
      sponsorId,
      reason,
      service: 'account-abstraction-routes'
    });

    // For testing purposes, simulate a successful transaction
    const txId = 'tx' + crypto.randomBytes(4).toString('hex');

    res.status(200).json({
      success: true,
      transaction: {
        id: txId,
        status: 'PENDING',
        type: operation.type,
        from: operation.from,
        to: operation.to,
        amount: operation.amount,
        timestamp: new Date().toISOString(),
      },
      sponsor: {
        id: sponsorId,
        covered: {
          gas: true,
          fee: '0.001',
        },
      },
    });
  } catch (error: unknown) {
    walletLogger.error('Error in sponsored-transaction route', { error: { message: (error as Error).message, stack: (error as Error).stack } });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

export default router;
