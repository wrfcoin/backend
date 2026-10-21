/**
 * Data-Aware Blocks for Wrfcoin Blockchain
 * Enables on-chain storage of content hashes while keeping large data off-chain
 */

const crypto = require('crypto');
const IPFSIntegration = require('./ipfs-integration');
const { blockchainLogger } = require('../server/utils/logger');

class DataAwareBlocks {
  constructor() {
    this.ipfs = new IPFSIntegration();
    this.blockDataRegistry = new Map();
  }

  /**
   * Create a data-aware transaction with IPFS reference
   */
  async createDataAwareTransaction(transactionData, offChainData) {
    try {
      // Store large data in IPFS
      const ipfsResult = await this.ipfs.storeWeatherData(
        offChainData,
        transactionData.stationId || 'unknown'
      );

      // Create on-chain transaction with IPFS reference
      const dataAwareTransaction = {
        ...transactionData,
        dataReference: {
          ipfsHash: ipfsResult.ipfsHash,
          contentHash: ipfsResult.contentHash,
          size: ipfsResult.size,
          metadata: ipfsResult.metadata,
        },
        timestamp: new Date().toISOString(),
        version: 'wrfcoin-data-aware-v1',
      };

      // Generate transaction hash
      const txHash = this.generateTransactionHash(dataAwareTransaction);
      dataAwareTransaction.hash = txHash;

      // Register in local cache
      this.blockDataRegistry.set(txHash, {
        onChainData: dataAwareTransaction,
        ipfsReference: ipfsResult.ipfsHash,
        contentHash: ipfsResult.contentHash,
      });

      return dataAwareTransaction;
    } catch (error) {
      blockchainLogger.error('Data-aware transaction creation error', { error: error.message });
      throw error;
    }
  }

  /**
   * Create a data-aware block with multiple transaction references
   */
  async createDataAwareBlock(blockData, transactions) {
    try {
      const dataReferences = [];

      for (const tx of transactions) {
        if (tx.dataReference) {
          dataReferences.push({
            transactionHash: tx.hash,
            ipfsHash: tx.dataReference.ipfsHash,
            contentHash: tx.dataReference.contentHash,
            size: tx.dataReference.size,
          });
        }
      }

      // Create Merkle root of all data references
      const merkleRoot = this.createMerkleRoot(dataReferences);

      const dataAwareBlock = {
        ...blockData,
        dataAware: {
          enabled: true,
          dataReferences: dataReferences,
          merkleRoot: merkleRoot,
          totalOffChainSize: dataReferences.reduce(
            (sum, ref) => sum + ref.size,
            0
          ),
          version: 'wrfcoin-data-aware-v1',
        },
        transactions: transactions.map(tx => ({
          ...tx,
          // Keep only essential data on-chain
          data: tx.dataReference ? 'STORED_OFF_CHAIN' : tx.data,
        })),
      };

      return dataAwareBlock;
    } catch (error) {
      blockchainLogger.error('Data-aware block creation error', { error: error.message });
      throw error;
    }
  }

  /**
   * Verify data integrity across on-chain and off-chain storage
   */
  async verifyDataIntegrity(transactionHash) {
    try {
      const registry = this.blockDataRegistry.get(transactionHash);
      if (!registry) {
        throw new Error('Transaction not found in registry');
      }

      // Verify IPFS data integrity
      const isValid = await this.ipfs.verifyDataIntegrity(
        registry.ipfsReference,
        registry.contentHash
      );

      return {
        transactionHash,
        ipfsHash: registry.ipfsReference,
        contentHash: registry.contentHash,
        isValid,
        verifiedAt: new Date().toISOString(),
      };
    } catch (error) {
      blockchainLogger.error('Data integrity verification error', { transactionHash, error: error.message });
      return {
        transactionHash,
        isValid: false,
        error: error.message,
        verifiedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Retrieve complete transaction data (on-chain + off-chain)
   */
  async getCompleteTransactionData(transactionHash) {
    try {
      const registry = this.blockDataRegistry.get(transactionHash);
      if (!registry) {
        throw new Error('Transaction not found in registry');
      }

      // Get off-chain data from IPFS
      const offChainData = await this.ipfs.retrieveData(registry.ipfsReference);

      return {
        onChainData: registry.onChainData,
        offChainData: offChainData,
        combined: true,
        retrievedAt: new Date().toISOString(),
      };
    } catch (error) {
      blockchainLogger.error('Complete transaction data retrieval error', { transactionHash, error: error.message });
      throw error;
    }
  }

  /**
   * Create optimized weather attestation for on-chain storage
   */
  createWeatherAttestation(weatherData, ipfsHash, contentHash) {
    return {
      type: 'WEATHER_ATTESTATION',
      stationId: weatherData.stationId,
      timestamp: weatherData.timestamp,
      sensorCount: weatherData.readings ? weatherData.readings.length : 0,
      dataHash: contentHash,
      ipfsReference: ipfsHash,
      attestation: {
        temperature: weatherData.temperature,
        humidity: weatherData.humidity,
        pressure: weatherData.pressure,
        // Only critical values for on-chain verification
        checksum: this.generateChecksum(weatherData),
      },
      signature: this.signAttestation(weatherData),
    };
  }

  /**
   * Generate transaction hash
   */
  generateTransactionHash(transaction) {
    const hashData = JSON.stringify({
      ...transaction,
      hash: undefined, // Exclude hash from hash calculation
    });
    return crypto.createHash('sha256').update(hashData).digest('hex');
  }

  /**
   * Create Merkle root for data references
   */
  createMerkleRoot(dataReferences) {
    if (dataReferences.length === 0) return null;

    const hashes = dataReferences.map(ref => ref.contentHash);
    return this.ipfs.createMerkleProof(hashes);
  }

  /**
   * Generate checksum for weather data validation
   */
  generateChecksum(weatherData) {
    const criticalFields = {
      temperature: weatherData.temperature,
      humidity: weatherData.humidity,
      pressure: weatherData.pressure,
      timestamp: weatherData.timestamp,
    };
    return crypto
      .createHash('md5')
      .update(JSON.stringify(criticalFields))
      .digest('hex');
  }

  /**
   * Sign attestation (simplified for demo)
   */
  signAttestation(weatherData) {
    const signature = crypto
      .createHash('sha256')
      .update(JSON.stringify(weatherData) + 'wrfcoin-secret')
      .digest('hex');
    return signature.substring(0, 16);
  }

  /**
   * Get storage statistics
   */
  getStorageStats() {
    const entries = Array.from(this.blockDataRegistry.values());
    return {
      totalTransactions: entries.length,
      totalOffChainReferences: entries.filter(e => e.ipfsReference).length,
      averageCompressionRatio: this.calculateCompressionRatio(entries),
      totalDataSaved: this.calculateDataSaved(entries),
    };
  }

  /**
   * Calculate compression ratio from using data-aware blocks
   */
  calculateCompressionRatio(entries) {
    if (entries.length === 0) return 0;

    let onChainSize = 0;
    let offChainSize = 0;

    entries.forEach(entry => {
      onChainSize += JSON.stringify(entry.onChainData).length;
      offChainSize += entry.onChainData.dataReference?.size || 0;
    });

    return offChainSize > 0
      ? (offChainSize / (onChainSize + offChainSize)) * 100
      : 0;
  }

  /**
   * Calculate total data saved by off-chain storage
   */
  calculateDataSaved(entries) {
    return entries.reduce((total, entry) => {
      return total + (entry.onChainData.dataReference?.size || 0);
    }, 0);
  }

  /**
   * Batch verify multiple transactions
   */
  async batchVerifyIntegrity(transactionHashes) {
    const results = await Promise.all(
      transactionHashes.map(hash => this.verifyDataIntegrity(hash))
    );

    return {
      total: results.length,
      valid: results.filter(r => r.isValid).length,
      invalid: results.filter(r => !r.isValid).length,
      results: results,
    };
  }
}

module.exports = DataAwareBlocks;
