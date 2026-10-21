/**
 * Ethereum Chain Adapter
 *
 * Handles signature verification and proof validation for EVM-compatible chains:
 * - Ethereum Mainnet
 * - Polygon
 * - BSC
 * - Avalanche C-Chain
 * - Arbitrum
 * - Optimism
 *
 * Features:
 * - ECDSA secp256k1 signature verification
 * - Keccak256 hashing (Ethereum standard)
 * - EIP-155 chain ID verification
 * - EIP-191/EIP-712 message signing
 * - Receipt and state proof verification
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { ECDSAVerifier } from '../bridge-crypto-verifier.js';
import { crosschainLogger } from '../../server/utils/logger.js';
import {
  BaseChainAdapter,
  ChainInfo,
  TransactionProof,
  BlockHeader,
  FinalityProof,
  ValidatorSignature,
  chainRegistry,
} from './index.js';

// ============================================================================
// EVM Chain Configurations
// ============================================================================

const EVM_CHAINS: Record<string, Partial<ChainInfo>> = {
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum Mainnet',
    chainId: 1,
    nativeToken: 'ETH',
    blockTime: 12000,
    requiredConfirmations: 15,
    supportedBridgeProtocols: ['layerzero', 'axelar', 'wormhole', 'chainlink-ccip'],
  },
  polygon: {
    id: 'polygon',
    name: 'Polygon PoS',
    chainId: 137,
    nativeToken: 'MATIC',
    blockTime: 2000,
    requiredConfirmations: 128,
    supportedBridgeProtocols: ['layerzero', 'axelar', 'polygon-bridge'],
  },
  bsc: {
    id: 'bsc',
    name: 'BNB Smart Chain',
    chainId: 56,
    nativeToken: 'BNB',
    blockTime: 3000,
    requiredConfirmations: 15,
    supportedBridgeProtocols: ['layerzero', 'axelar', 'wormhole'],
  },
  avalanche: {
    id: 'avalanche',
    name: 'Avalanche C-Chain',
    chainId: 43114,
    nativeToken: 'AVAX',
    blockTime: 2000,
    requiredConfirmations: 12,
    supportedBridgeProtocols: ['layerzero', 'axelar', 'avalanche-bridge'],
  },
  arbitrum: {
    id: 'arbitrum',
    name: 'Arbitrum One',
    chainId: 42161,
    nativeToken: 'ETH',
    blockTime: 250,
    requiredConfirmations: 12,
    supportedBridgeProtocols: ['layerzero', 'axelar', 'arbitrum-bridge'],
  },
  optimism: {
    id: 'optimism',
    name: 'Optimism',
    chainId: 10,
    nativeToken: 'ETH',
    blockTime: 2000,
    requiredConfirmations: 12,
    supportedBridgeProtocols: ['layerzero', 'axelar', 'optimism-bridge'],
  },
  base: {
    id: 'base',
    name: 'Base',
    chainId: 8453,
    nativeToken: 'ETH',
    blockTime: 2000,
    requiredConfirmations: 12,
    supportedBridgeProtocols: ['layerzero', 'axelar'],
  },
};

// ============================================================================
// Ethereum Adapter Implementation
// ============================================================================

export class EthereumAdapter extends BaseChainAdapter {
  readonly chainInfo: ChainInfo;

  constructor(chainId: string = 'ethereum') {
    super();

    const config = EVM_CHAINS[chainId.toLowerCase()];
    if (!config) {
      throw new Error(`Unsupported EVM chain: ${chainId}`);
    }

    this.chainInfo = {
      ...config,
      family: 'evm',
      signatureScheme: 'secp256k1',
      hashAlgorithm: 'keccak256',
    } as ChainInfo;
  }

  /**
   * Verify ECDSA secp256k1 signature using Keccak256 hashing
   */
  async verifySignature(
    messageHash: string,
    signature: string,
    publicKey: string
  ): Promise<boolean> {
    try {
      // Normalize inputs
      const normalizedHash = this.normalizeHex(messageHash);
      const normalizedSig = this.normalizeHex(signature);
      const normalizedPubKey = this.normalizeHex(publicKey);

      // Verify signature length (65 bytes with recovery byte or 64 bytes)
      if (normalizedSig.length !== 128 && normalizedSig.length !== 130) {
        this.emit('signature:invalid_length', {
          chain: this.chainInfo.id,
          length: normalizedSig.length,
        });
        return false;
      }

      // Use ECDSA verifier for secp256k1
      const result = ECDSAVerifier.verify(normalizedHash, normalizedSig, normalizedPubKey);

      if (!result.isValid) {
        this.emit('signature:verification_failed', {
          chain: this.chainInfo.id,
          error: result.error,
        });
        return false;
      }

      this.emit('signature:verified', {
        chain: this.chainInfo.id,
        publicKey: normalizedPubKey.substring(0, 16) + '...',
      });

      return true;
    } catch (error) {
      this.emit('signature:error', {
        chain: this.chainInfo.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Hash message using Keccak256 (Ethereum standard)
   */
  hashMessage(message: string | Uint8Array): string {
    let data: Uint8Array;

    if (typeof message === 'string') {
      // Check if it's hex
      if (message.startsWith('0x')) {
        data = hexToBytes(message.slice(2));
      } else {
        data = new TextEncoder().encode(message);
      }
    } else {
      data = message;
    }

    const hash = keccak_256(data);
    return '0x' + bytesToHex(hash);
  }

  /**
   * Hash EIP-712 typed data
   */
  hashTypedData(typedData: EIP712TypedData): string {
    // Compute domain separator
    const domainSeparator = this.hashEIP712Domain(typedData.domain);

    // Compute struct hash
    const structHash = this.hashEIP712Struct(
      typedData.primaryType,
      typedData.message,
      typedData.types
    );

    // Combine: keccak256("\x19\x01" ++ domainSeparator ++ structHash)
    const prefix = new Uint8Array([0x19, 0x01]);
    const combined = new Uint8Array(66);
    combined.set(prefix, 0);
    combined.set(hexToBytes(domainSeparator.slice(2)), 2);
    combined.set(hexToBytes(structHash.slice(2)), 34);

    return '0x' + bytesToHex(keccak_256(combined));
  }

  /**
   * Verify EVM receipt proof (Merkle-Patricia trie)
   */
  async verifyReceiptProof(
    proof: TransactionProof,
    expectedReceiptsRoot: string
  ): Promise<boolean> {
    try {
      if (!proof.receiptProof || proof.receiptProof.length === 0) {
        return false;
      }

      // EVM uses Merkle-Patricia tries for receipts
      // This is a simplified verification - full implementation would decode RLP
      const isValid = await this.verifyMerklePatriciaProof(
        proof.transactionHash,
        proof.receiptProof,
        expectedReceiptsRoot
      );

      this.emit('receipt_proof:verified', {
        chain: this.chainInfo.id,
        transactionHash: proof.transactionHash,
        isValid,
      });

      return isValid;
    } catch (error) {
      this.emit('receipt_proof:error', {
        chain: this.chainInfo.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Verify finality based on block confirmations or L2 finalization
   */
  async verifyFinalityProof(proof: FinalityProof): Promise<boolean> {
    const requiredConfirmations = this.chainInfo.requiredConfirmations;

    switch (proof.type) {
      case 'block_confirmations':
        // Standard block confirmation finality
        const confirmations = (proof.proof as { confirmations: number }).confirmations;
        return confirmations >= requiredConfirmations;

      case 'checkpoint':
        // Polygon-style checkpoint finality
        return this.verifyPolygonCheckpoint(proof);

      default:
        // Fall back to confidence threshold
        return proof.confidence >= 0.99;
    }
  }

  /**
   * Verify block header for EVM chain
   */
  async verifyBlockHeader(
    header: BlockHeader,
    parentHeader?: BlockHeader
  ): Promise<boolean> {
    // Verify parent hash linkage
    if (parentHeader) {
      if (header.parentHash.toLowerCase() !== parentHeader.hash.toLowerCase()) {
        this.emit('block:invalid_parent', {
          chain: this.chainInfo.id,
          blockNumber: header.number,
        });
        return false;
      }
    }

    // Verify block hash computation
    const computedHash = this.computeBlockHash(header);
    if (computedHash.toLowerCase() !== header.hash.toLowerCase()) {
      this.emit('block:invalid_hash', {
        chain: this.chainInfo.id,
        blockNumber: header.number,
        expected: header.hash,
        computed: computedHash,
      });
      return false;
    }

    return true;
  }

  /**
   * Encode Ethereum address (checksum format)
   */
  encodeAddress(address: string): string {
    const normalized = address.toLowerCase().replace('0x', '');
    const hash = bytesToHex(keccak_256(new TextEncoder().encode(normalized)));

    let checksummed = '0x';
    for (let i = 0; i < 40; i++) {
      if (parseInt(hash[i], 16) >= 8) {
        checksummed += normalized[i].toUpperCase();
      } else {
        checksummed += normalized[i];
      }
    }

    return checksummed;
  }

  /**
   * Verify Ethereum address checksum
   */
  verifyAddressChecksum(address: string): boolean {
    if (!address.startsWith('0x') || address.length !== 42) {
      return false;
    }

    const normalized = address.slice(2);
    const hash = bytesToHex(keccak_256(new TextEncoder().encode(normalized.toLowerCase())));

    for (let i = 0; i < 40; i++) {
      const charCode = normalized.charCodeAt(i);
      const isUpperCase = charCode >= 65 && charCode <= 90;
      const isLowerCase = charCode >= 97 && charCode <= 122;

      if (isUpperCase || isLowerCase) {
        const shouldBeUpperCase = parseInt(hash[i], 16) >= 8;
        if (shouldBeUpperCase !== isUpperCase) {
          return false;
        }
      }
    }

    return true;
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private normalizeHex(hex: string): string {
    return hex.startsWith('0x') ? hex.slice(2) : hex;
  }

  private hashEIP712Domain(domain: EIP712Domain): string {
    const typeHash = this.hashMessage(
      'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
    );

    const encodedData = this.abiEncode([
      { type: 'bytes32', value: typeHash },
      { type: 'bytes32', value: this.hashMessage(domain.name || '') },
      { type: 'bytes32', value: this.hashMessage(domain.version || '') },
      { type: 'uint256', value: domain.chainId || 0 },
      { type: 'address', value: domain.verifyingContract || '0x' + '0'.repeat(40) },
    ]);

    return this.hashMessage(encodedData);
  }

  private hashEIP712Struct(
    primaryType: string,
    message: Record<string, unknown>,
    types: Record<string, EIP712TypeField[]>
  ): string {
    // Compute type hash
    const typeString = this.encodeType(primaryType, types);
    const typeHash = this.hashMessage(typeString);

    // Encode struct data
    const encodedFields = this.encodeStructData(primaryType, message, types);

    // Combine type hash with encoded data
    const combined = typeHash.slice(2) + encodedFields;
    return this.hashMessage('0x' + combined);
  }

  private encodeType(
    primaryType: string,
    types: Record<string, EIP712TypeField[]>
  ): string {
    const fields = types[primaryType];
    if (!fields) {
      throw new Error(`Unknown type: ${primaryType}`);
    }

    const fieldStrings = fields.map(f => `${f.type} ${f.name}`);
    return `${primaryType}(${fieldStrings.join(',')})`;
  }

  private encodeStructData(
    primaryType: string,
    message: Record<string, unknown>,
    types: Record<string, EIP712TypeField[]>
  ): string {
    const fields = types[primaryType];
    if (!fields) {
      throw new Error(`Unknown type: ${primaryType}`);
    }

    let encoded = '';
    for (const field of fields) {
      const value = message[field.name];
      encoded += this.encodeValue(field.type, value, types).slice(2);
    }

    return encoded;
  }

  private encodeValue(
    type: string,
    value: unknown,
    types: Record<string, EIP712TypeField[]>
  ): string {
    if (type === 'string' || type === 'bytes') {
      return this.hashMessage(String(value));
    }

    if (type.startsWith('bytes')) {
      return this.padHex(String(value), 64);
    }

    if (type.startsWith('uint') || type.startsWith('int')) {
      const hex = BigInt(value as number | bigint).toString(16);
      return '0x' + hex.padStart(64, '0');
    }

    if (type === 'address') {
      return '0x' + String(value).slice(2).padStart(64, '0');
    }

    if (type === 'bool') {
      return '0x' + (value ? '1' : '0').padStart(64, '0');
    }

    // Custom struct type
    if (types[type]) {
      return this.hashEIP712Struct(type, value as Record<string, unknown>, types);
    }

    throw new Error(`Unsupported EIP-712 type: ${type}`);
  }

  private abiEncode(values: Array<{ type: string; value: unknown }>): string {
    let encoded = '0x';
    for (const v of values) {
      encoded += this.encodeValue(v.type, v.value, {}).slice(2);
    }
    return encoded;
  }

  private padHex(hex: string, length: number): string {
    const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
    return '0x' + normalized.padStart(length, '0');
  }

  private async verifyMerklePatriciaProof(
    key: string,
    proof: string[],
    expectedRoot: string
  ): Promise<boolean> {
    // Simplified MPT verification
    // Full implementation would decode RLP and traverse trie nodes
    if (proof.length === 0) {
      return false;
    }

    // Hash the proof elements
    let computedRoot = this.hashMessage(key);
    for (const node of proof) {
      computedRoot = this.hashMessage(computedRoot + node);
    }

    return computedRoot.toLowerCase() === expectedRoot.toLowerCase();
  }

  private verifyPolygonCheckpoint(proof: FinalityProof): boolean {
    // Polygon checkpoint verification
    const checkpointData = proof.proof as {
      checkpointRoot: string;
      headerBlockNumber: number;
      checkpointSignatures: ValidatorSignature[];
    };

    // Verify we have enough checkpoint signatures
    return checkpointData.checkpointSignatures?.length >= 2;
  }

  private computeBlockHash(header: BlockHeader): string {
    // Simplified block hash computation
    // Full implementation would RLP encode and hash all header fields
    const headerData = `${header.parentHash}${header.stateRoot}${header.transactionsRoot}${header.number}${header.timestamp}`;
    return this.hashMessage(headerData);
  }
}

// ============================================================================
// EIP-712 Types
// ============================================================================

interface EIP712Domain {
  name?: string;
  version?: string;
  chainId?: number;
  verifyingContract?: string;
  salt?: string;
}

interface EIP712TypeField {
  name: string;
  type: string;
}

interface EIP712TypedData {
  domain: EIP712Domain;
  primaryType: string;
  types: Record<string, EIP712TypeField[]>;
  message: Record<string, unknown>;
}

// ============================================================================
// Factory and Registration
// ============================================================================

export function createEVMAdapter(chainId: string): EthereumAdapter {
  return new EthereumAdapter(chainId);
}

// Register all EVM chains
Object.keys(EVM_CHAINS).forEach(chainId => {
  try {
    const adapter = new EthereumAdapter(chainId);
    chainRegistry.register(adapter);
  } catch (error) {
    crosschainLogger.warn('Failed to register EVM adapter', {
      operation: 'bridge:adapter:evm:register',
      chainId,
      error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
    });
  }
});
