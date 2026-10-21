/**
 * Cross-Chain Bridge Adapter System
 *
 * Provides unified interface for interacting with multiple blockchain networks.
 * Each chain adapter handles chain-specific signature verification, proof formats,
 * and finality mechanisms.
 *
 * Supported Chains:
 * - EVM: Ethereum, Polygon, BSC, Avalanche, Arbitrum, Optimism
 * - Cosmos: Cosmos Hub, Osmosis, Juno
 * - Polkadot: Polkadot, Kusama
 * - Other: Solana, Near
 */

import { EventEmitter } from 'events';
import { ECDSAVerifier, BLSVerifier } from '../bridge-crypto-verifier.js';

// ============================================================================
// Common Types and Interfaces
// ============================================================================

export type ChainFamily = 'evm' | 'cosmos' | 'polkadot' | 'solana' | 'near';

export type SignatureScheme = 'secp256k1' | 'ed25519' | 'sr25519' | 'bls12-381';

export type HashAlgorithm = 'keccak256' | 'sha256' | 'blake2b' | 'poseidon';

export interface ChainInfo {
  id: string;
  name: string;
  chainId: number | string;
  family: ChainFamily;
  signatureScheme: SignatureScheme;
  hashAlgorithm: HashAlgorithm;
  nativeToken: string;
  blockTime: number; // in milliseconds
  requiredConfirmations: number;
  supportedBridgeProtocols: string[];
}

export interface TransactionProof {
  transactionHash: string;
  blockHash: string;
  blockNumber: number | bigint;
  merkleProof: string[];
  receiptProof?: string[];
  stateProof?: string[];
}

export interface BlockHeader {
  hash: string;
  parentHash: string;
  number: number | bigint;
  timestamp: number;
  stateRoot: string;
  transactionsRoot: string;
  receiptsRoot?: string;
  validatorSignatures?: ValidatorSignature[];
}

export interface ValidatorSignature {
  validatorAddress: string;
  publicKey: string;
  signature: string;
  timestamp: number;
}

export interface FinalityProof {
  type: 'block_confirmations' | 'checkpoint' | 'grandpa' | 'tendermint' | 'solana_vote';
  proof: unknown;
  finalizedBlockNumber: number | bigint;
  confidence: number;
}

export interface VerificationResult {
  isValid: boolean;
  chain: string;
  verifiedAt: number;
  details: Record<string, unknown>;
  errors: string[];
}

// ============================================================================
// Chain Adapter Interface
// ============================================================================

export interface IChainAdapter {
  readonly chainInfo: ChainInfo;

  // Signature operations
  verifySignature(messageHash: string, signature: string, publicKey: string): Promise<boolean>;
  verifyMultiSig(
    messageHash: string,
    signatures: ValidatorSignature[],
    threshold: number
  ): Promise<{ valid: boolean; count: number }>;

  // Proof verification
  verifyTransactionProof(proof: TransactionProof, expectedRoot: string): Promise<boolean>;
  verifyBlockHeader(header: BlockHeader, parentHeader?: BlockHeader): Promise<boolean>;
  verifyFinalityProof(proof: FinalityProof): Promise<boolean>;

  // Message hashing
  hashMessage(message: string | Uint8Array): string;
  hashTypedData?(typedData: unknown): string;

  // Chain-specific operations
  encodeAddress(address: string): string;
  decodeAddress(encoded: string): string;
  getConfirmationBlocks(): number;
}

// ============================================================================
// Base Chain Adapter
// ============================================================================

export abstract class BaseChainAdapter extends EventEmitter implements IChainAdapter {
  abstract readonly chainInfo: ChainInfo;

  constructor() {
    super();
  }

  abstract verifySignature(messageHash: string, signature: string, publicKey: string): Promise<boolean>;

  abstract hashMessage(message: string | Uint8Array): string;

  async verifyMultiSig(
    messageHash: string,
    signatures: ValidatorSignature[],
    threshold: number
  ): Promise<{ valid: boolean; count: number }> {
    let validCount = 0;
    const verifiedValidators = new Set<string>();

    for (const sig of signatures) {
      // Skip duplicate validators
      if (verifiedValidators.has(sig.validatorAddress.toLowerCase())) {
        continue;
      }

      const isValid = await this.verifySignature(messageHash, sig.signature, sig.publicKey);
      if (isValid) {
        validCount++;
        verifiedValidators.add(sig.validatorAddress.toLowerCase());
      }
    }

    return {
      valid: validCount >= threshold,
      count: validCount,
    };
  }

  async verifyTransactionProof(proof: TransactionProof, expectedRoot: string): Promise<boolean> {
    // Default implementation using Merkle proof verification
    // Chain-specific adapters may override this
    const leaf = this.hashMessage(proof.transactionHash);
    let computedRoot = leaf;

    for (const proofElement of proof.merkleProof) {
      const combined = computedRoot < proofElement
        ? computedRoot + proofElement.slice(2)
        : proofElement.slice(2) + computedRoot;
      computedRoot = this.hashMessage(combined);
    }

    return computedRoot.toLowerCase() === expectedRoot.toLowerCase();
  }

  async verifyBlockHeader(header: BlockHeader, parentHeader?: BlockHeader): Promise<boolean> {
    // Verify parent hash linkage
    if (parentHeader) {
      if (header.parentHash.toLowerCase() !== parentHeader.hash.toLowerCase()) {
        return false;
      }
      if (BigInt(header.number) !== BigInt(parentHeader.number) + BigInt(1)) {
        return false;
      }
    }

    // Verify validator signatures if present
    if (header.validatorSignatures && header.validatorSignatures.length > 0) {
      const headerHash = this.hashMessage(header.hash);
      const result = await this.verifyMultiSig(headerHash, header.validatorSignatures, 1);
      return result.valid;
    }

    return true;
  }

  async verifyFinalityProof(proof: FinalityProof): Promise<boolean> {
    // Chain-specific finality verification
    // Override in specific adapters
    return proof.confidence >= 0.95;
  }

  encodeAddress(address: string): string {
    return address.toLowerCase();
  }

  decodeAddress(encoded: string): string {
    return encoded;
  }

  getConfirmationBlocks(): number {
    return this.chainInfo.requiredConfirmations;
  }
}

// ============================================================================
// Chain Registry
// ============================================================================

class ChainAdapterRegistry {
  private adapters = new Map<string, IChainAdapter>();
  private chainInfoMap = new Map<string, ChainInfo>();

  register(adapter: IChainAdapter): void {
    this.adapters.set(adapter.chainInfo.id.toLowerCase(), adapter);
    this.chainInfoMap.set(adapter.chainInfo.id.toLowerCase(), adapter.chainInfo);
  }

  get(chainId: string): IChainAdapter | undefined {
    return this.adapters.get(chainId.toLowerCase());
  }

  getChainInfo(chainId: string): ChainInfo | undefined {
    return this.chainInfoMap.get(chainId.toLowerCase());
  }

  getAllChains(): ChainInfo[] {
    return Array.from(this.chainInfoMap.values());
  }

  getSupportedChains(): string[] {
    return Array.from(this.adapters.keys());
  }

  hasChain(chainId: string): boolean {
    return this.adapters.has(chainId.toLowerCase());
  }
}

export const chainRegistry = new ChainAdapterRegistry();

// ============================================================================
// Re-exports of specific adapters
// ============================================================================

export * from './ethereum-adapter.js';
export * from './cosmos-adapter.js';
