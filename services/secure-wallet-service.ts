/**
 * Secure Wallet Service
 * Handles transaction signing without exposing private keys
 * Uses message signing verification instead of direct private key handling
 */

import { ethers } from 'ethers';
import crypto from 'crypto';
import winston from 'winston';

interface TransactionRequest {
  to: string;
  data: string;
  value?: string;
  gasLimit?: string;
  gasPrice?: string;
}

interface SignedMessage {
  address: string;
  message: string;
  signature: string;
  timestamp: number;
}

export class SecureWalletService {
  private logger: winston.Logger;
  private provider: ethers.Provider;
  private contractABIs: Map<string, any[]> = new Map();

  constructor(provider: ethers.Provider) {
    this.provider = provider;
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({ filename: 'logs/secure-wallet.log' }),
        new winston.transports.Console({ format: winston.format.simple() }),
      ],
    });
  }

  /**
   * Verify message signature and extract wallet address
   */
  public verifySignature(
    message: string,
    signature: string,
    expectedAddress: string
  ): boolean {
    try {
      const recoveredAddress = ethers.verifyMessage(message, signature);
      return recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();
    } catch (error) {
      this.logger.error('Signature verification failed', {
        error,
        expectedAddress,
      });
      return false;
    }
  }

  /**
   * Create a transaction request message for signing
   */
  public createTransactionMessage(
    contractAddress: string,
    functionName: string,
    params: any[],
    nonce: string,
    expiry: number
  ): string {
    const message = JSON.stringify({
      contractAddress,
      functionName,
      params,
      nonce,
      expiry,
      timestamp: Date.now(),
    });

    return message;
  }

  /**
   * Verify transaction request signature and parameters
   */
  public verifyTransactionRequest(
    walletAddress: string,
    signature: string,
    contractAddress: string,
    functionName: string,
    params: any[],
    nonce: string,
    expiry: number
  ): boolean {
    // Check expiry
    if (Date.now() > expiry) {
      this.logger.warn('Transaction request expired', {
        walletAddress,
        expiry,
      });
      return false;
    }

    // Create expected message
    const expectedMessage = this.createTransactionMessage(
      contractAddress,
      functionName,
      params,
      nonce,
      expiry
    );

    // Verify signature
    if (!this.verifySignature(expectedMessage, signature, walletAddress)) {
      this.logger.warn('Invalid transaction signature', {
        walletAddress,
        functionName,
      });
      return false;
    }

    return true;
  }

  /**
   * Create a secure wallet instance using environment variables
   * Only for admin operations - never expose private keys in API
   */
  public createAdminWallet(): ethers.Wallet | null {
    const adminPrivateKey = process.env.ADMIN_PRIVATE_KEY;
    if (!adminPrivateKey) {
      this.logger.error('Admin private key not configured');
      return null;
    }

    try {
      return new ethers.Wallet(adminPrivateKey, this.provider);
    } catch (error) {
      this.logger.error('Failed to create admin wallet', { error });
      return null;
    }
  }

  /**
   * Generate a secure nonce for transaction requests
   */
  public generateNonce(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Validate wallet address format
   */
  public isValidAddress(address: string): boolean {
    try {
      return ethers.isAddress(address);
    } catch {
      return false;
    }
  }

  /**
   * Check if wallet has sufficient balance for transaction
   */
  public async checkWalletBalance(
    walletAddress: string,
    tokenAddress: string,
    requiredAmount: string
  ): Promise<boolean> {
    try {
      let balance: bigint;

      if (tokenAddress === ethers.ZeroAddress) {
        // Check ETH balance
        balance = await this.provider.getBalance(walletAddress);
      } else {
        // Check ERC20 token balance
        const tokenContract = new ethers.Contract(
          tokenAddress,
          ['function balanceOf(address) view returns (uint256)'],
          this.provider
        );
        balance = await tokenContract.balanceOf(walletAddress);
      }

      return balance >= ethers.parseEther(requiredAmount);
    } catch (error) {
      this.logger.error('Balance check failed', {
        error,
        walletAddress,
        tokenAddress,
      });
      return false;
    }
  }

  /**
   * Estimate gas for a contract function call
   */
  public async estimateGas(
    contractAddress: string,
    functionName: string,
    params: any[],
    fromAddress: string
  ): Promise<bigint | null> {
    try {
      const abi = this.contractABIs.get(contractAddress);
      if (!abi) {
        throw new Error('Contract ABI not loaded');
      }

      const contract = new ethers.Contract(contractAddress, abi, this.provider);
      const gasEstimate = await contract[functionName].estimateGas(...params, {
        from: fromAddress,
      });

      return gasEstimate;
    } catch (error) {
      this.logger.error('Gas estimation failed', {
        error,
        contractAddress,
        functionName,
      });
      return null;
    }
  }

  /**
   * Load contract ABI for gas estimation and validation
   */
  public loadContractABI(contractAddress: string, abi: any[]): void {
    this.contractABIs.set(contractAddress.toLowerCase(), abi);
  }

  /**
   * Create transaction hash for audit trail
   */
  public createTransactionHash(
    walletAddress: string,
    contractAddress: string,
    functionName: string,
    params: any[]
  ): string {
    const data = {
      walletAddress,
      contractAddress,
      functionName,
      params,
      timestamp: Date.now(),
    };

    return crypto
      .createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
  }

  /**
   * Log security events
   */
  public logSecurityEvent(
    event: string,
    walletAddress: string,
    details: any = {}
  ): void {
    this.logger.info('Security Event', {
      event,
      walletAddress,
      ...details,
      timestamp: new Date().toISOString(),
    });
  }
}

export default SecureWalletService;
