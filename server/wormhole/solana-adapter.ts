/**
 * Wrfcoin Wormhole Solana Adapter
 *
 * Real adapter for the Solana blockchain when interacting with the
 * Wormhole protocol. Uses @solana/web3.js to interact with Wormhole
 * Core Bridge and Token Bridge programs on Solana.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

/**
 * Derives a PDA (Program Derived Address) for Wormhole accounts.
 */
function derivePDA(
  seeds: Array<Buffer | Uint8Array>,
  programId: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(seeds, programId);
  return pda;
}

export class SolanaAdapter {
  private connection: Connection;
  private coreBridgeProgramId: PublicKey;
  private tokenBridgeProgramId: PublicKey;

  constructor(
    rpcUrl: string,
    coreBridgeProgramId: string,
    tokenBridgeProgramId: string
  ) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.coreBridgeProgramId = new PublicKey(coreBridgeProgramId);
    this.tokenBridgeProgramId = new PublicKey(tokenBridgeProgramId);
  }

  /**
   * Publish a message through the Wormhole Core Bridge on Solana.
   * Creates the post_message instruction and sends it.
   */
  async publishMessage(
    payload: Uint8Array,
    nonce: number,
    payer: Keypair
  ): Promise<{ sequence: bigint; txSignature: string }> {
    try {
      // Derive bridge config PDA
      const bridgeConfig = derivePDA(
        [Buffer.from('Bridge')],
        this.coreBridgeProgramId
      );

      // Derive fee collector PDA
      const feeCollector = derivePDA(
        [Buffer.from('fee_collector')],
        this.coreBridgeProgramId
      );

      // Derive emitter PDA (the payer acts as emitter authority)
      const emitter = derivePDA(
        [Buffer.from('emitter')],
        this.coreBridgeProgramId
      );

      // Derive sequence PDA
      const sequence = derivePDA(
        [Buffer.from('Sequence'), emitter.toBuffer()],
        this.coreBridgeProgramId
      );

      // Create a message account keypair
      const messageAccount = Keypair.generate();

      // Encode instruction data: post_message
      // Layout: [instruction_id(1), consistency_level(1), nonce(4), payload_len(4), payload...]
      const instructionData = Buffer.alloc(10 + payload.length);
      instructionData.writeUInt8(0x01, 0); // PostMessage instruction
      instructionData.writeUInt8(15, 1); // consistency level (finalized)
      instructionData.writeUInt32LE(nonce, 2);
      instructionData.writeUInt32LE(payload.length, 6);
      Buffer.from(payload).copy(instructionData, 10);

      const instruction = new TransactionInstruction({
        programId: this.coreBridgeProgramId,
        keys: [
          { pubkey: bridgeConfig, isSigner: false, isWritable: true },
          { pubkey: messageAccount.publicKey, isSigner: true, isWritable: true },
          { pubkey: emitter, isSigner: false, isWritable: false },
          { pubkey: sequence, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: feeCollector, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: instructionData,
      });

      const transaction = new Transaction().add(instruction);
      const txSignature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [payer, messageAccount]
      );

      const seq = await this.getSequenceFromTx(txSignature);
      return { sequence: seq, txSignature };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Solana publishMessage failed: ${message}`);
    }
  }

  /**
   * Transfer tokens through the Wormhole Token Bridge on Solana.
   */
  async transferTokens(
    mintAddress: string,
    amount: bigint,
    recipientChain: number,
    recipient: Uint8Array,
    payer: Keypair
  ): Promise<{ sequence: bigint; txSignature: string }> {
    try {
      const mint = new PublicKey(mintAddress);

      // Derive token bridge config PDA
      const tokenBridgeConfig = derivePDA(
        [Buffer.from('config')],
        this.tokenBridgeProgramId
      );

      // Derive authority signer PDA
      const authoritySigner = derivePDA(
        [Buffer.from('authority_signer')],
        this.tokenBridgeProgramId
      );

      // Derive custody signer PDA
      const custodySigner = derivePDA(
        [Buffer.from('custody_signer')],
        this.tokenBridgeProgramId
      );

      // Derive custody account PDA (for the token mint)
      const custody = derivePDA(
        [mint.toBuffer()],
        this.tokenBridgeProgramId
      );

      // Derive bridge config PDA for core bridge
      const bridgeConfig = derivePDA(
        [Buffer.from('Bridge')],
        this.coreBridgeProgramId
      );

      // Create a message account keypair
      const messageAccount = Keypair.generate();

      // Derive emitter PDA
      const emitter = derivePDA(
        [Buffer.from('emitter')],
        this.tokenBridgeProgramId
      );

      // Derive sequence PDA
      const sequencePda = derivePDA(
        [Buffer.from('Sequence'), emitter.toBuffer()],
        this.coreBridgeProgramId
      );

      // Derive fee collector PDA
      const feeCollector = derivePDA(
        [Buffer.from('fee_collector')],
        this.coreBridgeProgramId
      );

      // Pad recipient to 32 bytes
      const recipientPadded = Buffer.alloc(32);
      Buffer.from(recipient).copy(recipientPadded, 32 - recipient.length);

      // Encode instruction data: transfer_tokens
      const nonceBytes = new Uint32Array(1);
      crypto.getRandomValues(nonceBytes);
      const nonce = nonceBytes[0];
      const instructionData = Buffer.alloc(54);
      instructionData.writeUInt8(0x01, 0); // TransferTokens instruction
      instructionData.writeBigUInt64LE(amount, 1);
      recipientPadded.copy(instructionData, 9);
      instructionData.writeUInt16LE(recipientChain, 41);
      instructionData.writeBigUInt64LE(0n, 43); // arbiter fee
      instructionData.writeUInt32LE(nonce, 51);

      // Build payer's associated token account (simplified — in production
      // use spl-token getAssociatedTokenAddress)
      const [payerTokenAccount] = PublicKey.findProgramAddressSync(
        [
          payer.publicKey.toBuffer(),
          new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(),
          mint.toBuffer(),
        ],
        new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
      );

      const instruction = new TransactionInstruction({
        programId: this.tokenBridgeProgramId,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tokenBridgeConfig, isSigner: false, isWritable: false },
          { pubkey: payerTokenAccount, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: true },
          { pubkey: custody, isSigner: false, isWritable: true },
          { pubkey: authoritySigner, isSigner: false, isWritable: false },
          { pubkey: custodySigner, isSigner: false, isWritable: false },
          { pubkey: bridgeConfig, isSigner: false, isWritable: true },
          { pubkey: messageAccount.publicKey, isSigner: true, isWritable: true },
          { pubkey: emitter, isSigner: false, isWritable: false },
          { pubkey: sequencePda, isSigner: false, isWritable: true },
          { pubkey: feeCollector, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          {
            pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
            isSigner: false,
            isWritable: false,
          },
          { pubkey: this.coreBridgeProgramId, isSigner: false, isWritable: false },
        ],
        data: instructionData,
      });

      const transaction = new Transaction().add(instruction);
      const txSignature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [payer, messageAccount]
      );

      const seq = await this.getSequenceFromTx(txSignature);
      return { sequence: seq, txSignature };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Solana transferTokens failed: ${message}`);
    }
  }

  /**
   * Complete a token transfer by submitting the signed VAA to the
   * Token Bridge on Solana.
   */
  async completeTransfer(
    signedVAA: Uint8Array,
    payer: Keypair
  ): Promise<string> {
    try {
      // Derive token bridge config PDA
      const tokenBridgeConfig = derivePDA(
        [Buffer.from('config')],
        this.tokenBridgeProgramId
      );

      // Hash the VAA to derive the claim account
      const vaaHash = Buffer.from(
        await crypto.subtle.digest('SHA-256', signedVAA.buffer as ArrayBuffer)
      );

      // Derive the posted VAA PDA
      const postedVaa = derivePDA(
        [Buffer.from('PostedVAA'), vaaHash],
        this.coreBridgeProgramId
      );

      // Derive claim PDA
      const claim = derivePDA(
        [Buffer.from('claim'), vaaHash],
        this.tokenBridgeProgramId
      );

      // Encode instruction data: complete_transfer
      const instructionData = Buffer.alloc(1 + signedVAA.length);
      instructionData.writeUInt8(0x03, 0); // CompleteTransfer instruction
      Buffer.from(signedVAA).copy(instructionData, 1);

      const instruction = new TransactionInstruction({
        programId: this.tokenBridgeProgramId,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tokenBridgeConfig, isSigner: false, isWritable: false },
          { pubkey: postedVaa, isSigner: false, isWritable: false },
          { pubkey: claim, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          {
            pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
            isSigner: false,
            isWritable: false,
          },
          { pubkey: this.coreBridgeProgramId, isSigner: false, isWritable: false },
        ],
        data: instructionData,
      });

      const transaction = new Transaction().add(instruction);
      const txSignature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [payer]
      );

      return txSignature;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Solana completeTransfer failed: ${message}`);
    }
  }

  /**
   * Parse transaction logs to extract the Wormhole sequence number.
   * Wormhole programs log "Sequence: <number>" on successful message posting.
   */
  async getSequenceFromTx(txSignature: string): Promise<bigint> {
    try {
      const tx = await this.connection.getTransaction(txSignature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!tx?.meta?.logMessages) {
        throw new Error(
          `Transaction logs not available for ${txSignature}`
        );
      }

      for (const log of tx.meta.logMessages) {
        // Wormhole programs log sequence as "Sequence: <number>"
        const match = log.match(/Sequence:\s*(\d+)/);
        if (match) {
          return BigInt(match[1]);
        }
      }

      // Fallback: use slot as a proxy for ordering if sequence not found in logs
      throw new Error(
        `Wormhole sequence number not found in transaction logs for ${txSignature}`
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Solana getSequenceFromTx failed: ${message}`
      );
    }
  }
}

// Backward-compatible default export
const adapter = { SolanaAdapter };
export default adapter;
