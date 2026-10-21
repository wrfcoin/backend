/**
 * Wrfcoin Wormhole EVM Adapter
 *
 * Real adapter for EVM-compatible blockchains interacting with the
 * Wormhole protocol. Uses ethers.js v6 to interact with Wormhole
 * Core Bridge and Token Bridge contracts on-chain.
 */

import { ethers } from 'ethers';

// Wormhole Core Bridge ABI (minimal - just the functions we need)
const CORE_BRIDGE_ABI = [
  'function publishMessage(uint32 nonce, bytes payload, uint8 consistencyLevel) payable returns (uint64 sequence)',
  'function messageFee() view returns (uint256)',
];

const TOKEN_BRIDGE_ABI = [
  'function transferTokens(address token, uint256 amount, uint16 recipientChain, bytes32 recipient, uint256 arbiterFee, uint32 nonce) payable returns (uint64 sequence)',
  'function completeTransfer(bytes encodedVm)',
  'function wrappedAsset(uint16 tokenChainId, bytes32 tokenAddress) view returns (address)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// Wormhole LogMessagePublished event signature
const LOG_MESSAGE_PUBLISHED_TOPIC = ethers.id(
  'LogMessagePublished(address,uint64,uint32,bytes,uint8)'
);

export class EvmAdapter {
  private provider: ethers.JsonRpcProvider;
  private coreBridge: ethers.Contract;
  private tokenBridge: ethers.Contract;
  private coreBridgeAddress: string;
  private tokenBridgeAddress: string;

  constructor(
    rpcUrl: string,
    coreBridgeAddress: string,
    tokenBridgeAddress: string
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.coreBridgeAddress = coreBridgeAddress;
    this.tokenBridgeAddress = tokenBridgeAddress;
    this.coreBridge = new ethers.Contract(
      coreBridgeAddress,
      CORE_BRIDGE_ABI,
      this.provider
    );
    this.tokenBridge = new ethers.Contract(
      tokenBridgeAddress,
      TOKEN_BRIDGE_ABI,
      this.provider
    );
  }

  /**
   * Publish a message through the Wormhole Core Bridge.
   * Encodes payload, pays the message fee, and returns the sequence number.
   */
  async publishMessage(
    payload: Uint8Array,
    nonce: number,
    signer: ethers.Signer
  ): Promise<{ sequence: bigint; txHash: string }> {
    try {
      if (!signer.provider) {
        throw new Error('Signer must be connected to a provider');
      }
      const coreBridgeWithSigner = this.coreBridge.connect(signer) as ethers.Contract;
      const messageFee = await this.coreBridge.messageFee();
      const consistencyLevel = 15; // finalized

      const tx = await coreBridgeWithSigner.publishMessage(
        nonce,
        payload,
        consistencyLevel,
        { value: messageFee }
      );
      const receipt = await tx.wait();

      const { sequence } = this.extractSequenceFromLogs(receipt.logs);
      return { sequence, txHash: receipt.hash };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(`EVM publishMessage failed: ${message}`);
    }
  }

  /**
   * Transfer tokens through the Wormhole Token Bridge.
   * Approves the token bridge to spend tokens, then initiates the transfer.
   */
  async transferTokens(
    tokenAddress: string,
    amount: bigint,
    recipientChain: number,
    recipient: Uint8Array,
    signer: ethers.Signer
  ): Promise<{ sequence: bigint; txHash: string }> {
    try {
      // Validate signer is connected to this adapter's provider
      if (!signer.provider) {
        throw new Error('Signer must be connected to a provider');
      }

      // Approve token bridge to spend tokens
      // Reset allowance to 0 first if non-zero (required by tokens like USDT
      // that forbid approve from non-zero to non-zero)
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
      const signerAddress = await signer.getAddress();
      const currentAllowance: bigint = await token.allowance(
        signerAddress,
        this.tokenBridgeAddress
      );

      if (currentAllowance < amount) {
        if (currentAllowance > 0n) {
          const resetTx = await token.approve(this.tokenBridgeAddress, 0n);
          await resetTx.wait();
        }
        const approveTx = await token.approve(this.tokenBridgeAddress, amount);
        await approveTx.wait();
      }

      // Pad recipient to bytes32
      const recipientBytes32 =
        '0x' + Buffer.from(recipient).toString('hex').padStart(64, '0');

      const messageFee = await this.coreBridge.messageFee();
      const tokenBridgeWithSigner = this.tokenBridge.connect(signer) as ethers.Contract;
      const nonceBytes = new Uint32Array(1);
      crypto.getRandomValues(nonceBytes);
      const nonce = nonceBytes[0];

      const tx = await tokenBridgeWithSigner.transferTokens(
        tokenAddress,
        amount,
        recipientChain,
        recipientBytes32,
        0n, // arbiterFee
        nonce,
        { value: messageFee }
      );
      const receipt = await tx.wait();

      const { sequence } = this.extractSequenceFromLogs(receipt.logs);
      return { sequence, txHash: receipt.hash };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(`EVM transferTokens failed: ${message}`);
    }
  }

  /**
   * Complete a token transfer by submitting the signed VAA to the Token Bridge.
   */
  async completeTransfer(
    signedVAA: Uint8Array,
    signer: ethers.Signer
  ): Promise<string> {
    try {
      if (!signer.provider) {
        throw new Error('Signer must be connected to a provider');
      }
      const tokenBridgeWithSigner = this.tokenBridge.connect(signer) as ethers.Contract;
      const tx = await tokenBridgeWithSigner.completeTransfer(signedVAA);
      const receipt = await tx.wait();
      return receipt.hash;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(`EVM completeTransfer failed: ${message}`);
    }
  }

  /**
   * Read the current message fee from the Core Bridge contract.
   */
  async getMessageFee(): Promise<bigint> {
    try {
      return await this.coreBridge.messageFee();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(`EVM getMessageFee failed: ${message}`);
    }
  }

  /**
   * Basic VAA verification by checking that the VAA bytes decode properly
   * and the guardian signatures are present. Full on-chain verification would
   * require calling the core bridge's parseAndVerifyVM function.
   */
  async verifyVAA(vaaBytes: Uint8Array): Promise<boolean> {
    try {
      if (vaaBytes.length < 6) {
        return false;
      }
      // Check VAA version byte (should be 1)
      const version = vaaBytes[0];
      if (version !== 1) {
        return false;
      }
      // Read guardian set index and signature count
      const guardianSetIndex =
        (vaaBytes[1] << 24) | (vaaBytes[2] << 16) | (vaaBytes[3] << 8) | vaaBytes[4];
      const signatureCount = vaaBytes[5];

      // Each signature is 66 bytes (1 guardian index + 65 signature)
      const expectedMinLength = 6 + signatureCount * 66 + 51; // 51 = body header
      if (vaaBytes.length < expectedMinLength) {
        return false;
      }

      // Basic structural validation passed
      return guardianSetIndex >= 0 && signatureCount > 0;
    } catch {
      return false;
    }
  }

  /**
   * Parse a transaction receipt to extract the Wormhole sequence number
   * and emitter address from the LogMessagePublished event.
   */
  async parseTransactionReceipt(
    txHash: string
  ): Promise<{ sequence: bigint; emitterAddress: string }> {
    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (!receipt) {
        throw new Error(`Transaction receipt not found for ${txHash}`);
      }
      return this.extractSequenceFromLogs(receipt.logs);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(`EVM parseTransactionReceipt failed: ${message}`);
    }
  }

  /**
   * Extract the sequence number and emitter from Core Bridge log events.
   */
  private extractSequenceFromLogs(logs: readonly ethers.Log[]): {
    sequence: bigint;
    emitterAddress: string;
  } {
    for (const log of logs) {
      if (
        log.address.toLowerCase() === this.coreBridgeAddress.toLowerCase() &&
        log.topics[0] === LOG_MESSAGE_PUBLISHED_TOPIC
      ) {
        // LogMessagePublished(address sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)
        // sequence is in topics[1] if indexed, otherwise in data
        // In Wormhole's implementation, sender is indexed (topics[1]), rest in data
        const emitterAddress = log.topics[1]
          ? ethers.getAddress('0x' + log.topics[1].slice(26))
          : ethers.ZeroAddress;

        // Decode data: uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel
        const abiCoder = ethers.AbiCoder.defaultAbiCoder();
        const decoded = abiCoder.decode(
          ['uint64', 'uint32', 'bytes', 'uint8'],
          log.data
        );
        const sequence = BigInt(decoded[0]);

        return { sequence, emitterAddress };
      }
    }

    throw new Error(
      'LogMessagePublished event not found in transaction logs'
    );
  }
}

// Backward-compatible CommonJS-style default export
const adapter = { EvmAdapter };
export default adapter;
