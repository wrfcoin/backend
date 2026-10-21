'use strict';
const __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        let desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ('get' in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
const __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, 'default', { enumerable: true, value: v });
      }
    : function (o, v) {
        o['default'] = v;
      });
const __importStar =
  (this && this.__importStar) ||
  (function () {
    let ownKeys = function (o) {
      ownKeys =
        Object.getOwnPropertyNames ||
        function (o) {
          const ar = [];
          for (const k in o)
            if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
          return ar;
        };
      return ownKeys(o);
    };
    return function (mod) {
      if (mod && mod.__esModule) return mod;
      const result = {};
      if (mod != null)
        for (let k = ownKeys(mod), i = 0; i < k.length; i++)
          if (k[i] !== 'default') __createBinding(result, mod, k[i]);
      __setModuleDefault(result, mod);
      return result;
    };
  })();
const __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, '__esModule', { value: true });
const crypto = __importStar(require('crypto'));
const express_1 = __importDefault(require('express'));
// Middleware imports
const SecurityStandardization = require('../middleware/security-standardization');
const ProductionCORSCleanup = require('../middleware/production-cors-cleanup');
const {
  transferValidation,
  weatherValidation,
  basicValidation,
} = require('../middleware/input-validation');
// Enhanced blockchain integration
const blockchain = require('../blockchain/simple-blockchain');
const enhanced_blockchain_service_1 = require('../blockchain/enhanced-blockchain-service');
/**
 * Main API Server for Wrfcoin Core
 * Handles all core API endpoints with TypeScript type safety
 */
// Express app configuration
const app = (0, express_1.default)();
const PORT = parseInt(process.env.PORT || '4001', 10);
// Security middleware
ProductionCORSCleanup.autoConfigureCORS(app, {
  customOrigins: [/\.replit\.dev$/],
});
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
// Type-safe response helper
function createApiResponse(data, meta) {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
    meta,
  };
}
function createApiError(code, message, details) {
  return {
    success: false,
    error: {
      code,
      message,
      details,
    },
    timestamp: new Date().toISOString(),
  };
}
// Dashboard Stats API endpoint
app.get('/api/stats', async (req, res) => {
  try {
    const stats =
      await enhanced_blockchain_service_1.enhancedBlockchainService.getDashboardStats();
    res.json(createApiResponse(stats));
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res
      .status(500)
      .json(
        createApiError('STATS_ERROR', 'Failed to fetch dashboard stats', error)
      );
  }
});
// NFT Marketplace API endpoints
app.get('/api/nft/marketplace', (req, res) => {
  try {
    const marketplace = {
      totalNFTs: 15643,
      activeListings: 892,
      floorPrice: '0.25 WRF',
      volume24h: '125,892 WRF',
      topCollections: [
        {
          id: 'climate_oracles',
          name: 'Climate Data Oracles',
          floorPrice: '2.5 WRF',
          volume: '45,892 WRF',
          owners: 1250,
        },
        {
          id: 'weather_stations',
          name: 'Weather Station Nodes',
          floorPrice: '1.8 WRF',
          volume: '32,156 WRF',
          owners: 890,
        },
      ],
    };
    res.json(createApiResponse(marketplace));
  } catch (error) {
    res
      .status(500)
      .json(
        createApiError(
          'NFT_MARKETPLACE_ERROR',
          'Failed to fetch NFT marketplace data',
          error
        )
      );
  }
});
// Individual NFT endpoint
app.get('/api/nft/:tokenId', (req, res) => {
  try {
    const { tokenId } = req.params;
    const nft = {
      tokenId,
      name: `Climate Data Oracle #${tokenId}`,
      description: 'A computational NFT that processes real-time weather data',
      image: `/api/nft/image/${tokenId}`,
      price: '2.5 WRF',
      owner: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
      collection: 'climate_oracles',
      attributes: [
        { trait_type: 'Computational Power', value: '150 GH/s', rarity: 85 },
        { trait_type: 'Data Sources', value: 12, rarity: 60 },
        { trait_type: 'Accuracy Rating', value: '99.8%', rarity: 95 },
      ],
    };
    res.json(createApiResponse(nft));
  } catch (error) {
    res
      .status(500)
      .json(createApiError('NFT_ERROR', 'Failed to fetch NFT details', error));
  }
});
// Weather Data Submission endpoint
app.post('/api/weather/submit', weatherValidation, async (req, res) => {
  try {
    const weatherData = req.body;
    // Validate weather data structure
    if (
      !weatherData.stationId ||
      !weatherData.temperature ||
      !weatherData.humidity
    ) {
      return res
        .status(400)
        .json(
          createApiError(
            'INVALID_WEATHER_DATA',
            'Missing required weather data fields'
          )
        );
    }
    const reward =
      await enhanced_blockchain_service_1.enhancedBlockchainService.processWeatherReward(
        weatherData
      );
    return res.json(createApiResponse(reward));
  } catch (error) {
    console.error('Weather submission error:', error);
    res
      .status(500)
      .json(
        createApiError(
          'WEATHER_SUBMISSION_ERROR',
          'Failed to process weather data',
          error
        )
      );
  }
});
// Cross-chain bridge endpoints
app.get('/api/bridges', (req, res) => {
  try {
    const bridges = [
      {
        id: 'ethereum_bridge',
        name: 'Ethereum Bridge',
        sourceChain: 'WRF',
        targetChain: 'Ethereum',
        tvl: '2,450,000 WRF',
        status: 'active',
        fee: '0.1%',
      },
      {
        id: 'polygon_bridge',
        name: 'Polygon Bridge',
        sourceChain: 'WRF',
        targetChain: 'Polygon',
        tvl: '1,200,000 WRF',
        status: 'active',
        fee: '0.05%',
      },
      {
        id: 'bsc_bridge',
        name: 'BSC Bridge',
        sourceChain: 'WRF',
        targetChain: 'BSC',
        tvl: '890,000 WRF',
        status: 'maintenance',
        fee: '0.08%',
      },
    ];
    res.json(createApiResponse(bridges));
  } catch (error) {
    res
      .status(500)
      .json(
        createApiError(
          'BRIDGES_ERROR',
          'Failed to fetch bridge information',
          error
        )
      );
  }
});
// Cross-chain transaction endpoint
app.post('/api/bridges/transfer', transferValidation, async (req, res) => {
  try {
    const { to, amount, token } = req.body;
    // For now, create a blockchain transaction and then wrap it as cross-chain
    // In the future, this could integrate with actual cross-chain bridges
    const blockchainTx =
      await enhanced_blockchain_service_1.enhancedBlockchainService.createTransaction(
        {
          from: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234', // Default sender for bridge
          to,
          amount: parseFloat(amount),
          memo: 'Cross-chain bridge transfer',
        }
      );
    const transaction = {
      id: `bridge_${crypto.randomBytes(16).toString('hex')}`,
      sourceChain: 'WRF',
      targetChain: 'Ethereum',
      amount,
      token: token || 'WRF',
      status: 'pending',
      timestamp: new Date(),
      sourceHash: blockchainTx.hash,
    };
    res.json(createApiResponse(transaction));
  } catch (error) {
    console.error('Bridge transfer error:', error);
    res
      .status(500)
      .json(
        createApiError(
          'BRIDGE_TRANSFER_ERROR',
          'Failed to initiate cross-chain transfer',
          error
        )
      );
  }
});
// Governance endpoints
app.get('/api/governance/proposals', (req, res) => {
  try {
    const proposals = [
      {
        id: 'prop_001',
        title: 'Increase Weather Data Rewards',
        description:
          'Proposal to increase base weather data submission rewards from 0.1 WRF to 0.2 WRF',
        proposer: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        status: 'active',
        votesFor: 125000,
        votesAgainst: 45000,
        startDate: new Date('2025-06-15'),
        endDate: new Date('2025-06-25'),
      },
      {
        id: 'prop_002',
        title: 'New Cross-Chain Bridge Integration',
        description: 'Add support for Arbitrum bridge with 0.05% fee structure',
        proposer: '0x8ba1f109551bD432803012645Hac136c82416aF8',
        status: 'passed',
        votesFor: 89000,
        votesAgainst: 23000,
        startDate: new Date('2025-06-10'),
        endDate: new Date('2025-06-20'),
        executionDate: new Date('2025-06-21'),
      },
    ];
    res.json(createApiResponse(proposals));
  } catch (error) {
    res
      .status(500)
      .json(
        createApiError(
          'GOVERNANCE_ERROR',
          'Failed to fetch governance proposals',
          error
        )
      );
  }
});
// Vote submission endpoint
app.post('/api/governance/vote', basicValidation, (req, res) => {
  try {
    const { proposalId, support, reason } = req.body;
    const vote = {
      proposalId,
      voter: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
      support,
      weight: 1000,
      timestamp: new Date(),
    };
    res.json(createApiResponse(vote, { reason }));
  } catch (error) {
    res
      .status(500)
      .json(createApiError('VOTE_ERROR', 'Failed to submit vote', error));
  }
});
// Mining statistics endpoint
app.get('/api/mining/stats', async (req, res) => {
  try {
    const stats =
      await enhanced_blockchain_service_1.enhancedBlockchainService.getMiningStats();
    res.json(createApiResponse(stats));
  } catch (error) {
    console.error('Mining stats error:', error);
    res
      .status(500)
      .json(
        createApiError(
          'MINING_STATS_ERROR',
          'Failed to fetch mining statistics',
          error
        )
      );
  }
});
// Mining pools endpoint
app.get('/api/mining/pools', (req, res) => {
  try {
    const pools = [
      {
        id: 'wrfpool_01',
        name: 'WRF Pool Alpha',
        hashrate: '450 TH/s',
        miners: 1245,
        fee: '1.5%',
        payoutScheme: 'PPLNS',
      },
      {
        id: 'weathermine_02',
        name: 'WeatherMine Pro',
        hashrate: '380 TH/s',
        miners: 890,
        fee: '2.0%',
        payoutScheme: 'PPS',
      },
    ];
    res.json(createApiResponse(pools));
  } catch (error) {
    res
      .status(500)
      .json(
        createApiError(
          'MINING_POOLS_ERROR',
          'Failed to fetch mining pools',
          error
        )
      );
  }
});
// Wallet balance endpoint
app.get('/api/wallet/:address', async (req, res) => {
  try {
    const { address } = req.params;
    // Support both Ethereum format and WRF format addresses
    if (!/^(0x[a-fA-F0-9]{40}|wrf[a-zA-Z0-9]{35,40})$/.test(address)) {
      return res
        .status(400)
        .json(createApiError('INVALID_ADDRESS', 'Invalid address format'));
    }
    const walletBalance =
      await enhanced_blockchain_service_1.enhancedBlockchainService.getWalletBalance(
        address
      );
    return res.json(createApiResponse(walletBalance));
  } catch (error) {
    console.error('Wallet balance error:', error);
    res
      .status(500)
      .json(
        createApiError('WALLET_ERROR', 'Failed to fetch wallet balance', error)
      );
  }
});
// Transaction history endpoint with pagination
app.get('/api/transactions', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sortBy = 'timestamp',
      sortOrder = 'desc',
      address,
    } = req.query;
    // Validate pagination parameters
    const validatedPage = Math.max(1, Number(page));
    const validatedLimit = Math.min(100, Math.max(1, Number(limit)));
    let transactions;
    if (address) {
      // Get transactions for specific address
      transactions =
        await enhanced_blockchain_service_1.enhancedBlockchainService.getTransactionHistory(
          address,
          validatedPage,
          validatedLimit
        );
    } else {
      // For global transaction history, we'll need to implement this in the enhanced service
      // For now, fallback to a default address or mock data
      transactions =
        await enhanced_blockchain_service_1.enhancedBlockchainService.getTransactionHistory(
          'wrf717d72395303fcb2aed4df368f32f1078d18e9cc', // Default to primary wallet
          validatedPage,
          validatedLimit
        );
    }
    const total = transactions.length > 0 ? 1500 : 0; // Estimated total
    const totalPages = Math.ceil(total / validatedLimit);
    const response = {
      data: transactions,
      pagination: {
        page: validatedPage,
        limit: validatedLimit,
        total,
        totalPages,
        hasNext: validatedPage < totalPages,
        hasPrev: validatedPage > 1,
      },
    };
    res.json(createApiResponse(response));
  } catch (error) {
    console.error('Transaction history error:', error);
    res
      .status(500)
      .json(
        createApiError(
          'TRANSACTIONS_ERROR',
          'Failed to fetch transaction history',
          error
        )
      );
  }
});
// Network information endpoint
app.get('/api/network/info', async (req, res) => {
  try {
    const networkInfo =
      await enhanced_blockchain_service_1.enhancedBlockchainService.getNetworkInfo();
    res.json(createApiResponse(networkInfo));
  } catch (error) {
    console.error('Network info error:', error);
    res
      .status(500)
      .json(
        createApiError(
          'NETWORK_INFO_ERROR',
          'Failed to fetch network information',
          error
        )
      );
  }
});
// Validators endpoint
app.get('/api/validators', async (req, res) => {
  try {
    const validators =
      await enhanced_blockchain_service_1.enhancedBlockchainService.getValidators();
    res.json(createApiResponse(validators));
  } catch (error) {
    console.error('Validators error:', error);
    res
      .status(500)
      .json(
        createApiError(
          'VALIDATORS_ERROR',
          'Failed to fetch validator information',
          error
        )
      );
  }
});
// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const blockchainHealth =
      await enhanced_blockchain_service_1.enhancedBlockchainService.getHealthStatus();
    const health = {
      status: blockchainHealth.status,
      timestamp: new Date().toISOString(),
      services: {
        api: 'healthy',
        ...blockchainHealth.services,
      },
    };
    res.json(createApiResponse(health));
  } catch (error) {
    console.error('Health check error:', error);
    res
      .status(500)
      .json(createApiError('HEALTH_CHECK_ERROR', 'Health check failed', error));
  }
});
// Helper function to calculate weather data quality score
function calculateWeatherQualityScore(weatherData) {
  let score = 60; // Base score
  // Temperature validation
  if (weatherData.temperature >= -50 && weatherData.temperature <= 60) {
    score += 10;
  }
  // Humidity validation
  if (weatherData.humidity >= 0 && weatherData.humidity <= 100) {
    score += 10;
  }
  // Pressure validation
  if (weatherData.pressure >= 900 && weatherData.pressure <= 1100) {
    score += 10;
  }
  // Additional sensor bonus
  if (weatherData.windSpeed !== undefined) score += 5;
  if (weatherData.windDirection !== undefined) score += 5;
  if (weatherData.rainfall !== undefined) score += 5;
  return Math.min(score, 100);
}
// Global error handler
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json(
    createApiError('INTERNAL_SERVER_ERROR', 'An unexpected error occurred', {
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    })
  );
});
// 404 handler
app.use('*', (req, res) => {
  res
    .status(404)
    .json(createApiError('NOT_FOUND', `Endpoint ${req.originalUrl} not found`));
});
// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `🚀 Wrfcoin Core API Server (TypeScript) running on http://0.0.0.0:${PORT}`
  );
  console.log(`📡 Server accessible at http://0.0.0.0:${PORT}`);
  console.log(`🔗 Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`📊 Dashboard stats: http://0.0.0.0:${PORT}/api/stats`);
  console.log('🎯 TypeScript migration Phase 1 complete - Main API Server');
});
exports.default = app;
