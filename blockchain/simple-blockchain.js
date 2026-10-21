/**
 * Simple Blockchain Transaction Processor
 * Handles actual token transfers for single-node testnet
 */

const crypto = require('crypto');
const { blockchainLogger } = require('../server/utils/logger.js');

function generateTransactionHash() {
  return `0x${crypto.randomBytes(32).toString('hex')}`;
}

class SimpleBlockchain {
  constructor() {
    // In-memory wallet balances for testnet
    this.wallets = new Map();

    // Initialize wallets with current balances + weather station earnings
    this.wallets.set('wrf717d72395303fcb2aed4df368f32f1078d18e9cc', 7.5); // Primary wallet + 0.40 WRF from weather earnings
    this.wallets.set('wrffb8404050b3727122c74c74887eadccf080ab223', 3.5); // Secondary wallet
    this.wallets.set('wrfc_weather_collector_001', 0.0); // Weather collector (transferred out)

    // Transaction history
    this.transactions = [];

    // Add the weather station earnings transfer to transaction history
    this.transactions.push({
      hash: '0x3d5b3af6b7352ff6dc34acda4823db8bb3a1d9b7f3ae37e59def6427f0bb4d44',
      from: 'wrfc_weather_collector_001',
      to: 'wrf717d72395303fcb2aed4df368f32f1078d18e9cc',
      amount: 0.4,
      fee: 0.0004,
      memo: 'Weather Station Earnings Transfer',
      timestamp: new Date().toISOString(),
      status: 'confirmed',
      type: 'weather_earnings',
    });
  }

  getBalance(address) {
    return this.wallets.get(address) || 0;
  }

  processTransaction(from, to, amount, memo = '') {
    const transferAmount = parseFloat(amount);
    const fee = transferAmount * 0.001; // 0.1% fee
    const totalDeduction = transferAmount + fee;

    const fromBalance = this.getBalance(from);
    const toBalance = this.getBalance(to);

    // Check if sender has sufficient balance
    if (fromBalance < totalDeduction) {
      throw new Error(
        `Insufficient balance. Available: ${fromBalance} WRF, Required: ${totalDeduction} WRF`
      );
    }

    // Process the transfer
    this.wallets.set(from, fromBalance - totalDeduction);
    this.wallets.set(to, toBalance + transferAmount);

    // Generate transaction hash
    const txHash = generateTransactionHash();

    // Record transaction
    const transaction = {
      hash: txHash,
      from: from,
      to: to,
      amount: transferAmount,
      fee: fee,
      memo: memo,
      timestamp: new Date().toISOString(),
      status: 'confirmed',
      blockHeight: Math.floor(Math.random() * 1000) + 1000,
    };

    this.transactions.push(transaction);

    blockchainLogger.info('Blockchain processed transaction', {
      component: 'simple-blockchain',
      txHash,
      from,
      to,
      amount: transferAmount,
      fee: fee.toFixed(6),
      fromBalance: this.getBalance(from).toFixed(2),
      toBalance: this.getBalance(to).toFixed(2),
    });

    return transaction;
  }

  getTransactionHistory(address) {
    return this.transactions
      .filter(tx => tx.from === address || tx.to === address)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  getAllBalances() {
    const balances = {};
    for (const [address, balance] of this.wallets) {
      balances[address] = balance;
    }
    return balances;
  }

  addTokensFromMining(address, amount, source = 'mining') {
    const currentBalance = this.getBalance(address);
    this.wallets.set(address, currentBalance + amount);

    blockchainLogger.info('Added tokens from mining', {
      component: 'simple-blockchain',
      address,
      amount,
      source,
      newBalance: this.getBalance(address).toFixed(2),
    });

    return this.getBalance(address);
  }
}

// Generate transaction ID
function generateTransactionId() {
  return generateTransactionHash();
}

// Execute transfer function for API
async function executeTransfer(transferData) {
  try {
    const { fromAddress, toAddress, amount, transactionId, description } =
      transferData;

    // Handle weather station earnings pool
    if (fromAddress === 'weather_station_pool') {
      // For weather station transfers, we don't need to check balance
      // since we're adding new tokens to the economy
      const currentBalance = blockchain.getBalance(toAddress);
      blockchain.wallets.set(toAddress, currentBalance + amount);

      // Add transaction to history
      blockchain.transactions.push({
        hash: transactionId,
        from: 'Weather Station Pool',
        to: toAddress,
        amount: amount,
        fee: 0,
        memo: description,
        timestamp: new Date().toISOString(),
        status: 'confirmed',
        type: 'weather_earnings',
      });

      blockchainLogger.info('Weather earnings transfer completed', {
        component: 'simple-blockchain',
        amount,
        toAddress,
        transactionId,
        newBalance: blockchain.getBalance(toAddress).toFixed(3),
      });

      return {
        success: true,
        transactionId,
        newBalance: blockchain.getBalance(toAddress),
      };
    }

    // For regular transfers, use existing processTransaction method
    const result = blockchain.processTransaction(
      fromAddress,
      toAddress,
      amount,
      description
    );
    return {
      success: true,
      transactionId: result.hash,
      newBalance: blockchain.getBalance(toAddress),
    };
  } catch (error) {
    blockchainLogger.error('Transfer execution failed', {
      component: 'simple-blockchain',
      error: error.message,
    });
    return { success: false, error: error.message };
  }
}

// Export singleton instance and functions
const blockchain = new SimpleBlockchain();
module.exports = {
  blockchain,
  executeTransfer,
  generateTransactionId,
  generateTransactionHash,
  getBalance: blockchain.getBalance.bind(blockchain),
  processTransaction: blockchain.processTransaction.bind(blockchain),
  getTransactionHistory: blockchain.getTransactionHistory.bind(blockchain),
  getAllBalances: blockchain.getAllBalances.bind(blockchain),
  addTokensFromMining: blockchain.addTokensFromMining.bind(blockchain),
  wallets: blockchain.wallets,
  transactions: blockchain.transactions,
};
