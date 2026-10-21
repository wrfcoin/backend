/**
 * Cryptographic Utilities
 *
 * TypeScript implementation providing cryptographic functions
 * for blockchain operations with type safety.
 */

import * as crypto from 'crypto';
import { HashAlgorithmType } from './constants.js';

// Types
export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export interface SignatureResult {
  signature: string;
  recovery: number;
}

export interface EncryptionResult {
  encrypted: string;
  iv: string;
  tag: string;
}

/**
 * Generate a cryptographically secure random hash
 */
export function generateSecureHash(
  data: string,
  algorithm: HashAlgorithmType = 'sha256'
): string {
  const hash = crypto.createHash(algorithm);
  hash.update(data);
  return hash.digest('hex');
}

/**
 * Generate a random salt for cryptographic operations
 */
export function generateSalt(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Generate a cryptographically secure random key pair
 */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  return {
    publicKey: publicKey.toString(),
    privateKey: privateKey.toString(),
  };
}

/**
 * Sign data with a private key
 */
export function signData(data: string, privateKey: string): string {
  const sign = crypto.createSign('SHA256');
  sign.update(data);
  sign.end();
  return sign.sign(privateKey, 'hex');
}

/**
 * Verify a signature with a public key
 */
export function verifySignature(
  data: string,
  signature: string,
  publicKey: string
): boolean {
  try {
    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    verify.end();
    return verify.verify(publicKey, signature, 'hex');
  } catch (error) {
    return false;
  }
}

/**
 * Encrypt data using AES-256-GCM
 */
export function encryptData(data: string, key: string): EncryptionResult {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'hex'),
    iv
  );
  cipher.setAAD(Buffer.from(iv));

  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

/**
 * Decrypt data using AES-256-GCM
 */
export function decryptData(
  encryptedData: EncryptionResult,
  key: string
): string {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(key, 'hex'),
      Buffer.from(encryptedData.iv, 'hex')
    );
    decipher.setAAD(Buffer.from(encryptedData.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(encryptedData.tag, 'hex'));

    let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    throw new Error('Decryption failed');
  }
}

/**
 * Generate a deterministic hash from multiple inputs
 */
export function merkleHash(inputs: string[]): string {
  if (inputs.length === 0) return '';
  if (inputs.length === 1) return generateSecureHash(inputs[0]);

  const hashes = inputs.map(input => generateSecureHash(input));

  while (hashes.length > 1) {
    const newHashes: string[] = [];

    for (let i = 0; i < hashes.length; i += 2) {
      const left = hashes[i];
      const right = i + 1 < hashes.length ? hashes[i + 1] : left;
      newHashes.push(generateSecureHash(left + right));
    }

    hashes.splice(0, hashes.length, ...newHashes);
  }

  return hashes[0];
}

/**
 * Derive a key from a password using PBKDF2
 */
export function deriveKey(
  password: string,
  salt: string,
  iterations: number = 100000
): string {
  return crypto
    .pbkdf2Sync(password, salt, iterations, 32, 'sha256')
    .toString('hex');
}

/**
 * Generate a random UUID v4
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Generate a cryptographically secure random address
 */
export function generateAddress(): string {
  const randomBytes = crypto.randomBytes(20);
  return 'wrf' + randomBytes.toString('hex');
}

/**
 * Validate an address format
 */
export function validateAddress(address: string): boolean {
  const addressRegex = /^wrf[a-fA-F0-9]{40}$/;
  return addressRegex.test(address);
}

/**
 * Generate a transaction hash
 */
export function generateTransactionHash(
  from: string,
  to: string,
  amount: number,
  nonce: number,
  timestamp: number
): string {
  const txData = `${from}${to}${amount}${nonce}${timestamp}`;
  return generateSecureHash(txData);
}

/**
 * Generate a block hash
 */
export function generateBlockHash(
  previousHash: string,
  merkleRoot: string,
  timestamp: number,
  nonce: number
): string {
  const blockData = `${previousHash}${merkleRoot}${timestamp}${nonce}`;
  return generateSecureHash(blockData);
}

/**
 * Verify a proof of work
 */
export function verifyProofOfWork(hash: string, difficulty: number): boolean {
  const target = '0'.repeat(difficulty);
  return hash.startsWith(target);
}

/**
 * Generate a weather data hash for verification
 */
export function generateWeatherHash(
  temperature: number,
  humidity: number,
  pressure: number,
  timestamp: number,
  stationId: string
): string {
  const weatherData = `${temperature}${humidity}${pressure}${timestamp}${stationId}`;
  return generateSecureHash(weatherData);
}

/**
 * Utility class for cryptographic operations
 */
export class CryptoUtils {
  private static instance: CryptoUtils;

  private constructor() {}

  public static getInstance(): CryptoUtils {
    if (!CryptoUtils.instance) {
      CryptoUtils.instance = new CryptoUtils();
    }
    return CryptoUtils.instance;
  }

  public hash(data: string, algorithm: HashAlgorithmType = 'sha256'): string {
    return generateSecureHash(data, algorithm);
  }

  public generateKeyPair(): KeyPair {
    return generateKeyPair();
  }

  public sign(data: string, privateKey: string): string {
    return signData(data, privateKey);
  }

  public verify(data: string, signature: string, publicKey: string): boolean {
    return verifySignature(data, signature, publicKey);
  }

  public encrypt(data: string, key: string): EncryptionResult {
    return encryptData(data, key);
  }

  public decrypt(encryptedData: EncryptionResult, key: string): string {
    return decryptData(encryptedData, key);
  }
}

export default CryptoUtils;
