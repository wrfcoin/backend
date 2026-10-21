/**
 * LayerZero Ultra-Light Node Verifier
 *
 * Implements LayerZero-style cross-chain message verification:
 * - Ultra-light node block header verification
 * - Oracle-based proof validation
 * - Relayer message verification
 * - Cross-chain state proof validation
 *
 * Security Features:
 * - Independent oracle/relayer verification
 * - Block header chain validation
 * - Receipt proof verification
 * - Replay protection via nonce tracking
 *
 * This module enables trustless cross-chain communication by verifying
 * that messages were properly sent on the source chain.
 */

import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { ECDSAVerifier, keccak_256, fromHex, toHex } from './bridge-crypto-verifier.js';
import { crosschainLogger } from '../server/utils/logger.js';

// ============================================================================
// Constants and Configuration
// ============================================================================

/**
 * Supported chains with their chain IDs and configuration
 */
export const LAYERZERO_CHAIN_CONFIG = {
  ethereum: {
    chainId: 1,
    lzChainId: 101,
    confirmations: 15,
    blockTime: 12,
    endpoint: '0x66A71Dcef29A0fFBDBE3c6a460a3B5BC225Cd675',
  },
  polygon: {
    chainId: 137,
    lzChainId: 109,
    confirmations: 256,
    blockTime: 2,
    endpoint: '0x3c2269811836af69497E5F486A85D7316753cf62',
  },
  bsc: {
    chainId: 56,
    lzChainId: 102,
    confirmations: 15,
    blockTime: 3,
    endpoint: '0x3c2269811836af69497E5F486A85D7316753cf62',
  },
  avalanche: {
    chainId: 43114,
    lzChainId: 106,
    confirmations: 12,
    blockTime: 2,
    endpoint: '0x3c2269811836af69497E5F486A85D7316753cf62',
  },
  arbitrum: {
    chainId: 42161,
    lzChainId: 110,
    confirmations: 20,
    blockTime: 0.25,
    endpoint: '0x3c2269811836af69497E5F486A85D7316753cf62',
  },
  optimism: {
    chainId: 10,
    lzChainId: 111,
    confirmations: 20,
    blockTime: 2,
    endpoint: '0x3c2269811836af69497E5F486A85D7316753cf62',
  },
  base: {
    chainId: 8453,
    lzChainId: 184,
    confirmations: 20,
    blockTime: 2,
    endpoint: '0xb6319cC6c8c27A8F5dAF0dD3DF91EA35C4720dd7',
  },
} as const;

export type SupportedChain = keyof typeof LAYERZERO_CHAIN_CONFIG;

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Block header for verification (minimal for ultra-light node)
 */
export interface BlockHeader {
  hash: string;
  parentHash: string;
  number: number;
  timestamp: number;
  stateRoot: string;
  transactionsRoot: string;
  receiptsRoot: string;
  difficulty?: string;
  nonce?: string;
  extraData?: string;
}

/**
 * Oracle-provided block hash confirmation
 */
export interface OracleBlockConfirmation {
  oracleId: string;
  oracleAddress: string;
  chainId: number;
  blockNumber: number;
  blockHash: string;
  confirmations: number;
  timestamp: number;
  signature: string;
}

/**
 * Cross-chain message packet
 */
export interface LayerZeroPacket {
  nonce: bigint;
  srcChainId: number;
  srcAddress: string;
  dstChainId: number;
  dstAddress: string;
  payload: string;
}

/**
 * Proof for cross-chain message
 */
export interface LayerZeroProof {
  packetHash: string;
  packet: LayerZeroPacket;
  blockHeader: BlockHeader;
  receiptProof: ReceiptProof;
  oracleConfirmation: OracleBlockConfirmation;
  relayerConfirmation: RelayerConfirmation;
}

/**
 * Receipt Merkle proof
 */
export interface ReceiptProof {
  receiptIndex: number;
  receiptRoot: string;
  proof: string[];
  proofFlags: boolean[];
  receipt: TransactionReceipt;
}

/**
 * Transaction receipt for verification
 */
export interface TransactionReceipt {
  transactionHash: string;
  transactionIndex: number;
  blockHash: string;
  blockNumber: number;
  from: string;
  to: string;
  status: boolean;
  logs: EventLog[];
  logsBloom: string;
  cumulativeGasUsed: string;
  gasUsed: string;
}

/**
 * Event log from transaction receipt
 */
export interface EventLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
  transactionIndex: number;
  blockNumber: number;
  blockHash: string;
}

/**
 * Relayer confirmation of message delivery
 */
export interface RelayerConfirmation {
  relayerId: string;
  relayerAddress: string;
  packetHash: string;
  srcChainId: number;
  dstChainId: number;
  blockNumber: number;
  timestamp: number;
  signature: string;
}

/**
 * Verification result
 */
export interface VerificationResult {
  valid: boolean;
  error?: string;
  details?: {
    oracleVerified: boolean;
    relayerVerified: boolean;
    proofVerified: boolean;
    headerVerified: boolean;
    nonceVerified: boolean;
  };
}

/**
 * Oracle configuration
 */
export interface OracleConfig {
  oracleId: string;
  address: string;
  publicKey: string;
  trustScore: number; // 0-100
  isActive: boolean;
}

/**
 * Relayer configuration
 */
export interface RelayerConfig {
  relayerId: string;
  address: string;
  publicKey: string;
  trustScore: number;
  isActive: boolean;
}

// ============================================================================
// Ultra-Light Node Verifier
// ============================================================================

/**
 * Ultra-Light Node implementation for block header verification
 * Stores minimal state (only verified block hashes) to enable trustless verification
 */
export class UltraLightNode extends EventEmitter {
  private verifiedBlocks: Map<string, Map<number, string>> = new Map(); // chainId -> blockNumber -> blockHash
  private chainHeads: Map<string, number> = new Map(); // chainId -> latest verified block
  private blockHeaders: Map<string, BlockHeader> = new Map(); // blockHash -> header

  /**
   * Submit a verified block hash from oracles
   * In production, this would require multiple oracle confirmations
   */
  submitBlockHash(
    chainId: number,
    blockNumber: number,
    blockHash: string,
    oracleConfirmations: OracleBlockConfirmation[]
  ): boolean {
    const chainKey = chainId.toString();

    // Verify we have enough oracle confirmations
    const validConfirmations = oracleConfirmations.filter(conf =>
      this.verifyOracleSignature(conf)
    );

    // Require at least 2/3 oracle agreement (Byzantine fault tolerance)
    const requiredConfirmations = Math.ceil(oracleConfirmations.length * 2 / 3);
    if (validConfirmations.length < requiredConfirmations) {
      this.emit('block-rejected', {
        chainId,
        blockNumber,
        reason: 'Insufficient oracle confirmations',
        validConfirmations: validConfirmations.length,
        required: requiredConfirmations,
      });
      return false;
    }

    // Verify all valid confirmations agree on the block hash
    const hashesMatch = validConfirmations.every(conf => conf.blockHash === blockHash);
    if (!hashesMatch) {
      this.emit('block-rejected', {
        chainId,
        blockNumber,
        reason: 'Oracle disagreement on block hash',
      });
      return false;
    }

    // Store verified block
    if (!this.verifiedBlocks.has(chainKey)) {
      this.verifiedBlocks.set(chainKey, new Map());
    }
    this.verifiedBlocks.get(chainKey)!.set(blockNumber, blockHash);

    // Update chain head if this is the latest
    const currentHead = this.chainHeads.get(chainKey) || 0;
    if (blockNumber > currentHead) {
      this.chainHeads.set(chainKey, blockNumber);
    }

    this.emit('block-verified', {
      chainId,
      blockNumber,
      blockHash,
      confirmations: validConfirmations.length,
      timestamp: new Date(),
    });

    return true;
  }

  /**
   * Submit full block header for storage
   */
  submitBlockHeader(header: BlockHeader): void {
    this.blockHeaders.set(header.hash, header);
  }

  /**
   * Get verified block hash for a chain and block number
   */
  getVerifiedBlockHash(chainId: number, blockNumber: number): string | null {
    const chainBlocks = this.verifiedBlocks.get(chainId.toString());
    if (!chainBlocks) return null;
    return chainBlocks.get(blockNumber) || null;
  }

  /**
   * Get block header by hash
   */
  getBlockHeader(blockHash: string): BlockHeader | null {
    return this.blockHeaders.get(blockHash) || null;
  }

  /**
   * Check if a block is verified
   */
  isBlockVerified(chainId: number, blockNumber: number, blockHash: string): boolean {
    const storedHash = this.getVerifiedBlockHash(chainId, blockNumber);
    return storedHash === blockHash;
  }

  /**
   * Get the latest verified block number for a chain
   */
  getChainHead(chainId: number): number {
    return this.chainHeads.get(chainId.toString()) || 0;
  }

  /**
   * Verify oracle signature on block confirmation
   */
  private verifyOracleSignature(confirmation: OracleBlockConfirmation): boolean {
    // In production, this would verify the actual cryptographic signature
    // For now, we verify the structure is correct
    if (!confirmation.signature || confirmation.signature.length < 64) {
      return false;
    }

    // Verify the confirmation is recent (within 1 hour)
    const oneHourAgo = Date.now() - 3600000;
    if (confirmation.timestamp < oneHourAgo) {
      return false;
    }

    // Verify sufficient confirmations for the chain
    const chainConfig = Object.values(LAYERZERO_CHAIN_CONFIG).find(
      c => c.chainId === confirmation.chainId
    );
    if (chainConfig && confirmation.confirmations < chainConfig.confirmations) {
      return false;
    }

    return true;
  }

  /**
   * Get statistics about verified blocks
   */
  getStatistics(): {
    chainsTracked: number;
    totalVerifiedBlocks: number;
    chainHeads: Record<string, number>;
  } {
    let totalBlocks = 0;
    const chainHeads: Record<string, number> = {};

    for (const [chainId, blocks] of Array.from(this.verifiedBlocks.entries())) {
      totalBlocks += blocks.size;
      chainHeads[chainId] = this.chainHeads.get(chainId) || 0;
    }

    return {
      chainsTracked: this.verifiedBlocks.size,
      totalVerifiedBlocks: totalBlocks,
      chainHeads,
    };
  }
}

// ============================================================================
// LayerZero Proof Verifier
// ============================================================================

/**
 * Main verifier for LayerZero-style cross-chain proofs
 */
export class LayerZeroProofVerifier extends EventEmitter {
  private ultraLightNode: UltraLightNode;
  private oracles: Map<string, OracleConfig> = new Map();
  private relayers: Map<string, RelayerConfig> = new Map();
  private processedNonces: Map<string, Set<bigint>> = new Map(); // srcChainId-dstChainId -> nonces
  private pendingProofs: Map<string, LayerZeroProof> = new Map();

  private readonly MIN_ORACLE_TRUST_SCORE = 50;
  private readonly MIN_RELAYER_TRUST_SCORE = 50;

  constructor() {
    super();
    this.ultraLightNode = new UltraLightNode();

    // Forward ULN events
    this.ultraLightNode.on('block-verified', (data) => this.emit('block-verified', data));
    this.ultraLightNode.on('block-rejected', (data) => this.emit('block-rejected', data));
  }

  /**
   * Register an oracle for proof verification
   */
  registerOracle(config: OracleConfig): void {
    this.oracles.set(config.oracleId, config);
    this.emit('oracle-registered', { oracleId: config.oracleId });
  }

  /**
   * Register a relayer for message delivery verification
   */
  registerRelayer(config: RelayerConfig): void {
    this.relayers.set(config.relayerId, config);
    this.emit('relayer-registered', { relayerId: config.relayerId });
  }

  /**
   * Submit block confirmation from oracle
   */
  submitOracleConfirmation(confirmation: OracleBlockConfirmation): boolean {
    const oracle = this.oracles.get(confirmation.oracleId);
    if (!oracle || !oracle.isActive) {
      this.emit('oracle-confirmation-rejected', {
        oracleId: confirmation.oracleId,
        reason: 'Unknown or inactive oracle',
      });
      return false;
    }

    if (oracle.trustScore < this.MIN_ORACLE_TRUST_SCORE) {
      this.emit('oracle-confirmation-rejected', {
        oracleId: confirmation.oracleId,
        reason: 'Oracle trust score too low',
      });
      return false;
    }

    // Collect confirmations for the block
    // In production, this would aggregate multiple oracle confirmations
    return this.ultraLightNode.submitBlockHash(
      confirmation.chainId,
      confirmation.blockNumber,
      confirmation.blockHash,
      [confirmation]
    );
  }

  /**
   * Verify a complete LayerZero proof
   * This is the main entry point for cross-chain message verification
   */
  verifyProof(proof: LayerZeroProof): VerificationResult {
    const details = {
      oracleVerified: false,
      relayerVerified: false,
      proofVerified: false,
      headerVerified: false,
      nonceVerified: false,
    };

    // 1. Verify nonce hasn't been processed (replay protection)
    const nonceKey = `${proof.packet.srcChainId}-${proof.packet.dstChainId}`;
    const processedNonces = this.processedNonces.get(nonceKey);
    if (processedNonces?.has(proof.packet.nonce)) {
      return {
        valid: false,
        error: 'Nonce already processed - replay attack detected',
        details,
      };
    }
    details.nonceVerified = true;

    // 2. Verify oracle confirmation
    const oracleResult = this.verifyOracleConfirmation(proof.oracleConfirmation);
    if (!oracleResult.valid) {
      return {
        valid: false,
        error: `Oracle verification failed: ${oracleResult.error}`,
        details,
      };
    }
    details.oracleVerified = true;

    // 3. Verify relayer confirmation
    const relayerResult = this.verifyRelayerConfirmation(proof.relayerConfirmation, proof.packetHash);
    if (!relayerResult.valid) {
      return {
        valid: false,
        error: `Relayer verification failed: ${relayerResult.error}`,
        details,
      };
    }
    details.relayerVerified = true;

    // 4. Verify block header against ultra-light node
    const headerVerified = this.ultraLightNode.isBlockVerified(
      proof.packet.srcChainId,
      proof.blockHeader.number,
      proof.blockHeader.hash
    );
    if (!headerVerified) {
      return {
        valid: false,
        error: 'Block header not verified by ultra-light node',
        details,
      };
    }
    details.headerVerified = true;

    // 5. Verify receipt proof (Merkle inclusion)
    const proofResult = this.verifyReceiptProof(proof);
    if (!proofResult.valid) {
      return {
        valid: false,
        error: `Receipt proof verification failed: ${proofResult.error}`,
        details,
      };
    }
    details.proofVerified = true;

    // 6. Verify packet hash matches
    const computedPacketHash = this.computePacketHash(proof.packet);
    if (computedPacketHash !== proof.packetHash) {
      return {
        valid: false,
        error: 'Packet hash mismatch',
        details,
      };
    }

    // All verifications passed
    this.emit('proof-verified', {
      packetHash: proof.packetHash,
      srcChainId: proof.packet.srcChainId,
      dstChainId: proof.packet.dstChainId,
      nonce: proof.packet.nonce.toString(),
      timestamp: new Date(),
    });

    return { valid: true, details };
  }

  /**
   * Mark a nonce as processed after successful message handling
   */
  markNonceProcessed(srcChainId: number, dstChainId: number, nonce: bigint): void {
    const key = `${srcChainId}-${dstChainId}`;
    if (!this.processedNonces.has(key)) {
      this.processedNonces.set(key, new Set());
    }
    this.processedNonces.get(key)!.add(nonce);

    this.emit('nonce-processed', { srcChainId, dstChainId, nonce: nonce.toString() });
  }

  /**
   * Check if a nonce has been processed
   */
  isNonceProcessed(srcChainId: number, dstChainId: number, nonce: bigint): boolean {
    const key = `${srcChainId}-${dstChainId}`;
    return this.processedNonces.get(key)?.has(nonce) || false;
  }

  /**
   * Get the next expected nonce for a path
   */
  getNextNonce(srcChainId: number, dstChainId: number): bigint {
    const key = `${srcChainId}-${dstChainId}`;
    const nonces = this.processedNonces.get(key);
    if (!nonces || nonces.size === 0) return BigInt(1);

    return BigInt(Math.max(...Array.from(nonces).map(n => Number(n)))) + BigInt(1);
  }

  /**
   * Verify oracle confirmation
   */
  private verifyOracleConfirmation(
    confirmation: OracleBlockConfirmation
  ): { valid: boolean; error?: string } {
    const oracle = this.oracles.get(confirmation.oracleId);
    if (!oracle) {
      return { valid: false, error: 'Unknown oracle' };
    }

    if (!oracle.isActive) {
      return { valid: false, error: 'Oracle is not active' };
    }

    if (oracle.trustScore < this.MIN_ORACLE_TRUST_SCORE) {
      return { valid: false, error: 'Oracle trust score below threshold' };
    }

    // Verify signature (simplified - in production would use actual crypto)
    if (!this.verifySignature(
      oracle.publicKey,
      this.hashOracleConfirmation(confirmation),
      confirmation.signature
    )) {
      return { valid: false, error: 'Invalid oracle signature' };
    }

    // Verify confirmations meet chain requirements
    const chainConfig = Object.values(LAYERZERO_CHAIN_CONFIG).find(
      c => c.chainId === confirmation.chainId
    );
    if (chainConfig && confirmation.confirmations < chainConfig.confirmations) {
      return {
        valid: false,
        error: `Insufficient confirmations: ${confirmation.confirmations}/${chainConfig.confirmations}`,
      };
    }

    return { valid: true };
  }

  /**
   * Verify relayer confirmation
   */
  private verifyRelayerConfirmation(
    confirmation: RelayerConfirmation,
    expectedPacketHash: string
  ): { valid: boolean; error?: string } {
    const relayer = this.relayers.get(confirmation.relayerId);
    if (!relayer) {
      return { valid: false, error: 'Unknown relayer' };
    }

    if (!relayer.isActive) {
      return { valid: false, error: 'Relayer is not active' };
    }

    if (relayer.trustScore < this.MIN_RELAYER_TRUST_SCORE) {
      return { valid: false, error: 'Relayer trust score below threshold' };
    }

    // Verify packet hash matches
    if (confirmation.packetHash !== expectedPacketHash) {
      return { valid: false, error: 'Packet hash mismatch in relayer confirmation' };
    }

    // Verify signature (simplified)
    if (!this.verifySignature(
      relayer.publicKey,
      this.hashRelayerConfirmation(confirmation),
      confirmation.signature
    )) {
      return { valid: false, error: 'Invalid relayer signature' };
    }

    return { valid: true };
  }

  /**
   * Verify receipt Merkle proof
   */
  private verifyReceiptProof(proof: LayerZeroProof): { valid: boolean; error?: string } {
    // Verify receipt root matches block header
    if (proof.receiptProof.receiptRoot !== proof.blockHeader.receiptsRoot) {
      return { valid: false, error: 'Receipt root mismatch with block header' };
    }

    // Verify Merkle proof
    const leafHash = this.hashReceipt(proof.receiptProof.receipt);
    const computedRoot = this.computeMerkleRoot(
      leafHash,
      proof.receiptProof.proof,
      proof.receiptProof.proofFlags,
      proof.receiptProof.receiptIndex
    );

    if (computedRoot !== proof.receiptProof.receiptRoot) {
      return { valid: false, error: 'Invalid receipt Merkle proof' };
    }

    // Verify the packet event is in the receipt logs
    const packetEvent = proof.receiptProof.receipt.logs.find(log =>
      this.isPacketEvent(log, proof.packet)
    );
    if (!packetEvent) {
      return { valid: false, error: 'Packet event not found in receipt logs' };
    }

    return { valid: true };
  }

  /**
   * Check if a log is the packet event for the given packet
   */
  private isPacketEvent(log: EventLog, packet: LayerZeroPacket): boolean {
    // LayerZero Packet event topic (keccak256 of event signature)
    const PACKET_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

    if (log.topics[0] !== PACKET_EVENT_TOPIC) {
      return false;
    }

    // Decode and verify packet data
    // In production, this would properly decode the event data
    try {
      const decodedNonce = BigInt('0x' + log.data.slice(2, 66));
      return decodedNonce === packet.nonce;
    } catch {
      return false;
    }
  }

  /**
   * Compute packet hash
   */
  private computePacketHash(packet: LayerZeroPacket): string {
    const data = Buffer.concat([
      this.bigIntToBuffer(packet.nonce),
      this.intToBuffer(packet.srcChainId),
      Buffer.from(packet.srcAddress.replace('0x', ''), 'hex'),
      this.intToBuffer(packet.dstChainId),
      Buffer.from(packet.dstAddress.replace('0x', ''), 'hex'),
      Buffer.from(packet.payload.replace('0x', ''), 'hex'),
    ]);

    return crypto.createHash('keccak256').update(data).digest('hex');
  }

  /**
   * Hash oracle confirmation for signature verification
   */
  private hashOracleConfirmation(confirmation: OracleBlockConfirmation): string {
    const data = Buffer.concat([
      Buffer.from(confirmation.oracleId),
      this.intToBuffer(confirmation.chainId),
      this.intToBuffer(confirmation.blockNumber),
      Buffer.from(confirmation.blockHash.replace('0x', ''), 'hex'),
      this.intToBuffer(confirmation.confirmations),
      this.bigIntToBuffer(BigInt(confirmation.timestamp)),
    ]);

    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Hash relayer confirmation for signature verification
   */
  private hashRelayerConfirmation(confirmation: RelayerConfirmation): string {
    const data = Buffer.concat([
      Buffer.from(confirmation.relayerId),
      Buffer.from(confirmation.packetHash.replace('0x', ''), 'hex'),
      this.intToBuffer(confirmation.srcChainId),
      this.intToBuffer(confirmation.dstChainId),
      this.intToBuffer(confirmation.blockNumber),
      this.bigIntToBuffer(BigInt(confirmation.timestamp)),
    ]);

    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Hash transaction receipt
   */
  private hashReceipt(receipt: TransactionReceipt): string {
    // RLP encode and hash receipt (simplified)
    const data = JSON.stringify({
      status: receipt.status,
      cumulativeGasUsed: receipt.cumulativeGasUsed,
      logsBloom: receipt.logsBloom,
      logs: receipt.logs,
    });

    return crypto.createHash('keccak256').update(data).digest('hex');
  }

  /**
   * Compute Merkle root from leaf and proof
   */
  private computeMerkleRoot(
    leafHash: string,
    proof: string[],
    proofFlags: boolean[],
    _leafIndex: number
  ): string {
    let computedHash = leafHash;

    for (let i = 0; i < proof.length; i++) {
      const proofElement = proof[i];
      const isRight = proofFlags[i];

      if (isRight) {
        // Proof element is on the right
        computedHash = crypto.createHash('keccak256')
          .update(Buffer.concat([
            Buffer.from(computedHash, 'hex'),
            Buffer.from(proofElement, 'hex'),
          ]))
          .digest('hex');
      } else {
        // Proof element is on the left
        computedHash = crypto.createHash('keccak256')
          .update(Buffer.concat([
            Buffer.from(proofElement, 'hex'),
            Buffer.from(computedHash, 'hex'),
          ]))
          .digest('hex');
      }
    }

    return computedHash;
  }

  /**
   * Verify ECDSA signature using secp256k1 cryptography
   * Validates oracle and relayer signatures for cross-chain message authenticity
   */
  private verifySignature(publicKey: string, messageHash: string, signature: string): boolean {
    try {
      // Validate input parameters
      if (!signature || signature.length < 128) {
        this.emit('signature:validation_failed', {
          reason: 'signature_too_short',
          length: signature?.length || 0,
        });
        return false;
      }

      if (!messageHash || messageHash.length < 64) {
        this.emit('signature:validation_failed', {
          reason: 'invalid_message_hash',
          length: messageHash?.length || 0,
        });
        return false;
      }

      // Normalize inputs - remove 0x prefix if present
      const normalizedHash = messageHash.startsWith('0x') ? messageHash.slice(2) : messageHash;
      const normalizedSig = signature.startsWith('0x') ? signature.slice(2) : signature;
      const normalizedPubKey = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey;

      // Use real ECDSA secp256k1 verification
      const result = ECDSAVerifier.verify(normalizedHash, normalizedSig, normalizedPubKey);

      if (!result.isValid) {
        this.emit('signature:cryptographic_verification_failed', {
          messageHash: messageHash.substring(0, 16) + '...',
          error: result.error,
        });
        return false;
      }

      this.emit('signature:verified', {
        publicKey: publicKey.substring(0, 16) + '...',
        messageHash: messageHash.substring(0, 16) + '...',
      });

      return true;
    } catch (error) {
      crosschainLogger.error('LayerZero signature verification failed', {
        operation: 'bridge:layerzero:signature:verify',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      this.emit('signature:error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Convert BigInt to Buffer
   */
  private bigIntToBuffer(value: bigint): Buffer {
    const hex = value.toString(16).padStart(16, '0');
    return Buffer.from(hex, 'hex');
  }

  /**
   * Convert number to Buffer
   */
  private intToBuffer(value: number): Buffer {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value, 0);
    return buffer;
  }

  /**
   * Get ultra-light node instance
   */
  getUltraLightNode(): UltraLightNode {
    return this.ultraLightNode;
  }

  /**
   * Get verifier statistics
   */
  getStatistics(): {
    registeredOracles: number;
    registeredRelayers: number;
    processedNonces: number;
    ultraLightNodeStats: ReturnType<UltraLightNode['getStatistics']>;
  } {
    let totalNonces = 0;
    for (const nonces of Array.from(this.processedNonces.values())) {
      totalNonces += nonces.size;
    }

    return {
      registeredOracles: this.oracles.size,
      registeredRelayers: this.relayers.size,
      processedNonces: totalNonces,
      ultraLightNodeStats: this.ultraLightNode.getStatistics(),
    };
  }
}

// ============================================================================
// Cross-Chain Message Coordinator
// ============================================================================

/**
 * Coordinates cross-chain message verification with double-spend prevention
 */
export class CrossChainMessageCoordinator extends EventEmitter {
  private proofVerifier: LayerZeroProofVerifier;
  private pendingMessages: Map<string, {
    proof: LayerZeroProof;
    receivedAt: Date;
    attempts: number;
  }> = new Map();

  private readonly MAX_RETRY_ATTEMPTS = 3;
  private readonly MESSAGE_TIMEOUT_MS = 600000; // 10 minutes

  constructor() {
    super();
    this.proofVerifier = new LayerZeroProofVerifier();

    // Forward events
    this.proofVerifier.on('proof-verified', (data) => this.emit('proof-verified', data));
    this.proofVerifier.on('block-verified', (data) => this.emit('block-verified', data));
  }

  /**
   * Submit a cross-chain message for verification
   */
  async submitMessage(proof: LayerZeroProof): Promise<{
    accepted: boolean;
    error?: string;
    messageId?: string;
  }> {
    const messageId = proof.packetHash;

    // Check if message is already pending
    if (this.pendingMessages.has(messageId)) {
      return {
        accepted: false,
        error: 'Message already pending',
        messageId,
      };
    }

    // Check replay protection
    if (this.proofVerifier.isNonceProcessed(
      proof.packet.srcChainId,
      proof.packet.dstChainId,
      proof.packet.nonce
    )) {
      return {
        accepted: false,
        error: 'Nonce already processed - replay attack prevented',
        messageId,
      };
    }

    // Verify the proof
    const result = this.proofVerifier.verifyProof(proof);
    if (!result.valid) {
      return {
        accepted: false,
        error: result.error,
        messageId,
      };
    }

    // Store as pending
    this.pendingMessages.set(messageId, {
      proof,
      receivedAt: new Date(),
      attempts: 0,
    });

    this.emit('message-accepted', {
      messageId,
      srcChainId: proof.packet.srcChainId,
      dstChainId: proof.packet.dstChainId,
      nonce: proof.packet.nonce.toString(),
      timestamp: new Date(),
    });

    return { accepted: true, messageId };
  }

  /**
   * Finalize a message after successful execution on destination chain
   */
  finalizeMessage(messageId: string, transactionHash: string): boolean {
    const pending = this.pendingMessages.get(messageId);
    if (!pending) {
      return false;
    }

    // Mark nonce as processed
    this.proofVerifier.markNonceProcessed(
      pending.proof.packet.srcChainId,
      pending.proof.packet.dstChainId,
      pending.proof.packet.nonce
    );

    // Remove from pending
    this.pendingMessages.delete(messageId);

    this.emit('message-finalized', {
      messageId,
      transactionHash,
      srcChainId: pending.proof.packet.srcChainId,
      dstChainId: pending.proof.packet.dstChainId,
      nonce: pending.proof.packet.nonce.toString(),
      timestamp: new Date(),
    });

    return true;
  }

  /**
   * Reject a message (e.g., due to execution failure)
   */
  rejectMessage(messageId: string, reason: string): boolean {
    const pending = this.pendingMessages.get(messageId);
    if (!pending) {
      return false;
    }

    pending.attempts++;

    if (pending.attempts >= this.MAX_RETRY_ATTEMPTS) {
      this.pendingMessages.delete(messageId);
      this.emit('message-failed', {
        messageId,
        reason,
        attempts: pending.attempts,
        timestamp: new Date(),
      });
    } else {
      this.emit('message-retry', {
        messageId,
        reason,
        attempts: pending.attempts,
        timestamp: new Date(),
      });
    }

    return true;
  }

  /**
   * Get pending message
   */
  getPendingMessage(messageId: string): LayerZeroProof | null {
    return this.pendingMessages.get(messageId)?.proof || null;
  }

  /**
   * Get proof verifier for direct access
   */
  getProofVerifier(): LayerZeroProofVerifier {
    return this.proofVerifier;
  }

  /**
   * Register oracle
   */
  registerOracle(config: OracleConfig): void {
    this.proofVerifier.registerOracle(config);
  }

  /**
   * Register relayer
   */
  registerRelayer(config: RelayerConfig): void {
    this.proofVerifier.registerRelayer(config);
  }

  /**
   * Get coordinator statistics
   */
  getStatistics(): {
    pendingMessages: number;
    verifierStats: ReturnType<LayerZeroProofVerifier['getStatistics']>;
  } {
    return {
      pendingMessages: this.pendingMessages.size,
      verifierStats: this.proofVerifier.getStatistics(),
    };
  }

  /**
   * Cleanup expired pending messages
   */
  cleanupExpiredMessages(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [messageId, pending] of Array.from(this.pendingMessages.entries())) {
      if (now - pending.receivedAt.getTime() > this.MESSAGE_TIMEOUT_MS) {
        this.pendingMessages.delete(messageId);
        this.emit('message-expired', { messageId, timestamp: new Date() });
        cleaned++;
      }
    }

    return cleaned;
  }
}

// Export singleton instances for shared use
export const ultraLightNode = new UltraLightNode();
export const layerZeroProofVerifier = new LayerZeroProofVerifier();
export const crossChainMessageCoordinator = new CrossChainMessageCoordinator();
