/**
 * Bridge Cryptographic Verification Module
 *
 * Provides production-grade cryptographic verification for cross-chain bridge operations:
 * - ECDSA secp256k1 signature verification (Ethereum-compatible)
 * - BLS12-381 signature verification and aggregation
 * - EIP-191 and EIP-712 message signing support
 * - Merkle proof verification
 * - Batch verification for performance
 *
 * This module replaces placeholder format-only checks with real cryptographic verification.
 *
 * @module bridge-crypto-verifier
 */

import * as secp256k1 from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { bls12_381 } from '@noble/curves/bls12-381';
import { EventEmitter } from 'events';
import { crosschainLogger } from '../server/utils/logger.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface ECDSASignature {
  r: Uint8Array;
  s: Uint8Array;
  v: number; // Recovery ID (27 or 28 for Ethereum, 0 or 1 for raw)
}

export interface SignatureVerificationResult {
  isValid: boolean;
  recoveredAddress?: string;
  publicKey?: Uint8Array;
  error?: string;
}

export interface BatchVerificationResult {
  allValid: boolean;
  results: SignatureVerificationResult[];
  validCount: number;
  invalidCount: number;
}

export interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
  salt?: string;
}

export interface EIP712TypedData {
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  domain: EIP712Domain;
  message: Record<string, unknown>;
}

export interface MerkleProof {
  leaf: Uint8Array;
  proof: Uint8Array[];
  indices: boolean[]; // true = right sibling, false = left sibling
  root: Uint8Array;
}

// ============================================================================
// ECDSA Secp256k1 Verifier
// ============================================================================

/**
 * ECDSA signature verification using secp256k1 curve
 * Compatible with Ethereum and other EVM chains
 */
export class ECDSAVerifier extends EventEmitter {
  /**
   * Verify a secp256k1 signature against a message and public key
   * @param messageHash - 32-byte message hash (Keccak256 or SHA256)
   * @param signature - Raw signature bytes (64 or 65 bytes) or hex string
   * @param publicKey - Public key (33 compressed or 65 uncompressed bytes) or hex string
   */
  static verify(
    messageHash: Uint8Array | string,
    signature: Uint8Array | string,
    publicKey: Uint8Array | string
  ): SignatureVerificationResult {
    try {
      // Normalize inputs to Uint8Array
      const msgHash = typeof messageHash === 'string' ? hexToBytes(normalizeHex(messageHash)) : messageHash;
      const sigBytes = typeof signature === 'string' ? hexToBytes(normalizeHex(signature)) : signature;
      const pubKeyBytes = typeof publicKey === 'string' ? hexToBytes(normalizeHex(publicKey)) : publicKey;

      // Validate message hash length
      if (msgHash.length !== 32) {
        return { isValid: false, error: 'Message hash must be 32 bytes' };
      }

      // Extract r, s from signature (first 64 bytes)
      if (sigBytes.length < 64) {
        return { isValid: false, error: 'Signature must be at least 64 bytes' };
      }

      // Create signature object for noble/secp256k1
      const compactSignature = sigBytes.slice(0, 64);

      // Verify signature against the pre-hashed message bytes.
      const isValid = secp256k1.verify(compactSignature, msgHash, pubKeyBytes, {
        prehash: false,
      });

      return {
        isValid,
        publicKey: pubKeyBytes,
      };
    } catch (error) {
      return {
        isValid: false,
        error: `Verification failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Verify and recover the public key/address from a signature
   * @param messageHash - 32-byte message hash
   * @param signature - 65-byte signature with recovery ID
   */
  static verifyAndRecover(
    messageHash: Uint8Array | string,
    signature: Uint8Array | string
  ): SignatureVerificationResult {
    try {
      const msgHash = typeof messageHash === 'string' ? hexToBytes(normalizeHex(messageHash)) : messageHash;
      const sigBytes = typeof signature === 'string' ? hexToBytes(normalizeHex(signature)) : signature;

      if (msgHash.length !== 32) {
        return { isValid: false, error: 'Message hash must be 32 bytes' };
      }

      if (sigBytes.length !== 65) {
        return { isValid: false, error: 'Signature with recovery must be 65 bytes' };
      }

      // Extract r, s, v
      const compactSignature = sigBytes.slice(0, 64);
      let recoveryId = sigBytes[64];

      // Handle Ethereum's v values (27/28) and EIP-155 chain IDs
      if (recoveryId >= 27) {
        recoveryId -= 27;
      }
      if (recoveryId > 3) {
        // EIP-155: v = chainId * 2 + 35 + recoveryId
        recoveryId = recoveryId % 2;
      }

      // Recover public key from recovered signature bytes.
      const recoveredSignature = new Uint8Array(65);
      recoveredSignature.set(compactSignature, 0);
      recoveredSignature[64] = recoveryId;
      const recoveredCompressed = secp256k1.recoverPublicKey(
        recoveredSignature,
        msgHash,
        { prehash: false }
      );
      const pubKeyBytes = secp256k1.Point.fromBytes(recoveredCompressed).toBytes(
        false
      ); // Uncompressed

      // Derive Ethereum address from public key
      const pubKeyHash = keccak_256(pubKeyBytes.slice(1)); // Remove 0x04 prefix
      const address = '0x' + bytesToHex(pubKeyHash.slice(-20));

      return {
        isValid: true,
        recoveredAddress: address,
        publicKey: pubKeyBytes,
      };
    } catch (error) {
      return {
        isValid: false,
        error: `Recovery failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Verify a signature against a specific Ethereum address
   * @param messageHash - 32-byte message hash
   * @param signature - 65-byte signature
   * @param expectedAddress - Expected Ethereum address (0x prefixed)
   */
  static verifyAddress(
    messageHash: Uint8Array | string,
    signature: Uint8Array | string,
    expectedAddress: string
  ): SignatureVerificationResult {
    const result = this.verifyAndRecover(messageHash, signature);

    if (!result.isValid || !result.recoveredAddress) {
      return result;
    }

    const normalizedExpected = expectedAddress.toLowerCase();
    const normalizedRecovered = result.recoveredAddress.toLowerCase();

    return {
      isValid: normalizedExpected === normalizedRecovered,
      recoveredAddress: result.recoveredAddress,
      publicKey: result.publicKey,
      error: normalizedExpected !== normalizedRecovered
        ? `Address mismatch: expected ${normalizedExpected}, got ${normalizedRecovered}`
        : undefined,
    };
  }

  /**
   * Create an EIP-191 personal message hash
   * @param message - Raw message string or bytes
   */
  static hashPersonalMessage(message: string | Uint8Array): Uint8Array {
    const messageBytes = typeof message === 'string'
      ? new TextEncoder().encode(message)
      : message;

    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
    return keccak_256(concatBytes(prefix, messageBytes));
  }

  /**
   * Create an EIP-712 typed data hash
   * @param typedData - EIP-712 typed data structure
   */
  static hashTypedData(typedData: EIP712TypedData): Uint8Array {
    const domainSeparator = this.hashDomain(typedData.domain);
    const structHash = this.hashStruct(typedData.primaryType, typedData.message, typedData.types);

    const prefix = hexToBytes('1901');
    return keccak_256(concatBytes(prefix, domainSeparator, structHash));
  }

  private static hashDomain(domain: EIP712Domain): Uint8Array {
    const types = {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    };

    if (domain.salt) {
      types.EIP712Domain.push({ name: 'salt', type: 'bytes32' });
    }

    return this.hashStruct('EIP712Domain', domain as unknown as Record<string, unknown>, types);
  }

  private static hashStruct(
    primaryType: string,
    data: Record<string, unknown>,
    types: Record<string, { name: string; type: string }[]>
  ): Uint8Array {
    const typeHash = this.hashType(primaryType, types);
    const encodedData = this.encodeData(primaryType, data, types);
    return keccak_256(concatBytes(typeHash, encodedData));
  }

  private static hashType(
    primaryType: string,
    types: Record<string, { name: string; type: string }[]>
  ): Uint8Array {
    const typeString = this.encodeType(primaryType, types);
    return keccak_256(new TextEncoder().encode(typeString));
  }

  private static encodeType(
    primaryType: string,
    types: Record<string, { name: string; type: string }[]>
  ): string {
    const deps = new Set<string>();
    this.findTypeDependencies(primaryType, types, deps);
    deps.delete(primaryType);

    const sortedDeps = [primaryType, ...Array.from(deps).sort()];

    return sortedDeps.map(type => {
      const fields = types[type];
      return `${type}(${fields.map(f => `${f.type} ${f.name}`).join(',')})`;
    }).join('');
  }

  private static findTypeDependencies(
    type: string,
    types: Record<string, { name: string; type: string }[]>,
    deps: Set<string>
  ): void {
    if (deps.has(type) || !types[type]) return;
    deps.add(type);

    for (const field of types[type]) {
      const baseType = field.type.replace(/\[\d*\]$/, '');
      if (types[baseType]) {
        this.findTypeDependencies(baseType, types, deps);
      }
    }
  }

  private static encodeData(
    primaryType: string,
    data: Record<string, unknown>,
    types: Record<string, { name: string; type: string }[]>
  ): Uint8Array {
    const fields = types[primaryType];
    const values: Uint8Array[] = [];

    for (const field of fields) {
      const value = data[field.name];
      values.push(this.encodeValue(field.type, value, types));
    }

    return concatBytes(...values);
  }

  private static encodeValue(
    type: string,
    value: unknown,
    types: Record<string, { name: string; type: string }[]>
  ): Uint8Array {
    if (type === 'string') {
      return keccak_256(new TextEncoder().encode(value as string));
    }
    if (type === 'bytes') {
      const bytes = typeof value === 'string' ? hexToBytes(normalizeHex(value)) : value as Uint8Array;
      return keccak_256(bytes);
    }
    if (type.startsWith('uint') || type.startsWith('int')) {
      const num = BigInt(value as string | number | bigint);
      const bytes = new Uint8Array(32);
      let n = num < 0n ? num + (1n << 256n) : num;
      for (let i = 31; i >= 0; i--) {
        bytes[i] = Number(n & 0xFFn);
        n >>= 8n;
      }
      return bytes;
    }
    if (type === 'address') {
      const addr = hexToBytes(normalizeHex(value as string));
      const padded = new Uint8Array(32);
      padded.set(addr, 12);
      return padded;
    }
    if (type === 'bool') {
      const bytes = new Uint8Array(32);
      bytes[31] = value ? 1 : 0;
      return bytes;
    }
    if (type.startsWith('bytes')) {
      const size = parseInt(type.slice(5), 10);
      const bytes = typeof value === 'string' ? hexToBytes(normalizeHex(value)) : value as Uint8Array;
      const padded = new Uint8Array(32);
      padded.set(bytes.slice(0, size), 0);
      return padded;
    }
    if (types[type]) {
      return this.hashStruct(type, value as Record<string, unknown>, types);
    }

    throw new Error(`Unsupported type: ${type}`);
  }

  /**
   * Batch verify multiple signatures for performance
   * @param verifications - Array of {messageHash, signature, publicKey}
   */
  static batchVerify(
    verifications: Array<{
      messageHash: Uint8Array | string;
      signature: Uint8Array | string;
      publicKey: Uint8Array | string;
    }>
  ): BatchVerificationResult {
    const results: SignatureVerificationResult[] = [];
    let validCount = 0;
    let invalidCount = 0;

    for (const { messageHash, signature, publicKey } of verifications) {
      const result = this.verify(messageHash, signature, publicKey);
      results.push(result);

      if (result.isValid) {
        validCount++;
      } else {
        invalidCount++;
      }
    }

    return {
      allValid: invalidCount === 0,
      results,
      validCount,
      invalidCount,
    };
  }
}

// ============================================================================
// BLS12-381 Verifier
// ============================================================================

const blsOps: any = (bls12_381 as any).shortSignatures || (bls12_381 as any);

/**
 * BLS12-381 signature verification
 * Supports signature aggregation for multi-sig operations
 */
export class BLSVerifier extends EventEmitter {
  /**
   * Verify a single BLS signature
   * @param message - Message bytes or hex string
   * @param signature - BLS signature (48 bytes for short sigs, 96 for regular)
   * @param publicKey - BLS public key (96 bytes for short sigs, 48 for regular)
   */
  static verify(
    message: Uint8Array | string,
    signature: Uint8Array | string,
    publicKey: Uint8Array | string
  ): boolean {
    try {
      const msgBytes = typeof message === 'string'
        ? hexToBytes(normalizeHex(message))
        : message;
      const sigBytes = typeof signature === 'string'
        ? hexToBytes(normalizeHex(signature))
        : signature;
      const pubKeyBytes = typeof publicKey === 'string'
        ? hexToBytes(normalizeHex(publicKey))
        : publicKey;

      // Use the short signatures scheme from noble/curves
      // Cast needed: the noble/curves BLS API uses WeierstrassPoint types internally
      // but accepts raw bytes at the implementation level
      return blsOps.verify(sigBytes, msgBytes, pubKeyBytes);
    } catch (error) {
      crosschainLogger.error('BLS verification error', {
        operation: 'bridge:crypto:bls:verify',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Aggregate multiple BLS signatures into one
   * @param signatures - Array of BLS signatures
   */
  static aggregateSignatures(signatures: (Uint8Array | string)[]): Uint8Array {
    if (signatures.length === 0) {
      throw new Error('Cannot aggregate empty signature array');
    }

    const sigBytes = signatures.map(sig =>
      typeof sig === 'string' ? hexToBytes(normalizeHex(sig)) : sig
    );

    return blsOps.aggregateSignatures(sigBytes);
  }

  /**
   * Aggregate multiple BLS public keys
   * @param publicKeys - Array of BLS public keys
   */
  static aggregatePublicKeys(publicKeys: (Uint8Array | string)[]): Uint8Array {
    if (publicKeys.length === 0) {
      throw new Error('Cannot aggregate empty public key array');
    }

    const pubKeyBytes = publicKeys.map(pk =>
      typeof pk === 'string' ? hexToBytes(normalizeHex(pk)) : pk
    );

    return blsOps.aggregatePublicKeys(pubKeyBytes);
  }

  /**
   * Verify an aggregated signature against multiple public keys
   * All signers must have signed the same message
   * @param message - Signed message
   * @param aggregatedSignature - Aggregated BLS signature
   * @param publicKeys - Array of all participating public keys
   */
  static verifyAggregate(
    message: Uint8Array | string,
    aggregatedSignature: Uint8Array | string,
    publicKeys: (Uint8Array | string)[]
  ): boolean {
    try {
      const msgBytes = typeof message === 'string'
        ? hexToBytes(normalizeHex(message))
        : message;
      const sigBytes = typeof aggregatedSignature === 'string'
        ? hexToBytes(normalizeHex(aggregatedSignature))
        : aggregatedSignature;
      const pubKeyBytes = publicKeys.map(pk =>
        typeof pk === 'string' ? hexToBytes(normalizeHex(pk)) : pk
      );

      // Aggregate public keys first
      const aggregatedPubKey = blsOps.aggregatePublicKeys(pubKeyBytes);

      // Verify aggregated signature against aggregated public key
      return blsOps.verify(sigBytes, msgBytes, aggregatedPubKey);
    } catch (error) {
      crosschainLogger.error('BLS aggregate verification error', {
        operation: 'bridge:crypto:bls:aggregate:verify',
        publicKeyCount: publicKeys.length,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Verify multiple signatures with different messages (batch verification)
   * More efficient than verifying each signature individually
   * @param items - Array of {message, signature, publicKey}
   */
  static verifyBatch(
    items: Array<{
      message: Uint8Array | string;
      signature: Uint8Array | string;
      publicKey: Uint8Array | string;
    }>
  ): boolean {
    try {
      const messages = items.map(item =>
        typeof item.message === 'string' ? hexToBytes(normalizeHex(item.message)) : item.message
      );
      const signatures = items.map(item =>
        typeof item.signature === 'string' ? hexToBytes(normalizeHex(item.signature)) : item.signature
      );
      const publicKeys = items.map(item =>
        typeof item.publicKey === 'string' ? hexToBytes(normalizeHex(item.publicKey)) : item.publicKey
      );

      // verifyBatch takes (aggregatedSignature, items[]) -- aggregate first, then verify
      const aggregatedSig = blsOps.aggregateSignatures(signatures);
      const batchItems = messages.map((msg, i) => ({ message: msg, publicKey: publicKeys[i] }));
      return blsOps.verifyBatch(aggregatedSig, batchItems);
    } catch (error) {
      crosschainLogger.error('BLS batch verification error', {
        operation: 'bridge:crypto:bls:batch:verify',
        batchSize: items.length,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Generate a BLS key pair
   */
  static generateKeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
    const randomPrivateKey =
      (bls12_381 as any).utils.randomSecretKey ||
      (bls12_381 as any).utils.randomPrivateKey;
    const privateKey = randomPrivateKey();
    const publicKey = blsOps.getPublicKey(privateKey);
    return { privateKey, publicKey };
  }

  /**
   * Sign a message with a BLS private key
   * @param message - Message to sign
   * @param privateKey - BLS private key
   */
  static sign(
    message: Uint8Array | string,
    privateKey: Uint8Array | string
  ): Uint8Array {
    const msgBytes = typeof message === 'string'
      ? hexToBytes(normalizeHex(message))
      : message;
    const privKeyBytes = typeof privateKey === 'string'
      ? hexToBytes(normalizeHex(privateKey))
      : privateKey;

    return blsOps.sign(msgBytes, privKeyBytes);
  }
}

// ============================================================================
// Merkle Proof Verifier
// ============================================================================

/**
 * Merkle proof verification for cross-chain transaction inclusion
 */
export class MerkleVerifier {
  /**
   * Verify a Merkle proof
   * @param proof - Merkle proof structure
   * @param hashFn - Hash function to use (defaults to SHA256)
   */
  static verify(
    proof: MerkleProof,
    hashFn: (data: Uint8Array) => Uint8Array = sha256
  ): boolean {
    try {
      let currentHash = proof.leaf;

      for (let i = 0; i < proof.proof.length; i++) {
        const sibling = proof.proof[i];
        const isRight = proof.indices[i];

        if (isRight) {
          // Sibling is on the right
          currentHash = hashFn(concatBytes(currentHash, sibling));
        } else {
          // Sibling is on the left
          currentHash = hashFn(concatBytes(sibling, currentHash));
        }
      }

      // Compare computed root with expected root
      return bytesEqual(currentHash, proof.root);
    } catch (error) {
      crosschainLogger.error('Merkle verification error', {
        operation: 'bridge:crypto:merkle:verify',
        proofLength: proof.proof.length,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Verify a Merkle proof using Keccak256 (Ethereum-compatible)
   * @param proof - Merkle proof structure
   */
  static verifyKeccak(proof: MerkleProof): boolean {
    return this.verify(proof, keccak_256);
  }

  /**
   * Build a Merkle tree from leaves
   * @param leaves - Array of leaf hashes
   * @param hashFn - Hash function to use
   */
  static buildTree(
    leaves: Uint8Array[],
    hashFn: (data: Uint8Array) => Uint8Array = sha256
  ): { root: Uint8Array; tree: Uint8Array[][] } {
    if (leaves.length === 0) {
      throw new Error('Cannot build tree from empty leaves');
    }

    const tree: Uint8Array[][] = [leaves.slice()];
    let currentLevel = leaves.slice();

    while (currentLevel.length > 1) {
      const nextLevel: Uint8Array[] = [];

      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
        nextLevel.push(hashFn(concatBytes(left, right)));
      }

      tree.push(nextLevel);
      currentLevel = nextLevel;
    }

    return {
      root: currentLevel[0],
      tree,
    };
  }

  /**
   * Generate a Merkle proof for a specific leaf
   * @param leafIndex - Index of the leaf in the original array
   * @param leaves - All leaves in the tree
   * @param hashFn - Hash function to use
   */
  static generateProof(
    leafIndex: number,
    leaves: Uint8Array[],
    hashFn: (data: Uint8Array) => Uint8Array = sha256
  ): MerkleProof {
    const { root, tree } = this.buildTree(leaves, hashFn);
    const proof: Uint8Array[] = [];
    const indices: boolean[] = [];

    let index = leafIndex;

    for (let level = 0; level < tree.length - 1; level++) {
      const isRightNode = index % 2 === 1;
      const siblingIndex = isRightNode ? index - 1 : index + 1;

      if (siblingIndex < tree[level].length) {
        proof.push(tree[level][siblingIndex]);
        indices.push(!isRightNode); // true if sibling is on the right
      }

      index = Math.floor(index / 2);
    }

    return {
      leaf: leaves[leafIndex],
      proof,
      indices,
      root,
    };
  }
}

// ============================================================================
// Bridge Message Verification
// ============================================================================

export interface BridgeMessage {
  sourceChain: string;
  destinationChain: string;
  nonce: bigint;
  sender: string;
  recipient: string;
  amount: bigint;
  asset: string;
  timestamp: number;
  payload?: Uint8Array;
}

/**
 * Cross-chain bridge message verification
 */
export class BridgeMessageVerifier {
  /**
   * Compute a deterministic hash of a bridge message
   * Compatible with the Rust implementation
   */
  static hashMessage(message: BridgeMessage): Uint8Array {
    const encoder = new TextEncoder();

    // Encode each field in a deterministic order
    const parts = [
      encoder.encode(message.sourceChain),
      encoder.encode(message.destinationChain),
      bigintToBytes(message.nonce, 8),
      encoder.encode(message.sender),
      encoder.encode(message.recipient),
      bigintToBytes(message.amount, 32),
      encoder.encode(message.asset),
      bigintToBytes(BigInt(message.timestamp), 8),
    ];

    if (message.payload) {
      parts.push(message.payload);
    }

    return sha256(concatBytes(...parts));
  }

  /**
   * Verify a signed bridge message
   * @param message - Bridge message
   * @param signature - ECDSA signature (65 bytes with recovery)
   * @param expectedSigner - Expected signer address
   */
  static verifySignedMessage(
    message: BridgeMessage,
    signature: Uint8Array | string,
    expectedSigner: string
  ): SignatureVerificationResult {
    const messageHash = this.hashMessage(message);
    return ECDSAVerifier.verifyAddress(messageHash, signature, expectedSigner);
  }

  /**
   * Verify a bridge message with multi-sig
   * @param message - Bridge message
   * @param signatures - Array of signatures
   * @param expectedSigners - Expected signer addresses
   * @param requiredSignatures - Minimum valid signatures required
   */
  static verifyMultiSig(
    message: BridgeMessage,
    signatures: (Uint8Array | string)[],
    expectedSigners: string[],
    requiredSignatures: number
  ): {
    isValid: boolean;
    validCount: number;
    validSigners: string[];
    error?: string;
  } {
    const messageHash = this.hashMessage(message);
    const validSigners: string[] = [];
    const signerSet = new Set(expectedSigners.map(s => s.toLowerCase()));

    for (const signature of signatures) {
      const result = ECDSAVerifier.verifyAndRecover(messageHash, signature);

      if (result.isValid && result.recoveredAddress) {
        const recoveredLower = result.recoveredAddress.toLowerCase();
        if (signerSet.has(recoveredLower) && !validSigners.includes(recoveredLower)) {
          validSigners.push(recoveredLower);
        }
      }
    }

    const isValid = validSigners.length >= requiredSignatures;

    return {
      isValid,
      validCount: validSigners.length,
      validSigners,
      error: !isValid
        ? `Insufficient signatures: ${validSigners.length}/${requiredSignatures}`
        : undefined,
    };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Normalize a hex string by removing '0x' prefix
 */
function normalizeHex(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

/**
 * Compare two byte arrays for equality
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Convert a BigInt to a fixed-size byte array (big-endian)
 */
function bigintToBytes(value: bigint, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let n = value;
  for (let i = size - 1; i >= 0; i--) {
    bytes[i] = Number(n & 0xFFn);
    n >>= 8n;
  }
  return bytes;
}

/**
 * Convert bytes to hex string
 */
export function toHex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

/**
 * Convert hex string to bytes
 */
export function fromHex(hex: string): Uint8Array {
  return hexToBytes(normalizeHex(hex));
}

// ============================================================================
// Exports
// ============================================================================

export {
  sha256,
  keccak_256,
  bytesToHex,
  hexToBytes,
};
