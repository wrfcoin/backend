/**
 * Multi-Signature Wallet Implementation for ISO 22739 Digital Asset Custody
 * Enhanced security for digital asset management
 */

const crypto = require('crypto');
const { ethers } = require('ethers');
const { walletLogger } = require('../server/utils/logger');

class MultiSignatureWalletManager {
  constructor() {
    this.wallets = new Map();
    this.pendingTransactions = new Map();
    this.signers = new Map();
    this.auditLog = [];
    this.thresholdPolicies = new Map();
  }

  // Create multi-signature wallet
  async createMultiSigWallet(config) {
    const walletId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // Validate configuration
    this.validateMultiSigConfig(config);

    // Generate wallet keys
    const walletKeys = await this.generateWalletKeys(config.signers.length);

    // Create wallet structure
    const wallet = {
      id: walletId,
      name: config.name,
      type: 'multi_signature',
      threshold: config.threshold,
      totalSigners: config.signers.length,
      signers: config.signers.map((signer, index) => ({
        id: signer.id,
        name: signer.name,
        publicKey: walletKeys.signers[index].publicKey,
        role: signer.role,
        permissions: signer.permissions || ['sign', 'view'],
      })),
      addresses: {
        ethereum: await this.generateEthereumMultiSigAddress(
          walletKeys,
          config.threshold
        ),
        wrfcoin: await this.generateWRFMultiSigAddress(
          walletKeys,
          config.threshold
        ),
        bitcoin: await this.generateBitcoinMultiSigAddress(
          walletKeys,
          config.threshold
        ),
      },
      createdAt: timestamp,
      lastActivity: timestamp,
      status: 'active',
      securityLevel: this.calculateSecurityLevel(config),
      custodyInsurance: config.custodyInsurance || false,
    };

    // Store wallet
    this.wallets.set(walletId, wallet);

    // Initialize threshold policies
    await this.initializeThresholdPolicies(walletId, config);

    // Log wallet creation
    await this.logCustodyActivity('wallet_created', {
      walletId,
      signers: config.signers.length,
      threshold: config.threshold,
      securityLevel: wallet.securityLevel,
    });

    return {
      success: true,
      walletId,
      wallet: this.sanitizeWalletForResponse(wallet),
      securityLevel: wallet.securityLevel,
    };
  }

  // Initiate transaction that requires multiple signatures
  async initiateMultiSigTransaction(walletId, transaction, initiatorId) {
    const wallet = this.wallets.get(walletId);
    if (!wallet) {
      throw new Error('Multi-signature wallet not found');
    }

    // Validate initiator permissions
    const initiator = wallet.signers.find(s => s.id === initiatorId);
    if (!initiator || !initiator.permissions.includes('sign')) {
      throw new Error('Insufficient permissions to initiate transaction');
    }

    const transactionId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // Validate transaction against wallet policies
    await this.validateTransactionPolicies(walletId, transaction);

    // Create pending transaction
    const pendingTx = {
      id: transactionId,
      walletId,
      type: transaction.type,
      to: transaction.to,
      amount: transaction.amount,
      currency: transaction.currency,
      data: transaction.data || {},
      initiatedBy: initiatorId,
      initiatedAt: timestamp,
      requiredSignatures: wallet.threshold,
      signatures: [],
      status: 'pending',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
      approvals: [],
      rejections: [],
    };

    // Add initiator's signature
    const initiatorSignature = await this.signTransaction(pendingTx, initiator);
    pendingTx.signatures.push(initiatorSignature);
    pendingTx.approvals.push({
      signerId: initiatorId,
      timestamp,
      signature: initiatorSignature.signature,
    });

    this.pendingTransactions.set(transactionId, pendingTx);

    // Log transaction initiation
    await this.logCustodyActivity('transaction_initiated', {
      transactionId,
      walletId,
      initiator: initiatorId,
      amount: transaction.amount,
      currency: transaction.currency,
    });

    // Check if transaction can be executed immediately
    if (pendingTx.signatures.length >= wallet.threshold) {
      return await this.executeMultiSigTransaction(transactionId);
    }

    return {
      success: true,
      transactionId,
      status: 'awaiting_signatures',
      requiredSignatures: wallet.threshold,
      currentSignatures: pendingTx.signatures.length,
      pendingSigners: this.getPendingSigners(walletId, pendingTx),
    };
  }

  // Sign pending transaction
  async signTransaction(transactionOrId, signer) {
    let transaction;

    if (typeof transactionOrId === 'string') {
      transaction = this.pendingTransactions.get(transactionOrId);
      if (!transaction) {
        throw new Error('Pending transaction not found');
      }
    } else {
      transaction = transactionOrId;
    }

    const wallet = this.wallets.get(transaction.walletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    // Validate signer
    const walletSigner = wallet.signers.find(s => s.id === signer.id);
    if (!walletSigner) {
      throw new Error('Signer not authorized for this wallet');
    }

    // Check if already signed
    const existingSignature = transaction.signatures.find(
      s => s.signerId === signer.id
    );
    if (existingSignature) {
      throw new Error('Transaction already signed by this signer');
    }

    // Generate transaction hash for signing
    const txHash = this.generateTransactionHash(transaction);

    // Validate signer has a private key
    if (!signer.privateKey) {
      throw new Error(`Signer ${signer.id} has no private key configured. All signers must have valid cryptographic keys.`);
    }

    // Create signature
    const signature = {
      signerId: signer.id,
      signerName: walletSigner.name,
      timestamp: new Date().toISOString(),
      signature: await this.generateSignature(
        txHash,
        signer.privateKey
      ),
      algorithm: 'ECDSA_secp256k1',
    };

    return signature;
  }

  // Add signature to pending transaction
  async addSignature(transactionId, signerId) {
    const transaction = this.pendingTransactions.get(transactionId);
    if (!transaction) {
      throw new Error('Pending transaction not found');
    }

    const wallet = this.wallets.get(transaction.walletId);
    const signer = wallet.signers.find(s => s.id === signerId);

    if (!signer) {
      throw new Error('Signer not authorized');
    }

    // Generate and add signature
    const signature = await this.signTransaction(transaction, signer);
    transaction.signatures.push(signature);
    transaction.approvals.push({
      signerId,
      timestamp: signature.timestamp,
      signature: signature.signature,
    });

    // Log signature addition
    await this.logCustodyActivity('signature_added', {
      transactionId,
      signerId,
      totalSignatures: transaction.signatures.length,
      requiredSignatures: wallet.threshold,
    });

    // Check if transaction can be executed
    if (transaction.signatures.length >= wallet.threshold) {
      return await this.executeMultiSigTransaction(transactionId);
    }

    return {
      success: true,
      transactionId,
      status: 'awaiting_signatures',
      requiredSignatures: wallet.threshold,
      currentSignatures: transaction.signatures.length,
    };
  }

  // Execute multi-signature transaction
  async executeMultiSigTransaction(transactionId) {
    const transaction = this.pendingTransactions.get(transactionId);
    if (!transaction) {
      throw new Error('Pending transaction not found');
    }

    const wallet = this.wallets.get(transaction.walletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    try {
      // Verify all signatures
      const signatureVerification = await this.verifyAllSignatures(transaction);
      if (!signatureVerification.valid) {
        throw new Error(
          `Signature verification failed: ${signatureVerification.reason}`
        );
      }

      // Execute based on transaction type
      let executionResult;
      switch (transaction.type) {
        case 'transfer':
          executionResult = await this.executeTransfer(transaction, wallet);
          break;
        case 'smart_contract':
          executionResult = await this.executeSmartContract(
            transaction,
            wallet
          );
          break;
        case 'custody_operation':
          executionResult = await this.executeCustodyOperation(
            transaction,
            wallet
          );
          break;
        default:
          throw new Error(`Unsupported transaction type: ${transaction.type}`);
      }

      // Update transaction status
      transaction.status = 'executed';
      transaction.executedAt = new Date().toISOString();
      transaction.executionResult = executionResult;

      // Update wallet last activity
      wallet.lastActivity = new Date().toISOString();

      // Log execution
      await this.logCustodyActivity('transaction_executed', {
        transactionId,
        walletId: transaction.walletId,
        executionResult: executionResult.txHash,
        amount: transaction.amount,
        currency: transaction.currency,
      });

      // Remove from pending transactions
      this.pendingTransactions.delete(transactionId);

      return {
        success: true,
        transactionId,
        status: 'executed',
        executionResult,
        blockchainTxHash: executionResult.txHash,
      };
    } catch (error) {
      transaction.status = 'failed';
      transaction.failedAt = new Date().toISOString();
      transaction.error = error.message;

      await this.logCustodyActivity('transaction_failed', {
        transactionId,
        error: error.message,
      });

      throw error;
    }
  }

  // Validate multi-signature configuration
  validateMultiSigConfig(config) {
    if (!config.name || typeof config.name !== 'string') {
      throw new Error('Wallet name is required');
    }

    if (
      !config.signers ||
      !Array.isArray(config.signers) ||
      config.signers.length < 2
    ) {
      throw new Error(
        'At least 2 signers are required for multi-signature wallet'
      );
    }

    if (
      !config.threshold ||
      config.threshold < 2 ||
      config.threshold > config.signers.length
    ) {
      throw new Error(
        'Threshold must be between 2 and total number of signers'
      );
    }

    // Validate signer configurations
    for (const signer of config.signers) {
      if (!signer.id || !signer.name) {
        throw new Error('Each signer must have id and name');
      }
    }

    return true;
  }

  // Generate wallet keys for all signers
  async generateWalletKeys(signerCount) {
    const masterSeed = crypto.randomBytes(32);
    const signers = [];

    for (let i = 0; i < signerCount; i++) {
      const wallet = ethers.Wallet.createRandom();
      signers.push({
        index: i,
        privateKey: wallet.privateKey,
        publicKey: wallet.publicKey,
        address: wallet.address,
      });
    }

    return {
      masterSeed: masterSeed.toString('hex'),
      signers,
    };
  }

  // Generate Ethereum multi-signature address
  async generateEthereumMultiSigAddress(walletKeys, threshold) {
    // In production, this would deploy a multi-sig contract
    const addresses = walletKeys.signers.map(s => s.address).sort();
    const combinedHash = crypto
      .createHash('sha256')
      .update(addresses.join('') + threshold.toString())
      .digest('hex');

    return '0x' + combinedHash.substring(0, 40);
  }

  // Generate WRF multi-signature address
  async generateWRFMultiSigAddress(walletKeys, threshold) {
    const publicKeys = walletKeys.signers.map(s => s.publicKey);
    const multisigScript = this.createMultiSigScript(publicKeys, threshold);
    const scriptHash = crypto
      .createHash('sha256')
      .update(multisigScript)
      .digest('hex');

    return 'wrf1' + scriptHash.substring(0, 39);
  }

  // Generate Bitcoin multi-signature address
  async generateBitcoinMultiSigAddress(walletKeys, threshold) {
    const publicKeys = walletKeys.signers.map(s => s.publicKey);
    const redeemScript = this.createBitcoinRedeemScript(publicKeys, threshold);
    const scriptHash = crypto
      .createHash('sha256')
      .update(redeemScript, 'hex')
      .digest('hex');

    return '3' + scriptHash.substring(0, 33); // P2SH address
  }

  // Create multi-signature script
  createMultiSigScript(publicKeys, threshold) {
    // Simplified multi-sig script creation
    return `${threshold}${publicKeys.join('')}${publicKeys.length}CHECKMULTISIG`;
  }

  // Create Bitcoin redeem script
  createBitcoinRedeemScript(publicKeys, threshold) {
    // Simplified Bitcoin redeem script
    const script = [
      threshold + 80, // OP_2, OP_3, etc.
      ...publicKeys.map(pk => pk.length + pk),
      publicKeys.length + 80, // OP_2, OP_3, etc.
      174, // OP_CHECKMULTISIG
    ];

    return Buffer.from(script).toString('hex');
  }

  // Calculate security level
  calculateSecurityLevel(config) {
    let score = 0;

    // Threshold scoring
    const thresholdRatio = config.threshold / config.signers.length;
    if (thresholdRatio >= 0.67) score += 30;
    else if (thresholdRatio >= 0.5) score += 20;
    else score += 10;

    // Number of signers
    if (config.signers.length >= 5) score += 25;
    else if (config.signers.length >= 3) score += 20;
    else score += 15;

    // Additional security features
    if (config.custodyInsurance) score += 15;
    if (config.hwsm) score += 20; // Hardware Security Module
    if (config.timelock) score += 10;

    if (score >= 80) return 'enterprise';
    if (score >= 60) return 'high';
    if (score >= 40) return 'medium';
    return 'basic';
  }

  // Initialize threshold policies
  async initializeThresholdPolicies(walletId, config) {
    const policies = {
      daily_limit: config.dailyLimit || 1000000, // WRF tokens
      transaction_limit: config.transactionLimit || 100000,
      cooling_period: config.coolingPeriod || 3600000, // 1 hour in ms
      emergency_threshold: Math.ceil(config.signers.length * 0.8),
      high_value_threshold: config.highValueThreshold || 50000,
    };

    this.thresholdPolicies.set(walletId, policies);
    return policies;
  }

  // Validate transaction against policies
  async validateTransactionPolicies(walletId, transaction) {
    const policies = this.thresholdPolicies.get(walletId);
    if (!policies) return true;

    const amount = parseFloat(transaction.amount);

    // Check transaction limits
    if (amount > policies.transaction_limit) {
      throw new Error(
        `Transaction amount exceeds limit: ${policies.transaction_limit}`
      );
    }

    // Check daily limits
    const dailyVolume = await this.calculateDailyVolume(walletId);
    if (dailyVolume + amount > policies.daily_limit) {
      throw new Error(
        `Transaction would exceed daily limit: ${policies.daily_limit}`
      );
    }

    return true;
  }

  // Generate transaction hash
  generateTransactionHash(transaction) {
    const txData = {
      walletId: transaction.walletId,
      type: transaction.type,
      to: transaction.to,
      amount: transaction.amount,
      currency: transaction.currency,
      timestamp: transaction.initiatedAt,
    };

    return crypto
      .createHash('sha256')
      .update(JSON.stringify(txData))
      .digest('hex');
  }

  // Generate signature
  async generateSignature(hash, privateKey) {
    if (!privateKey) {
      throw new Error('Private key is required for signature generation');
    }
    // In production, this would use actual cryptographic signing
    return crypto
      .createHmac('sha256', privateKey)
      .update(hash)
      .digest('hex');
  }

  // Verify all signatures
  async verifyAllSignatures(transaction) {
    const txHash = this.generateTransactionHash(transaction);
    const wallet = this.wallets.get(transaction.walletId);

    for (const signature of transaction.signatures) {
      const signer = wallet?.signers?.find(s => s.id === signature.signerId);
      if (!signer?.privateKey) {
        return {
          valid: false,
          reason: `Cannot verify signature: signer ${signature.signerId} key not available`,
        };
      }
      const expectedSignature = await this.generateSignature(
        txHash,
        signer.privateKey
      );
      if (!signature.signature || signature.signature !== expectedSignature) {
        return {
          valid: false,
          reason: `Invalid signature from ${signature.signerId}`,
        };
      }
    }

    return { valid: true };
  }

  // Execute transfer
  async executeTransfer(transaction, wallet) {
    // Simulate blockchain transaction
    const txHash = crypto.randomBytes(32).toString('hex');

    return {
      type: 'transfer',
      txHash: `0x${txHash}`,
      from:
        wallet.addresses[transaction.currency.toLowerCase()] ||
        wallet.addresses.ethereum,
      to: transaction.to,
      amount: transaction.amount,
      currency: transaction.currency,
      gasUsed: 21000,
      fee: '0.001',
      timestamp: new Date().toISOString(),
    };
  }

  // Execute smart contract interaction
  async executeSmartContract(transaction, wallet) {
    const txHash = crypto.randomBytes(32).toString('hex');

    return {
      type: 'smart_contract',
      txHash: `0x${txHash}`,
      contract: transaction.to,
      function: transaction.data.function,
      parameters: transaction.data.parameters,
      gasUsed: 150000,
      fee: '0.005',
      timestamp: new Date().toISOString(),
    };
  }

  // Execute custody operation
  async executeCustodyOperation(transaction, wallet) {
    return {
      type: 'custody_operation',
      operation: transaction.data.operation,
      status: 'completed',
      timestamp: new Date().toISOString(),
    };
  }

  // Get pending signers
  getPendingSigners(walletId, transaction) {
    const wallet = this.wallets.get(walletId);
    const signedBy = transaction.signatures.map(s => s.signerId);

    return wallet.signers
      .filter(s => !signedBy.includes(s.id))
      .map(s => ({
        id: s.id,
        name: s.name,
        role: s.role,
      }));
  }

  // Calculate daily volume
  async calculateDailyVolume(walletId) {
    // In production, would query transaction history
    return 0;
  }

  // Sanitize wallet for response
  sanitizeWalletForResponse(wallet) {
    const { signers, ...sanitized } = wallet;
    sanitized.signers = signers.map(s => ({
      id: s.id,
      name: s.name,
      role: s.role,
      permissions: s.permissions,
      // Remove publicKey for security
    }));
    return sanitized;
  }

  // Log custody activity
  async logCustodyActivity(activity, data) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      activity,
      data,
      id: crypto.randomUUID(),
    };

    this.auditLog.push(logEntry);
    walletLogger.info('Custody Activity', { activity, ...data });
  }

  // Get wallet status
  getWalletStatus(walletId) {
    const wallet = this.wallets.get(walletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    const pendingTransactions = Array.from(
      this.pendingTransactions.values()
    ).filter(tx => tx.walletId === walletId);

    return {
      wallet: this.sanitizeWalletForResponse(wallet),
      pendingTransactions: pendingTransactions.length,
      lastActivity: wallet.lastActivity,
      securityLevel: wallet.securityLevel,
    };
  }

  // Get pending transactions for wallet
  getPendingTransactions(walletId) {
    return Array.from(this.pendingTransactions.values())
      .filter(tx => tx.walletId === walletId)
      .map(tx => ({
        id: tx.id,
        type: tx.type,
        amount: tx.amount,
        currency: tx.currency,
        initiatedBy: tx.initiatedBy,
        initiatedAt: tx.initiatedAt,
        requiredSignatures: tx.requiredSignatures,
        currentSignatures: tx.signatures.length,
        status: tx.status,
        expiresAt: tx.expiresAt,
      }));
  }
}

// Express middleware
const multiSigManager = new MultiSignatureWalletManager();

const multiSigMiddleware = {
  createWallet: async (req, res, next) => {
    try {
      const config = req.body;
      const result = await multiSigManager.createMultiSigWallet(config);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  initiateTransaction: async (req, res, next) => {
    try {
      const { walletId } = req.params;
      const transaction = req.body;
      const { userId } = req.user;

      const result = await multiSigManager.initiateMultiSigTransaction(
        walletId,
        transaction,
        userId
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  signTransaction: async (req, res, next) => {
    try {
      const { transactionId } = req.params;
      const { userId } = req.user;

      const result = await multiSigManager.addSignature(transactionId, userId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  getWalletStatus: async (req, res, next) => {
    try {
      const { walletId } = req.params;
      const status = multiSigManager.getWalletStatus(walletId);
      res.json(status);
    } catch (error) {
      next(error);
    }
  },

  getPendingTransactions: async (req, res, next) => {
    try {
      const { walletId } = req.params;
      const transactions = multiSigManager.getPendingTransactions(walletId);
      res.json({ transactions });
    } catch (error) {
      next(error);
    }
  },
};

module.exports = {
  MultiSignatureWalletManager,
  multiSigMiddleware,
  multiSigManager,
};
