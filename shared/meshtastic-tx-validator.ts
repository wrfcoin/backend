/**
 * Meshtastic Transaction Validator
 *
 * Handles signature verification, nonce tracking, and validation
 * for transactions relayed over LoRa mesh network (Task 109.3).
 */

import { ethers } from 'ethers';
import { eq, and, lte } from 'drizzle-orm';
import { db } from '../database/db.js';
import { meshtasticTxNonces } from './schema-meshtastic.js';
import type { ReconstructedTransaction } from './meshtastic-tx-reconstructor.js';
import {
  isValidAddress,
  isValidAmount,
  EVM_ADDRESS_REGEX,
  WRFCOIN_ADDRESS_REGEX,
} from './meshtastic-payload-types.js';
import { blockchainLogger } from '../server/utils/logger.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Result of transaction validation.
 */
export interface TxValidationResult {
  isValid: boolean;
  recoveredAddress?: string;
  error?: string;
  validationDetails: {
    signatureValid: boolean;
    addressMatch: boolean;
    nonceValid: boolean;
    amountValid: boolean;
    notReplay: boolean;
  };
}

/**
 * Result of nonce check.
 */
export interface NonceCheckResult {
  isValid: boolean;
  isReplay: boolean;
  error?: string;
}

export class NonceAlreadyUsedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonceAlreadyUsedError';
  }
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Nonce retention period (24 hours).
 * Nonces older than this are eligible for cleanup.
 */
const NONCE_RETENTION_HOURS = parseInt(process.env.MESHTASTIC_NONCE_RETENTION_HOURS || '24', 10);

// ============================================================================
// Message Construction
// ============================================================================

/**
 * Construct the canonical message format for transaction signing.
 * This is the message that the sender signs to authorize the transaction.
 *
 * Format: WRFCOIN_TX:${txId}:${from}:${to}:${amount}:${nonce}
 */
export function constructTxMessage(
  txId: string,
  from: string,
  to: string,
  amount: string,
  nonce: number
): string {
  return `WRFCOIN_TX:${txId}:${from}:${to}:${amount}:${nonce}`;
}

/**
 * Construct message from a reconstructed transaction.
 */
export function constructTxMessageFromTx(tx: ReconstructedTransaction): string {
  return constructTxMessage(tx.txId, tx.from, tx.to, tx.amount, tx.nonce);
}

// ============================================================================
// Address Utilities
// ============================================================================

/**
 * Normalize address to lowercase for comparison.
 */
function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

// ============================================================================
// Signature Verification
// ============================================================================

/**
 * Verify a transaction signature.
 * Supports both EVM (0x...) and WRFCoin native (wrf...) addresses.
 */
export function verifyTxSignature(
  message: string,
  signature: string,
  expectedAddress: string
): { isValid: boolean; recoveredAddress?: string; error?: string } {
  try {
    // EVM-style verification
    if (EVM_ADDRESS_REGEX.test(expectedAddress)) {
      return verifyEvmSignature(message, signature, expectedAddress);
    }

    // WRFCoin native address verification
    if (WRFCOIN_ADDRESS_REGEX.test(expectedAddress)) {
      return verifyWrfcoinSignature(message, signature, expectedAddress);
    }

    return {
      isValid: false,
      error: 'Unsupported address format',
    };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : 'Signature verification failed',
    };
  }
}

/**
 * Verify EVM-style (Ethereum) signature using personal_sign format.
 */
function verifyEvmSignature(
  message: string,
  signature: string,
  expectedAddress: string
): { isValid: boolean; recoveredAddress?: string; error?: string } {
  try {
    // Recover the signer address from the signature
    const recoveredAddress = ethers.verifyMessage(message, signature);

    // Compare addresses (case-insensitive)
    const isValid = normalizeAddress(recoveredAddress) === normalizeAddress(expectedAddress);

    return {
      isValid,
      recoveredAddress,
      error: isValid ? undefined : 'Recovered address does not match sender address',
    };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : 'EVM signature verification failed',
    };
  }
}

/**
 * Verify WRFCoin native signature.
 * For compatibility, also attempts EVM verification if signature format matches.
 */
function verifyWrfcoinSignature(
  message: string,
  signature: string,
  expectedAddress: string
): { isValid: boolean; recoveredAddress?: string; error?: string } {
  try {
    const sigBytes = signature.startsWith('0x') ? signature.slice(2) : signature;
    const isHex = /^[a-fA-F0-9]+$/.test(sigBytes);

    // Accept only 65-byte or EIP-2098 compact 64-byte ECDSA signatures.
    if (!isHex || (sigBytes.length !== 130 && sigBytes.length !== 128)) {
      return {
        isValid: false,
        error: 'Invalid WRFCoin signature format',
      };
    }

    const prefixedMessage = ethers.hashMessage(message);
    const fullSig = signature.startsWith('0x') ? signature : `0x${signature}`;
    const recoveredAddress = ethers.recoverAddress(prefixedMessage, fullSig);
    const derivedWrfAddress = 'wrf' + recoveredAddress.slice(2).toLowerCase();

    if (normalizeAddress(derivedWrfAddress) === normalizeAddress(expectedAddress)) {
      return {
        isValid: true,
        recoveredAddress: derivedWrfAddress,
      };
    }

    return {
      isValid: false,
      recoveredAddress: derivedWrfAddress,
      error: 'Recovered address does not match sender address',
    };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : 'WRFCoin signature verification failed',
    };
  }
}

// ============================================================================
// Nonce Tracking (Replay Prevention)
// ============================================================================

/**
 * Check if a nonce has already been used for a given address.
 */
export async function isNonceUsed(fromAddress: string, nonce: number): Promise<boolean> {
  const result = await db
    .select({ id: meshtasticTxNonces.id })
    .from(meshtasticTxNonces)
    .where(
      and(
        eq(meshtasticTxNonces.fromAddress, normalizeAddress(fromAddress)),
        eq(meshtasticTxNonces.nonce, nonce)
      )
    )
    .limit(1);

  return result.length > 0;
}

/**
 * Mark a nonce as used for a given address.
 */
export async function markNonceUsed(
  fromAddress: string,
  nonce: number,
  txId: string,
  meshtasticNodeId?: string
): Promise<void> {
  try {
    await db.insert(meshtasticTxNonces).values({
      fromAddress: normalizeAddress(fromAddress),
      nonce,
      txId,
      meshtasticNodeId: meshtasticNodeId || null,
      usedAt: new Date(),
    });
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError.code === '23505') {
      throw new NonceAlreadyUsedError(
        `Nonce ${nonce} already used for address ${fromAddress}`
      );
    }
    throw error;
  }

  blockchainLogger.info('Marked nonce as used', { module: 'TxValidator', nonce, fromAddress });
}

/**
 * Check nonce validity (not already used = not replay).
 */
export async function checkNonce(
  fromAddress: string,
  nonce: number
): Promise<NonceCheckResult> {
  try {
    const used = await isNonceUsed(fromAddress, nonce);

    if (used) {
      return {
        isValid: false,
        isReplay: true,
        error: `Nonce ${nonce} already used for address ${fromAddress}`,
      };
    }

    return {
      isValid: true,
      isReplay: false,
    };
  } catch (error) {
    return {
      isValid: false,
      isReplay: false,
      error: error instanceof Error ? error.message : 'Nonce check failed',
    };
  }
}

/**
 * Clean up old nonces beyond the retention period.
 */
export async function cleanupOldNonces(): Promise<number> {
  const cutoffTime = new Date(Date.now() - NONCE_RETENTION_HOURS * 60 * 60 * 1000);

  const result = await db
    .delete(meshtasticTxNonces)
    .where(lte(meshtasticTxNonces.usedAt, cutoffTime));

  // Note: Drizzle delete doesn't return count directly in all cases
  // This is a best-effort cleanup
  blockchainLogger.info('Cleaned up old nonces', { module: 'TxValidator', retentionHours: NONCE_RETENTION_HOURS });

  return 0; // Count not available from drizzle delete
}

// ============================================================================
// Full Transaction Validation
// ============================================================================

/**
 * Validate a reconstructed transaction.
 * Performs signature verification, amount validation, and replay check.
 */
export async function validateTransaction(
  tx: ReconstructedTransaction
): Promise<TxValidationResult> {
  const validationDetails = {
    signatureValid: false,
    addressMatch: false,
    nonceValid: false,
    amountValid: false,
    notReplay: false,
  };

  // 1. Validate amount format
  if (!isValidAmount(tx.amount)) {
    return {
      isValid: false,
      error: 'Invalid amount: must be a positive number',
      validationDetails,
    };
  }
  validationDetails.amountValid = true;

  // 2. Validate addresses
  if (!isValidAddress(tx.from)) {
    return {
      isValid: false,
      error: 'Invalid sender address format',
      validationDetails,
    };
  }
  if (!isValidAddress(tx.to)) {
    return {
      isValid: false,
      error: 'Invalid recipient address format',
      validationDetails,
    };
  }
  validationDetails.addressMatch = true;

  // 3. Verify signature
  const message = constructTxMessageFromTx(tx);
  const sigResult = verifyTxSignature(message, tx.signature, tx.from);

  if (!sigResult.isValid) {
    blockchainLogger.warn('Signature verification failed', { module: 'TxValidator', txId: tx.txId, error: sigResult.error });
    return {
      isValid: false,
      error: sigResult.error || 'Signature verification failed',
      recoveredAddress: sigResult.recoveredAddress,
      validationDetails,
    };
  }
  validationDetails.signatureValid = true;

  // 4. Check nonce for replay
  const nonceCheck = await checkNonce(tx.from, tx.nonce);
  if (!nonceCheck.isValid) {
    return {
      isValid: false,
      error: nonceCheck.error || 'Nonce validation failed',
      validationDetails: {
        ...validationDetails,
        notReplay: !nonceCheck.isReplay,
      },
    };
  }
  validationDetails.notReplay = true;
  validationDetails.nonceValid = true;

  // All validations passed
  return {
    isValid: true,
    recoveredAddress: sigResult.recoveredAddress,
    validationDetails,
  };
}

// ============================================================================
// Transaction Validator Service Class
// ============================================================================

/**
 * Service class for transaction validation operations.
 */
export class MeshtasticTxValidator {
  private cleanupInterval: NodeJS.Timeout | null = null;

  /**
   * Start periodic nonce cleanup.
   */
  startCleanup(intervalMs: number = 60 * 60 * 1000): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(async () => {
      try {
        await cleanupOldNonces();
      } catch (error) {
        blockchainLogger.error('Nonce cleanup error', { module: 'TxValidator', error: error instanceof Error ? error.message : String(error) });
      }
    }, intervalMs);
    // #977: unref'd — startCleanup() is invoked at module scope below.
    this.cleanupInterval.unref();

    blockchainLogger.info('Started nonce cleanup interval', { module: 'TxValidator', intervalMs });
  }

  /**
   * Stop periodic cleanup.
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Validate a transaction.
   */
  async validate(tx: ReconstructedTransaction): Promise<TxValidationResult> {
    return validateTransaction(tx);
  }

  /**
   * Check if a nonce is a replay.
   */
  async isReplay(fromAddress: string, nonce: number): Promise<boolean> {
    return isNonceUsed(fromAddress, nonce);
  }

  /**
   * Record a used nonce.
   */
  async recordNonce(
    fromAddress: string,
    nonce: number,
    txId: string,
    meshtasticNodeId?: string
  ): Promise<void> {
    return markNonceUsed(fromAddress, nonce, txId, meshtasticNodeId);
  }

  /**
   * Verify just the signature (without nonce check).
   */
  verifySignature(
    tx: ReconstructedTransaction
  ): { isValid: boolean; recoveredAddress?: string; error?: string } {
    const message = constructTxMessageFromTx(tx);
    return verifyTxSignature(message, tx.signature, tx.from);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

/**
 * Global validator instance.
 */
export const txValidator = new MeshtasticTxValidator();

// Start cleanup on module load
txValidator.startCleanup();

// Graceful shutdown
process.on('SIGTERM', () => txValidator.stopCleanup());
process.on('SIGINT', () => txValidator.stopCleanup());
