// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});
const { resolveAllowedOrigins } = require('./utils/strict-cors-config');

const express = require('express');
const cors = require('cors');
const { appLogger } = require('./utils/logger');
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');

const app = express();
const PORT = process.env.PORT || 3001;
const probeState = { draining: false };

// CORS configuration for microservices
const corsOptions = {
  origin: [
    ...(resolveAllowedOrigins({ developmentDefaults: ['http://localhost:3000', 'http://localhost:5000', 'http://127.0.0.1:5000'] })),
    'https://workspace.replit.app',
    /\.replit\.dev$/,
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-requested-with'],
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  createHealthMiddleware('simplified-api-server', {}, { state: probeState }).router
);

// Core dashboard stats endpoint
app.get('/api/stats', (req, res) => {
  const stats = {
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
  };

  res.json({
    success: true,
    data: stats,
    timestamp: new Date().toISOString(),
  });
});

// NFT marketplace endpoint
app.get('/api/nft/marketplace', (req, res) => {
  const marketplace = {
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
  };

  res.json({
    success: true,
    data: marketplace,
    timestamp: new Date().toISOString(),
  });
});

// Weather submission endpoint
app.post('/api/weather/submit', (req, res) => {
  const reward = {
    amount: '0.125 WRF',
    qualityScore: 95,
    transactionHash: '0x' + Math.random().toString(16).substr(2, 64),
    timestamp: new Date().toISOString(),
  };

  res.json({
    success: true,
    data: reward,
    message: 'Weather data submitted successfully',
    timestamp: new Date().toISOString(),
  });
});

// Cross-chain bridges
app.get('/api/bridges', (req, res) => {
  const bridges = [
    {
      id: 'eth-bridge',
      name: 'Ethereum Bridge',
      status: 'active',
      totalLocked: '1250000 WRF',
      targetChain: 'Ethereum',
    },
    {
      id: 'polygon-bridge',
      name: 'Polygon Bridge',
      status: 'active',
      totalLocked: '850000 WRF',
      targetChain: 'Polygon',
    },
  ];

  res.json({
    success: true,
    data: bridges,
    timestamp: new Date().toISOString(),
  });
});

// Mining stats
app.get('/api/mining/stats', (req, res) => {
  const stats = {
    networkHashRate: '1.2 TH/s',
    difficulty: 15847293,
    blockTime: '12.3s',
    reward: '6.25 WRF',
    activePools: 24,
    totalMiners: 3421,
  };

  res.json({
    success: true,
    data: stats,
    timestamp: new Date().toISOString(),
  });
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
  appLogger.info('Unified API Server (Microservices) running', { module: 'SimplifiedAPI', operation: 'serverStart', port: PORT, url: `http://0.0.0.0:${PORT}` });
  appLogger.info('Dashboard API endpoints active', { module: 'SimplifiedAPI', operation: 'serverStart' });
  appLogger.info('TypeScript microservices architecture transitioning', { module: 'SimplifiedAPI', operation: 'serverStart' });
});

registerGracefulShutdown({
  serviceName: 'simplified-api-server',
  server,
  logger: appLogger,
  state: probeState,
});

module.exports = app;
module.exports.server = server;
