// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

const fs = require('fs');
const http = require('http');

const express = require('express');
const { appLogger } = require('./utils/logger');
const { createErrorResponse } = require('./utils/error-response');
const cors = require('cors');
const ProductionCORSCleanup = require('../middleware/production-cors-cleanup').default;
const {
  transferValidation,
  basicValidation,
} = require('../middleware/input-validation');

const blockchainAdapter = require('./blockchain_adapter');
const nftController = configureController(
  require('./controllers/nftController')
);
const miningPoolController = configureController(
  require('./controllers/miningPoolController')
);
const miningController = configureController(
  require('./controllers/miningController')
);
const governanceController = configureController(
  require('./controllers/governanceController')
);
const securityController = configureController(
  require('./controllers/securityController')
);
const consensusController = configureController(
  require('./controllers/consensusController')
);
const blockchainController = configureController(
  require('./controllers/blockchainController')
);
const transactionController = configureController(
  require('./controllers/transactionController')
);
const walletController = configureController(
  require('./controllers/walletController')
);
const crossChainController = configureController(
  require('./controllers/crossChainController')
);
const moduleController = configureController(
  require('./controllers/moduleController')
);
const computationalNftController = configureController(
  require('./controllers/computationalNftController')
);
const wasmRuntimeApi = require('./computational/api');
const { instance } = require('./computational/weather_models');

// server/api.js

// Real DB-backed storage via api-storage.js (#603).
// Dynamic ESM imports are handled lazily inside api-storage.js so startup is not blocked.
const storage = require('./api-storage');
appLogger.info('Using DB-backed storage (api-storage.js)', { module: 'API', operation: 'storageInit' });

// We'll set up our controllers with access to the storage object
const configureController = controllerModule => {
  // Create a wrapper for each controller function that injects our storage
  const controller = { ...controllerModule };

  // Wrap each controller function to inject the storage reference and handle errors
  return Object.fromEntries(
    Object.entries(controller).map(([key, fn]) => [
      key,
      (req, res) => {
        // Make storage available in controller scope
        req.storage = storage;

        // Call the original function with our context
        return fn(req, res).catch(error => {
          appLogger.error(`Error in controller ${key}`, { module: 'API', operation: 'controllerError', error: error.message });
          res.status(500).json(
            createErrorResponse('Internal server error', 'INTERNAL_SERVER_ERROR')
          );
        });
      },
    ])
  );
};

// Import controllers and configure them with our storage

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced security middleware with production CORS cleanup
ProductionCORSCleanup.autoConfigureCORS(app);
app.use(express.json());

// Serve static files - make sure they're accessible
app.use('/static', express.static('static'));
appLogger.info('Serving static files from /static directory', { module: 'API', operation: 'staticFiles' });

// Add mock weather maps for demo
const staticDir = 'static/images/mockWeatherMaps';
if (!fs.existsSync(staticDir)) {
  fs.mkdirSync(staticDir, { recursive: true });
}
// Log available weather maps
if (fs.existsSync(staticDir)) {
  appLogger.info('Weather maps available', { module: 'API', operation: 'weatherMaps', files: fs.readdirSync(staticDir) });
}
// ------ API Routes ------

// Blockchain API routes
// Blockchain info
app.get('/api/blockchain/info', blockchainController.getBlockchainInfo);
// Blocks
app.get('/api/blockchain/blocks', blockchainController.getLatestBlocks);
app.get(
  '/api/blockchain/block/hash/:hash',
  blockchainController.getBlockByHash
);
app.get(
  '/api/blockchain/block/height/:height',
  blockchainController.getBlockByHeight
);
app.post('/api/blockchain/blocks', blockchainController.createBlock);

// Transaction API routes
// Only enabling the basic transaction routes that we've implemented in storage.ts
app.get(
  '/api/transactions/tx/:hash',
  transactionController.getTransactionByHash
);
app.get(
  '/api/transactions/sender/:address',
  transactionController.getTransactionsBySender
);
app.get(
  '/api/transactions/recipient/:address',
  transactionController.getTransactionsByRecipient
);
app.get(
  '/api/transactions/block/:blockHash',
  transactionController.getTransactionsByBlock
);
// Temporarily disabling these until we fully implement the required storage methods
/*
app.get('/api/transactions/address/:address', transactionController.getTransactionsByAddress);
app.get('/api/transactions/pending', transactionController.getPendingTransactions);
app.post('/api/transactions', transactionController.createTransaction);
*/

// Wallet API routes
// Temporarily commenting these routes until we fully implement the storage methods
/*
app.get('/api/wallets/address/:address', walletController.getWalletByAddress);
app.get('/api/wallets/user/:userId', walletController.getWalletByUserId);
app.post('/api/wallets', walletController.createWallet);
app.put('/api/wallets/:address/balance', walletController.updateWalletBalance);
app.put('/api/wallets/:address/nonce', walletController.incrementWalletNonce);
*/

// Cross-chain API routes
// Temporarily commenting these routes until we fully implement the storage methods
/*
app.get('/api/cross-chain/transfers', crossChainController.getAllCrossChainTransfers);
app.get('/api/cross-chain/transfers/:id', crossChainController.getCrossChainTransferById);
app.get('/api/cross-chain/transfers/address/:address', crossChainController.getCrossChainTransfersByAddress);
app.get('/api/cross-chain/transfers/chains/:fromChain/:toChain', crossChainController.getTransfersByChainPair);
app.post('/api/cross-chain/transfers', crossChainController.createCrossChainTransfer);
app.put('/api/cross-chain/transfers/:id/status', crossChainController.updateCrossChainTransferStatus);
*/

// NFT API Routes
app.get('/api/nfts', nftController.getAllNFTs);
app.get('/api/nfts/:id', nftController.getNFTById);
app.get('/api/nfts/creator/:address', nftController.getNFTsByCreator);
app.post('/api/nfts', nftController.createNFT);
app.put('/api/nfts/:id', nftController.updateNFTStatus);

// Note: Computational NFT routes are now handled by computationalNftController
// See below for route definitions:
// app.get('/api/nft/computational/:id', computationalNftController.getComputationalNFT);
// app.get('/api/nft/computational', computationalNftController.getAllComputationalNFTs);
// app.get('/api/nft/marketplace', computationalNftController.getNFTMarketplace);

// Mining API Routes
app.get('/api/mining/stats', miningController.getMiningStats);
app.get('/api/mining/status/:address', miningController.getMiningStatus);
app.post('/api/mining/start', miningController.startMining);
app.post('/api/mining/stop', miningController.stopMining);
app.get('/api/mining/hardware', miningController.getHardwareCapabilities);

// Mining Pool API Routes
app.get('/api/mining/pools', miningPoolController.getAllMiningPools);
app.get('/api/mining/pools/:poolId', miningPoolController.getMiningPoolById);
app.post('/api/mining/pools', miningPoolController.createMiningPool);
app.put('/api/mining/pools/:poolId', miningPoolController.updateMiningPool);
app.get(
  '/api/mining/pools/:poolId/members',
  miningPoolController.getPoolMembers
);
app.post('/api/mining/pools/:poolId/join', miningPoolController.joinPool);
app.post('/api/mining/pools/:poolId/leave', miningPoolController.leavePool);
app.post('/api/mining/pools/:poolId/shares', miningPoolController.submitShares);

// Governance API Routes
// Proposals
app.get('/api/governance/proposals', governanceController.getAllProposals);
app.get(
  '/api/governance/proposals/active',
  governanceController.getActiveProposals
);
app.get(
  '/api/governance/proposals/:proposalId',
  governanceController.getProposalById
);
app.post('/api/governance/proposals', governanceController.createProposal);
app.post(
  '/api/governance/proposals/:proposalId/finalize',
  governanceController.finalizeProposal
);

// Voting
app.post(
  '/api/governance/proposals/:proposalId/vote',
  governanceController.castVote
);
app.get(
  '/api/governance/proposals/:proposalId/votes',
  governanceController.getVotesByProposal
);

// Parameters
app.get('/api/governance/parameters', governanceController.getAllParameters);
app.get(
  '/api/governance/parameters/:paramName',
  governanceController.getParameterByName
);

// Delegations
app.get(
  '/api/governance/delegations/delegator/:delegator',
  governanceController.getDelegationsByDelegator
);
app.get(
  '/api/governance/delegations/delegate/:delegate',
  governanceController.getDelegationsByDelegate
);
app.post('/api/governance/delegations', governanceController.createDelegation);
app.delete(
  '/api/governance/delegations/:delegator/:delegate',
  governanceController.removeDelegation
);

// Security API Routes
app.get(
  '/api/security/settings/:nodeId',
  securityController.getSecuritySettings
);
app.post('/api/security/settings', securityController.createSecuritySettings);
app.put(
  '/api/security/settings/:nodeId',
  securityController.updateSecuritySettings
);
app.get(
  '/api/security/privacy/:transactionId',
  securityController.getPrivacyTransaction
);
app.post('/api/security/privacy', securityController.createPrivacyTransaction);
app.post('/api/security/mev/analyze', securityController.analyzeMevRisk);

// Consensus API Routes
app.get(
  '/api/consensus/settings/:nodeId',
  consensusController.getConsensusSettings
);
app.post(
  '/api/consensus/settings',
  consensusController.createConsensusSettings
);
app.put(
  '/api/consensus/settings/:nodeId',
  consensusController.updateConsensusSettings
);
app.get(
  '/api/consensus/current',
  consensusController.getCurrentConsensusSettings
);

// Module API Routes (common, config, mempool, resources, util)

// Common module routes
app.get('/api/common/info', moduleController.getCommonInfo);
app.post('/api/common/hash', moduleController.calculateHash);

// Config module routes
app.get('/api/config', moduleController.getConfig);
app.put('/api/config', moduleController.updateConfig);

// Mempool module routes
app.get('/api/mempool/transactions', moduleController.getPendingTransactions);
app.get('/api/mempool/stats', moduleController.getMempoolStats);

// Resources module routes
app.get('/api/resources', moduleController.listResources);
app.get('/api/resources/:path', moduleController.getResource);

// Util module routes
app.get(
  '/api/util/validate-address/:address',
  moduleController.validateAddress
);
app.get('/api/util/format-timestamp', moduleController.formatTimestamp);

// Computational NFT routes

// Initialize the computational models later in the startServer function
// to ensure storage is properly set up

// NFT routes
app.get('/api/nft/models', computationalNftController.getAvailableModelTypes);
app.get('/api/nft/sample-models', computationalNftController.getSampleModels);
app.post(
  '/api/nft/computational',
  computationalNftController.createComputationalNFT
);
app.get(
  '/api/nft/computational/:id',
  computationalNftController.getComputationalNFTById
);
app.get(
  '/api/nft/computational',
  computationalNftController.getAllComputationalNFTs
);
app.get('/api/nft/marketplace', computationalNftController.getNFTMarketplace);
app.post(
  '/api/nft/computational/:id/execute',
  computationalNftController.executeComputationalNFT
);
app.post(
  '/api/nft/computational/:id/verify',
  computationalNftController.verifyComputationalNFT
);
app.post(
  '/api/nft/computational/:id/transfer',
  computationalNftController.transferNFTOwnership
);
app.get(
  '/api/nft/region/:regionCode',
  computationalNftController.getNFTsByRegion
);

// HTTP server reference to expose for WebSocket
let httpServer = null;

// WebAssembly Runtime API routes
app.use('/api/computational', wasmRuntimeApi);

// Start server
const startServer = async () => {
  // Initialize computational models before starting the server
  try {
    // Call the initialize method directly on the weather models module
    // bypassing the controller wrapper
    if (instance.initialize) {
      await instance.initialize();
      appLogger.info('Weather models initialized', { module: 'API', operation: 'modelInit' });
    }
  } catch (error) {
    appLogger.error('Failed to initialize computational models', { module: 'API', operation: 'modelInit', error: error.message });
  }

  // Create an HTTP server
  httpServer = http.createServer(app);

  // Start the server
  httpServer.listen(PORT, '0.0.0.0', () => {
    appLogger.info(`API server running on http://0.0.0.0:${PORT}`, { module: 'API', operation: 'serverStart', port: PORT });
  });

  return httpServer;
};

// Get HTTP server instance for WebSocket setup
const getHttpServer = () => {
  return httpServer;
};

module.exports = { app, startServer, getHttpServer };
