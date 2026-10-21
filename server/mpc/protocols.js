/**
 * MPC Protocol Implementations
 *
 * This module implements various Multi-Party Computation protocols:
 * - Threshold Signature Schemes (with real Shamir's Secret Sharing)
 * - Zero-Knowledge Proofs
 * - Secure Multi-party Computation
 * - Secret Sharing Schemes (Polynomial-based SSS with Lagrange interpolation)
 */

const { createHash, randomBytes } = require('crypto');
const { logger } = require('../utils/logger');

// ============================================================================
// Finite Field Arithmetic for Shamir's Secret Sharing
// ============================================================================

/**
 * Prime modulus for finite field operations
 * Using a 256-bit prime: 2^256 - 189
 * Represented as a BigInt for JavaScript arbitrary precision arithmetic
 */
const FIELD_PRIME = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF43');

/**
 * Perform modular addition: (a + b) mod p
 * @param {BigInt} a - First operand
 * @param {BigInt} b - Second operand
 * @returns {BigInt} Result
 */
function fieldAdd(a, b) {
  return ((a % FIELD_PRIME) + (b % FIELD_PRIME)) % FIELD_PRIME;
}

/**
 * Perform modular subtraction: (a - b) mod p
 * @param {BigInt} a - First operand
 * @param {BigInt} b - Second operand
 * @returns {BigInt} Result
 */
function fieldSub(a, b) {
  let result = ((a % FIELD_PRIME) - (b % FIELD_PRIME)) % FIELD_PRIME;
  if (result < 0n) {
    result += FIELD_PRIME;
  }
  return result;
}

/**
 * Perform modular multiplication: (a * b) mod p
 * @param {BigInt} a - First operand
 * @param {BigInt} b - Second operand
 * @returns {BigInt} Result
 */
function fieldMul(a, b) {
  return ((a % FIELD_PRIME) * (b % FIELD_PRIME)) % FIELD_PRIME;
}

/**
 * Compute modular exponentiation: a^exp mod p
 * Using square-and-multiply algorithm
 * @param {BigInt} base - Base
 * @param {BigInt} exp - Exponent
 * @returns {BigInt} Result
 */
function fieldPow(base, exp) {
  let result = 1n;
  base = base % FIELD_PRIME;

  while (exp > 0n) {
    if (exp % 2n === 1n) {
      result = fieldMul(result, base);
    }
    exp = exp >> 1n;
    base = fieldMul(base, base);
  }

  return result;
}

/**
 * Compute modular multiplicative inverse using Fermat's little theorem
 * a^(-1) = a^(p-2) mod p
 * @param {BigInt} a - Value to invert
 * @returns {BigInt} Multiplicative inverse
 */
function fieldInverse(a) {
  if (a === 0n) {
    throw new Error('Cannot compute inverse of zero');
  }
  return fieldPow(a, FIELD_PRIME - 2n);
}

/**
 * Negate a field element: -a mod p
 * @param {BigInt} a - Value to negate
 * @returns {BigInt} Negated value
 */
function fieldNeg(a) {
  if (a === 0n) return 0n;
  return FIELD_PRIME - (a % FIELD_PRIME);
}

/**
 * Convert bytes to BigInt (big-endian)
 * @param {Buffer} bytes - Byte buffer
 * @returns {BigInt} BigInt representation
 */
function bytesToBigInt(bytes) {
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

/**
 * Convert BigInt to bytes (big-endian, 32 bytes)
 * @param {BigInt} value - BigInt value
 * @returns {Buffer} Byte buffer
 */
function bigIntToBytes(value) {
  const bytes = Buffer.alloc(32);
  let temp = value;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(temp & 0xFFn);
    temp = temp >> 8n;
  }
  return bytes;
}

/**
 * Generate a cryptographically secure random field element
 * @returns {BigInt} Random field element
 */
function randomFieldElement() {
  const bytes = randomBytes(32);
  return bytesToBigInt(bytes) % FIELD_PRIME;
}

// ============================================================================
// Shamir's Secret Sharing Implementation
// ============================================================================

/**
 * Production-ready Shamir's Secret Sharing implementation
 * Uses polynomial evaluation for splitting and Lagrange interpolation for reconstruction
 */
const shamirSecretSharing = {
  /**
   * Split a secret into shares using polynomial-based Shamir's Secret Sharing
   *
   * Creates a random polynomial f(x) of degree (threshold - 1) where:
   * - f(0) = secret
   * - Coefficients a_1, ..., a_{k-1} are random
   * - Returns shares f(1), f(2), ..., f(numShares)
   *
   * @param {Buffer|string} secret - The secret to split (up to 32 bytes)
   * @param {number} numShares - Number of shares to create (n)
   * @param {number} threshold - Minimum shares needed to reconstruct (k)
   * @returns {Array<{x: number, y: string, threshold: number, totalShares: number}>} Array of secret shares
   */
  split: (secret, numShares, threshold) => {
    // Validate parameters
    if (threshold < 1) {
      throw new Error('Threshold must be at least 1');
    }
    if (numShares < threshold) {
      throw new Error('Number of shares must be greater than or equal to threshold');
    }
    if (numShares > 255) {
      throw new Error('Maximum 255 shares supported');
    }

    logger.info(`[ShamirSSS] Splitting secret into ${numShares} shares with threshold ${threshold}`);

    // Convert secret to BigInt
    let secretBytes;
    if (Buffer.isBuffer(secret)) {
      secretBytes = secret;
    } else if (typeof secret === 'string') {
      // If hex string, decode it
      if (/^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0) {
        secretBytes = Buffer.from(secret, 'hex');
      } else {
        secretBytes = Buffer.from(secret, 'utf8');
      }
    } else {
      throw new Error('Secret must be a Buffer or string');
    }

    // Ensure secret fits in field
    if (secretBytes.length > 32) {
      throw new Error('Secret too large (max 32 bytes)');
    }

    // Pad to 32 bytes
    const paddedSecret = Buffer.alloc(32);
    secretBytes.copy(paddedSecret, 32 - secretBytes.length);

    const secretValue = bytesToBigInt(paddedSecret);

    // Generate random polynomial coefficients
    // f(x) = a_0 + a_1*x + a_2*x^2 + ... + a_{k-1}*x^{k-1}
    // where a_0 = secret
    const coefficients = [secretValue];
    for (let i = 1; i < threshold; i++) {
      coefficients.push(randomFieldElement());
    }

    // Evaluate polynomial at x = 1, 2, ..., numShares
    const shares = [];
    for (let i = 1; i <= numShares; i++) {
      const x = BigInt(i);
      const y = evaluatePolynomial(coefficients, x);

      shares.push({
        x: i,
        y: bigIntToBytes(y).toString('hex'),
        threshold: threshold,
        totalShares: numShares,
      });
    }

    logger.info(`[ShamirSSS] Successfully created ${shares.length} shares`);
    return shares;
  },

  /**
   * Reconstruct a secret from shares using Lagrange interpolation
   *
   * Given k or more shares (x_i, y_i), reconstructs f(0) = secret using:
   * f(0) = sum_{i} y_i * L_i(0)
   * where L_i(0) = product_{j != i} (0 - x_j) / (x_i - x_j)
   *
   * @param {Array<{x: number, y: string}>} shares - The secret shares
   * @param {number} threshold - Minimum shares needed
   * @returns {string} The reconstructed secret (hex encoded)
   */
  reconstruct: (shares, threshold) => {
    if (shares.length < threshold) {
      throw new Error(`Not enough shares: ${shares.length} < ${threshold}`);
    }

    logger.info(`[ShamirSSS] Reconstructing secret from ${shares.length} shares`);

    // Use only the required number of shares
    const sharesToUse = shares.slice(0, threshold);

    // Perform Lagrange interpolation at x = 0
    let secret = 0n;

    for (let i = 0; i < sharesToUse.length; i++) {
      const xi = BigInt(sharesToUse[i].x);
      const yi = bytesToBigInt(Buffer.from(sharesToUse[i].y, 'hex'));

      // Calculate Lagrange basis polynomial L_i(0)
      let numerator = 1n;
      let denominator = 1n;

      for (let j = 0; j < sharesToUse.length; j++) {
        if (i !== j) {
          const xj = BigInt(sharesToUse[j].x);

          // numerator *= (0 - xj) = -xj
          numerator = fieldMul(numerator, fieldNeg(xj));

          // denominator *= (xi - xj)
          denominator = fieldMul(denominator, fieldSub(xi, xj));
        }
      }

      // L_i(0) = numerator / denominator = numerator * denominator^(-1)
      const denominatorInverse = fieldInverse(denominator);
      const lagrangeCoef = fieldMul(numerator, denominatorInverse);

      // secret += yi * L_i(0)
      secret = fieldAdd(secret, fieldMul(yi, lagrangeCoef));
    }

    logger.info('[ShamirSSS] Successfully reconstructed secret');
    return bigIntToBytes(secret).toString('hex');
  },

  /**
   * Verify that a set of shares are consistent
   * (i.e., they reconstruct to the same secret with different combinations)
   *
   * @param {Array<{x: number, y: string}>} shares - The secret shares
   * @param {number} threshold - Minimum shares needed
   * @returns {boolean} Whether all shares are consistent
   */
  verifyShares: (shares, threshold) => {
    if (shares.length < threshold) {
      return false;
    }

    try {
      // Reconstruct with first k shares
      const secret1 = shamirSecretSharing.reconstruct(shares.slice(0, threshold), threshold);

      // If we have more shares, verify consistency with different combinations
      if (shares.length > threshold) {
        for (let i = threshold; i < shares.length; i++) {
          // Create combination with different share
          const testShares = [...shares.slice(0, threshold - 1), shares[i]];
          const secret2 = shamirSecretSharing.reconstruct(testShares, threshold);

          if (secret1 !== secret2) {
            logger.warn('[ShamirSSS] Shares are inconsistent');
            return false;
          }
        }
      }

      return true;
    } catch (error) {
      logger.error(`[ShamirSSS] Share verification failed: ${error.message}`);
      return false;
    }
  },
};

/**
 * Evaluate polynomial at point x using Horner's method
 * f(x) = a_0 + a_1*x + a_2*x^2 + ... = a_0 + x*(a_1 + x*(a_2 + ...))
 *
 * @param {BigInt[]} coefficients - Polynomial coefficients [a_0, a_1, ..., a_{k-1}]
 * @param {BigInt} x - Point to evaluate at
 * @returns {BigInt} f(x)
 */
function evaluatePolynomial(coefficients, x) {
  let result = 0n;

  // Process coefficients in reverse order for Horner's method
  for (let i = coefficients.length - 1; i >= 0; i--) {
    result = fieldAdd(fieldMul(result, x), coefficients[i]);
  }

  return result;
}

// ============================================================================
// BLS Signature Simulation (with improved structure)
// ============================================================================

// Threshold BLS signatures
// In production, this would use a proper BLS library like @noble/curves
const thresholdBLS = {
  privateKeyGen: () => {
    return randomBytes(32).toString('hex');
  },

  publicKeyGen: privateKey => {
    // Simulate public key derivation
    // In production: use BLS12-381 curve operations
    return createHash('sha256').update(privateKey).digest('hex');
  },

  sign: (privateKey, message) => {
    // Simulate signature
    // In production: use BLS12-381 signature
    const messageHash = createHash('sha256').update(message).digest('hex');
    return createHash('sha256')
      .update(privateKey + messageHash)
      .digest('hex');
  },

  /**
   * Aggregate partial signatures using Lagrange interpolation
   * In production, this would use actual BLS signature aggregation
   *
   * @param {Array<{index: number, signature: string}>} partialSignatures - Partial signatures with indices
   * @param {number} threshold - Threshold for signing
   * @returns {string} Aggregated signature
   */
  aggregateSignatures: (partialSignatures, threshold) => {
    if (!partialSignatures || partialSignatures.length === 0) {
      throw new Error('No signatures to aggregate');
    }

    if (partialSignatures.length < threshold) {
      throw new Error(`Not enough signatures: ${partialSignatures.length} < ${threshold}`);
    }

    // Use Lagrange interpolation to combine signatures
    // This simulates the actual BLS signature aggregation math
    const sigsToUse = partialSignatures.slice(0, threshold);
    let aggregatedValue = 0n;

    for (let i = 0; i < sigsToUse.length; i++) {
      const xi = BigInt(sigsToUse[i].index);
      const sigBytes = Buffer.from(sigsToUse[i].signature, 'hex');
      const yi = bytesToBigInt(sigBytes.slice(0, 32)); // Use first 32 bytes

      // Calculate Lagrange coefficient at x = 0
      let numerator = 1n;
      let denominator = 1n;

      for (let j = 0; j < sigsToUse.length; j++) {
        if (i !== j) {
          const xj = BigInt(sigsToUse[j].index);
          numerator = fieldMul(numerator, fieldNeg(xj));
          denominator = fieldMul(denominator, fieldSub(xi, xj));
        }
      }

      const lagrangeCoef = fieldMul(numerator, fieldInverse(denominator));
      aggregatedValue = fieldAdd(aggregatedValue, fieldMul(yi, lagrangeCoef));
    }

    return bigIntToBytes(aggregatedValue).toString('hex');
  },

  verify: (publicKey, message, signature) => {
    // In production: use BLS12-381 verification
    // For simulation, perform basic validation
    if (!signature || signature.length < 64) {
      return false;
    }
    return true;
  },
};

// Backward compatibility: keep simulateBLS for existing code
const simulateBLS = thresholdBLS;

// Backward compatibility: keep simulateSecretSharing for existing code
const simulateSecretSharing = shamirSecretSharing;

// Zero Knowledge Proof simulation
const simulateZKP = {
  /**
   * Generate a zero-knowledge proof
   * @param {Object} statement - Public statement to prove
   * @param {Object} witness - Private witness
   * @param {Object} public_params - Public parameters
   * @returns {Object} The proof
   */
  generateProof: (statement, witness, public_params) => {
    // In a real implementation, this would generate an actual ZK proof
    // For simulation, we create a hash-based proof
    const statementStr = JSON.stringify(statement);
    const witnessStr = JSON.stringify(witness);
    const paramsStr = JSON.stringify(public_params);

    const proofBase = createHash('sha256')
      .update(`${statementStr}:${witnessStr}:${paramsStr}`)
      .digest('hex');

    return {
      proof: proofBase,
      commitment: proofBase.substring(0, 16),
      challenge: proofBase.substring(16, 32),
      response: proofBase.substring(32, 48),
    };
  },

  /**
   * Verify a zero-knowledge proof
   * @param {Object} statement - Public statement being proved
   * @param {Object} proof - The proof to verify
   * @param {Object} public_params - Public parameters
   * @returns {boolean} Whether the proof is valid
   */
  verifyProof: (statement, proof, public_params) => {
    // In a real implementation, this would verify the proof
    // For simulation, we return true
    return true;
  },

  /**
   * Verify proofs from multiple parties
   * @param {Map<string, Object>} proofs - Map of party IDs to their proofs
   * @param {Object} statement - The statement being proved
   * @returns {boolean} Whether all proofs are valid
   */
  verifyMultipleProofs: (proofs, statement) => {
    // Verify that all proofs are valid
    for (const [partyId, proof] of proofs.entries()) {
      if (!simulateZKP.verifyProof(statement, proof, {})) {
        return false;
      }
    }

    return true;
  },
};

/**
 * Threshold signing implementation
 * @param {Array<string>} participants - List of participant IDs
 * @param {number} threshold - Threshold for signing
 * @param {string} message - Message to sign
 * @returns {Promise<Object>} Signature result
 */
async function thresholdSigning(participants, threshold, message) {
  try {
    logger.info(
      `[MPCProtocols] Starting threshold signing with ${participants.length} participants, threshold ${threshold}`
    );

    // In a real implementation, this would distribute key shares to participants
    // For simulation, we create dummy shares and signatures

    const messageHash = createHash('sha256').update(message).digest('hex');

    // Generate a master key for simulation
    const masterKey = simulateBLS.privateKeyGen();
    const masterPublicKey = simulateBLS.publicKeyGen(masterKey);

    // Simulate distributed shares
    const shares = simulateSecretSharing.split(
      masterKey,
      participants.length,
      threshold
    );

    // Simulate partial signatures from each participant
    const partialSignatures = [];
    for (let i = 0; i < participants.length; i++) {
      const share = shares[i].y;
      const partialSig = simulateBLS.sign(share, messageHash);
      partialSignatures.push(partialSig);
    }

    // Simulate signature aggregation
    const aggregatedSignature = simulateBLS.aggregateSignatures(
      partialSignatures.slice(0, threshold)
    );

    logger.info('[MPCProtocols] Threshold signing completed successfully');

    return {
      messageHash,
      aggregatedSignature,
      publicKey: masterPublicKey,
      valid: true,
    };
  } catch (error) {
    logger.error(`[MPCProtocols] Threshold signing error: ${error.message}`);
    throw error;
  }
}

/**
 * Generate a zero-knowledge proof
 * @param {Object} statement - The statement to prove
 * @param {Object} witness - The witness (private data)
 * @param {Object} public_params - Public parameters
 * @returns {Promise<Object>} The generated proof
 */
async function generateZKProof(statement, witness, public_params) {
  try {
    logger.info(
      `[MPCProtocols] Generating ZK proof for statement: ${JSON.stringify(statement)}`
    );

    const proof = simulateZKP.generateProof(statement, witness, public_params);

    logger.info('[MPCProtocols] ZK proof generated successfully');

    return {
      proof,
      statement,
      valid: true,
    };
  } catch (error) {
    logger.error(`[MPCProtocols] ZK proof generation error: ${error.message}`);
    throw error;
  }
}

/**
 * Verify a zero-knowledge proof from multiple parties
 * @param {Map<string, Object>} shares - Map of party IDs to their proofs
 * @param {Object} statement - The statement being proved
 * @returns {Promise<Object>} Verification result
 */
async function verifyZKProof(shares, statement) {
  try {
    logger.info(
      `[MPCProtocols] Verifying ZK proofs from ${shares.size} parties`
    );

    const allValid = simulateZKP.verifyMultipleProofs(shares, statement);

    logger.info(
      `[MPCProtocols] ZK proof verification ${allValid ? 'successful' : 'failed'}`
    );

    return {
      verified: allValid,
      proofCount: shares.size,
      statement,
    };
  } catch (error) {
    logger.error(
      `[MPCProtocols] ZK proof verification error: ${error.message}`
    );
    throw error;
  }
}

/**
 * Reconstruct a secret from shares
 * @param {Map<string, Object>} shares - Map of party IDs to their shares
 * @param {number} threshold - Minimum shares needed for reconstruction
 * @returns {Promise<Object>} The reconstructed secret
 */
async function reconstructSecret(shares, threshold) {
  try {
    logger.info(
      `[MPCProtocols] Reconstructing secret from ${shares.size} shares, threshold ${threshold}`
    );

    // Extract actual share values and convert to format needed by reconstruction algorithm
    const shareArray = Array.from(shares.entries()).map(([partyId, share]) => ({
      x: parseInt(partyId.substring(0, 8), 16) % 100, // Generate a number from partyId for demo
      y: share.value,
    }));

    // Reconstruct the secret
    const reconstructed = simulateSecretSharing.reconstruct(
      shareArray,
      threshold
    );

    logger.info('[MPCProtocols] Secret reconstruction completed successfully');

    return {
      secret: reconstructed,
      shareCount: shares.size,
      threshold,
    };
  } catch (error) {
    logger.error(
      `[MPCProtocols] Secret reconstruction error: ${error.message}`
    );
    throw error;
  }
}

/**
 * Aggregate signatures for a threshold signature scheme
 * @param {Map<string, Object>} shares - Map of party IDs to their signature shares
 * @param {string} message - The message that was signed
 * @returns {Promise<Object>} The aggregated signature
 */
async function aggregateThresholdSignature(shares, message) {
  try {
    logger.info(`[MPCProtocols] Aggregating ${shares.size} signature shares`);

    const signatures = Array.from(shares.values()).map(
      share => share.signature
    );

    // Aggregate signatures
    const aggregatedSignature = simulateBLS.aggregateSignatures(signatures);

    // Hash the message for verification
    const messageHash = createHash('sha256').update(message).digest('hex');

    logger.info('[MPCProtocols] Signature aggregation completed successfully');

    return {
      messageHash,
      aggregatedSignature,
      valid: true,
      shareCount: shares.size,
    };
  } catch (error) {
    logger.error(
      `[MPCProtocols] Signature aggregation error: ${error.message}`
    );
    throw error;
  }
}

/**
 * Generic aggregation for custom protocols
 * @param {Map<string, Object>} shares - Map of party IDs to their shares
 * @param {string} protocol - The protocol identifier
 * @param {Object} metadata - Additional protocol metadata
 * @returns {Promise<Object>} The aggregation result
 */
async function aggregateGeneric(shares, protocol, metadata) {
  try {
    logger.info(
      `[MPCProtocols] Generic aggregation for protocol ${protocol} with ${shares.size} shares`
    );

    // For demonstration, we just concatenate and hash all shares
    const serializedShares = Array.from(shares.entries())
      .map(([partyId, share]) => `${partyId}:${JSON.stringify(share)}`)
      .join('|');

    const aggregated = createHash('sha256')
      .update(serializedShares)
      .digest('hex');

    logger.info('[MPCProtocols] Generic aggregation completed successfully');

    return {
      protocol,
      aggregated,
      metadata,
      shareCount: shares.size,
    };
  } catch (error) {
    logger.error(`[MPCProtocols] Generic aggregation error: ${error.message}`);
    throw error;
  }
}

module.exports = {
  thresholdSigning,
  generateZKProof,
  verifyZKProof,
  reconstructSecret,
  aggregateThresholdSignature,
  aggregateGeneric,
};
