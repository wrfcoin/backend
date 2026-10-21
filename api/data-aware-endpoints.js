/**
 * Data-Aware Block API Endpoints
 * Provides REST API for hybrid on-chain/off-chain data operations
 */

const express = require('express');
const IPFSIntegration = require('../middleware/ipfs-integration');
const DataAwareBlocks = require('../middleware/data-aware-blocks');
const { blockchainLogger } = require('../server/utils/logger');

const router = express.Router();
const ipfs = new IPFSIntegration();
const dataAwareBlocks = new DataAwareBlocks();

/**
 * Store data with IPFS and create on-chain attestation
 */
router.post('/store', async (req, res) => {
  try {
    const { data, metadata } = req.body;

    if (!data) {
      return res.status(400).json({ error: 'Data is required' });
    }

    // Additional input validation
    if (typeof data !== 'object' || data === null) {
      return res.status(400).json({ error: 'data must be a non-null object' });
    }
    if (metadata !== undefined) {
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
        return res.status(400).json({ error: 'metadata must be an object' });
      }
      if (metadata.stationId !== undefined && (typeof metadata.stationId !== 'string' || metadata.stationId.length > 100)) {
        return res.status(400).json({ error: 'metadata.stationId must be a string under 100 chars' });
      }
      if (metadata.type !== undefined && (typeof metadata.type !== 'string' || metadata.type.length > 50)) {
        return res.status(400).json({ error: 'metadata.type must be a string under 50 chars' });
      }
    }

    // Store in IPFS
    const ipfsResult = await ipfs.storeWeatherData(
      data,
      metadata?.stationId || 'unknown'
    );

    // Create data-aware transaction
    const transaction = await dataAwareBlocks.createDataAwareTransaction(
      {
        type: metadata?.type || 'DATA_SUBMISSION',
        stationId: metadata?.stationId,
        timestamp: new Date().toISOString(),
      },
      data
    );

    res.json({
      success: true,
      transactionHash: transaction.hash,
      ipfsHash: ipfsResult.ipfsHash,
      contentHash: ipfsResult.contentHash,
      size: ipfsResult.size,
      compressionRatio: (
        ((ipfsResult.size - JSON.stringify(transaction).length) /
          ipfsResult.size) *
        100
      ).toFixed(2),
    });
  } catch (error) {
    blockchainLogger.error('Data storage error', { api: 'data-aware-endpoints', error: error.message });
    res
      .status(500)
      .json({ error: 'Failed to store data', details: error.message });
  }
});

/**
 * Retrieve complete data (on-chain + IPFS)
 */
router.get('/retrieve/:transactionHash', async (req, res) => {
  try {
    const { transactionHash } = req.params;

    // Input validation
    if (typeof transactionHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(transactionHash)) {
      return res.status(400).json({ error: 'transactionHash must be a valid 64-character hex string with 0x prefix' });
    }

    const completeData =
      await dataAwareBlocks.getCompleteTransactionData(transactionHash);

    res.json({
      success: true,
      transaction: completeData.onChainData,
      offChainData: completeData.offChainData,
      retrievedAt: completeData.retrievedAt,
    });
  } catch (error) {
    blockchainLogger.error('Data retrieval error', { api: 'data-aware-endpoints', error: error.message });
    res
      .status(404)
      .json({ error: 'Transaction not found', details: error.message });
  }
});

/**
 * Verify data integrity
 */
router.post('/verify/:transactionHash', async (req, res) => {
  try {
    const { transactionHash } = req.params;

    // Input validation
    if (typeof transactionHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(transactionHash)) {
      return res.status(400).json({ error: 'transactionHash must be a valid 64-character hex string with 0x prefix' });
    }

    const verification =
      await dataAwareBlocks.verifyDataIntegrity(transactionHash);

    res.json({
      success: true,
      verification: verification,
    });
  } catch (error) {
    blockchainLogger.error('Data verification error', { api: 'data-aware-endpoints', error: error.message });
    res
      .status(500)
      .json({ error: 'Verification failed', details: error.message });
  }
});

/**
 * Get storage statistics
 */
router.get('/stats', (req, res) => {
  try {
    const stats = dataAwareBlocks.getStorageStats();

    res.json({
      success: true,
      statistics: {
        ...stats,
        compressionRatio: `${stats.averageCompressionRatio.toFixed(2)}%`,
        dataSaved: `${(stats.totalDataSaved / 1024).toFixed(2)} KB`,
      },
    });
  } catch (error) {
    blockchainLogger.error('Statistics error', { api: 'data-aware-endpoints', error: error.message });
    res
      .status(500)
      .json({ error: 'Failed to get statistics', details: error.message });
  }
});

/**
 * Create weather attestation
 */
router.post('/attestation/weather', async (req, res) => {
  try {
    const { weatherData, stationId } = req.body;

    if (!weatherData || !stationId) {
      return res
        .status(400)
        .json({ error: 'weatherData and stationId are required' });
    }

    // Additional input validation
    if (typeof stationId !== 'string' || stationId.length === 0 || stationId.length > 100) {
      return res.status(400).json({ error: 'stationId must be a non-empty string under 100 chars' });
    }
    if (typeof weatherData !== 'object' || weatherData === null || Array.isArray(weatherData)) {
      return res.status(400).json({ error: 'weatherData must be an object' });
    }
    // Validate weather data fields if present
    if (weatherData.temperature !== undefined && (typeof weatherData.temperature !== 'number' || weatherData.temperature < -100 || weatherData.temperature > 100)) {
      return res.status(400).json({ error: 'weatherData.temperature must be a number between -100 and 100' });
    }
    if (weatherData.humidity !== undefined && (typeof weatherData.humidity !== 'number' || weatherData.humidity < 0 || weatherData.humidity > 100)) {
      return res.status(400).json({ error: 'weatherData.humidity must be a number between 0 and 100' });
    }
    if (weatherData.pressure !== undefined && (typeof weatherData.pressure !== 'number' || weatherData.pressure < 800 || weatherData.pressure > 1200)) {
      return res.status(400).json({ error: 'weatherData.pressure must be a number between 800 and 1200 hPa' });
    }

    // Store raw data in IPFS
    const ipfsResult = await ipfs.storeWeatherData(weatherData, stationId);

    // Create attestation
    const attestation = dataAwareBlocks.createWeatherAttestation(
      weatherData,
      ipfsResult.ipfsHash,
      ipfsResult.contentHash
    );

    res.json({
      success: true,
      attestation: attestation,
      ipfsReference: {
        hash: ipfsResult.ipfsHash,
        contentHash: ipfsResult.contentHash,
        size: ipfsResult.size,
      },
    });
  } catch (error) {
    blockchainLogger.error('Weather attestation error', { api: 'data-aware-endpoints', error: error.message });
    res
      .status(500)
      .json({ error: 'Failed to create attestation', details: error.message });
  }
});

/**
 * Health check for data-aware system
 */
router.get('/health', async (req, res) => {
  try {
    // Test IPFS connectivity
    const testData = {
      test: 'health_check',
      timestamp: new Date().toISOString(),
    };
    const testHash = await ipfs.storeWeatherData(testData, 'health_check');

    // Test retrieval
    const retrieved = await ipfs.retrieveData(testHash.ipfsHash);
    const isHealthy = retrieved.test === 'health_check';

    res.json({
      success: true,
      health: {
        ipfsConnectivity: isHealthy,
        dataAwareBlocks: true,
        storageStats: dataAwareBlocks.getStorageStats(),
      },
    });
  } catch (error) {
    blockchainLogger.error('Health check error', { api: 'data-aware-endpoints', error: error.message });
    res.json({
      success: false,
      health: {
        ipfsConnectivity: false,
        dataAwareBlocks: true,
        error: error.message,
      },
    });
  }
});

module.exports = router;
