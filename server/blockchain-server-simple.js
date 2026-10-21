// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

import http from 'http';
import { applyRawCorsHeaders } from './backend/shared/middleware/cors-config.js';
import { applyApiSecurityHeaders } from './backend/shared/middleware/security-headers.js';
import shutdownUtils from './utils/graceful-shutdown.js';
import rawHealthUtils from './utils/raw-http-health.js';
const port = 3000;
const probeState = { draining: false };
const { registerGracefulShutdown } = shutdownUtils;
const { writeProbeResponse } = rawHealthUtils;

const server = http.createServer((req, res) => {
  // Apply secure CORS headers with origin validation
  const origin = req.headers.origin;
  applyRawCorsHeaders(res, origin);

  // Apply security headers (CSP, X-Frame-Options, etc.)
  applyApiSecurityHeaders(res);

  if (writeProbeResponse(req, res, 'blockchain-server-simple', probeState)) {
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Parse URL
  const urlPath = req.url;
  res.setHeader('Content-Type', 'application/json');

  // Simple blockchain status response
  if (urlPath.startsWith('/api/blockchain/status')) {
    const response = {
      status: 'active',
      network: 'wrfcoin-mainnet',
      blockHeight: 1024567,
      peers: 42,
      difficulty: '0x1bc16d674ec80000',
      hashRate: '150.2 TH/s',
      timestamp: new Date().toISOString(),
    };
    res.writeHead(200);
    res.end(JSON.stringify(response));
    return;
  }

  // Mining status
  if (urlPath.startsWith('/api/mining')) {
    const response = {
      isMining: true,
      currentBlock: 1024567,
      hashRate: '15.2 GH/s',
      difficulty: 4.2e12,
      reward: '12.5 WRF',
      timestamp: new Date().toISOString(),
    };
    res.writeHead(200);
    res.end(JSON.stringify(response));
    return;
  }

  // Privacy features
  if (urlPath.startsWith('/api/privacy')) {
    const response = {
      zkSnarksEnabled: true,
      mixerAvailable: true,
      privacyLevel: 'high',
      anonymousTransactions: 1337,
      timestamp: new Date().toISOString(),
    };
    res.writeHead(200);
    res.end(JSON.stringify(response));
    return;
  }

  // Default blockchain info
  const defaultResponse = {
    service: 'wrfcoin-blockchain',
    version: '1.0.0',
    status: 'running',
    endpoints: ['/api/blockchain/status', '/api/mining', '/api/privacy'],
    timestamp: new Date().toISOString(),
  };

  res.writeHead(200);
  res.end(JSON.stringify(defaultResponse));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`🔗 Wrfcoin Blockchain Server running at http://0.0.0.0:${port}`);
  console.log(
    `📊 Blockchain status: http://0.0.0.0:${port}/api/blockchain/status`
  );
  console.log(`⛏️ Mining status: http://0.0.0.0:${port}/api/mining`);
});

registerGracefulShutdown({
  serviceName: 'blockchain-server-simple',
  server,
  logger: console,
  state: probeState,
});
