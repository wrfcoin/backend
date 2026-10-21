// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});
const { resolveAllowedOrigins } = require('./utils/strict-cors-config');

const express = require('express');
const cors = require('cors');
const wvmRoutes = require('./routes/wvm');
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');

const app = express();
const PORT = process.env.PORT || 5001;
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
  createHealthMiddleware('wvm-demo-server', {}, { state: probeState }).router
);

// WVM API routes - connecting your Virtual Machine to the dashboard
app.use('/api/wvm', wvmRoutes);

// Cross-chain rewards endpoint (the one your frontend is looking for)
app.use('/api', wvmRoutes);

// Blockchain status endpoint that your dashboard uses
app.get('/api/blockchain/status', (req, res) => {
  res.json({
    status: 'online',
    blockHeight: 987,
    activeMiners: 76,
    networkUptime: 99.98,
    avgTransactionFee: 0.0418,
    consensusAlgorithm: 'Proof-of-Environment',
    carbonFootprint: -0.0089, // Carbon negative
    renewableEnergy: 94.7,
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('WVM Server Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    wvm: 'error',
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 WVM Demo Server running on port ${PORT}`);
  console.log(`📊 Dashboard integration: http://localhost:${PORT}/health`);
  console.log(
    `⛓️  Cross-chain endpoints: http://localhost:${PORT}/api/wvm/mining/cross-chain-rewards`
  );
  console.log(
    `🌍 Environmental data: http://localhost:${PORT}/api/wvm/environmental/impact`
  );
});

registerGracefulShutdown({
  serviceName: 'wvm-demo-server',
  server,
  logger: console,
  state: probeState,
});
