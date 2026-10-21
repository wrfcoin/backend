/**
 * Cryptographic utilities for Wrfcoin
 *
 * This module provides JavaScript access to cryptographic functions
 * including hashing, signing, and key management operations.
 * Now includes quantum-resistant cryptography support via XMSS.
 */

const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Hash algorithms supported by Wrfcoin
 */
const HashAlgorithm = {
  SHA256: 'sha256',
  SHA3_256: 'sha3-256',
  BLAKE2B: 'blake2b',
};

/**
 * Hash data using SHA-256
 * @param {Buffer|string} data - Data to hash
 * @returns {string} Hex-encoded hash
 */
function sha256(data) {
  const hash = crypto.createHash('sha256');
  hash.update(data);
  return hash.digest('hex');
}

/**
 * Hash data using SHA-3 (256-bit)
 * @param {Buffer|string} data - Data to hash
 * @returns {string} Hex-encoded hash
 */
function sha3_256(data) {
  try {
    const hash = crypto.createHash('sha3-256');
    hash.update(data);
    return hash.digest('hex');
  } catch (error) {
    // Fallback to SHA-256 if SHA-3 is not available
    console.warn('SHA-3 not available, falling back to SHA-256');
    return sha256(data);
  }
}

/**
 * Hash data using BLAKE2b
 * @param {Buffer|string} data - Data to hash
 * @returns {string} Hex-encoded hash
 */
function blake2b(data) {
  try {
    const hash = crypto.createHash('blake2b512');
    hash.update(data);
    // Return first 32 bytes (256 bits) to match Rust implementation
    return hash.digest('hex').substring(0, 64);
  } catch (error) {
    // Fallback to SHA-256 if BLAKE2b is not available
    console.warn('BLAKE2b not available, falling back to SHA-256');
    return sha256(data);
  }
}

/**
 * Generate a cryptographically secure random nonce
 * @param {number} size - Size in bytes (default: 32)
 * @returns {string} Hex-encoded nonce
 */
function generateNonce(size = 32) {
  return crypto.randomBytes(size).toString('hex');
}

/**
 * Convert hex string to buffer
 * @param {string} hex - Hex string
 * @returns {Buffer} Buffer representation
 */
function fromHex(hex) {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have an even number of characters');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Convert buffer to hex string
 * @param {Buffer} buffer - Buffer to convert
 * @returns {string} Hex string
 */
function toHex(buffer) {
  return buffer.toString('hex');
}

/**
 * Verify a checksum against data
 * @param {Buffer|string} data - Original data
 * @param {string} checksum - Expected checksum (hex)
 * @returns {boolean} True if checksum matches
 */
function verifyChecksum(data, checksum) {
  const calculated = sha256(data);
  const expectedChecksum = calculated.substring(0, 8); // First 4 bytes
  return expectedChecksum === checksum.substring(0, 8);
}

/**
 * Generate a checksum for data
 * @param {Buffer|string} data - Data to checksum
 * @returns {string} Hex-encoded checksum (first 4 bytes of hash)
 */
function generateChecksum(data) {
  const hash = sha256(data);
  return hash.substring(0, 8); // First 4 bytes
}

/**
 * Generate a key pair for cryptographic operations
 * @returns {Object} Object containing publicKey and privateKey
 */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'hex' },
    privateKeyEncoding: { type: 'pkcs8', format: 'hex' },
  });

  return {
    publicKey,
    privateKey,
    // Extract the raw 32-byte keys for compatibility
    publicKeyRaw: publicKey.substring(24, 88), // Skip ASN.1 header
    privateKeyRaw: privateKey.substring(32, 96), // Skip ASN.1 header
  };
}

/**
 * Sign data with a private key
 * @param {Buffer|string} data - Data to sign
 * @param {string} privateKey - Private key in hex format
 * @returns {string} Signature in hex format
 */
function sign(data, privateKey) {
  try {
    const sign = crypto.createSign('ed25519');
    sign.update(data);
    const signature = sign.sign({
      key: Buffer.from(privateKey, 'hex'),
      format: 'der',
      type: 'pkcs8',
    });
    return signature.toString('hex');
  } catch (error) {
    console.error('Signing failed:', error.message);
    return null;
  }
}

/**
 * Verify a signature
 * @param {Buffer|string} data - Original data
 * @param {string} signature - Signature in hex format
 * @param {string} publicKey - Public key in hex format
 * @returns {boolean} True if signature is valid
 */
function verify(data, signature, publicKey) {
  try {
    const verify = crypto.createVerify('ed25519');
    verify.update(data);
    return verify.verify(
      {
        key: Buffer.from(publicKey, 'hex'),
        format: 'der',
        type: 'spki',
      },
      Buffer.from(signature, 'hex')
    );
  } catch (error) {
    console.error('Verification failed:', error.message);
    return false;
  }
}

/**
 * Quantum-resistant signature schemes supported by Wrfcoin
 */
const QuantumSignatureScheme = {
  XMSS_SHA256_H10: 'XMSS_SHA256_H10', // 1,024 signatures
  XMSS_SHA256_H16: 'XMSS_SHA256_H16', // 65,536 signatures
  XMSS_SHA256_H20: 'XMSS_SHA256_H20', // 1,048,576 signatures
  XMSSMT_SHA256_H20_D2: 'XMSSMT_SHA256_H20_D2', // Multi-tree XMSS
  XMSSMT_SHA256_H40_D4: 'XMSSMT_SHA256_H40_D4', // Very high capacity
  SPHINCSPLUS_SHA256_128S: 'SPHINCSPLUS_SHA256_128S',
  SPHINCSPLUS_SHA256_128F: 'SPHINCSPLUS_SHA256_128F',
  DILITHIUM2: 'DILITHIUM2',
  DILITHIUM3: 'DILITHIUM3',
  DILITHIUM5: 'DILITHIUM5',
  FALCON512: 'FALCON512',
  FALCON1024: 'FALCON1024',
};

/**
 * Path to the Rust blockchain executable
 */
const RUST_BLOCKCHAIN_PATH = path.join(
  __dirname,
  '../../blockchain-core/target/release/wrfcoin'
);

/**
 * Allowed commands for the Rust blockchain CLI
 */
const ALLOWED_COMMANDS = new Set([
  'xmss',
  'wallet',
  'transaction',
  'balance',
  'info',
  'generate',
  'sign',
  'verify',
  'schemes',
]);

/**
 * Allowed command arguments (whitelist)
 */
const ALLOWED_ARGS = new Set([
  'generate',
  'sign',
  'verify',
  'info',
  'schemes',
  '--scheme',
  '--data',
  '--private-key',
  '--public-key',
  '--signature',
  '--help',
]);

/**
 * Sanitize and validate command input
 * @param {string} command - Command to validate
 * @param {Array} args - Arguments to validate
 * @returns {Object} Validated command and args
 */
function sanitizeCommandInput(command, args = []) {
  // Validate command
  if (typeof command !== 'string' || !ALLOWED_COMMANDS.has(command)) {
    throw new Error(`Invalid or unauthorized command: ${command}`);
  }

  // Validate and sanitize arguments
  const sanitizedArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Ensure argument is a string
    if (typeof arg !== 'string') {
      throw new Error(`Invalid argument type: ${typeof arg}`);
    }

    // Check for command injection patterns
    if (
      arg.includes(';') ||
      arg.includes('&') ||
      arg.includes('|') ||
      arg.includes('$(') ||
      arg.includes('`') ||
      arg.includes('\n') ||
      arg.includes('\r') ||
      arg.includes('&&') ||
      arg.includes('||')
    ) {
      throw new Error(`Potentially dangerous characters in argument: ${arg}`);
    }

    // Validate argument flags
    if (arg.startsWith('--')) {
      if (!ALLOWED_ARGS.has(arg)) {
        throw new Error(`Unauthorized argument flag: ${arg}`);
      }
    } else if (arg.startsWith('-')) {
      throw new Error(`Short flags not allowed: ${arg}`);
    } else {
      // Validate hex strings for keys and signatures
      if (arg.length > 10 && /^[a-fA-F0-9]+$/.test(arg)) {
        // Validate hex string length (reasonable limits)
        if (arg.length > 2048) {
          throw new Error(`Argument too long: ${arg.length} characters`);
        }
      } else if (arg.length > 100) {
        // Non-hex arguments shouldn't be too long
        throw new Error(`Argument too long: ${arg.length} characters`);
      }

      // Validate known signature schemes
      if (i > 0 && args[i - 1] === '--scheme') {
        const validSchemes = Object.values(QuantumSignatureScheme);
        if (!validSchemes.includes(arg)) {
          throw new Error(`Invalid signature scheme: ${arg}`);
        }
      }
    }

    sanitizedArgs.push(arg);
  }

  return { command, args: sanitizedArgs };
}

/**
 * Execute a Rust blockchain command with security validation
 * @param {string} command - Command to execute
 * @param {Array} args - Command arguments
 * @returns {Promise<string>} Command output
 */
async function executeRustCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    try {
      // Sanitize and validate input
      const { command: validCommand, args: validArgs } = sanitizeCommandInput(
        command,
        args
      );

      // Check if Rust binary exists and is executable
      if (!require('fs').existsSync(RUST_BLOCKCHAIN_PATH)) {
        throw new Error('Rust blockchain binary not found');
      }

      const process = spawn(
        RUST_BLOCKCHAIN_PATH,
        [validCommand, ...validArgs],
        {
          // Security options
          stdio: ['ignore', 'pipe', 'pipe'], // Don't inherit stdin
          env: {}, // Empty environment to prevent environment variable injection
          timeout: 30000, // 30 second timeout
          killSignal: 'SIGTERM',
        }
      );

      let output = '';
      let error = '';

      process.stdout.on('data', data => {
        output += data.toString();
        // Limit output size to prevent memory exhaustion
        if (output.length > 1024 * 1024) {
          // 1MB limit
          process.kill('SIGTERM');
          reject(new Error('Command output too large'));
        }
      });

      process.stderr.on('data', data => {
        error += data.toString();
        // Limit error output size
        if (error.length > 64 * 1024) {
          // 64KB limit
          process.kill('SIGTERM');
          reject(new Error('Command error output too large'));
        }
      });

      process.on('close', code => {
        if (code === 0) {
          try {
            // Try to parse JSON output
            const result = JSON.parse(output.trim());
            resolve(result);
          } catch (parseError) {
            // If not JSON, return raw output (sanitized)
            const sanitizedOutput = output
              .trim()
              .replace(/[\x00-\x1F\x7F]/g, '');
            resolve(sanitizedOutput);
          }
        } else {
          reject(
            new Error(
              `Rust command failed with code ${code}: ${error || 'Unknown error'}`
            )
          );
        }
      });

      process.on('error', err => {
        reject(new Error(`Failed to start Rust process: ${err.message}`));
      });

      // Set timeout to kill long-running processes
      const timeoutId = setTimeout(() => {
        process.kill('SIGTERM');
        reject(new Error('Command timeout after 30 seconds'));
      }, 30000);

      process.on('close', () => {
        clearTimeout(timeoutId);
      });
    } catch (error) {
      reject(new Error(`Command validation failed: ${error.message}`));
    }
  });
}

/**
 * Generate XMSS key pair
 * @param {string} scheme - XMSS signature scheme
 * @returns {Promise<Object>} Object containing publicKey, privateKey, and address
 */
async function generateXmssKeyPair(
  scheme = QuantumSignatureScheme.XMSS_SHA256_H16
) {
  try {
    const result = await executeRustCommand('xmss', [
      'generate',
      '--scheme',
      scheme,
    ]);
    return {
      scheme,
      publicKey: result.public_key,
      privateKey: result.private_key,
      address: result.address,
      maxSignatures: result.max_signatures,
      currentIndex: 0,
    };
  } catch (error) {
    console.error('XMSS key generation failed:', error.message);
    throw new Error(`Failed to generate XMSS key pair: ${error.message}`);
  }
}

/**
 * Sign data with XMSS private key
 * @param {Buffer|string} data - Data to sign
 * @param {string} privateKey - XMSS private key in hex format
 * @param {string} scheme - XMSS signature scheme
 * @returns {Promise<Object>} Signature object with metadata
 */
async function signXmss(
  data,
  privateKey,
  scheme = QuantumSignatureScheme.XMSS_SHA256_H16
) {
  try {
    const dataHex = Buffer.isBuffer(data)
      ? data.toString('hex')
      : Buffer.from(data).toString('hex');

    const result = await executeRustCommand('xmss', [
      'sign',
      '--data',
      dataHex,
      '--private-key',
      privateKey,
      '--scheme',
      scheme,
    ]);

    return {
      signature: result.signature,
      signatureIndex: result.signature_index,
      scheme: result.scheme,
      remainingSignatures: result.remaining_signatures,
    };
  } catch (error) {
    console.error('XMSS signing failed:', error.message);
    throw new Error(`Failed to sign with XMSS: ${error.message}`);
  }
}

/**
 * Verify XMSS signature
 * @param {Buffer|string} data - Original data
 * @param {string} signature - XMSS signature in hex format
 * @param {string} publicKey - XMSS public key in hex format
 * @param {string} scheme - XMSS signature scheme
 * @returns {Promise<boolean>} True if signature is valid
 */
async function verifyXmss(
  data,
  signature,
  publicKey,
  scheme = QuantumSignatureScheme.XMSS_SHA256_H16
) {
  try {
    const dataHex = Buffer.isBuffer(data)
      ? data.toString('hex')
      : Buffer.from(data).toString('hex');

    const result = await executeRustCommand('xmss', [
      'verify',
      '--data',
      dataHex,
      '--signature',
      signature,
      '--public-key',
      publicKey,
      '--scheme',
      scheme,
    ]);

    return result.valid === true;
  } catch (error) {
    console.error('XMSS verification failed:', error.message);
    return false;
  }
}

/**
 * Get XMSS key information
 * @param {string} privateKey - XMSS private key in hex format
 * @param {string} scheme - XMSS signature scheme
 * @returns {Promise<Object>} Key information including usage statistics
 */
async function getXmssKeyInfo(
  privateKey,
  scheme = QuantumSignatureScheme.XMSS_SHA256_H16
) {
  try {
    const result = await executeRustCommand('xmss', [
      'info',
      '--private-key',
      privateKey,
      '--scheme',
      scheme,
    ]);

    return {
      scheme: result.scheme,
      maxSignatures: result.max_signatures,
      usedSignatures: result.used_signatures,
      remainingSignatures: result.remaining_signatures,
      isExhausted: result.is_exhausted,
      address: result.address,
    };
  } catch (error) {
    console.error('Failed to get XMSS key info:', error.message);
    throw new Error(`Failed to get XMSS key info: ${error.message}`);
  }
}

/**
 * Create quantum-resistant wallet
 * @param {string} scheme - Quantum signature scheme to use
 * @param {string} password - Password for wallet encryption
 * @returns {Promise<Object>} Wallet information
 */
async function createQuantumWallet(
  scheme = QuantumSignatureScheme.XMSS_SHA256_H16,
  password
) {
  try {
    const keyPair = await generateXmssKeyPair(scheme);

    // In a real implementation, you would encrypt the private key with the password
    const encryptedPrivateKey = encryptPrivateKey(keyPair.privateKey, password);

    return {
      address: keyPair.address,
      scheme: keyPair.scheme,
      publicKey: keyPair.publicKey,
      encryptedPrivateKey,
      maxSignatures: keyPair.maxSignatures,
      isQuantumResistant: true,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Quantum wallet creation failed:', error.message);
    throw new Error(`Failed to create quantum wallet: ${error.message}`);
  }
}

/**
 * Encrypt private key with password (secure implementation)
 * @param {string} privateKey - Private key to encrypt
 * @param {string} password - Password for encryption
 * @returns {string} Encrypted private key
 */
function encryptPrivateKey(privateKey, password) {
  try {
    const algorithm = 'aes-256-gcm';
    const salt = crypto.randomBytes(32);
    const key = crypto.scryptSync(password, salt, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);

    let encrypted = cipher.update(privateKey, 'hex', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return JSON.stringify({
      encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      salt: salt.toString('hex'),
      algorithm,
    });
  } catch (error) {
    console.error('Private key encryption failed:', error.message);
    throw new Error('Failed to encrypt private key');
  }
}

/**
 * Decrypt private key with password (secure implementation)
 * @param {string} encryptedData - Encrypted private key data
 * @param {string} password - Password for decryption
 * @returns {string} Decrypted private key
 */
function decryptPrivateKey(encryptedData, password) {
  try {
    const data = JSON.parse(encryptedData);

    // Validate required fields
    if (!data.encrypted || !data.iv || !data.authTag || !data.salt) {
      throw new Error('Invalid encrypted data format');
    }

    const algorithm = data.algorithm || 'aes-256-gcm';
    const salt = Buffer.from(data.salt, 'hex');
    const key = crypto.scryptSync(password, salt, 32);
    const iv = Buffer.from(data.iv, 'hex');

    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    decipher.setAuthTag(Buffer.from(data.authTag, 'hex'));

    let decrypted = decipher.update(data.encrypted, 'hex', 'hex');
    decrypted += decipher.final('hex');

    return decrypted;
  } catch (error) {
    console.error('Private key decryption failed:', error.message);
    throw new Error('Failed to decrypt private key');
  }
}

/**
 * Check if XMSS implementation is available
 * @returns {Promise<boolean>} True if XMSS is available
 */
async function isXmssAvailable() {
  try {
    await executeRustCommand('xmss', ['--help']);
    return true;
  } catch (error) {
    console.warn('XMSS implementation not available:', error.message);
    return false;
  }
}

/**
 * Get information about available quantum-resistant schemes
 * @returns {Promise<Array>} Array of available schemes with their properties
 */
async function getAvailableQuantumSchemes() {
  try {
    const result = await executeRustCommand('xmss', ['schemes']);
    return (
      result.schemes ||
      Object.values(QuantumSignatureScheme).map(scheme => ({
        name: scheme,
        available: true,
        description: getSchemeDescription(scheme),
      }))
    );
  } catch (error) {
    console.warn('Failed to get available schemes:', error.message);
    return Object.values(QuantumSignatureScheme).map(scheme => ({
      name: scheme,
      available: false,
      description: getSchemeDescription(scheme),
    }));
  }
}

/**
 * Get description for a quantum signature scheme
 * @param {string} scheme - Signature scheme name
 * @returns {string} Human-readable description
 */
function getSchemeDescription(scheme) {
  const descriptions = {
    [QuantumSignatureScheme.XMSS_SHA256_H10]:
      'XMSS with SHA-256, 1,024 signatures',
    [QuantumSignatureScheme.XMSS_SHA256_H16]:
      'XMSS with SHA-256, 65,536 signatures',
    [QuantumSignatureScheme.XMSS_SHA256_H20]:
      'XMSS with SHA-256, 1,048,576 signatures',
    [QuantumSignatureScheme.XMSSMT_SHA256_H20_D2]:
      'Multi-tree XMSS, very high capacity',
    [QuantumSignatureScheme.XMSSMT_SHA256_H40_D4]:
      'Multi-tree XMSS, extremely high capacity',
    [QuantumSignatureScheme.SPHINCSPLUS_SHA256_128S]:
      'SPHINCS+ with small signatures',
    [QuantumSignatureScheme.SPHINCSPLUS_SHA256_128F]:
      'SPHINCS+ with fast verification',
    [QuantumSignatureScheme.DILITHIUM2]: 'CRYSTALS-Dilithium level 2',
    [QuantumSignatureScheme.DILITHIUM3]: 'CRYSTALS-Dilithium level 3',
    [QuantumSignatureScheme.DILITHIUM5]: 'CRYSTALS-Dilithium level 5',
    [QuantumSignatureScheme.FALCON512]: 'Falcon-512 (NTRU-based)',
    [QuantumSignatureScheme.FALCON1024]: 'Falcon-1024 (NTRU-based)',
  };

  return descriptions[scheme] || 'Unknown quantum signature scheme';
}

/**
 * Test all cryptographic functions
 * @returns {Object} Test results
 */
function runCryptoTests() {
  const results = {
    tests: [],
    passed: 0,
    failed: 0,
  };

  const testData = 'Hello, Wrfcoin!';

  // Test SHA-256
  try {
    const hash = sha256(testData);
    results.tests.push({
      name: 'SHA-256 Hash',
      status: hash && hash.length === 64 ? 'passed' : 'failed',
      result: hash,
    });
    if (hash && hash.length === 64) results.passed++;
    else results.failed++;
  } catch (error) {
    results.tests.push({
      name: 'SHA-256 Hash',
      status: 'failed',
      error: error.message,
    });
    results.failed++;
  }

  // Test nonce generation
  try {
    const nonce = generateNonce();
    results.tests.push({
      name: 'Nonce Generation',
      status: nonce && nonce.length === 64 ? 'passed' : 'failed',
      result: nonce,
    });
    if (nonce && nonce.length === 64) results.passed++;
    else results.failed++;
  } catch (error) {
    results.tests.push({
      name: 'Nonce Generation',
      status: 'failed',
      error: error.message,
    });
    results.failed++;
  }

  // Test key pair generation
  try {
    const keyPair = generateKeyPair();
    results.tests.push({
      name: 'Key Pair Generation',
      status:
        keyPair && keyPair.publicKey && keyPair.privateKey
          ? 'passed'
          : 'failed',
      result: keyPair ? 'Generated successfully' : 'Failed',
    });
    if (keyPair && keyPair.publicKey && keyPair.privateKey) results.passed++;
    else results.failed++;
  } catch (error) {
    results.tests.push({
      name: 'Key Pair Generation',
      status: 'failed',
      error: error.message,
    });
    results.failed++;
  }

  // Test checksum
  try {
    const checksum = generateChecksum(testData);
    const isValid = verifyChecksum(testData, checksum);
    results.tests.push({
      name: 'Checksum Generation/Verification',
      status: checksum && isValid ? 'passed' : 'failed',
      result: { checksum, isValid },
    });
    if (checksum && isValid) results.passed++;
    else results.failed++;
  } catch (error) {
    results.tests.push({
      name: 'Checksum Generation/Verification',
      status: 'failed',
      error: error.message,
    });
    results.failed++;
  }

  results.successRate = (
    (results.passed / (results.passed + results.failed)) *
    100
  ).toFixed(1);

  return results;
}

module.exports = {
  // Classical cryptography
  HashAlgorithm,
  sha256,
  sha3_256,
  blake2b,
  generateNonce,
  fromHex,
  toHex,
  verifyChecksum,
  generateChecksum,
  generateKeyPair,
  sign,
  verify,
  runCryptoTests,

  // Quantum-resistant cryptography
  QuantumSignatureScheme,
  generateXmssKeyPair,
  signXmss,
  verifyXmss,
  getXmssKeyInfo,
  createQuantumWallet,
  encryptPrivateKey,
  decryptPrivateKey,
  isXmssAvailable,
  getAvailableQuantumSchemes,
  getSchemeDescription,
  executeRustCommand,
};
