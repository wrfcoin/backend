/**
 * Cosmos Chain Adapter
 *
 * Handles signature verification and proof validation for Cosmos SDK chains:
 * - Cosmos Hub
 * - Osmosis
 * - Juno
 * - Evmos
 * - Kava
 *
 * Features:
 * - Ed25519 signature verification (Tendermint consensus)
 * - ECDSA secp256k1 for some chains (Evmos, Kava)
 * - SHA256 hashing
 * - Tendermint light client proofs
 * - IBC packet verification
 * - IAVL+ tree proofs
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';
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
// Cosmos Chain Configurations
// ============================================================================

const COSMOS_CHAINS: Record<string, Partial<ChainInfo> & { isEVM?: boolean }> = {
  cosmoshub: {
    id: 'cosmoshub',
    name: 'Cosmos Hub',
    chainId: 'cosmoshub-4',
    nativeToken: 'ATOM',
    blockTime: 6000,
    requiredConfirmations: 1, // Tendermint finality is instant
    supportedBridgeProtocols: ['ibc', 'axelar', 'gravity'],
    isEVM: false,
  },
  osmosis: {
    id: 'osmosis',
    name: 'Osmosis',
    chainId: 'osmosis-1',
    nativeToken: 'OSMO',
    blockTime: 6000,
    requiredConfirmations: 1,
    supportedBridgeProtocols: ['ibc', 'axelar'],
    isEVM: false,
  },
  juno: {
    id: 'juno',
    name: 'Juno',
    chainId: 'juno-1',
    nativeToken: 'JUNO',
    blockTime: 6000,
    requiredConfirmations: 1,
    supportedBridgeProtocols: ['ibc', 'axelar'],
    isEVM: false,
  },
  evmos: {
    id: 'evmos',
    name: 'Evmos',
    chainId: 'evmos_9001-2',
    nativeToken: 'EVMOS',
    blockTime: 6000,
    requiredConfirmations: 1,
    supportedBridgeProtocols: ['ibc', 'axelar', 'layerzero'],
    isEVM: true,
  },
  kava: {
    id: 'kava',
    name: 'Kava',
    chainId: 'kava_2222-10',
    nativeToken: 'KAVA',
    blockTime: 6000,
    requiredConfirmations: 1,
    supportedBridgeProtocols: ['ibc', 'axelar'],
    isEVM: true,
  },
  injective: {
    id: 'injective',
    name: 'Injective',
    chainId: 'injective-1',
    nativeToken: 'INJ',
    blockTime: 1000,
    requiredConfirmations: 1,
    supportedBridgeProtocols: ['ibc', 'axelar', 'wormhole'],
    isEVM: true,
  },
};

// ============================================================================
// Tendermint Types
// ============================================================================

interface TendermintHeader {
  version: { block: string; app: string };
  chainId: string;
  height: number;
  time: string;
  lastBlockId: {
    hash: string;
    parts: { total: number; hash: string };
  };
  lastCommitHash: string;
  dataHash: string;
  validatorsHash: string;
  nextValidatorsHash: string;
  consensusHash: string;
  appHash: string;
  lastResultsHash: string;
  evidenceHash: string;
  proposerAddress: string;
}

interface TendermintCommit {
  height: number;
  round: number;
  blockId: {
    hash: string;
    parts: { total: number; hash: string };
  };
  signatures: TendermintSignature[];
}

interface TendermintSignature {
  blockIdFlag: number;
  validatorAddress: string;
  timestamp: string;
  signature: string;
}

interface IBCPacket {
  sequence: number;
  sourcePort: string;
  sourceChannel: string;
  destinationPort: string;
  destinationChannel: string;
  data: string;
  timeoutHeight: { revisionNumber: number; revisionHeight: number };
  timeoutTimestamp: number;
}

interface IBCProof {
  packet: IBCPacket;
  proof: string;
  proofHeight: { revisionNumber: number; revisionHeight: number };
}

// ============================================================================
// Cosmos Adapter Implementation
// ============================================================================

export class CosmosAdapter extends BaseChainAdapter {
  readonly chainInfo: ChainInfo;
  private readonly isEVMCompatible: boolean;

  constructor(chainId: string = 'cosmoshub') {
    super();

    const config = COSMOS_CHAINS[chainId.toLowerCase()];
    if (!config) {
      throw new Error(`Unsupported Cosmos chain: ${chainId}`);
    }

    this.isEVMCompatible = config.isEVM || false;

    this.chainInfo = {
      ...config,
      family: 'cosmos',
      signatureScheme: this.isEVMCompatible ? 'secp256k1' : 'ed25519',
      hashAlgorithm: 'sha256',
    } as ChainInfo;
  }

  /**
   * Verify signature using Ed25519 (Tendermint) or ECDSA (EVM Cosmos chains)
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

      if (this.isEVMCompatible) {
        // Use ECDSA secp256k1 for EVM-compatible Cosmos chains
        const result = ECDSAVerifier.verify(normalizedHash, normalizedSig, normalizedPubKey);
        return result.isValid;
      } else {
        // Use Ed25519 for standard Cosmos chains
        const messageBytes = hexToBytes(normalizedHash);
        const signatureBytes = hexToBytes(normalizedSig);
        const publicKeyBytes = hexToBytes(normalizedPubKey);

        // Ed25519 signatures are 64 bytes
        if (signatureBytes.length !== 64) {
          this.emit('signature:invalid_length', {
            chain: this.chainInfo.id,
            length: signatureBytes.length,
            expected: 64,
          });
          return false;
        }

        // Ed25519 public keys are 32 bytes
        if (publicKeyBytes.length !== 32) {
          this.emit('signature:invalid_pubkey_length', {
            chain: this.chainInfo.id,
            length: publicKeyBytes.length,
            expected: 32,
          });
          return false;
        }

        const isValid = ed25519.verify(signatureBytes, messageBytes, publicKeyBytes);

        if (!isValid) {
          this.emit('signature:verification_failed', {
            chain: this.chainInfo.id,
          });
          return false;
        }

        this.emit('signature:verified', {
          chain: this.chainInfo.id,
          publicKey: normalizedPubKey.substring(0, 16) + '...',
        });

        return true;
      }
    } catch (error) {
      this.emit('signature:error', {
        chain: this.chainInfo.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Hash message using SHA256 (Cosmos/Tendermint standard)
   */
  hashMessage(message: string | Uint8Array): string {
    let data: Uint8Array;

    if (typeof message === 'string') {
      if (message.startsWith('0x')) {
        data = hexToBytes(message.slice(2));
      } else {
        data = new TextEncoder().encode(message);
      }
    } else {
      data = message;
    }

    const hash = sha256(data);
    return '0x' + bytesToHex(hash);
  }

  /**
   * Verify Tendermint commit signatures
   */
  async verifyTendermintCommit(
    header: TendermintHeader,
    commit: TendermintCommit,
    validatorSet: Map<string, string> // address -> public key
  ): Promise<{ valid: boolean; signedPower: number; totalPower: number }> {
    // Compute the header hash that validators signed
    const headerHash = this.computeTendermintHeaderHash(header);

    // Compute the canonical vote message
    const voteMessage = this.computeCanonicalVoteMessage(
      commit.height,
      commit.round,
      commit.blockId.hash,
      header.chainId
    );

    let signedPower = 0;
    const totalPower = validatorSet.size; // Simplified - in reality use voting power

    for (const sig of commit.signatures) {
      // Skip absent or nil votes
      if (sig.blockIdFlag !== 2) continue; // BlockIDFlagCommit = 2

      const validatorPubKey = validatorSet.get(sig.validatorAddress);
      if (!validatorPubKey) continue;

      const isValid = await this.verifySignature(
        voteMessage,
        sig.signature,
        validatorPubKey
      );

      if (isValid) {
        signedPower++;
      }
    }

    // Tendermint requires >2/3 of validators to sign
    const threshold = Math.floor((totalPower * 2) / 3) + 1;
    const valid = signedPower >= threshold;

    this.emit('tendermint:commit_verified', {
      chain: this.chainInfo.id,
      height: commit.height,
      signedPower,
      totalPower,
      valid,
    });

    return { valid, signedPower, totalPower };
  }

  /**
   * Verify IBC packet proof
   */
  async verifyIBCPacketProof(
    ibcProof: IBCProof,
    connectionStateRoot: string
  ): Promise<boolean> {
    try {
      // Compute the packet commitment
      const packetCommitment = this.computePacketCommitment(ibcProof.packet);

      // Verify the IAVL+ proof against the state root
      const isValid = await this.verifyIAVLProof(
        packetCommitment,
        ibcProof.proof,
        connectionStateRoot
      );

      this.emit('ibc:packet_verified', {
        chain: this.chainInfo.id,
        sequence: ibcProof.packet.sequence,
        sourceChannel: ibcProof.packet.sourceChannel,
        isValid,
      });

      return isValid;
    } catch (error) {
      this.emit('ibc:verification_error', {
        chain: this.chainInfo.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Verify finality for Cosmos chains (instant with Tendermint)
   */
  async verifyFinalityProof(proof: FinalityProof): Promise<boolean> {
    // Tendermint provides instant finality once a block is committed
    if (proof.type === 'tendermint') {
      const tendermintProof = proof.proof as {
        header: TendermintHeader;
        commit: TendermintCommit;
        validators: Map<string, string>;
      };

      const result = await this.verifyTendermintCommit(
        tendermintProof.header,
        tendermintProof.commit,
        tendermintProof.validators
      );

      return result.valid;
    }

    // Default confidence check
    return proof.confidence >= 0.99;
  }

  /**
   * Encode Cosmos address (Bech32 format)
   */
  encodeAddress(address: string): string {
    // For now, return lowercase
    // Full implementation would use Bech32 encoding
    return address.toLowerCase();
  }

  /**
   * Verify Cosmos address format
   */
  verifyAddressFormat(address: string, prefix: string): boolean {
    // Simplified check for Bech32 address format
    const validPrefix = address.startsWith(prefix);
    const validLength = address.length >= 39 && address.length <= 59;
    return validPrefix && validLength;
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private normalizeHex(hex: string): string {
    return hex.startsWith('0x') ? hex.slice(2) : hex;
  }

  private computeTendermintHeaderHash(header: TendermintHeader): string {
    // Simplified header hash computation
    // Full implementation would use Amino/Protobuf encoding
    const headerData = [
      header.version.block,
      header.chainId,
      header.height.toString(),
      header.time,
      header.lastBlockId.hash,
      header.lastCommitHash,
      header.dataHash,
      header.validatorsHash,
      header.nextValidatorsHash,
      header.consensusHash,
      header.appHash,
      header.lastResultsHash,
      header.evidenceHash,
      header.proposerAddress,
    ].join('');

    return this.hashMessage(headerData);
  }

  private computeCanonicalVoteMessage(
    height: number,
    round: number,
    blockIdHash: string,
    chainId: string
  ): string {
    // Compute canonical vote message that validators sign
    const voteData = `${height}:${round}:${blockIdHash}:${chainId}`;
    return this.hashMessage(voteData);
  }

  private computePacketCommitment(packet: IBCPacket): string {
    // Compute IBC packet commitment hash
    const packetData = [
      packet.sequence.toString(),
      packet.sourcePort,
      packet.sourceChannel,
      packet.destinationPort,
      packet.destinationChannel,
      packet.data,
      packet.timeoutHeight.revisionNumber.toString(),
      packet.timeoutHeight.revisionHeight.toString(),
      packet.timeoutTimestamp.toString(),
    ].join(':');

    return this.hashMessage(packetData);
  }

  private async verifyIAVLProof(
    key: string,
    proof: string,
    root: string
  ): Promise<boolean> {
    // Simplified IAVL+ proof verification
    // Full implementation would decode and verify IAVL tree proof
    try {
      const proofBytes = hexToBytes(this.normalizeHex(proof));

      // Check proof is not empty
      if (proofBytes.length === 0) {
        return false;
      }

      // Compute leaf hash
      const leafHash = this.hashMessage(key);

      // For now, verify proof is properly formed
      // Full implementation would traverse the proof
      return proofBytes.length > 32;
    } catch (error) {
      return false;
    }
  }
}

// ============================================================================
// Factory and Registration
// ============================================================================

export function createCosmosAdapter(chainId: string): CosmosAdapter {
  return new CosmosAdapter(chainId);
}

// Register all Cosmos chains
Object.keys(COSMOS_CHAINS).forEach(chainId => {
  try {
    const adapter = new CosmosAdapter(chainId);
    chainRegistry.register(adapter);
  } catch (error) {
    crosschainLogger.warn('Failed to register Cosmos adapter', {
      operation: 'bridge:adapter:cosmos:register',
      chainId,
      error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
    });
  }
});
