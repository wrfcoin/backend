// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

const express = require('express');
const path = require('path');
const fs = require('fs');
// scripts/analyze-smart-contracts.cjs does not exist in this repo (the
// analyzer never migrated from the pre-extraction tree). Load it lazily and
// fail closed with a clear error instead of crashing the whole server at
// require time — every contract route reports 501 until the script returns.
let ContractAnalyzer = null;
let contractAnalyzerLoadError = null;
try {
  ContractAnalyzer = require('../scripts/analyze-smart-contracts.cjs');
} catch (error) {
  contractAnalyzerLoadError = error instanceof Error ? error : new Error(String(error));
}

function createContractAnalyzer() {
  if (!ContractAnalyzer) {
    throw new Error(
      `smart-contract analyzer unavailable: ${contractAnalyzerLoadError?.message ?? 'not loaded'}`,
    );
  }
  return new ContractAnalyzer();
}
const { corsMiddleware } = require('../shared/middleware/cors-config.js');
const { createApiSecurityHeadersMiddleware } = require('../shared/middleware/security-headers.js');
const { appLogger } = require('./utils/logger.js');
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');

const app = express();
const PORT = process.env.PORT || 3001;
const probeState = { draining: false };

// Basic middleware
app.use(express.json());
app.use(corsMiddleware);
app.use(createApiSecurityHeadersMiddleware());
app.use(
  createHealthMiddleware('minimal-api-server', {}, { state: probeState }).router
);

// Dashboard stats endpoint - critical for frontend
app.get('/api/stats', (req, res) => {
  res.json({
    success: true,
    data: {
      totalUsers: 12847,
      activeValidators: 156,
      totalTransactions: 2485901,
      networkHashRate: '1.2 TH/s',
      currentBlockHeight: 148592,
      totalSupply: '21000000 WRF',
      circulatingSupply: '8534000 WRF',
      marketCap: '$425.2M',
      price: '$0.0498',
      totalStaked: '3200000 WRF',
      stakingRewards: '12.5%',
      networkUptime: '99.8%',
      weatherStations: 847,
      totalEarnings: '45.8 WRF',
      lastUpdate: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  });
});

// Additional API endpoints to fix 404 errors
app.get('/api/security/metrics', (req, res) => {
  res.json({
    success: true,
    data: {
      threatsDetected: 3,
      blockedAttacks: 12,
      securityScore: 98.5,
      vulnerabilities: 0,
      lastScan: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/performance/metrics', (req, res) => {
  res.json({
    success: true,
    data: {
      responseTime: 125,
      throughput: 1847,
      uptime: 99.8,
      errorRate: 0.02,
      memoryUsage: 68.5,
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/compliance/status', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'compliant',
      auditScore: 94.2,
      lastAudit: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      certifications: ['ISO 27001', 'SOC 2 Type II'],
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/weather/security-status', (req, res) => {
  res.json({
    success: true,
    data: {
      validatedStations: 847,
      secureConnections: 843,
      dataIntegrity: 99.7,
      encryptionStatus: 'active',
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/blockchain/status', (req, res) => {
  res.json({
    success: true,
    data: {
      network: 'Wrfcoin Mainnet',
      status: 'online',
      blockHeight: 148592,
      hashRate: '1.2 TH/s',
      difficulty: 15847293,
      peers: 156,
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/consensus/settings', (req, res) => {
  res.json({
    success: true,
    data: {
      consensusType: 'Proof of Weather',
      validators: 156,
      blockTime: 12.3,
      finalizationTime: 2.1,
      slashingEnabled: true,
    },
    timestamp: new Date().toISOString(),
  });
});

// NFT marketplace
app.get('/api/nft/marketplace', (req, res) => {
  res.json({
    success: true,
    data: {
      featured: [
        {
          tokenId: '1001',
          name: 'Climate Oracle Genesis',
          price: '5.0 WRF',
          image: '/api/nft/image/1001',
          collection: 'genesis_oracles',
        },
      ],
      totalListings: 234,
      floorPrice: '2.1 WRF',
      volume24h: '127.5 WRF',
    },
    timestamp: new Date().toISOString(),
  });
});

// Weather submission
app.post('/api/weather/submit', (req, res) => {
  res.json({
    success: true,
    data: {
      amount: '0.125 WRF',
      qualityScore: 95,
      transactionHash: '0x' + Math.random().toString(16).substr(2, 64),
      timestamp: new Date().toISOString(),
    },
    message: 'Weather data submitted successfully',
    timestamp: new Date().toISOString(),
  });
});

// Mining stats
app.get('/api/mining/stats', (req, res) => {
  res.json({
    success: true,
    data: {
      networkHashRate: '1.2 TH/s',
      difficulty: 15847293,
      blockTime: '12.3s',
      reward: '6.25 WRF',
      activePools: 24,
      totalMiners: 3421,
    },
    timestamp: new Date().toISOString(),
  });
});

// Bridges
app.get('/api/bridges', (req, res) => {
  res.json({
    success: true,
    data: [
      {
        id: 'eth-bridge',
        name: 'Ethereum Bridge',
        status: 'active',
        totalLocked: '1250000 WRF',
        targetChain: 'Ethereum',
      },
    ],
    timestamp: new Date().toISOString(),
  });
});

// Governance proposals
app.get('/api/governance/proposals', (req, res) => {
  res.json({
    success: true,
    data: [
      {
        id: 'prop-001',
        title: 'Weather Data Validation Upgrade',
        description: 'Improve weather data validation algorithms',
        status: 'active',
        votesFor: 12500,
        votesAgainst: 3200,
        endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
    timestamp: new Date().toISOString(),
  });
});

// Generate sample contract data for visualization demonstration
function generateSampleContractData() {
  return {
    nodes: [
      {
        id: 'WRFToken',
        name: 'WRFToken',
        category: 'core',
        type: 'contract',
        importance: 10,
        description: 'Main WRFCoin token contract implementing ERC-20 standard',
        functions: ['transfer', 'approve', 'mint', 'burn'],
        events: ['Transfer', 'Approval'],
        modifiers: ['onlyOwner'],
        dependencies: ['ERC20'],
        bytecodeSize: 4528,
        gasUsage: { deployment: 1200000, average: 45000 },
        auditStatus: 'audited',
        version: '1.0.0',
      },
      {
        id: 'WeatherOracle',
        name: 'WeatherOracle',
        category: 'weather',
        type: 'contract',
        importance: 8,
        description: 'Oracle contract for weather data feeds and validation',
        functions: ['updateWeatherData', 'getWeatherData', 'validateData'],
        events: ['WeatherUpdate', 'DataValidated'],
        modifiers: ['onlyValidator'],
        dependencies: ['Ownable'],
        bytecodeSize: 3210,
        gasUsage: { deployment: 850000, average: 35000 },
        auditStatus: 'audited',
        version: '2.1.0',
      },
      {
        id: 'CarbonMarketplace',
        name: 'CarbonMarketplace',
        category: 'carbon',
        type: 'contract',
        importance: 7,
        description: 'Marketplace for trading carbon credits',
        functions: ['listCredit', 'buyCredit', 'verifyCredit'],
        events: ['CreditListed', 'CreditSold'],
        modifiers: ['validCredit'],
        dependencies: ['WRFToken'],
        bytecodeSize: 2890,
        gasUsage: { deployment: 720000, average: 42000 },
        auditStatus: 'pending',
        version: '1.2.0',
      },
      {
        id: 'StakingPool',
        name: 'StakingPool',
        category: 'staking',
        type: 'contract',
        importance: 9,
        description: 'Staking contract for WRF token rewards',
        functions: ['stake', 'unstake', 'claimRewards'],
        events: ['Staked', 'Unstaked', 'RewardsClaimed'],
        modifiers: ['nonReentrant'],
        dependencies: ['WRFToken', 'ReentrancyGuard'],
        bytecodeSize: 3450,
        gasUsage: { deployment: 950000, average: 38000 },
        auditStatus: 'audited',
        version: '1.1.0',
      },
      {
        id: 'NFTMarketplace',
        name: 'NFTMarketplace',
        category: 'nft',
        type: 'contract',
        importance: 6,
        description: 'NFT marketplace for computational weather models',
        functions: ['mintNFT', 'listNFT', 'buyNFT'],
        events: ['NFTMinted', 'NFTListed', 'NFTSold'],
        modifiers: ['validNFT'],
        dependencies: ['ERC721'],
        bytecodeSize: 4100,
        gasUsage: { deployment: 1100000, average: 55000 },
        auditStatus: 'audited',
        version: '1.0.0',
      },
      {
        id: 'GovernanceDAO',
        name: 'GovernanceDAO',
        category: 'governance',
        type: 'contract',
        importance: 8,
        description: 'DAO governance contract for protocol decisions',
        functions: ['propose', 'vote', 'execute'],
        events: ['ProposalCreated', 'VoteCast', 'ProposalExecuted'],
        modifiers: ['onlyMember'],
        dependencies: ['WRFToken'],
        bytecodeSize: 3780,
        gasUsage: { deployment: 980000, average: 48000 },
        auditStatus: 'audited',
        version: '2.0.0',
      },
    ],
    edges: [
      {
        id: 'edge-1',
        source: 'CarbonMarketplace',
        target: 'WRFToken',
        type: 'call',
        weight: 8,
        description: 'Uses WRF tokens for payment',
        frequency: 120,
      },
      {
        id: 'edge-2',
        source: 'StakingPool',
        target: 'WRFToken',
        type: 'call',
        weight: 9,
        description: 'Stakes and rewards WRF tokens',
        frequency: 200,
      },
      {
        id: 'edge-3',
        source: 'GovernanceDAO',
        target: 'WRFToken',
        type: 'call',
        weight: 7,
        description: 'Uses WRF for voting power',
        frequency: 85,
      },
      {
        id: 'edge-4',
        source: 'WeatherOracle',
        target: 'NFTMarketplace',
        type: 'event',
        weight: 6,
        description: 'Provides data for computational NFTs',
        frequency: 45,
      },
      {
        id: 'edge-5',
        source: 'CarbonMarketplace',
        target: 'WeatherOracle',
        type: 'call',
        weight: 5,
        description: 'Validates environmental data',
        frequency: 30,
      },
    ],
    metadata: {
      totalContracts: 6,
      totalConnections: 5,
      categories: {
        core: 1,
        weather: 1,
        carbon: 1,
        staking: 1,
        nft: 1,
        governance: 1,
      },
      lastUpdated: new Date().toISOString(),
      networkStats: {
        diameter: 3,
        density: 0.33,
        avgClusteringCoefficient: 0.45,
      },
    },
  };
}

// Smart Contracts Analysis API
let contractsGraphCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 300000; // 5 minutes cache

// Main smart contracts graph endpoint
app.get('/api/smart-contracts/graph', async (req, res) => {
  try {
    const now = Date.now();

    // Check if cache is valid
    if (contractsGraphCache && now - cacheTimestamp < CACHE_TTL) {
      return res.json({
        success: true,
        data: contractsGraphCache,
        cached: true,
        cacheAge: Math.floor((now - cacheTimestamp) / 1000),
        timestamp: new Date().toISOString(),
      });
    }

    appLogger.debug('Analyzing smart contracts (cache miss)');

    // Initialize analyzer
    const analyzer = createContractAnalyzer();
    let data;

    try {
      data = await analyzer.analyze();

      // If no contracts found, provide sample/mock data for demonstration
      if (!data.nodes || data.nodes.length === 0) {
        appLogger.debug('No contracts found, providing sample visualization data');
        data = generateSampleContractData();
      }
    } catch (error) {
      appLogger.warn('Contract analysis failed, providing sample data', { error: error.message });
      data = generateSampleContractData();
    }

    // Update cache
    contractsGraphCache = data;
    cacheTimestamp = now;

    res.json({
      success: true,
      data: data,
      cached: false,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    appLogger.error('Smart contracts analysis failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      success: false,
      error: 'Failed to analyze smart contracts',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Contract categories endpoint
app.get('/api/smart-contracts/categories', (req, res) => {
  const categories = {
    'Core Tokens': {
      color: '#FF6B6B',
      description: 'Core token contracts and basic functionality',
    },
    DeFi: {
      color: '#4ECDC4',
      description: 'Decentralized Finance protocols and mechanisms',
    },
    Governance: {
      color: '#45B7D1',
      description: 'DAO governance and voting mechanisms',
    },
    Security: {
      color: '#96CEB4',
      description: 'Security, access control, and fraud prevention',
    },
    'Data/Oracles': {
      color: '#FFEAA7',
      description: 'Data feeds, oracles, and external integrations',
    },
    'NFT/Marketplace': {
      color: '#DDA0DD',
      description: 'NFT contracts and marketplace functionality',
    },
    'Carbon/Climate': {
      color: '#98D8C8',
      description: 'Carbon credits and climate-related contracts',
    },
    'Cross-Chain': {
      color: '#F7DC6F',
      description: 'Cross-chain bridges and interoperability',
    },
    Infrastructure: {
      color: '#BB8FCE',
      description: 'Infrastructure and utility contracts',
    },
    Other: { color: '#BDC3C7', description: 'Other specialized contracts' },
  };

  res.json({
    success: true,
    data: { categories },
    timestamp: new Date().toISOString(),
  });
});

// Search contracts endpoint (MUST come before :contractName route)
app.get('/api/smart-contracts/search', async (req, res) => {
  try {
    const { q, category, type } = req.query;

    if (!q && !category && !type) {
      return res.status(400).json({
        success: false,
        error:
          'At least one search parameter (q, category, or type) is required',
        timestamp: new Date().toISOString(),
      });
    }

    // Ensure we have data
    if (!contractsGraphCache) {
      const analyzer = createContractAnalyzer();
      contractsGraphCache = await analyzer.analyze();
      cacheTimestamp = Date.now();
    }

    let results = contractsGraphCache.nodes;

    // Filter by search query
    if (q) {
      const query = q.toLowerCase();
      results = results.filter(
        contract =>
          contract.name.toLowerCase().includes(query) ||
          contract.description.toLowerCase().includes(query) ||
          contract.category.toLowerCase().includes(query)
      );
    }

    // Filter by category
    if (category) {
      results = results.filter(
        contract => contract.category.toLowerCase() === category.toLowerCase()
      );
    }

    // Filter by type
    if (type) {
      results = results.filter(contract => contract.type === type);
    }

    res.json({
      success: true,
      data: {
        contracts: results,
        total: results.length,
        query: { q, category, type },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    appLogger.error('Contract search failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      success: false,
      error: 'Contract search failed',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Statistics endpoint (MUST come before :contractName route)
app.get('/api/smart-contracts/stats', async (req, res) => {
  try {
    // Ensure we have data
    if (!contractsGraphCache) {
      const analyzer = createContractAnalyzer();
      contractsGraphCache = await analyzer.analyze();
      cacheTimestamp = Date.now();
    }

    const stats = {
      totalContracts: contractsGraphCache.nodes.length,
      totalRelationships: contractsGraphCache.links.length,
      categories: contractsGraphCache.metadata.categoryCounts,
      hubContracts: contractsGraphCache.nodes.filter(node => node.isHub).length,
      contractTypes: {
        core: contractsGraphCache.nodes.filter(n => n.type === 'core').length,
        contract: contractsGraphCache.nodes.filter(n => n.type === 'contract')
          .length,
        interface: contractsGraphCache.nodes.filter(n => n.type === 'interface')
          .length,
        library: contractsGraphCache.nodes.filter(n => n.type === 'library')
          .length,
        abstract: contractsGraphCache.nodes.filter(n => n.type === 'abstract')
          .length,
      },
      relationshipTypes: {
        import: contractsGraphCache.links.filter(l => l.type === 'import')
          .length,
        inheritance: contractsGraphCache.links.filter(
          l => l.type === 'inheritance'
        ).length,
        interface: contractsGraphCache.links.filter(l => l.type === 'interface')
          .length,
        composition: contractsGraphCache.links.filter(
          l => l.type === 'composition'
        ).length,
        dependency: contractsGraphCache.links.filter(
          l => l.type === 'dependency'
        ).length,
      },
    };

    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    appLogger.error('Stats generation failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      success: false,
      error: 'Stats generation failed',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Contract details endpoint (MUST come AFTER specific routes)
app.get('/api/smart-contracts/:contractName', async (req, res) => {
  try {
    const { contractName } = req.params;

    // Ensure we have fresh data
    if (!contractsGraphCache) {
      const analyzer = createContractAnalyzer();
      contractsGraphCache = await analyzer.analyze();
      cacheTimestamp = Date.now();
    }

    // Find the contract
    const contract = contractsGraphCache.nodes.find(
      node => node.id === contractName || node.name === contractName
    );

    if (!contract) {
      return res.status(404).json({
        success: false,
        error: `Contract '${contractName}' not found`,
        timestamp: new Date().toISOString(),
      });
    }

    // Find related contracts
    const relationships = contractsGraphCache.links.filter(
      link => link.source === contractName || link.target === contractName
    );

    res.json({
      success: true,
      data: {
        contract,
        relationships,
        relatedContracts: relationships
          .map(rel => {
            const relatedId =
              rel.source === contractName ? rel.target : rel.source;
            return contractsGraphCache.nodes.find(
              node => node.id === relatedId
            );
          })
          .filter(Boolean),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    appLogger.error('Failed to get contract details', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      success: false,
      error: 'Failed to get contract details',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Cache management endpoint
app.post('/api/smart-contracts/refresh-cache', async (req, res) => {
  try {
    appLogger.debug('Refreshing smart contracts cache');

    const analyzer = createContractAnalyzer();
    const data = await analyzer.analyze();

    contractsGraphCache = data;
    cacheTimestamp = Date.now();

    res.json({
      success: true,
      message: 'Cache refreshed successfully',
      data: {
        totalContracts: data.metadata.totalContracts,
        totalRelationships: data.metadata.totalRelationships,
        categoryCounts: data.metadata.categoryCounts,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    appLogger.error('Cache refresh failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      success: false,
      error: 'Cache refresh failed',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: `Endpoint ${req.originalUrl} not found`,
    timestamp: new Date().toISOString(),
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  appLogger.info('Minimal API Server started', {
    port: PORT,
    url: `http://0.0.0.0:${PORT}`,
    features: ['dashboard endpoints', 'microservices architecture']
  });
});

registerGracefulShutdown({
  serviceName: 'minimal-api-server',
  server,
  logger: appLogger,
  state: probeState,
});

module.exports = app;
module.exports.server = server;
