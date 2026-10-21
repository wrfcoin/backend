/**
 * Meshtastic Node Registration Service
 *
 * Handles signature verification and node registration for linking
 * Meshtastic node IDs to WRFCoin wallet addresses.
 *
 * Task 111: Node Registration and Identity Mapping
 */

import { ethers } from 'ethers';
import * as crypto from 'crypto';
import {
  registerNode,
  isNonceUsed,
  markNonceUsed,
  getRegisteredNode,
  findNodeByMeshtasticId,
  type RegisteredNodeInfo,
  RegistrationNonceAlreadyUsedError,
} from './meshtastic-db-helpers.js';
import { blockchainLogger } from '../server/utils/logger.js';
import {
  buildGeoFenceReviewUpdate,
  IotGatewayGeoFenceService,
  isGeoFenceLocation,
  type GeoFenceReviewStatus,
} from './iot-gateway-geofence-service.js';
import { db } from '../database/db.js';

// ============================================================================
// Types
// ============================================================================

export interface RegistrationRequest {
  meshtasticNodeId: string;
  wrfcoinAddress: string;
  nonce: number;
  timestamp: number;
  signature: string;
  location?: {
    lat: number;
    lon: number;
    alt?: number;
  };
  metadata?: {
    hardwareModel?: string;
    firmwareVersion?: string;
    shortName?: string;
    longName?: string;
  };
}

export interface RegistrationResult {
  success: boolean;
  registration?: {
    meshtasticNodeId: string;
    wrfcoinAddress: string;
    registeredAt: string;
    isNew: boolean;
    geoFenceStatus: string;
    geoFenceGrid: string | null;
    geoFenceBurstCount: number;
    manualAttestationRequired: boolean;
  };
  error?: string;
}

export interface VerificationResult {
  isValid: boolean;
  recoveredAddress?: string;
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

// Maximum age of a registration request (5 minutes)
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

// Future timestamp tolerance (1 minute to account for clock drift)
const MAX_TIMESTAMP_FUTURE_MS = 60 * 1000;

// Minimum nonce value
const MIN_NONCE = 1;

// Maximum nonce value
const MAX_NONCE = 2147483647; // Max 32-bit signed int

// WRFCoin address regex
const WRFCOIN_ADDRESS_REGEX = /^(wrf|WRF)[a-fA-F0-9]{40}$/;

// EVM address regex
const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const geoFenceService = new IotGatewayGeoFenceService(db);

// ============================================================================
// Message Construction
// ============================================================================

/**
 * Construct the canonical message to sign for node registration.
 * Format: WRFCOIN_NODE_REGISTRATION:${nodeId}:${address}:${nonce}:${timestamp}
 */
export function constructRegistrationMessage(
  meshtasticNodeId: string,
  wrfcoinAddress: string,
  nonce: number,
  timestamp: number
): string {
  return `WRFCOIN_NODE_REGISTRATION:${meshtasticNodeId}:${wrfcoinAddress}:${nonce}:${timestamp}`;
}

/**
 * Hash the registration message for verification.
 * Uses Keccak256 for EVM compatibility or SHA256 for WRFCoin native.
 */
export function hashMessage(message: string, useKeccak: boolean = true): string {
  if (useKeccak) {
    return ethers.keccak256(ethers.toUtf8Bytes(message));
  }
  return crypto.createHash('sha256').update(message).digest('hex');
}

// ============================================================================
// Address Validation
// ============================================================================

/**
 * Validate WRFCoin address format.
 * Supports both native WRFCoin (wrf...) and EVM (0x...) addresses.
 */
export function isValidWrfcoinAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }

  // Check for WRFCoin native address format
  if (WRFCOIN_ADDRESS_REGEX.test(address)) {
    return true;
  }

  // Check for EVM address format
  // First check regex, then use ethers.isAddress with lowercase to bypass checksum validation
  if (EVM_ADDRESS_REGEX.test(address)) {
    // Convert to lowercase to avoid checksum validation issues in ethers v6
    // The regex already ensures it's a valid hex string of correct length
    return ethers.isAddress(address.toLowerCase());
  }

  return false;
}

/**
 * Normalize address to lowercase for comparison.
 */
export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

// ============================================================================
// Signature Verification
// ============================================================================

/**
 * Verify a registration signature.
 *
 * Supports:
 * 1. EVM-style personal_sign signatures (most common for web3 wallets)
 * 2. Raw signature verification for WRFCoin native addresses
 */
export function verifyRegistrationSignature(
  message: string,
  signature: string,
  expectedAddress: string
): VerificationResult {
  try {
    // Try EVM-style verification first (personal_sign)
    if (EVM_ADDRESS_REGEX.test(expectedAddress)) {
      return verifyEvmSignature(message, signature, expectedAddress);
    }

    // For WRFCoin native addresses, use custom verification
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
 * Verify EVM-style (Ethereum) signature.
 * Uses ethers.verifyMessage which expects personal_sign format.
 */
function verifyEvmSignature(
  message: string,
  signature: string,
  expectedAddress: string
): VerificationResult {
  try {
    // Recover the signer address from the signature
    const recoveredAddress = ethers.verifyMessage(message, signature);

    // Compare addresses (case-insensitive)
    const isValid = normalizeAddress(recoveredAddress) === normalizeAddress(expectedAddress);

    return {
      isValid,
      recoveredAddress,
      error: isValid ? undefined : 'Recovered address does not match expected address',
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
 * Uses ED25519 signature verification.
 *
 * Note: This is a placeholder implementation. In production, this should
 * use the actual WRFCoin wallet cryptographic scheme.
 */
function verifyWrfcoinSignature(
  message: string,
  signature: string,
  expectedAddress: string
): VerificationResult {
  try {
    // For WRFCoin native addresses, we derive the public key from the address
    // and verify the ED25519 signature.
    //
    // WRFCoin addresses are: 'wrf' + 40 hex chars (derived from public key hash)
    // We need the full public key for verification, which should be provided
    // alongside the signature or derived from on-chain data.
    //
    // For now, we fall back to EVM-style verification if the signature looks
    // like an EVM signature (65 or 66 bytes hex encoded).

    // Check if signature looks like EVM format
    const sigBytes = signature.startsWith('0x') ? signature.slice(2) : signature;
    if (sigBytes.length === 130 || sigBytes.length === 128) {
      // Likely EVM signature, verify using hash of the message
      const messageHash = crypto.createHash('sha256').update(message).digest();
      const prefixedMessage = ethers.hashMessage(message);

      try {
        const recoveredAddress = ethers.recoverAddress(prefixedMessage, signature);
        // Map recovered EVM address to WRFCoin format for comparison
        const derivedWrfAddress = 'wrf' + recoveredAddress.slice(2).toLowerCase();

        if (normalizeAddress(derivedWrfAddress) === normalizeAddress(expectedAddress)) {
          return {
            isValid: true,
            recoveredAddress: derivedWrfAddress,
          };
        }
      } catch {
        // Fall through to return invalid
      }
    }

    return {
      isValid: false,
      error: 'WRFCoin native signature verification not yet implemented. Use EVM-compatible wallet.',
    };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : 'WRFCoin signature verification failed',
    };
  }
}

// ============================================================================
// Registration Validation
// ============================================================================

/**
 * Validate registration request parameters.
 */
export function validateRegistrationRequest(
  request: RegistrationRequest
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Validate meshtasticNodeId
  if (!request.meshtasticNodeId || typeof request.meshtasticNodeId !== 'string') {
    errors.push('meshtasticNodeId is required and must be a string');
  } else if (request.meshtasticNodeId.length < 1 || request.meshtasticNodeId.length > 64) {
    errors.push('meshtasticNodeId must be between 1 and 64 characters');
  }

  // Validate wrfcoinAddress
  if (!request.wrfcoinAddress || typeof request.wrfcoinAddress !== 'string') {
    errors.push('wrfcoinAddress is required and must be a string');
  } else if (!isValidWrfcoinAddress(request.wrfcoinAddress)) {
    errors.push('Invalid wrfcoinAddress format. Expected WRFCoin (wrf...) or EVM (0x...) address');
  }

  // Validate nonce
  if (typeof request.nonce !== 'number' || !Number.isInteger(request.nonce)) {
    errors.push('nonce is required and must be an integer');
  } else if (request.nonce < MIN_NONCE || request.nonce > MAX_NONCE) {
    errors.push(`nonce must be between ${MIN_NONCE} and ${MAX_NONCE}`);
  }

  // Validate timestamp
  if (typeof request.timestamp !== 'number' || !Number.isInteger(request.timestamp)) {
    errors.push('timestamp is required and must be a Unix timestamp (integer)');
  } else {
    const now = Date.now();
    const requestTime = request.timestamp * 1000; // Convert to milliseconds

    if (requestTime > now + MAX_TIMESTAMP_FUTURE_MS) {
      errors.push('timestamp is too far in the future');
    }

    if (now - requestTime > MAX_TIMESTAMP_AGE_MS) {
      errors.push('timestamp has expired (maximum age is 5 minutes)');
    }
  }

  // Validate signature
  if (!request.signature || typeof request.signature !== 'string') {
    errors.push('signature is required and must be a string');
  } else if (request.signature.length < 64) {
    errors.push('Invalid signature format');
  }

  // Validate metadata (optional)
  if (request.metadata !== undefined && request.metadata !== null) {
    if (typeof request.metadata !== 'object') {
      errors.push('metadata must be an object if provided');
    } else {
      // Validate individual metadata fields
      if (request.metadata.hardwareModel !== undefined &&
          (typeof request.metadata.hardwareModel !== 'string' ||
           request.metadata.hardwareModel.length > 64)) {
        errors.push('metadata.hardwareModel must be a string with max 64 characters');
      }
      if (request.metadata.firmwareVersion !== undefined &&
          (typeof request.metadata.firmwareVersion !== 'string' ||
           request.metadata.firmwareVersion.length > 32)) {
        errors.push('metadata.firmwareVersion must be a string with max 32 characters');
      }
      if (request.metadata.shortName !== undefined &&
          (typeof request.metadata.shortName !== 'string' ||
           request.metadata.shortName.length > 16)) {
        errors.push('metadata.shortName must be a string with max 16 characters');
      }
      if (request.metadata.longName !== undefined &&
          (typeof request.metadata.longName !== 'string' ||
           request.metadata.longName.length > 255)) {
        errors.push('metadata.longName must be a string with max 255 characters');
      }
    }
  }

  if (request.location !== undefined && request.location !== null && !isGeoFenceLocation(request.location)) {
    errors.push('location must include finite lat and lon numbers if provided');
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Main Registration Function
// ============================================================================

/**
 * Process a node registration request.
 *
 * Steps:
 * 1. Validate request parameters
 * 2. Check timestamp is within acceptable window
 * 3. Check nonce hasn't been used before
 * 4. Verify signature
 * 5. Create/update registration record
 * 6. Mark nonce as used
 */
export async function processRegistration(
  request: RegistrationRequest
): Promise<RegistrationResult> {
  // Step 1: Validate request parameters
  const validation = validateRegistrationRequest(request);
  if (!validation.valid) {
    return {
      success: false,
      error: `Validation failed: ${validation.errors.join('; ')}`,
    };
  }

  // Step 2: Check nonce hasn't been used
  const nonceUsed = await isNonceUsed(request.wrfcoinAddress, request.nonce);
  if (nonceUsed) {
    return {
      success: false,
      error: 'Nonce has already been used. Please use a different nonce.',
    };
  }

  // Step 3: Construct and verify signature
  const message = constructRegistrationMessage(
    request.meshtasticNodeId,
    request.wrfcoinAddress,
    request.nonce,
    request.timestamp
  );

  const verificationResult = verifyRegistrationSignature(
    message,
    request.signature,
    request.wrfcoinAddress
  );

  if (!verificationResult.isValid) {
    return {
      success: false,
      error: `Signature verification failed: ${verificationResult.error}`,
    };
  }

  const existingNode = await findNodeByMeshtasticId(request.meshtasticNodeId);
  const existingLocation = isGeoFenceLocation(existingNode?.location)
    ? existingNode.location
    : null;
  const resolvedLocation = request.location || existingLocation;
  const geoFenceUpdate = existingNode
    ? {
        geoFenceGrid: existingNode.geoFenceGrid,
        geoFenceStatus: existingNode.geoFenceStatus as GeoFenceReviewStatus,
        geoFenceReason: existingNode.geoFenceReason,
        geoFenceBurstCount: existingNode.geoFenceBurstCount,
        geoFenceWindowStartedAt: existingNode.geoFenceWindowStartedAt,
        geoFenceTriggeredAt: existingNode.geoFenceTriggeredAt,
      }
    : buildGeoFenceReviewUpdate(
        await geoFenceService.evaluateNewIdentity({
          integrationType: 'meshtastic',
          subjectId: request.meshtasticNodeId,
          location: resolvedLocation,
          existingGridKey: null,
        })
      );

  // Step 4: Register the node
  try {
    const { node, isNew } = await registerNode({
      meshtasticNodeId: request.meshtasticNodeId,
      wrfcoinAddress: request.wrfcoinAddress,
      signature: request.signature,
      nonce: request.nonce,
      location: resolvedLocation,
      ...geoFenceUpdate,
      metadata: request.metadata,
    });

    // Step 5: Mark nonce as used
    await markNonceUsed(request.wrfcoinAddress, request.nonce);

    return {
      success: true,
      registration: {
        meshtasticNodeId: node.meshtasticNodeId,
        wrfcoinAddress: node.wrfcoinAddress!,
        registeredAt: node.registeredAt?.toISOString() || new Date().toISOString(),
        isNew,
        geoFenceStatus: node.geoFenceStatus,
        geoFenceGrid: node.geoFenceGrid,
        geoFenceBurstCount: node.geoFenceBurstCount,
        manualAttestationRequired: requiresManualAttestation(node.geoFenceStatus),
      },
    };
  } catch (error) {
    if (error instanceof RegistrationNonceAlreadyUsedError) {
      return {
        success: false,
        error: 'Nonce has already been used. Please use a different nonce.',
      };
    }
    blockchainLogger.error('Registration error', { module: 'MeshtasticRegistration', error: error instanceof Error ? error.message : String(error) });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Registration failed',
    };
  }
}

function requiresManualAttestation(status?: string | null): boolean {
  return status === 'manual_review_required' || status === 'rejected';
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get registration info for a node.
 */
export async function getNodeRegistration(
  meshtasticNodeId: string
): Promise<RegisteredNodeInfo | null> {
  return getRegisteredNode(meshtasticNodeId);
}

/**
 * Check if a node is registered.
 */
export async function isNodeRegistered(meshtasticNodeId: string): Promise<boolean> {
  const registration = await getRegisteredNode(meshtasticNodeId);
  return registration !== null;
}

/**
 * Generate a secure nonce for registration.
 * Returns a random integer between MIN_NONCE and MAX_NONCE.
 */
export function generateRegistrationNonce(): number {
  // Use crypto.randomInt for secure random number generation
  return crypto.randomInt(MIN_NONCE, MAX_NONCE);
}

/**
 * Get the current Unix timestamp for registration.
 */
export function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}
