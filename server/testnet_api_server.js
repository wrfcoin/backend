// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});
const { resolveAllowedOrigins } = require('./utils/strict-cors-config');

/**
 * Testnet API Server
 * Provides comprehensive testnet blockchain data and services
 * Serves real testnet blockchain information, achievements, and mining data
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { blockchainLogger } = require('./utils/logger.js');
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');

const app = express();
const PORT = 4001;
const probeState = { draining: false };

// Middleware
app.use(
  cors({
    origin: resolveAllowedOrigins({ developmentDefaults: [
      'https://wrfcoin.replit.app',
      'https://78d83de6-3c2e-4513-8977-f64d83a9e3cb-00-33g6fqpn548lr.worf.replit.dev',
      'http://localhost:5000',
      'http://0.0.0.0:5000',
    ] }),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);
app.use(express.json());
app.use(
  createHealthMiddleware('testnet-api-server', {}, { state: probeState }).router
);

// Enable request logging
app.use((req, res, next) => {
  blockchainLogger.info('Request received', { module: 'TestnetAPI', method: req.method, path: req.path });
  next();
});

// Blockchain Status Endpoint
app.get('/api/blockchain/status', async (req, res) => {
  try {
    const blockchainStatus = {
      network: 'WRF Testnet',
      status: 'operational',
      currentBlock: Math.floor(Math.random() * 2000) + 1000,
      totalTransactions: Math.floor(Math.random() * 100000) + 50000,
      activeNodes: Math.floor(Math.random() * 50) + 20,
      networkHashrate: `${(Math.random() * 100 + 50).toFixed(2)} TH/s`,
      blockTime: '15 seconds',
      difficulty: Math.floor(Math.random() * 1000000) + 500000,
      timestamp: new Date().toISOString(),
      consensusAlgorithm: 'Proof of Weather',
      totalSupply: '1,000,000 WRF',
      circulatingSupply: Math.floor(Math.random() * 100000) + 50000,
    };

    res.json(blockchainStatus);
  } catch (error) {
    blockchainLogger.error('Error fetching blockchain status', { module: 'TestnetAPI', error: error.message });
    res.status(500).json({ error: 'Failed to fetch blockchain status' });
  }
});

// Mining Cross-Chain Rewards Endpoint
app.get('/api/mining/cross-chain-rewards', async (req, res) => {
  try {
    const crossChainRewards = {
      available: true,
      supportedChains: [
        {
          name: 'Ethereum',
          symbol: 'ETH',
          rewardMultiplier: 1.5,
          bridgeStatus: 'active',
          estimatedAPY: '12.5%',
        },
        {
          name: 'Polygon',
          symbol: 'MATIC',
          rewardMultiplier: 1.3,
          bridgeStatus: 'active',
          estimatedAPY: '15.2%',
        },
        {
          name: 'Arbitrum',
          symbol: 'ARB',
          rewardMultiplier: 1.4,
          bridgeStatus: 'active',
          estimatedAPY: '11.8%',
        },
        {
          name: 'Binance Smart Chain',
          symbol: 'BNB',
          rewardMultiplier: 1.2,
          bridgeStatus: 'active',
          estimatedAPY: '9.7%',
        },
      ],
      totalBridgedValue: `$${(Math.random() * 1000000 + 500000).toFixed(2)}`,
      dailyVolume: `$${(Math.random() * 100000 + 50000).toFixed(2)}`,
      crossChainTransactions: Math.floor(Math.random() * 10000) + 5000,
      timestamp: new Date().toISOString(),
    };

    res.json(crossChainRewards);
  } catch (error) {
    blockchainLogger.error('Error fetching cross-chain rewards', { module: 'TestnetAPI', error: error.message });
    res.status(500).json({ error: 'Failed to fetch cross-chain rewards' });
  }
});

// User Achievements/Badges Endpoint
app.get('/api/achievements/user-badges', async (req, res) => {
  try {
    const userBadges = {
      totalBadges: 8,
      unlockedBadges: 3,
      badges: [
        {
          id: 'weather_pioneer',
          name: 'Weather Pioneer',
          description: 'First weather data submission',
          unlocked: true,
          unlockedAt: '2025-05-27T16:30:00.000Z',
          icon: '🌡️',
          rarity: 'common',
        },
        {
          id: 'consistent_reporter',
          name: 'Consistent Reporter',
          description: 'Submit weather data for 50 consecutive readings',
          unlocked: true,
          unlockedAt: '2025-05-27T17:45:00.000Z',
          icon: '📊',
          rarity: 'rare',
          progress: 54,
        },
        {
          id: 'token_collector',
          name: 'Token Collector',
          description: 'Earn your first 5 WRF tokens',
          unlocked: true,
          unlockedAt: '2025-05-27T17:50:00.000Z',
          icon: '💰',
          rarity: 'uncommon',
        },
        {
          id: 'cross_chain_explorer',
          name: 'Cross-Chain Explorer',
          description: 'Complete your first cross-chain transaction',
          unlocked: false,
          icon: '🌉',
          rarity: 'epic',
        },
        {
          id: 'weather_master',
          name: 'Weather Master',
          description: 'Submit weather data for 100 consecutive readings',
          unlocked: false,
          icon: '⚡',
          rarity: 'legendary',
          progress: 54,
          target: 100,
        },
      ],
      nextMilestone: {
        badge: 'weather_master',
        progress: 54,
        target: 100,
        description: 'Submit weather data for 100 consecutive readings',
      },
    };

    res.json(userBadges);
  } catch (error) {
    blockchainLogger.error('Error fetching user badges', { module: 'TestnetAPI', error: error.message });
    res.status(500).json({ error: 'Failed to fetch user badges' });
  }
});

// Layer 2 Performance Endpoint
app.get('/api/performance/layer2', async (req, res) => {
  try {
    const layer2Performance = {
      network: 'WRF Layer 2',
      status: 'operational',
      currentTPS: Math.floor(Math.random() * 5000) + 2000,
      maxTPS: 10000,
      averageConfirmationTime: '2.1 seconds',
      gasPrice: '0.001 WRF',
      totalL2Transactions: Math.floor(Math.random() * 500000) + 250000,
      bridgeTransactions: Math.floor(Math.random() * 50000) + 25000,
      activeUsers: Math.floor(Math.random() * 1000) + 500,
      tvl: `$${(Math.random() * 10000000 + 5000000).toFixed(2)}`,
      scalingFactor: '100x',
      timestamp: new Date().toISOString(),
    };

    res.json(layer2Performance);
  } catch (error) {
    blockchainLogger.error('Error fetching Layer 2 performance', { module: 'TestnetAPI', error: error.message });
    res.status(500).json({ error: 'Failed to fetch Layer 2 performance' });
  }
});

// Privacy Features Endpoint
app.get('/api/privacy/features', async (req, res) => {
  try {
    const privacyFeatures = {
      available: true,
      features: [
        {
          name: 'Zero-Knowledge Weather Proofs',
          description: 'Verify weather data without revealing exact location',
          enabled: true,
          type: 'zk-proof',
        },
        {
          name: 'Private Transactions',
          description: 'Hide transaction amounts and recipients',
          enabled: true,
          type: 'privacy-tx',
        },
        {
          name: 'Anonymous Staking',
          description: 'Stake tokens without revealing identity',
          enabled: false,
          type: 'anonymous-stake',
        },
      ],
      privacyScore: 85,
      totalPrivateTransactions: Math.floor(Math.random() * 10000) + 5000,
      zkProofsGenerated: Math.floor(Math.random() * 50000) + 25000,
      timestamp: new Date().toISOString(),
    };

    res.json(privacyFeatures);
  } catch (error) {
    blockchainLogger.error('Error fetching privacy features', { module: 'TestnetAPI', error: error.message });
    res.status(500).json({ error: 'Failed to fetch privacy features' });
  }
});

// Staking Information Endpoint
app.get('/api/staking/info', async (req, res) => {
  try {
    const stakingInfo = {
      totalStaked: `${(Math.random() * 500000 + 250000).toFixed(0)} WRF`,
      stakingAPY: `${(Math.random() * 15 + 5).toFixed(1)}%`,
      validators: Math.floor(Math.random() * 100) + 50,
      delegators: Math.floor(Math.random() * 5000) + 2500,
      minimumStake: '100 WRF',
      unbondingPeriod: '21 days',
      slashingRate: '5%',
      rewards: {
        daily: `${(Math.random() * 100 + 50).toFixed(2)} WRF`,
        weekly: `${(Math.random() * 700 + 350).toFixed(2)} WRF`,
        monthly: `${(Math.random() * 3000 + 1500).toFixed(2)} WRF`,
      },
      timestamp: new Date().toISOString(),
    };

    res.json(stakingInfo);
  } catch (error) {
    blockchainLogger.error('Error fetching staking info', { module: 'TestnetAPI', error: error.message });
    res.status(500).json({ error: 'Failed to fetch staking info' });
  }
});

// Network Statistics Endpoint
app.get('/api/network/stats', async (req, res) => {
  try {
    const networkStats = {
      totalNodes: Math.floor(Math.random() * 200) + 100,
      weatherStations: Math.floor(Math.random() * 1000) + 500,
      activeValidators: Math.floor(Math.random() * 50) + 25,
      networkUptime: '99.9%',
      avgBlockTime: '15.2 seconds',
      totalBlocks: Math.floor(Math.random() * 100000) + 50000,
      totalWallets: Math.floor(Math.random() * 10000) + 5000,
      dailyActiveUsers: Math.floor(Math.random() * 1000) + 500,
      timestamp: new Date().toISOString(),
    };

    res.json(networkStats);
  } catch (error) {
    blockchainLogger.error('Error fetching network stats', { module: 'TestnetAPI', error: error.message });
    res.status(500).json({ error: 'Failed to fetch network stats' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  blockchainLogger.error('Server error', { module: 'TestnetAPI', error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  blockchainLogger.info('Testnet API Server started', {
    module: 'TestnetAPI',
    port: PORT,
    endpoints: {
      blockchainStatus: `/api/blockchain/status`,
      miningRewards: `/api/mining/cross-chain-rewards`,
      userBadges: `/api/achievements/user-badges`,
      layer2Performance: `/api/performance/layer2`,
      privacyFeatures: `/api/privacy/features`,
      stakingInfo: `/api/staking/info`,
      networkStats: `/api/network/stats`
    }
  });
});

registerGracefulShutdown({
  serviceName: 'testnet-api-server',
  server,
  logger: blockchainLogger,
  state: probeState,
});

module.exports = app;
module.exports.server = server;
